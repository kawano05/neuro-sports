// =====================================================================
// engine.js — 部屋の状態を進める（ホストだけが動かす。純粋関数）
//
// reduce(state, action, now, rng) → 新しい state。
// ホストはこれで状態を進め、まるごとゲストへ配る（net.js / session.js）。
// ゲストは自分では状態を変えない。押したら「押した時刻（ホストの時計）」をホストへ送る。
//
// events は「起きたこと」の短い列（音・読み上げ・ぱっと出る絵のため）。各端末は、
// まだ見ていない id のものだけを鳴らす。
// =====================================================================

import {
  OUT,
  OUTS_PER_HALF,
  RESULT_MS,
  SPIN_PERIOD_MS,
  advanceRunners,
  contactQuality,
  firstSweetAt,
  hitWindowMs,
  offsetFromSweet,
  simulateHit,
} from "./games/baseball.js";
import {
  SWEEP_PERIOD_MS,
  TEAMS,
  aimAt,
  autoPower,
  nextTeam,
  placeJack,
  powerAt,
  scoreEnd,
  simulateThrow,
} from "./games/boccia.js";

export const GAMES = ["baseball", "boccia"];

/** 遊ぶ人ごとの色（はっきり分かれる8色）。ボッチャのチームの色（赤・青）とは別。 */
export const PLAYER_COLORS = ["#F2B705", "#2E9E44", "#8E44AD", "#F07D1A", "#14A3A3", "#D6458B", "#5B6BD6", "#8C5A2B"];
/** 見るだけの人の色。 */
export const WATCH_COLOR = "#D5D0C4";

/**
 * 部屋の人数の上限。
 *   あそぶ … 8人まで。色が重ならず、野球の1巡が長くなりすぎない（8人×3回で3〜4分）。
 *           ボッチャは 4対4 まで（本物の団体戦は 3対3）。
 *   部屋全体 … 20人まで（見るだけ 12人）。状態はホストの端末がまとめて全員へ配るので、
 *           iPad がホストでも重くならない数にしておく。
 * あそぶ人がいっぱいのときに来た人は、見るだけで入る（出来事 "full" で知らせる）。
 */
export const MAX_PLAYING = 8;
export const MAX_IN_ROOM = 20;

export const DEFAULT_SETTINGS = Object.freeze({
  baseball: Object.freeze({ speed: "normal", width: "wide", outs: true, innings: 2, atBats: 3, rotate: "auto", cue: true }),
  boccia: Object.freeze({ speed: "normal", presses: 2, balls: 3, guide: true, cue: true }),
});

/** 押しても数えない、交代した直後の時間（前の人の押しが重なって入らないように）。 */
export const TURN_GUARD_MS = 900;
/** ボッチャ: 「むき」を決めてから「つよさ」が動き出すまでの、押しを受けない時間。 */
export const LOCK_GUARD_MS = 450;
/** ボッチャ: 放してから、ランプを下りて出口に着くまで。 */
export const RAMP_DROP_MS = 300;
/** ボッチャ: 止まってから、次の人へ移るまで。 */
export const SETTLE_MS = 1000;
/** 覚えておく出来事の数。 */
const EVENT_KEEP = 16;

export function createState({ roomCode = null, settings = null } = {}) {
  return {
    seq: 0,
    roomCode,
    screen: "room",
    game: "baseball",
    settings: mergeSettings(settings),
    players: [],
    turn: null,
    baseball: null,
    boccia: null,
    events: [],
    eventSeq: 0,
  };
}

function mergeSettings(saved) {
  const out = {};
  for (const game of GAMES) {
    out[game] = { ...DEFAULT_SETTINGS[game], ...(saved?.[game] || {}) };
  }
  return out;
}

const clone = (value) => (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

/** 遊ぶ人（見るだけ・つながっていない人を除く）。参加した順。 */
export function activePlayers(state) {
  return state.players.filter((p) => p.role === "play" && p.connected);
}

export function playerById(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

/** id の人を除いた、つながっている「あそぶ」人の数。 */
export function playingCount(state, exceptId = null) {
  return state.players.filter((p) => p.connected && p.role === "play" && p.id !== exceptId).length;
}

/** id の人が入れるか（入り直しの人は、いつでも入れる）。 */
export function roomHasSpace(state, id) {
  const existing = playerById(state, id);
  if (existing) return true;
  return state.players.filter((p) => p.connected).length < MAX_IN_ROOM;
}

/** あいている色（つながっている「あそぶ」人が使っていない色）。 */
function freeColor(s, exceptId) {
  const used = new Set(s.players.filter((p) => p.connected && p.role === "play" && p.id !== exceptId).map((p) => p.color));
  return PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
}

/** 役わり（あそぶ／見るだけ）に合わせて色を決め直す。 */
function fitColor(s, player) {
  if (player.role !== "play") {
    player.color = WATCH_COLOR;
    return;
  }
  const taken = s.players.some((p) => p.id !== player.id && p.connected && p.role === "play" && p.color === player.color);
  if (taken || !PLAYER_COLORS.includes(player.color)) player.color = freeColor(s, player.id);
}

function pushEvent(s, now, event) {
  s.eventSeq += 1;
  s.events.push({ id: s.eventSeq, at: now, ...event });
  if (s.events.length > EVENT_KEEP) s.events.splice(0, s.events.length - EVENT_KEEP);
}

/** active の並びで、id の次の人（いなければ先頭）。 */
function nextInOrder(list, id) {
  if (list.length === 0) return null;
  const index = list.findIndex((p) => p.id === id);
  return list[(index + 1) % list.length] ?? list[0];
}

function setTurn(s, now, playerId) {
  s.turn = playerId ? { playerId, since: now } : null;
  if (playerId) pushEvent(s, now, { kind: "turn", playerId, game: s.game });
}

/**
 * @param {object} state
 * @param {{type:string, [key:string]: any}} action
 * @param {number} now ホストの時計（ms）
 * @param {() => number} [rng]
 */
export function reduce(state, action, now, rng = Math.random) {
  const s = clone(state);
  const changed = apply(s, action, now, rng);
  if (!changed) return state;
  s.seq += 1;
  return s;
}

function apply(s, action, now, rng) {
  switch (action.type) {
    case "join": {
      const incoming = action.player;
      const existing = playerById(s, incoming.id);
      if (existing?.removed) return false;
      if (!existing && !roomHasSpace(s, incoming.id)) return false;
      const wantsPlay = incoming.role !== "watch";
      const canPlay = playingCount(s, incoming.id) < MAX_PLAYING;
      const role = wantsPlay && canPlay ? "play" : "watch";
      let player = existing;
      if (player) {
        player.connected = true;
        if (incoming.name) player.name = incoming.name;
        if (incoming.role) player.role = role;
      } else {
        // ボッチャのチームは、来た順に 赤・青・赤・青……（あとでホストが変えられる）。
        const playing = s.players.filter((p) => p.role === "play").length;
        player = {
          id: incoming.id,
          name: (incoming.name || "").slice(0, 12) || `${s.players.length + 1}ばん`,
          color: WATCH_COLOR,
          role,
          team: TEAMS[playing % 2],
          connected: true,
          host: !!incoming.host,
        };
        s.players.push(player);
      }
      fitColor(s, player);
      pushEvent(s, now, { kind: "join", playerId: incoming.id });
      if (wantsPlay && !canPlay && (incoming.role || !existing)) pushEvent(s, now, { kind: "full", playerId: incoming.id });
      // 遊んでいる途中で、だれの番でもなければ、この人の番にする。
      if (s.screen === "game" && !s.turn) startTurnFor(s, now, rng);
      return true;
    }
    case "remove": {
      // ホストが部屋から外した人。名前の列から消え、二度と入れない（session.js が札も消す）。
      const player = playerById(s, action.id);
      if (!player || player.host || player.removed) return false;
      player.removed = true;
      player.connected = false;
      player.role = "watch";
      fitColor(s, player);
      if (s.turn?.playerId === action.id && s.screen === "game") passTurn(s, now, rng);
      return true;
    }
    case "leave": {
      const player = playerById(s, action.id);
      if (!player || !player.connected) return false;
      player.connected = false;
      if (s.turn?.playerId === action.id && s.screen === "game") passTurn(s, now, rng);
      return true;
    }
    case "rename": {
      const player = playerById(s, action.id);
      const name = String(action.name || "").trim().slice(0, 12);
      if (!player || !name || player.name === name) return false;
      player.name = name;
      return true;
    }
    case "setRole": {
      const player = playerById(s, action.id);
      if (!player || (action.role !== "play" && action.role !== "watch") || player.role === action.role) return false;
      if (action.role === "play" && playingCount(s, player.id) >= MAX_PLAYING) return false;
      player.role = action.role;
      fitColor(s, player);
      if (action.role === "watch" && s.turn?.playerId === player.id && s.screen === "game") passTurn(s, now, rng);
      if (action.role === "play" && s.screen === "game" && !s.turn) startTurnFor(s, now, rng);
      return true;
    }
    case "setTeam": {
      const player = playerById(s, action.id);
      if (!player || !TEAMS.includes(action.team) || player.team === action.team) return false;
      player.team = action.team;
      return true;
    }
    case "settings": {
      const { game, key, value } = action;
      if (!GAMES.includes(game) || !(key in DEFAULT_SETTINGS[game])) return false;
      if (s.settings[game][key] === value) return false;
      s.settings[game][key] = value;
      if (s.screen === "game" && s.game === game) onSettingsChanged(s, now);
      return true;
    }
    case "chooseGame": {
      if (!GAMES.includes(action.game) || s.screen === "game" || s.game === action.game) return false;
      s.game = action.game;
      return true;
    }
    case "start": {
      const game = GAMES.includes(action.game) ? action.game : s.game;
      if (activePlayers(s).length === 0) return false;
      s.game = game;
      s.screen = "game";
      s.baseball = null;
      s.boccia = null;
      if (game === "baseball") startBaseball(s, now);
      else startBoccia(s, now, rng);
      pushEvent(s, now, { kind: "start", game });
      return true;
    }
    case "stop": {
      if (s.screen !== "game") return false;
      s.screen = "room";
      s.turn = null;
      s.baseball = null;
      s.boccia = null;
      return true;
    }
    case "next": {
      if (s.screen !== "game") return false;
      passTurn(s, now, rng);
      return true;
    }
    case "setTurn": {
      const player = playerById(s, action.id);
      if (s.screen !== "game" || !player || !player.connected) return false;
      if (player.role !== "play") player.role = "play";
      beginTurn(s, now, player.id);
      return true;
    }
    case "nextEnd": {
      if (s.screen !== "game" || s.game !== "boccia" || s.boccia?.phase !== "end") return false;
      s.boccia.endNo += 1;
      startEnd(s, now, rng);
      return true;
    }
    case "press":
      return onPress(s, action, now, rng);
    case "tick":
      return onTick(s, now, rng);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------
// 番（ターン）
// ---------------------------------------------------------------------

/** 今の番の人を、ゲームごとの決まりで次の人へ。 */
function passTurn(s, now, rng) {
  if (s.game === "baseball") {
    const bb = s.baseball;
    const next = bb?.mode === "team" ? pickBatter(s, bb.batting, s.turn?.playerId ?? null) : nextInOrder(activePlayers(s), s.turn?.playerId);
    beginTurn(s, now, next?.id ?? null);
  } else {
    // ボッチャ: 同じチームの次の人へ（投げる玉は同じまま）。
    const bc = s.boccia;
    if (!bc || bc.phase === "end") {
      s.turn = null;
      return;
    }
    const thrower = pickThrower(s, bc.current.team, s.turn?.playerId);
    beginTurn(s, now, thrower?.id ?? null);
  }
}

/** だれの番でもないとき（はじめ・全員抜けたあと）に、番を決める。 */
function startTurnFor(s, now, rng) {
  if (s.game === "baseball") {
    const bb = s.baseball;
    if (bb?.phase === "done") return;
    const first = bb?.mode === "team" ? pickBatter(s, bb.batting, null) : activePlayers(s)[0];
    beginTurn(s, now, first?.id ?? null);
  } else if (s.boccia && s.boccia.phase !== "end") {
    const thrower = pickThrower(s, s.boccia.current.team, null);
    beginTurn(s, now, thrower?.id ?? null);
  }
}

/** id の人の番を始める（ゲームの中の「構え」もやり直す）。 */
function beginTurn(s, now, playerId) {
  setTurn(s, now, playerId);
  if (!playerId) return;
  if (s.game === "baseball" && s.baseball && s.baseball.phase !== "done") {
    if (s.baseball.phase === "spin") newBall(s.baseball, now);
  }
  if (s.game === "boccia" && s.boccia && (s.boccia.phase === "aim" || s.boccia.phase === "power")) {
    const bc = s.boccia;
    const player = playerById(s, playerId);
    // ホストが別のチームの人を選んだら、その人のチームの玉にする（支援者の判断を優先）。
    if (player && bc.teams.includes(player.team) && (bc.left[player.team] ?? 0) > 0) bc.current.team = player.team;
    {
      bc.phase = "aim";
      bc.aimT0 = now;
      bc.angle = null;
      bc.power = null;
      bc.readyAt = now + TURN_GUARD_MS;
    }
  }
}

// ---------------------------------------------------------------------
// 野球
//
// 2つの遊び方（支援者の設定「アウト」）:
//   あり（team）… 赤・青のチームで、決めた回数まで。3アウトで攻守交代（チェンジ）。
//                本物の野球盤のように、穴や内野で止まるとアウト。
//   なし（together）… みんなで合計点。アウトの場所に止まってもヒットにする。
//                ひとりが決めた回数を打ったら おわり（neuro の「へこませない」遊び方）。
//
// 打つ → ボールが転がる（flight）→ 止まったら結果（result）→ 少し見せて、次のボール。
// 結果（塁・点・アウト）は、ボールが止まった時に反映する（画面と食い違わない）。
// ---------------------------------------------------------------------

function baseballTeams(s) {
  const inPlay = TEAMS.filter((team) => activePlayers(s).some((p) => p.team === team));
  return inPlay.length >= 2 ? [...TEAMS] : [inPlay[0] || "red"];
}

/** チームの次の打者（いなければ、遊ぶ人のだれか）。 */
function pickBatter(s, team, afterId) {
  const active = activePlayers(s);
  const inTeam = s.baseball?.mode === "team" ? active.filter((p) => p.team === team) : active;
  const pool = inTeam.length ? inTeam : active;
  if (pool.length === 0) return null;
  const after = afterId ?? s.baseball?.lastBatter?.[team] ?? null;
  if (!after) return pool[0];
  return nextInOrder(pool, after);
}

function startBaseball(s, now) {
  const set = s.settings.baseball;
  const period = SPIN_PERIOD_MS[set.speed] || SPIN_PERIOD_MS.normal;
  const mode = set.outs ? "team" : "together";
  const teams = baseballTeams(s);
  s.baseball = {
    mode,
    phase: "spin",
    period,
    window: hitWindowMs(set.width, period),
    sweetAt: firstSweetAt(now, period),
    ballFrom: now,
    hit: null,
    roll: null,
    resultAt: null,
    nextAt: null,
    bases: [null, null, null],
    outs: 0,
    inning: 1,
    half: 0,
    teams,
    batting: teams[0],
    score: { red: 0, blue: 0 },
    runs: 0,
    last: null,
    atBats: {},
    log: [],
    lastBatter: {},
    winner: null,
  };
  const first = mode === "team" ? pickBatter(s, teams[0], null) : activePlayers(s)[0];
  setTurn(s, now, first?.id ?? null);
}

function newBall(bb, now) {
  bb.phase = "spin";
  bb.hit = null;
  bb.roll = null;
  bb.last = null;
  bb.sweetAt = firstSweetAt(now, bb.period);
  bb.ballFrom = now;
  bb.resultAt = null;
  bb.nextAt = null;
}

function togetherDone(s) {
  const bb = s.baseball;
  const limit = Number(s.settings.baseball.atBats);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const active = activePlayers(s);
  if (active.length === 0) return false;
  return active.every((p) => (bb.atBats[p.id] || 0) >= limit);
}

function pressBaseball(s, action, now, rng) {
  const bb = s.baseball;
  const playerId = action.playerId;
  if (bb.phase !== "spin" || action.t < (s.turn?.since ?? 0) + TURN_GUARD_MS || action.t < bb.ballFrom) {
    pushEvent(s, now, { kind: "swing", playerId, contact: false, pid: action.pid });
    return true;
  }
  const offset = offsetFromSweet(action.t, bb.sweetAt, bb.period);
  const q = contactQuality(offset, bb.window);
  if (q === null) {
    pushEvent(s, now, { kind: "swing", playerId, contact: false, pid: action.pid, offset: Math.round(offset) });
    return true;
  }
  const roll = simulateHit(offset, bb.window, rng);
  bb.phase = "flight";
  bb.hit = { t: action.t, playerId, offset: Math.round(offset), q: roll.q, team: bb.batting };
  bb.roll = roll;
  bb.resultAt = action.t + roll.durationMs;
  bb.nextAt = bb.resultAt + RESULT_MS;
  pushEvent(s, now, { kind: "swing", playerId, contact: true, q: roll.q, pid: action.pid, offset: Math.round(offset) });
  return true;
}

/** ボールが止まった: 塁・点・アウトを反映する。 */
function applyResult(s, now) {
  const bb = s.baseball;
  const playerId = bb.hit.playerId;
  let n = bb.roll.n;
  if (bb.mode === "together" && n === OUT) n = 1;
  let scored = [];
  if (n === OUT) {
    bb.outs += 1;
  } else {
    const moved = advanceRunners(bb.bases, playerId, n);
    bb.bases = moved.bases;
    scored = moved.scored;
    if (bb.mode === "team") bb.score[bb.batting] += scored.length;
    else bb.runs += scored.length;
  }
  bb.atBats[playerId] = (bb.atBats[playerId] || 0) + 1;
  bb.log.push({ playerId, n, team: bb.batting });
  bb.lastBatter[bb.batting] = playerId;
  bb.last = { n, scored: scored.length, outs: bb.outs };
  bb.phase = "result";
  pushEvent(s, now, { kind: "result", playerId, n, runs: scored.length, outs: bb.outs, team: bb.batting, mode: bb.mode });
}

function finishBaseball(s, now) {
  const bb = s.baseball;
  bb.phase = "done";
  bb.hit = null;
  bb.roll = null;
  bb.resultAt = null;
  bb.nextAt = null;
  s.turn = null;
  if (bb.mode === "team" && bb.teams.length > 1) {
    const { red, blue } = bb.score;
    bb.winner = red === blue ? null : red > blue ? "red" : "blue";
  }
  pushEvent(s, now, { kind: "done", game: "baseball", mode: bb.mode, runs: bb.runs, score: { ...bb.score }, winner: bb.winner });
}

/** 次のボールへ（チェンジ・おわりも、ここで決める）。 */
function nextAtBat(s, now) {
  const bb = s.baseball;
  const set = s.settings.baseball;
  if (bb.mode === "together") {
    if (togetherDone(s)) return finishBaseball(s, now);
    newBall(bb, now);
    if (set.rotate === "auto") {
      // 打ち終わった人（決まった数を打った人）はとばす。
      const limit = Number(set.atBats);
      const active = activePlayers(s);
      let next = nextInOrder(active, s.turn?.playerId);
      if (Number.isFinite(limit) && limit > 0) {
        for (let i = 0; i < active.length && next && (bb.atBats[next.id] || 0) >= limit; i += 1) {
          next = nextInOrder(active, next.id);
        }
      }
      setTurn(s, now, next?.id ?? null);
    } else {
      setTurn(s, now, s.turn?.playerId ?? activePlayers(s)[0]?.id ?? null);
    }
    return;
  }
  // チームで: 3アウトでチェンジ。
  if (bb.outs >= OUTS_PER_HALF) {
    bb.outs = 0;
    bb.bases = [null, null, null];
    if (bb.teams.length > 1 && bb.half === 0) {
      bb.half = 1;
    } else {
      bb.half = 0;
      bb.inning += 1;
    }
    const innings = Math.max(1, Number(set.innings) || 2);
    if (bb.inning > innings) return finishBaseball(s, now);
    bb.batting = bb.teams[bb.half] || bb.teams[0];
    newBall(bb, now);
    pushEvent(s, now, { kind: "change", team: bb.batting, inning: bb.inning, half: bb.half });
    const batter = pickBatter(s, bb.batting, null);
    setTurn(s, now, batter?.id ?? null);
    return;
  }
  newBall(bb, now);
  const batter = set.rotate === "auto" ? pickBatter(s, bb.batting, s.turn?.playerId ?? null) : playerById(s, s.turn?.playerId);
  setTurn(s, now, batter?.id ?? pickBatter(s, bb.batting, null)?.id ?? null);
}

function tickBaseball(s, now) {
  const bb = s.baseball;
  if (bb.phase === "flight" && bb.resultAt !== null && now >= bb.resultAt) {
    applyResult(s, now);
    return true;
  }
  if (bb.phase === "result" && bb.nextAt !== null && now >= bb.nextAt) {
    nextAtBat(s, now);
    return true;
  }
  return false;
}

function onSettingsChanged(s, now) {
  if (s.game === "baseball" && s.baseball) {
    const bb = s.baseball;
    const set = s.settings.baseball;
    const period = SPIN_PERIOD_MS[set.speed] || SPIN_PERIOD_MS.normal;
    if (bb.phase === "spin" && period !== bb.period) {
      // 円盤の今の角度はそのままに、速さだけ変える（ボールが跳ばない）。
      const fraction = offsetFromSweet(now, bb.sweetAt, bb.period) / bb.period;
      bb.sweetAt = now - fraction * period;
    }
    bb.period = period;
    bb.window = hitWindowMs(set.width, period);
  }
  if (s.game === "boccia" && s.boccia) {
    const bc = s.boccia;
    const set = s.settings.boccia;
    bc.period = SWEEP_PERIOD_MS[set.speed] || SWEEP_PERIOD_MS.normal;
    bc.presses = set.presses === 1 ? 1 : 2;
    bc.guide = !!set.guide;
    if (bc.phase === "power" && bc.presses === 1) {
      bc.phase = "aim";
      bc.aimT0 = now;
      bc.angle = null;
    }
  }
}

// ---------------------------------------------------------------------
// ボッチャ
// ---------------------------------------------------------------------

function startBoccia(s, now, rng) {
  const set = s.settings.boccia;
  s.boccia = {
    phase: "aim",
    teams: [...TEAMS],
    perTeam: 3,
    left: {},
    jack: null,
    balls: [],
    current: { team: "red", ballId: null },
    period: SWEEP_PERIOD_MS[set.speed] || SWEEP_PERIOD_MS.normal,
    presses: set.presses === 1 ? 1 : 2,
    guide: !!set.guide,
    aimT0: now,
    readyAt: now,
    angle: null,
    power: null,
    roll: null,
    nextAt: null,
    score: { red: 0, blue: 0 },
    endNo: 1,
    result: null,
    lastThrower: {},
    ballCount: 0,
  };
  startEnd(s, now, rng);
}

/** 1エンド（全員が投げ終わるまで）を始める。 */
function startEnd(s, now, rng) {
  const bc = s.boccia;
  const set = s.settings.boccia;
  // 遊ぶ人が1つのチームにしかいなければ、ひとつのチームで（ひとりで あそぶ）。
  const teamsInPlay = TEAMS.filter((team) => activePlayers(s).some((p) => p.team === team));
  bc.teams = teamsInPlay.length >= 2 ? [...TEAMS] : [teamsInPlay[0] || "red"];
  const per = Math.max(1, Math.min(6, Number(set.balls) || 3));
  bc.perTeam = bc.teams.length === 1 ? per * 2 : per;
  bc.left = Object.fromEntries(bc.teams.map((team) => [team, bc.perTeam]));
  bc.jack = placeJack(rng);
  bc.balls = [];
  bc.roll = null;
  bc.result = null;
  bc.nextAt = null;
  bc.current = { team: nextTeam([], bc.jack, bc.left, bc.teams), ballId: null };
  prepareThrow(s, now);
}

function pickThrower(s, team, afterId) {
  const active = activePlayers(s);
  const inTeam = active.filter((p) => p.team === team);
  const pool = inTeam.length ? inTeam : active;
  if (pool.length === 0) return null;
  const after = afterId ?? s.boccia?.lastThrower?.[team] ?? null;
  if (!after) return pool[0];
  return nextInOrder(pool, after);
}

function prepareThrow(s, now) {
  const bc = s.boccia;
  bc.ballCount += 1;
  bc.current.ballId = `b${bc.ballCount}`;
  bc.phase = "aim";
  bc.aimT0 = now;
  bc.readyAt = now + TURN_GUARD_MS;
  bc.angle = null;
  bc.power = null;
  bc.roll = null;
  const thrower = pickThrower(s, bc.current.team, null);
  setTurn(s, now, thrower?.id ?? null);
}

function pressBoccia(s, action, now) {
  const bc = s.boccia;
  const playerId = action.playerId;
  const t = action.t;
  if ((bc.phase !== "aim" && bc.phase !== "power") || t < bc.readyAt) {
    pushEvent(s, now, { kind: "cheer", playerId });
    return true;
  }
  if (bc.phase === "aim") {
    bc.angle = Math.round(aimAt(t, bc.aimT0, bc.period) * 10) / 10;
    pushEvent(s, now, { kind: "lock", what: "aim", playerId, value: bc.angle, pid: action.pid });
    if (bc.presses === 1) {
      throwBall(s, playerId, autoPower(bc.angle, bc.jack), t, now);
      return true;
    }
    bc.phase = "power";
    bc.powerT0 = t;
    bc.readyAt = t + LOCK_GUARD_MS;
    return true;
  }
  const power = Math.round(powerAt(t, bc.powerT0, bc.period) * 1000) / 1000;
  pushEvent(s, now, { kind: "lock", what: "power", playerId, value: power, pid: action.pid });
  throwBall(s, playerId, power, t, now);
  return true;
}

function throwBall(s, playerId, power, t, now) {
  const bc = s.boccia;
  const team = bc.current.team;
  const thrown = { id: bc.current.ballId, team, playerId };
  const before = { jack: bc.jack, balls: bc.balls };
  const sim = simulateThrow(before, thrown, bc.angle, power);
  bc.power = power;
  bc.phase = "roll";
  bc.roll = {
    t0: t + RAMP_DROP_MS,
    releasedAt: t,
    angle: bc.angle,
    power,
    thrown,
    frames: sim.frames,
    fps: sim.fps,
    durationMs: sim.durationMs,
    before: clone(before),
  };
  bc.jack = sim.jack;
  bc.balls = sim.balls;
  bc.left[team] = Math.max(0, (bc.left[team] ?? 0) - 1);
  bc.lastThrower[team] = playerId;
  bc.nextAt = bc.roll.t0 + sim.durationMs + SETTLE_MS;
  pushEvent(s, now, { kind: "throw", playerId, team, hits: sim.hits, jackReset: !!sim.jack.reset });
}

function tickBoccia(s, now) {
  const bc = s.boccia;
  if (bc.phase !== "roll" || bc.nextAt === null || now < bc.nextAt) return false;
  bc.nextAt = null;
  const team = nextTeam(bc.balls, bc.jack, bc.left, bc.teams);
  if (!team) {
    bc.phase = "end";
    bc.result = scoreEnd(bc.balls, bc.jack, bc.teams);
    if (bc.result.team && bc.teams.length > 1) bc.score[bc.result.team] += bc.result.points;
    s.turn = null;
    pushEvent(s, now, { kind: "end", team: bc.result.team, points: bc.result.points, solo: bc.teams.length < 2 });
    return true;
  }
  bc.current = { team, ballId: null };
  prepareThrow(s, now);
  return true;
}

// ---------------------------------------------------------------------
// 押した・時間が来た
// ---------------------------------------------------------------------

function onPress(s, action, now, rng) {
  const playerId = action.playerId;
  if (!playerById(s, playerId)) return false;
  if (s.screen !== "game") {
    // 待っている部屋では「スイッチの ためし」。だれが押したかを、全員の画面で光らせる。
    pushEvent(s, now, { kind: "test", playerId });
    return true;
  }
  if (s.turn?.playerId !== playerId) {
    pushEvent(s, now, { kind: "cheer", playerId });
    return true;
  }
  // 押した時刻は、送られてきた時刻を使う（ゲストが見ていた画面に合わせる）。
  // ただし、未来の時刻や、古すぎる時刻は丸める。
  const t = Math.min(now, Math.max(now - 1500, Number.isFinite(action.t) ? action.t : now));
  const a = { ...action, t };
  if (s.game === "baseball" && s.baseball) {
    if (s.baseball.phase === "done") return false;
    return pressBaseball(s, a, now, rng);
  }
  if (s.game === "boccia" && s.boccia) return pressBoccia(s, a, now);
  return false;
}

function onTick(s, now, rng) {
  if (s.screen !== "game") return false;
  if (s.game === "baseball" && s.baseball) return tickBaseball(s, now);
  if (s.game === "boccia" && s.boccia) return tickBoccia(s, now);
  return false;
}

/** 次に tick が要る時刻（無ければ null）。 */
export function nextWake(state) {
  if (state.screen !== "game") return null;
  if (state.game === "baseball") {
    const bb = state.baseball;
    if (bb?.phase === "flight") return bb.resultAt;
    if (bb?.phase === "result") return bb.nextAt;
    return null;
  }
  if (state.game === "boccia") return state.boccia?.nextAt ?? null;
  return null;
}

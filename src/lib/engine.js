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
  FLIGHT_MS,
  RUN_MS,
  SPIN_PERIOD_MS,
  advanceRunners,
  firstSweetAt,
  hitWindowMs,
  judgeSwing,
  offsetFromSweet,
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

/** 人ごとの色（はっきり分かれる8色）。ボッチャのチームの色（赤・青）とは別。 */
export const PLAYER_COLORS = ["#F2B705", "#2E9E44", "#8E44AD", "#F07D1A", "#14A3A3", "#D6458B", "#5B6BD6", "#8C5A2B"];

export const DEFAULT_SETTINGS = Object.freeze({
  baseball: Object.freeze({ speed: "normal", width: "wide", atBats: 3, rotate: "auto", cue: true }),
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
      if (existing) {
        existing.connected = true;
        if (incoming.name) existing.name = incoming.name;
        if (incoming.role) existing.role = incoming.role;
      } else {
        const used = new Set(s.players.map((p) => p.color));
        const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[s.players.length % PLAYER_COLORS.length];
        // ボッチャのチームは、来た順に 赤・青・赤・青……（あとでホストが変えられる）。
        const playing = s.players.filter((p) => p.role === "play").length;
        s.players.push({
          id: incoming.id,
          name: (incoming.name || "").slice(0, 12) || `${s.players.length + 1}ばん`,
          color,
          role: incoming.role === "watch" ? "watch" : "play",
          team: TEAMS[playing % 2],
          connected: true,
          host: !!incoming.host,
        });
      }
      pushEvent(s, now, { kind: "join", playerId: incoming.id });
      // 遊んでいる途中で、だれの番でもなければ、この人の番にする。
      if (s.screen === "game" && !s.turn) startTurnFor(s, now, rng);
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
      player.role = action.role;
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
    const next = nextInOrder(activePlayers(s), s.turn?.playerId);
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
    const first = activePlayers(s)[0];
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
// ---------------------------------------------------------------------

function startBaseball(s, now) {
  const set = s.settings.baseball;
  const period = SPIN_PERIOD_MS[set.speed] || SPIN_PERIOD_MS.normal;
  s.baseball = {
    phase: "spin",
    period,
    window: hitWindowMs(set.width, period),
    sweetAt: firstSweetAt(now, period),
    ballFrom: now,
    hit: null,
    bases: [null, null, null],
    prevBases: [null, null, null],
    scored: [],
    runs: 0,
    nextAt: null,
    atBats: {},
    log: [],
  };
  const first = activePlayers(s)[0];
  setTurn(s, now, first?.id ?? null);
}

function newBall(bb, now) {
  bb.phase = "spin";
  bb.hit = null;
  bb.sweetAt = firstSweetAt(now, bb.period);
  bb.ballFrom = now;
  bb.nextAt = null;
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

function baseballDone(s) {
  const bb = s.baseball;
  const limit = Number(s.settings.baseball.atBats);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const active = activePlayers(s);
  if (active.length === 0) return false;
  return active.every((p) => (bb.atBats[p.id] || 0) >= limit);
}

function pressBaseball(s, action, now) {
  const bb = s.baseball;
  const playerId = action.playerId;
  if (bb.phase !== "spin" || action.t < (s.turn?.since ?? 0) + TURN_GUARD_MS || action.t < bb.ballFrom) {
    pushEvent(s, now, { kind: "swing", playerId, n: 0, pid: action.pid });
    return true;
  }
  const offset = offsetFromSweet(action.t, bb.sweetAt, bb.period);
  const n = judgeSwing(offset, bb.window);
  if (n === 0) {
    pushEvent(s, now, { kind: "swing", playerId, n: 0, pid: action.pid, offset: Math.round(offset) });
    return true;
  }
  const { bases, scored } = advanceRunners(bb.bases, playerId, n);
  bb.prevBases = bb.bases;
  bb.bases = bases;
  bb.scored = scored;
  bb.runs += scored.length;
  bb.phase = "flight";
  bb.hit = { t: action.t, n, playerId, offset: Math.round(offset) };
  bb.atBats[playerId] = (bb.atBats[playerId] || 0) + 1;
  bb.log.push({ playerId, n });
  bb.nextAt = action.t + FLIGHT_MS + RUN_MS;
  pushEvent(s, now, { kind: "swing", playerId, n, pid: action.pid, offset: Math.round(offset), runs: scored.length });
  return true;
}

function tickBaseball(s, now, rng) {
  const bb = s.baseball;
  if (bb.phase !== "flight" || bb.nextAt === null || now < bb.nextAt) return false;
  bb.prevBases = bb.bases;
  bb.scored = [];
  if (baseballDone(s)) {
    bb.phase = "done";
    bb.hit = null;
    bb.nextAt = null;
    s.turn = null;
    pushEvent(s, now, { kind: "done", game: "baseball", runs: bb.runs });
    return true;
  }
  newBall(bb, now);
  if (s.settings.baseball.rotate === "auto") {
    // 打ち終わった人（決まった数を打った人）はとばす。
    const limit = Number(s.settings.baseball.atBats);
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
  return true;
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
    return pressBaseball(s, a, now);
  }
  if (s.game === "boccia" && s.boccia) return pressBoccia(s, a, now);
  return false;
}

function onTick(s, now, rng) {
  if (s.screen !== "game") return false;
  if (s.game === "baseball" && s.baseball) return tickBaseball(s, now, rng);
  if (s.game === "boccia" && s.boccia) return tickBoccia(s, now);
  return false;
}

/** 次に tick が要る時刻（無ければ null）。 */
export function nextWake(state) {
  if (state.screen !== "game") return null;
  if (state.game === "baseball") return state.baseball?.nextAt ?? null;
  if (state.game === "boccia") return state.boccia?.nextAt ?? null;
  return null;
}

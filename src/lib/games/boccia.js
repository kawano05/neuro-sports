// =====================================================================
// games/boccia.js — ボッチャの決まり（画面にも通信にも依存しない純粋関数）
//
// 参考資料（ケアの方舟の「プロトタイプ３版」）は、回転台に乗せたランプ（すべり台）を
// スイッチで「向きを変える」「ボールを放す」の2つで動かしていた。これを画面に移す:
//
//   1回目に押す … むき。ランプが左右に ゆっくり首を振っている。押したところで止まる。
//   2回目に押す … つよさ。ボールがランプを上り下りしている。高いところで放すほど遠くへ。
//                ランプの横の目盛り（1〜5）で、どのくらい転がるかが見える。
//
// 支援者の設定で「むきだけ（1回押し）」にもできる。そのときの強さは、
// ジャックボール（白い的の玉）のところまで届く強さに決まる。
//
// 時刻はすべて「ホストの時計」（ミリ秒）。転がりはホストだけが計算し、
// 結果（コマごとの位置）を全員へ配る。どの画面でも同じに転がる。
// =====================================================================

/** コート（センチではなく、画面の単位）。y が小さいほど奥。 */
export const COURT = { w: 600, h: 900 };
/** 玉の半径（見やすさを優先して、本物より大きい）。 */
export const BALL_R = 24;
export const JACK_R = 18;
/** 回転台の中心と、ランプの出口までの長さ。 */
export const TURNTABLE = { x: 300, y: 1035 };
export const RAMP_EXIT = 150;
/** ランプの上で、ボールが動ける長さ（出口から奥へ）。 */
export const RAMP_TRAVEL = { from: 40, to: 250 };
/** 首振りの片側の角度（度）。 */
export const AIM_MAX_DEG = 28;
/** 転がる距離の範囲（つよさ 0 → 1）。 */
export const ROLL_DISTANCE = { min: 200, max: 960 };
/** 転がりのブレーキ（単位/秒²）。 */
export const ROLL_DECEL = 320;

/** 首振り・上り下りの1往復の時間（ミリ秒）。支援者が選ぶ。 */
export const SWEEP_PERIOD_MS = { slow: 6400, normal: 4600, fast: 3300 };

export const TEAMS = ["red", "blue"];

/**
 * 0→1→0 と行き来する三角の波。速さが一定なので、いつ来るかが読みやすい
 * （サインの波だと、端でゆっくりになって、真ん中で速くなる）。
 * @returns {number} 0〜1
 */
export function triangle(t, t0, period) {
  const phase = ((((t - t0) / period) % 1) + 1) % 1;
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

/** 時刻 t のランプの向き（度）。t0 で真ん中から右へ振り始める。 */
export function aimAt(t, t0, period) {
  // 真ん中（0.5）から始める。
  const k = triangle(t + period / 4, t0, period);
  return (k * 2 - 1) * AIM_MAX_DEG;
}

/** 時刻 t のつよさ（0〜1）。t0 で一番下（弱い）から上り始める。 */
export function powerAt(t, t0, period) {
  return triangle(t, t0, period);
}

/** 向き（度）から、ランプの出口の位置と進む向き。 */
export function rampExit(angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const dir = { x: Math.sin(a), y: -Math.cos(a) };
  return {
    x: TURNTABLE.x + dir.x * RAMP_EXIT,
    y: TURNTABLE.y + dir.y * RAMP_EXIT,
    dir,
  };
}

/** つよさ（0〜1）から、ブレーキだけで止まるまでに転がる距離。 */
export function rollDistance(power) {
  const p = Math.min(1, Math.max(0, power));
  return ROLL_DISTANCE.min + p * (ROLL_DISTANCE.max - ROLL_DISTANCE.min);
}

/** 「むきだけ」のときの つよさ。出口からジャックまでの距離ぶん転がる。 */
export function autoPower(angleDeg, jack) {
  const exit = rampExit(angleDeg);
  const d = Math.hypot(jack.x - exit.x, jack.y - exit.y) - BALL_R - JACK_R;
  const p = (d - ROLL_DISTANCE.min) / (ROLL_DISTANCE.max - ROLL_DISTANCE.min);
  return Math.min(1, Math.max(0, p));
}

/** ぶつからなかったときに止まるところ（とどく ところの線に使う）。 */
export function restingPoint(angleDeg, power) {
  const exit = rampExit(angleDeg);
  const d = rollDistance(power);
  return { x: exit.x + exit.dir.x * d, y: exit.y + exit.dir.y * d };
}

/** コートの中か（玉の中心で見る）。 */
export function onCourt(x, y) {
  return x >= 0 && x <= COURT.w && y >= 0 && y <= COURT.h + BALL_R;
}

/**
 * 投げた玉を転がす。コートの上の玉とぶつかったら はじく（同じ重さ、少し弾む）。
 * コートの外に出た玉は「アウト」（out: true）。ジャックが出たら、まんなかの × に戻す。
 *
 * 画面ごとに計算すると、端末のちがいで結果がずれうる。ホストだけが計算して、
 * コマ（1/30 秒ごと、動いている玉だけ）と、止まったあとの位置を配る。
 *
 * @param {{jack: {x:number,y:number,out?:boolean}, balls: Array<{id:string,team:string,x:number,y:number,out?:boolean}>}} court
 * @param {{id:string, team:string, playerId?:string}} thrown 投げる玉
 * @param {number} angleDeg
 * @param {number} power 0〜1
 * @returns {{frames: Array<Record<string,[number,number]>>, fps: number, durationMs: number,
 *   jack: {x:number,y:number,out?:boolean}, balls: Array<object>, hits: number}}
 */
export function simulateThrow(court, thrown, angleDeg, power) {
  const exit = rampExit(angleDeg);
  const speed = Math.sqrt(2 * ROLL_DECEL * rollDistance(power));
  const bodies = [
    { id: "jack", r: JACK_R, x: court.jack.x, y: court.jack.y, vx: 0, vy: 0, out: !!court.jack.out },
    ...court.balls.map((b) => ({ ...b, r: BALL_R, vx: 0, vy: 0, out: !!b.out })),
    { ...thrown, r: BALL_R, x: exit.x, y: exit.y, vx: exit.dir.x * speed, vy: exit.dir.y * speed, out: false },
  ];
  const DT = 1 / 240;
  const FPS = 30;
  const STEPS_PER_FRAME = 240 / FPS;
  const frames = [];
  let hits = 0;
  let step = 0;
  const MAX_STEPS = 240 * 12;
  const moving = () => bodies.some((b) => !b.out && (b.vx !== 0 || b.vy !== 0));

  while (step < MAX_STEPS && moving()) {
    // 進める（一定のブレーキ）。
    for (const b of bodies) {
      if (b.out || (b.vx === 0 && b.vy === 0)) continue;
      const v = Math.hypot(b.vx, b.vy);
      const nv = Math.max(0, v - ROLL_DECEL * DT);
      if (nv === 0) {
        b.vx = 0;
        b.vy = 0;
        continue;
      }
      b.vx *= nv / v;
      b.vy *= nv / v;
      b.x += b.vx * DT;
      b.y += b.vy * DT;
    }
    // ぶつかり（同じ重さ。はね返りの係数 0.86）。
    for (let i = 0; i < bodies.length; i += 1) {
      const a = bodies[i];
      if (a.out) continue;
      for (let j = i + 1; j < bodies.length; j += 1) {
        const b = bodies[j];
        if (b.out) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r;
        if (dist >= minDist || dist === 0) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        // 重なりを半分ずつ戻す。
        const overlap = (minDist - dist) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (rel <= 0) continue;
        const impulse = ((1 + 0.86) / 2) * rel;
        a.vx -= impulse * nx;
        a.vy -= impulse * ny;
        b.vx += impulse * nx;
        b.vy += impulse * ny;
        hits += 1;
      }
    }
    // コートの外に出たか。
    for (const b of bodies) {
      if (b.out) continue;
      if (!onCourt(b.x, b.y)) {
        b.out = true;
        b.vx = 0;
        b.vy = 0;
      }
    }
    step += 1;
    if (step % STEPS_PER_FRAME === 0) {
      const frame = {};
      for (const b of bodies) {
        if (b.vx !== 0 || b.vy !== 0 || (b.out && !b.outFramed)) {
          frame[b.id] = [Math.round(b.x), Math.round(b.y)];
          if (b.out) b.outFramed = true;
        }
      }
      frames.push(frame);
    }
  }

  const jackBody = bodies[0];
  const jack = jackBody.out
    ? { x: COURT.w / 2, y: COURT.h / 2, out: false, reset: true }
    : { x: round1(jackBody.x), y: round1(jackBody.y), out: false };
  const balls = bodies.slice(1).map(({ id, team, playerId, x, y, out }) => ({
    id,
    team,
    ...(playerId ? { playerId } : {}),
    x: round1(x),
    y: round1(y),
    out,
  }));
  return { frames, fps: FPS, durationMs: Math.round((frames.length / FPS) * 1000), jack, balls, hits };
}

const round1 = (v) => Math.round(v * 10) / 10;

/** 玉とジャックの距離（中心どうし）。 */
export function distanceToJack(ball, jack) {
  return Math.hypot(ball.x - jack.x, ball.y - jack.y);
}

/**
 * 点数。ジャックにいちばん近い玉のチームが、相手のいちばん近い玉より近い玉の数だけ点を取る。
 * チームが1つ（ひとりで）のときは、点ではなく「いちばん近い玉」だけを返す。
 * @returns {{team: string|null, points: number, closest: Array<{id:string, team:string, d:number}>}}
 */
export function scoreEnd(balls, jack, teams = TEAMS) {
  const inPlay = balls
    .filter((b) => !b.out)
    .map((b) => ({ id: b.id, team: b.team, d: distanceToJack(b, jack) }))
    .sort((a, b) => a.d - b.d);
  if (inPlay.length === 0) return { team: null, points: 0, closest: [] };
  const winner = inPlay[0].team;
  if (teams.length < 2) return { team: winner, points: 0, closest: [inPlay[0]] };
  const rivalBest = inPlay.find((b) => b.team !== winner);
  const limit = rivalBest ? rivalBest.d : Infinity;
  // 同じ距離（同点）は、点にしない。
  const closest = inPlay.filter((b) => b.team === winner && b.d < limit);
  return { team: winner, points: closest.length, closest };
}

/**
 * 次に投げるチーム。本物のボッチャと同じく、ジャックから遠いほう（負けているほう）が投げる。
 * 残りが無いチームはとばす。はじめの2球は 赤 → 青 の順。
 * @param {Array<{team:string,out?:boolean,x:number,y:number}>} balls 投げた玉
 * @param {{x:number,y:number}} jack
 * @param {Record<string, number>} left 残りの玉の数
 * @param {string[]} teams
 * @returns {string|null} 投げ終わっていたら null
 */
export function nextTeam(balls, jack, left, teams = TEAMS) {
  const can = teams.filter((team) => (left[team] ?? 0) > 0);
  if (can.length === 0) return null;
  if (can.length === 1) return can[0];
  // まだ1球も投げていないチームがあれば、そのチーム（赤が先）。
  const notYet = teams.find((team) => !balls.some((b) => b.team === team));
  if (notYet && can.includes(notYet)) return notYet;
  const best = {};
  for (const team of teams) {
    const ds = balls.filter((b) => b.team === team && !b.out).map((b) => distanceToJack(b, jack));
    best[team] = ds.length ? Math.min(...ds) : Infinity;
  }
  // いちばん遠い（負けている）チーム。同じなら、最後に投げたのではないほう。
  const sorted = [...can].sort((a, b) => best[b] - best[a]);
  if (best[sorted[0]] === best[sorted[1]]) {
    const last = balls[balls.length - 1]?.team;
    return can.find((team) => team !== last) ?? sorted[0];
  }
  return sorted[0];
}

/**
 * ジャックの置き場所。毎回少しずつ変える（rng は 0〜1 を返す関数）。
 * 真ん中の帯に置いて、遠すぎず近すぎないようにする。
 */
export function placeJack(rng = Math.random) {
  return {
    x: round1(160 + rng() * 280),
    y: round1(240 + rng() * 340),
    out: false,
  };
}

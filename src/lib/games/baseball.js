// =====================================================================
// games/baseball.js — 野球の決まり（画面にも通信にも依存しない純粋関数）
//
// 本塁の上で円盤（回転台）が回っている。円盤のふちにボールが乗っていて、1周ごとに
// バットの前（「あたる ところ」）を通る。スイッチを押すとバットを振る。
// ボールが「あたる ところ」にあれば当たり、盤の上を転がっていく。
// 結果は、ボールが止まったところで決まる（ユニバーサル野球の決まりに合わせた。2026-11-25 に調べた）:
//   - 外野のフェンス（奥の壁）は区画に分かれていて、ヒットの区画のあいだにアウトの区画がある。
//     真ん中がホームラン、外へ スリーベース・アウト・ツーベース・アウト・ヒット。
//   - 盤の上の穴は、野手のいる位置（一塁・二塁・遊撃・三塁・左・中・右）。ゆっくり来たボールは落ちて、アウト。
//   - どこにも入らずに止まったら、アウト（内野でも外野でも）。
//   - フェンスは、センターが遠く、線ぞいが近い（本物の球場の形）。弱い当たりでも、線ぞいならヒットになりうる。
// 押したタイミングで、打つ向きと強さが決まる。真ん中で打つほど、まっすぐ強く飛ぶ。
// 早く振ると左へ、遅く振ると右へ。向きと強さには、本物の盤のようなばらつきがある
// （ねらい通りにはいかない。以前はばらつきが小さく、上手な人は毎回ホームランで、3アウトにならなかった）。
//
// ※ 仕組みは、本塁の回転台とスイッチで打つ野球盤（ユニバーサル野球）を参考にした。
//   名前・ロゴ・盤の絵や色・穴の並びは使っていない（独自の盤）。
//
// 空振り（あたる ところの外）は数えない。円盤が回っているので、ボールはまた来る。
// 判定の時刻は、押した瞬間の時刻（入力の入口で取った時刻）。描画のコマには頼らない。
// 時刻はすべて「ホストの時計」（ミリ秒）。ゲストは時計のずれを測って合わせる（net.js）。
// =====================================================================

/**
 * 円盤が1周する時間（ミリ秒）。支援者が選ぶ。
 * 本物は1周2〜15秒で変えられる。いちばん遅いのは12秒。
 */
export const SPIN_PERIOD_MS = { slowest: 12000, slower: 8000, slow: 4400, normal: 3400, fast: 2500 };

/**
 * 当たる広さ（あたる ところの、真ん中から前後の時間、ミリ秒）。
 * always は円盤のどこにあっても当たる（半周 = 前後いっぱい）。
 */
export const HIT_WIDTH_MS = { narrow: 220, normal: 380, wide: 600, always: Infinity };

/** 結果。0 はアウト、1〜4 は何塁打か。 */
export const OUT = 0;

/** 止まってから、結果を見せておく時間（カメラが引いたまま。そのあと寄り直す）。 */
export const RESULT_MS = 1900;
/** 交代して、次のボールが「あたる ところ」に初めて来るまでの、いちばん短い時間。 */
export const FIRST_PASS_LEAD_MS = 2600;
/** 1回の攻撃のアウトの数。 */
export const OUTS_PER_HALF = 3;

// ---------------------------------------------------------------------
// 盤（画面の単位。本塁が 500,1000、上が外野。センターのフェンスまで 600、線ぞいは 470）
// ---------------------------------------------------------------------

export const HOME = { x: 500, y: 1000 };
export const FENCE_R = 600;
export const LINE_R = 470;
/** 内野の土の広さ（絵だけ。止まったらどこでもアウト）。 */
export const INFIELD_R = 255;
/** 打った瞬間のボールの位置（円盤のふち、バットの前）。 */
export const LAUNCH = { x: 500, y: 968 };
export const BALL_R = 8;
/** ころがりのブレーキ（単位/秒²）。 */
const DECEL = 260;
/** これより遅いボールは、穴に落ちる（速いボールは穴を飛びこえる）。 */
const CAPTURE_SPEED = 330;
/** 打つ向きの広さ（真ん中から左右の角度）。 */
const SPRAY_MAX = 40;
/** 向きのばらつき（度）と、強さのばらつき（割合）。どちらも正規分布の標準偏差。 */
const SPRAY_SPREAD = 10;
const STRENGTH_SPREAD = 0.15;

/** 本塁から見た角度 spray（センターが 0、左が負）での、フェンスまでの距離。 */
export function fenceR(spray) {
  const s = Math.min(45, Math.abs(spray));
  return LINE_R + (FENCE_R - LINE_R) * Math.cos((s * 2 * Math.PI) / 180);
}

/**
 * フェンスの区画。spray は真ん中（センター）からの角度（左が負）。
 * 真ん中ほど長打。区画の境目は独自。
 */
export const WALL = [
  { from: -45, to: -33, n: 1 },
  { from: -33, to: -26, n: OUT },
  { from: -26, to: -18, n: 2 },
  { from: -18, to: -12, n: OUT },
  { from: -12, to: -5, n: 3 },
  { from: -5, to: 5, n: 4 },
  { from: 5, to: 12, n: 3 },
  { from: 12, to: 18, n: OUT },
  { from: 18, to: 26, n: 2 },
  { from: 26, to: 33, n: OUT },
  { from: 33, to: 45, n: 1 },
];

const polar = (r, spray) => {
  const a = ((-90 + spray) * Math.PI) / 180;
  return { x: HOME.x + r * Math.cos(a), y: HOME.y + r * Math.sin(a) };
};

/** 盤の穴（野手のいる位置。どれもアウト）。id・場所・半径・守る位置の名前。 */
export const POCKETS = [
  { id: "3b", ...polar(175, -38), r: 26, n: OUT, pos: "サード" },
  { id: "ss", ...polar(235, -15), r: 26, n: OUT, pos: "ショート" },
  { id: "2b", ...polar(235, 15), r: 26, n: OUT, pos: "セカンド" },
  { id: "1b", ...polar(175, 38), r: 26, n: OUT, pos: "ファースト" },
  { id: "lf", ...polar(430, -28), r: 26, n: OUT, pos: "レフト" },
  { id: "cf", ...polar(470, 0), r: 26, n: OUT, pos: "センター" },
  { id: "rf", ...polar(430, 28), r: 26, n: OUT, pos: "ライト" },
];

/** 0〜1 の乱数から、平均 0・標準偏差 1 のばらつき（ボックス＝ミュラー法）。 */
function gaussFrom(rng) {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 実際に使う当たる広さ。半周より広くはしない（隣の周回と重ならない）。
 * @param {string} width HIT_WIDTH_MS のキー
 * @param {number} period 円盤の1周（ms）
 */
export function hitWindowMs(width, period) {
  const w = HIT_WIDTH_MS[width] ?? HIT_WIDTH_MS.normal;
  return Math.min(w, period / 2);
}

/**
 * 時刻 t に、ボールが「あたる ところ」の真ん中からどれだけずれているか（ms）。
 * 早い（まだ来ていない）と負、遅い（通り過ぎた）と正。範囲は (−period/2, period/2]。
 */
export function offsetFromSweet(t, sweetAt, period) {
  const phase = (((t - sweetAt) % period) + period) % period;
  return phase > period / 2 ? phase - period : phase;
}

/**
 * 当たりのよさ（0〜1）。真ん中が 1、あたる ところの端が 0。外れ（空振り）は null。
 */
export function contactQuality(offsetMs, windowMs) {
  const miss = Math.abs(offsetMs);
  if (!(miss <= windowMs)) return null;
  return 1 - miss / windowMs;
}

/** フェンスに当たった角度から、区画の結果。 */
export function wallResult(spray) {
  const s = Math.max(-45, Math.min(45, spray));
  return (WALL.find((w) => s >= w.from && s <= w.to) || WALL[0]).n;
}

/**
 * 打ったボールを転がす（ホストだけが計算して、コマと結果を配る）。
 * @param {number} offset 押した時刻のずれ（ms）
 * @param {number} window 当たる広さ（ms）
 * @param {() => number} rng 0〜1
 * @returns {{frames: Array<[number,number]>, fps: number, durationMs: number, n: number,
 *   stop: {x:number,y:number}, where: {kind: "wall"|"pocket"|"stop", id?: string}, q: number, spray: number}}
 */
export function simulateHit(offset, window, rng = Math.random) {
  const q = Math.max(0, Math.min(1, 1 - Math.abs(offset) / window));
  const side = Math.max(-1, Math.min(1, offset / window));
  const spray = side * SPRAY_MAX + gaussFrom(rng) * SPRAY_SPREAD;
  const reach = Math.max(60, (330 + 470 * q) * (1 + gaussFrom(rng) * STRENGTH_SPREAD));
  let v = Math.sqrt(2 * DECEL * reach);
  const a = ((-90 + spray) * Math.PI) / 180;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  let x = LAUNCH.x;
  let y = LAUNCH.y;
  const DT = 1 / 120;
  const FPS = 30;
  const frames = [[Math.round(x), Math.round(y)]];
  let step = 0;
  let where = null;
  let n = null;
  while (step < 120 * 8) {
    v = Math.max(0, v - DECEL * DT);
    x += dir.x * v * DT;
    y += dir.y * v * DT;
    step += 1;
    const fromHome = Math.hypot(x - HOME.x, y - HOME.y);
    const sNow = (Math.atan2(x - HOME.x, HOME.y - y) * 180) / Math.PI;
    const wallAt = fenceR(sNow) - BALL_R;
    if (fromHome >= wallAt) {
      // フェンスに着いた。区画で決まる（アウトの区画もある）。
      const k = wallAt / fromHome;
      x = HOME.x + (x - HOME.x) * k;
      y = HOME.y + (y - HOME.y) * k;
      where = { kind: "wall" };
      n = wallResult(sNow);
    } else if (v < CAPTURE_SPEED) {
      const pocket = POCKETS.find((p) => Math.hypot(x - p.x, y - p.y) < p.r);
      if (pocket) {
        x = pocket.x;
        y = pocket.y;
        where = { kind: "pocket", id: pocket.id };
        n = pocket.n;
      }
    }
    if (!where && v === 0) {
      // どこにも入らずに止まった: アウト。
      where = { kind: "stop" };
      n = OUT;
    }
    if (step % (120 / FPS) === 0 || where) frames.push([Math.round(x), Math.round(y)]);
    if (where) break;
  }
  if (!where) {
    where = { kind: "stop" };
    n = OUT;
  }
  return {
    frames,
    fps: FPS,
    durationMs: Math.round(((frames.length - 1) / FPS) * 1000),
    n,
    stop: { x: Math.round(x), y: Math.round(y) },
    where,
    q: Math.round(q * 100) / 100,
    spray: Math.round(spray * 10) / 10,
  };
}

/**
 * ランナーを進める。打った人も含め、全員が n 個ぶん進む（押し出しのような
 * 細かい決まりは使わない。分かりやすさを優先）。
 * @param {Array<string|null>} bases [一塁, 二塁, 三塁] にいる人の id
 * @param {string} batterId 打った人
 * @param {number} n 何塁打か（1〜4）
 * @returns {{bases: Array<string|null>, scored: string[]}}
 */
export function advanceRunners(bases, batterId, n) {
  const next = [null, null, null];
  const scored = [];
  const runners = [];
  bases.forEach((id, index) => {
    if (id) runners.push({ id, at: index + 1 });
  });
  runners.push({ id: batterId, at: 0 });
  // 先の塁にいる人から順に進める（後ろの人が前の人を追い越さない）。
  runners
    .sort((a, b) => b.at - a.at)
    .forEach(({ id, at }) => {
      const to = at + n;
      if (to >= 4) scored.push(id);
      else next[to - 1] = id;
    });
  return { bases: next, scored };
}

/**
 * 円盤の上のボールの角度（ラジアン）。0 が「あたる ところ」の真ん中で、
 * 時計回り（画面で）に進む。描画用。
 */
export function ballAngle(t, sweetAt, period) {
  return (offsetFromSweet(t, sweetAt, period) / period) * Math.PI * 2;
}

/**
 * 交代したときの、最初に真ん中を通る時刻。ボールは円盤の向こう側から来る。
 */
export function firstSweetAt(now, period) {
  // 少なくとも FIRST_PASS_LEAD_MS、かつ 3/4 周ぶんは見せてから来る（遅い円盤でも 4.5 秒まで）。
  return now + Math.max(FIRST_PASS_LEAD_MS, Math.min(period * 0.75, 4500));
}

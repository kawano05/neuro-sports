// =====================================================================
// games/baseball.js — 野球の決まり（画面にも通信にも依存しない純粋関数）
//
// 本塁の上で円盤（回転台）が回っている。円盤のふちにボールが乗っていて、1周ごとに
// バットの前（「あたる ところ」）を通る。スイッチを押すとバットを振る。
// ボールが「あたる ところ」にあれば当たり、ボールは飛んで、落ちて、はねて、盤の上を転がっていく。
// 結果は、ボールが止まったところで決まる（ユニバーサル野球の決まりに合わせた。2026-11-25 に調べた）:
//   - 外野のフェンス（奥の壁）は区画に分かれていて、ヒットの区画のあいだにアウトの区画がある。
//     真ん中がホームラン、外へ スリーベース・アウト・ツーベース・アウト・ヒット。
//   - 盤の上の穴は、野手のいる位置（一塁・二塁・遊撃・三塁・左・中・右）。ゆっくり来たボールは落ちて、アウト。
//   - どこにも入らずに止まったら、内野ならアウト（ゴロ）、外野ならヒット（野手のあいだに落ちた）。
//     （ユニバーサル野球では外野でもアウト。こちらは、見える所（穴・アウトの区画）でだけアウトになるよう変えた。
//      2026-11-25 の打ち合わせ: 帯のうすい色で打つと約半分がアウトで、その多くが「外野でただ止まる」だった）
//   - フェンスは、センターが遠く、線ぞいが近い（本物の球場の形）。弱い当たりでも、線ぞいならヒットになりうる。
// 押したタイミングで、打つ向きと強さが決まる。真ん中で打つほど、まっすぐ強く、高く飛ぶ。
// 早く振ると左へ、遅く振ると右へ。向きと強さには、本物の盤のようなばらつきがある
// （ねらい通りにはいかない。以前はばらつきが小さく、上手な人は毎回ホームランで、3アウトにならなかった）。
// 強さは「その向きのフェンスまでの道のり」に合わせる。線ぞい（ヒットの区画）にも、ちゃんと届く
// （以前は端の当たりほど弱く、線ぞいのヒットの区画には ほとんど届かなかった）。
//
// 飛んでいる間（と、はねている間）は、穴に落ちない（内野の穴を飛びこえる）。
// 落ちる前にホームランの区画に届いたら、フェンスをこえてスタンドに入る。
// ほかの区画に空中で届いたら（はねている時も）、フェンスに当たって下に落ちる（結果は区画のとおり）。
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
export const SPIN_PERIOD_MS = { slowest: 12000, slower: 8000, slow: 6000, normal: 4600, fast: 3400 };

/**
 * 当たる広さ（あたる ところの、真ん中から前後の時間、ミリ秒）。
 * always は円盤のどこにあっても当たる（半周 = 前後いっぱい）。
 * 2026-11-25 に広げた（ひろい ±0.6 → ±0.9秒）。円盤もゆっくりにしたので、帯の角度は ふつうの速さで ±64° → ±70°。
 */
export const HIT_WIDTH_MS = { narrow: 300, normal: 550, wide: 900, always: Infinity };

/** 結果。0 はアウト、1〜4 は何塁打か。 */
export const OUT = 0;

/**
 * 押してから、ボールが飛び出すまで（バットが当たる形になるまで 0.09 秒 ＋ 手ごたえの「止め」0.07 秒）。
 * 当たった瞬間に、ほんの少しだけ止める（ヒットストップ。neuro のごほうびの決まり: 60〜90ms）。
 */
export const CONTACT_MS = 90;
export const HIT_STOP_MS = 70;
export const LAUNCH_DELAY_MS = CONTACT_MS + HIT_STOP_MS;

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
/** 内野の土の広さ。ここより内で止まったらアウト、外で止まったらヒット。 */
export const INFIELD_R = 255;
/** 打った瞬間のボールの位置（円盤のふち、バットの前）。 */
export const LAUNCH = { x: 500, y: 968 };
export const BALL_R = 8;
/** ころがりのブレーキ（単位/秒²）。 */
const DECEL = 260;
/** これより遅いボールは、穴に落ちる（速いボールは穴を飛びこえる）。 */
const CAPTURE_SPEED = 330;
/** 打つ向きの広さ（真ん中から左右の角度）。 */
const SPRAY_MAX = 42;
/** 向きのばらつき（度）と、強さのばらつき（割合）。どちらも正規分布の標準偏差。 */
const SPRAY_SPREAD = 10;
const STRENGTH_SPREAD = 0.15;
/**
 * 強さ（転がって止まるまでの道のり）は、その向きのフェンスまでの道のりの何倍か。
 * 当たりのよさ q（0〜1）で、BASE から BASE+Q まで。端の当たりでも、フェンスに届くことが多い。
 */
const STRENGTH_BASE = 1.05;
const STRENGTH_Q = 0.15;
/** 空を飛ぶ道のり（強さに対する割合）。よい当たりほど遠くまで飛ぶ。 */
const CARRY_BASE = 0.3;
const CARRY_Q = 0.5;
/** 飛ぶ高さ（飛ぶ道のりに対する割合）。よい当たりは高いフライ、端の当たりは低いライナー。 */
const LOFT_BASE = 0.12;
const LOFT_Q = 0.22;
/** 落ちたあとに はねる（飛ぶ道のり・高さに対する割合）。 */
const BOUNCES = [
  { len: 0.22, h: 0.18 },
  { len: 0.08, h: 0.05 },
];
/** これより高ければ「空中」（フェンスをこえる・フェンスに当たって落ちる）。 */
const AIR_MIN = 4;
/** スタンドに入ったボールが落ちる、いちばん遠いところ（フェンスの外へ）。 */
const OVER_MAX = 150;

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

/** 本塁の前（LAUNCH）から角度 spray へまっすぐ行ったとき、フェンスまでの道のり。 */
/** どこにも入らずに止まったときの結果。内野ならアウト、外野ならヒット。 */
export function stopResult(x, y) {
  return Math.hypot(x - HOME.x, y - HOME.y) < INFIELD_R ? OUT : 1;
}

export function fenceDistance(spray) {
  const r = fenceR(spray) - BALL_R;
  const back = HOME.y - LAUNCH.y;
  const a = (spray * Math.PI) / 180;
  return -back * Math.cos(a) + Math.sqrt(Math.max(0, r * r - back * back * Math.sin(a) ** 2));
}

/** 進んだ道のり d での高さ（飛ぶ山と、はねる小さな山）。 */
function heightAt(d, arcs) {
  for (const arc of arcs) {
    if (d > arc.from && d < arc.to) {
      const k = (d - arc.from) / (arc.to - arc.from);
      return 4 * arc.h * k * (1 - k);
    }
  }
  return 0;
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
 * 打ったボールを飛ばして転がす（ホストだけが計算して、コマと結果を配る）。
 * コマは [x, y, 高さ]。x, y は地面の上の位置（影の位置）、高さは盤の単位。
 * コマの 0 番目は、押してから LAUNCH_DELAY_MS 後（ボールが飛び出す時）。
 * @param {number} offset 押した時刻のずれ（ms）
 * @param {number} window 当たる広さ（ms）
 * @param {() => number} rng 0〜1
 * @returns {{frames: Array<[number,number,number]>, fps: number, durationMs: number, landMs: number|null, n: number,
 *   stop: {x:number,y:number}, where: {kind: "wall"|"over"|"pocket"|"stop", id?: string, air?: boolean}, q: number, spray: number}}
 */
export function simulateHit(offset, window, rng = Math.random) {
  const q = Math.max(0, Math.min(1, 1 - Math.abs(offset) / window));
  const side = Math.max(-1, Math.min(1, offset / window));
  const spray = side * SPRAY_MAX + gaussFrom(rng) * SPRAY_SPREAD;
  const ratio = (STRENGTH_BASE + STRENGTH_Q * q) * (1 + gaussFrom(rng) * STRENGTH_SPREAD);
  const reach = Math.max(60, fenceDistance(spray) * ratio);
  // 飛ぶ山と、はねる山（道のりで決める）。
  const carry = reach * (CARRY_BASE + CARRY_Q * q);
  const loft = carry * (LOFT_BASE + LOFT_Q * q);
  const arcs = [{ from: 0, to: carry, h: loft }];
  // はねるのは、止まる少し前まで（空中で止まって見えないように、はね方を縮める）。
  const bounceLen = BOUNCES.reduce((sum, b) => sum + b.len, 0) * carry;
  const fit = Math.min(1, Math.max(0, reach * 0.95 - carry) / bounceLen);
  for (const b of BOUNCES) {
    const from = arcs[arcs.length - 1].to;
    arcs.push({ from, to: from + carry * b.len * fit, h: loft * b.h * fit });
  }

  let v = Math.sqrt(2 * DECEL * reach);
  const a = ((-90 + spray) * Math.PI) / 180;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  let x = LAUNCH.x;
  let y = LAUNCH.y;
  let z = 0;
  let d = 0;
  const DT = 1 / 120;
  const FPS = 30;
  const frame = () => [Math.round(x), Math.round(y), Math.round(z)];
  const frames = [frame()];
  let step = 0;
  let where = null;
  let n = null;
  let over = false;
  let landMs = null;
  while (step < 120 * 8) {
    v = Math.max(0, v - DECEL * DT);
    x += dir.x * v * DT;
    y += dir.y * v * DT;
    d += v * DT;
    z = heightAt(d, arcs);
    step += 1;
    if (landMs === null && !over && d >= carry) landMs = Math.round((step / 120) * 1000);
    const fromHome = Math.hypot(x - HOME.x, y - HOME.y);
    const sNow = (Math.atan2(x - HOME.x, HOME.y - y) * 180) / Math.PI;
    const wallAt = fenceR(sNow) - BALL_R;
    if (over) {
      // スタンドの中を飛んでいる。落ちたら（または いちばん遠くまで来たら）おわり。
      if (d >= carry || fromHome >= wallAt + OVER_MAX) {
        z = 0;
        where = { kind: "over" };
        n = 4;
      }
    } else if (fromHome >= wallAt) {
      n = wallResult(sNow);
      if (d < carry && z > AIR_MIN && n === 4) {
        // 飛んだまま（はねる前に）、ホームランの区画をこえた。
        over = true;
      } else {
        // フェンスに着いた。区画で決まる（アウトの区画もある）。
        const k = wallAt / fromHome;
        x = HOME.x + (x - HOME.x) * k;
        y = HOME.y + (y - HOME.y) * k;
        where = { kind: "wall", air: z > AIR_MIN };
      }
    } else if (z === 0 && v < CAPTURE_SPEED) {
      // 地面を転がっているときだけ、穴に落ちる。
      const pocket = POCKETS.find((p) => Math.hypot(x - p.x, y - p.y) < p.r);
      if (pocket) {
        x = pocket.x;
        y = pocket.y;
        where = { kind: "pocket", id: pocket.id };
        n = pocket.n;
      }
    }
    if (!where && v === 0) {
      // どこにも入らずに止まった: 内野ならアウト、外野ならヒット。
      n = stopResult(x, y);
      where = { kind: "stop" };
    }
    if (step % (120 / FPS) === 0 || where) frames.push(frame());
    if (where) break;
  }
  if (!where) {
    n = stopResult(x, y);
    where = { kind: "stop" };
  }
  if (where.kind !== "over" && z > 0) {
    // 空中でフェンスに当たった（など）: その場で下に落ちる。
    const top = z;
    for (let i = 1; i <= 6; i += 1) {
      z = top * (1 - (i / 6) ** 2);
      frames.push(frame());
    }
  }
  return {
    frames,
    fps: FPS,
    durationMs: Math.round(((frames.length - 1) / FPS) * 1000),
    landMs,
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

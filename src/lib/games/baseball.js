// =====================================================================
// games/baseball.js — 野球の決まり（画面にも通信にも依存しない純粋関数）
//
// バッターボックスの前で、円盤（ターンテーブル）が回っている。円盤のふちに
// ボールが乗っていて、1周ごとにバットの前（「あたる ところ」）を通る。
// スイッチを押すとバットを振る。ボールが「あたる ところ」にあれば打てる。
//
// neuro の「ボールを 打つ」（src/lib/games/baseball.js）と同じ考え方:
//   - 見送っても、空振りしても、へこませない（ストライクもアウトも無い）。
//     円盤が回っているので、ボールはまた来る。
//   - 合うほど遠くへ飛ぶ。真ん中に近いほど ホームラン。
//   - 判定の時刻は、押した瞬間の時刻（入力の入口で取った時刻）。描画のコマには頼らない。
//
// 時刻はすべて「ホストの時計」（ミリ秒）。ゲストは時計のずれを測って合わせる（net.js）。
// =====================================================================

/** 円盤が1周する時間（ミリ秒）。支援者が選ぶ。 */
export const SPIN_PERIOD_MS = { slow: 4400, normal: 3400, fast: 2500 };

/**
 * 「合った」にする広さ（あたる ところの、真ん中から前後の時間、ミリ秒）。
 * always は円盤のどこにあっても当たる（半周 = 前後いっぱい）。
 */
export const HIT_WIDTH_MS = { narrow: 220, normal: 380, wide: 600, always: Infinity };

/** 何塁打か（1〜4）。0 は空振り。 */
export const HIT_NAMES = { 1: "hit", 2: "double", 3: "triple", 4: "homerun" };

/** 打ってから、ボールが飛んでいる時間。 */
export const FLIGHT_MS = 1700;
/** 落ちたあと、どこへ飛んだかを見せておく時間（カメラが引いたまま。そのあと寄り直す）。 */
export const RUN_MS = 1800;
/** 交代して、次のボールが「あたる ところ」に初めて来るまでの、いちばん短い時間。 */
export const FIRST_PASS_LEAD_MS = 2600;

/**
 * 実際に使う「合った」の広さ。半周より広くはしない（隣の周回と重ならない）。
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
 * @param {number} t 押した時刻（ホストの時計）
 * @param {number} sweetAt ボールが真ん中を通る時刻のひとつ
 * @param {number} period 1周（ms）
 */
export function offsetFromSweet(t, sweetAt, period) {
  const phase = (((t - sweetAt) % period) + period) % period;
  return phase > period / 2 ? phase - period : phase;
}

/**
 * ずれ（ms）と広さ W から、何塁打かを決める。真ん中ほど遠くへ飛ぶ。
 *   |ずれ| ≤ W/4 … ホームラン（4）
 *   |ずれ| ≤ W/2 … スリーベース（3）
 *   |ずれ| ≤ 3W/4 … ツーベース（2）
 *   |ずれ| ≤ W   … ヒット（1）
 *   それより外   … 空振り（0）。数えない
 * @returns {0|1|2|3|4}
 */
export function judgeSwing(offsetMs, windowMs) {
  const miss = Math.abs(offsetMs);
  if (!(miss <= windowMs)) return 0;
  const k = miss / windowMs;
  if (k <= 0.25) return 4;
  if (k <= 0.5) return 3;
  if (k <= 0.75) return 2;
  return 1;
}

/**
 * ランナーを進める。打った人も含め、全員が bases 個ぶん進む（押し出しのような
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
 * @param {number} now
 * @param {number} period
 */
export function firstSweetAt(now, period) {
  // 少なくとも FIRST_PASS_LEAD_MS、かつ 3/4 周ぶんは見せてから来る。
  return now + Math.max(FIRST_PASS_LEAD_MS, period * 0.75);
}

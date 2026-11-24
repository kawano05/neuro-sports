// ふりがな（neuro の i18n.js と同じ書き方）。`打[う]つ` → <ruby>打<rt>う</rt></ruby>つ
// rt は読み上げから外す（VoiceOver が本文と読みの両方を読むため）。

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function rb(text) {
  return escapeHtml(text).replace(/([^\s\[\]]+?)\[([^\]]+)\]/g, (_, base, reading) => `<ruby>${base}<rt aria-hidden="true">${reading}</rt></ruby>`);
}

/** 読み上げ・aria-label 用。漢字のかわりに読みを使う。 */
export function plain(text) {
  return String(text).replace(/([^\s\[\]]+?)\[([^\]]+)\]/g, (_, base, reading) => reading);
}

export const HIT_LABELS = { 1: "ヒット", 2: "ツーベース", 3: "スリーベース", 4: "ホームラン" };
export const TEAM_LABELS = { red: "あか", blue: "あお" };
export const GAME_LABELS = { baseball: "野球[やきゅう]", boccia: "ボッチャ" };

/** 名前の呼び方。 */
export function callName(player) {
  if (!player) return "";
  return `${player.name}さん`;
}

// =====================================================================
// scan.js — 選ぶ画面で、ボタンを順に光らせて、スイッチ1回で選ぶ（オートスキャン）
//
// 試合のおわり（もういちど / 部屋に もどる など）と、部屋の「野球・ボッチャ・はじめる」は、
// 前はタップでしか選べず、スイッチだけの人はそこで止まっていた。いまは、ボタンが一定の間で順に光り
// （黄色い枠）、スイッチ・画面・「えらぶ」ボタンのどれかを押すと、光っているボタンを押す。
// neuro の走査（scan.js）と同じ考え方。
//
// - 光が移るたびに、ボタンの言葉を読み上げる（読み上げ「なし」なら読まない）。
//   最初の1つは読まない（直前の「おわり！」などの読み上げを切らないため）。
// - 選ぶ画面が出てすぐ（0.7秒）の押しは、選ばずに捨てる（打った勢いで押してしまうのを防ぐ）。
// - 光の間は、この端末の設定「えらぶ 光の はやさ」（prefs.scanMs）。
// - ボタンはタップでも、そのまま押せる。
// - 選んでも画面が変わらないボタン（部屋の「野球」など）は、data-scan-then に次に光らせる
//   ボタン（入れ物の中のセレクタ）を書く。選んだら、すぐそこへ光を移す（野球 → はじめる）。
// - 文字を打つ欄（名前・番号）に入っているあいだは、光を止める（支援者が打っているときに、
//   読み上げで じゃまをしない）。押せないボタン（つないでいる最中など）は飛ばす。
// =====================================================================

import { writable, get } from "svelte/store";
import { prefs, audio } from "./app.js";

export const SCAN_MS_OPTIONS = [1200, 1600, 2400, 3200];
export const DEFAULT_SCAN_MS = 1600;
const GUARD_MS = 700;

/** いま選んでいる最中か（「おす」ボタンの言葉を「えらぶ」にする）。 */
export const scanning = writable(false);

const groups = [];

/** いま文字を打つ欄に入っているか。 */
function typing() {
  const el = document.activeElement;
  const tag = el?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!el?.isContentEditable;
}

function labelOf(button) {
  const label = button.getAttribute("aria-label");
  if (label) return label;
  const copy = button.cloneNode(true);
  copy.querySelectorAll("rt, rp").forEach((e) => e.remove());
  return copy.textContent.replace(/\s+/g, " ").trim();
}

/**
 * Svelte の use: で、選ぶボタンの入れ物に付ける。中の（押せる）ボタンを順に光らせる。
 * use:scanGroup={false} のときは光らせない（ホストでない人の部屋など）。
 * @param {HTMLElement} node
 * @param {boolean} [enabled]
 */
export function scanGroup(node, enabled = true) {
  let since = performance.now();
  let index = -1;
  let timer = null;
  let on = false;
  const buttons = () => [...node.querySelectorAll("button:not([disabled])")];

  function show(next, speak) {
    node.querySelectorAll(".scan-focus").forEach((b) => b.classList.remove("scan-focus"));
    const list = buttons();
    if (!list.length) return;
    index = ((next % list.length) + list.length) % list.length;
    list.forEach((b, k) => b.classList.toggle("scan-focus", k === index));
    if (speak) audio.speak(labelOf(list[index]));
  }

  function schedule() {
    clearTimeout(timer);
    const ms = SCAN_MS_OPTIONS.includes(get(prefs).scanMs) ? get(prefs).scanMs : DEFAULT_SCAN_MS;
    timer = setTimeout(() => {
      if (!typing()) show(index + 1, true);
      schedule();
    }, ms);
  }

  const group = {
    /** 光っているボタンを押す。押しを受けたら true（選ばずに捨てたときも）。 */
    select(t) {
      if (t - since < GUARD_MS) return true;
      const button = buttons()[index];
      if (!button) return false;
      const then = button.dataset.scanThen;
      button.click();
      // 画面が変わらないときは、次に光らせるボタンへ（書いていなければ、同じボタンから数えなおす）。
      const next = then ? node.querySelector(then) : null;
      const at = next ? buttons().indexOf(next) : -1;
      if (at >= 0) show(at, true);
      else if (index >= 0) show(index, false);
      schedule();
      return true;
    },
  };

  function start() {
    if (on) return;
    on = true;
    since = performance.now();
    groups.push(group);
    scanning.set(true);
    show(0, false);
    schedule();
  }

  function stop() {
    if (!on) return;
    on = false;
    clearTimeout(timer);
    buttons().forEach((b) => b.classList.remove("scan-focus"));
    const at = groups.indexOf(group);
    if (at >= 0) groups.splice(at, 1);
    scanning.set(groups.length > 0);
  }

  if (enabled) start();
  return {
    update(value) {
      if (value) start();
      else stop();
    },
    destroy: stop,
  };
}

/**
 * スイッチが押された。選ぶ画面が出ていれば、光っているボタンを押して true を返す。
 * @param {number} t performance.now()
 */
export function scanSelect(t) {
  const group = groups.at(-1);
  return group ? group.select(t) : false;
}

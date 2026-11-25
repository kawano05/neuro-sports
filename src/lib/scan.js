// =====================================================================
// scan.js — 選ぶ画面で、ボタンを順に光らせて、スイッチ1回で選ぶ（オートスキャン）
//
// 試合のおわり（もういちど / 部屋に もどる など）は、前はタップでしか選べず、
// スイッチだけの人はそこで止まっていた。いまは、ボタンが一定の間で順に光り
// （黄色い枠）、スイッチ・画面・「えらぶ」ボタンのどれかを押すと、光っているボタンを押す。
// neuro の走査（scan.js）と同じ考え方。
//
// - 光が移るたびに、ボタンの言葉を読み上げる（読み上げ「なし」なら読まない）。
//   最初の1つは読まない（直前の「おわり！」などの読み上げを切らないため）。
// - 選ぶ画面が出てすぐ（0.7秒）の押しは、選ばずに捨てる（打った勢いで押してしまうのを防ぐ）。
// - 光の間は、この端末の設定「えらぶ 光の はやさ」（prefs.scanMs）。
// - ボタンはタップでも、そのまま押せる。
// =====================================================================

import { writable, get } from "svelte/store";
import { prefs, audio } from "./app.js";

export const SCAN_MS_OPTIONS = [1200, 1600, 2400, 3200];
export const DEFAULT_SCAN_MS = 1600;
const GUARD_MS = 700;

/** いま選んでいる最中か（「おす」ボタンの言葉を「えらぶ」にする）。 */
export const scanning = writable(false);

const groups = [];

function labelOf(button) {
  const label = button.getAttribute("aria-label");
  if (label) return label;
  const copy = button.cloneNode(true);
  copy.querySelectorAll("rt, rp").forEach((e) => e.remove());
  return copy.textContent.replace(/\s+/g, " ").trim();
}

/**
 * Svelte の use: で、選ぶボタンの入れ物に付ける。中の（押せる）ボタンを順に光らせる。
 * @param {HTMLElement} node
 */
export function scanGroup(node) {
  const since = performance.now();
  let index = -1;
  let timer = null;
  const buttons = () => [...node.querySelectorAll("button:not([disabled])")];

  function show(next, speak) {
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
      show(index + 1, true);
      schedule();
    }, ms);
  }

  const group = {
    /** 光っているボタンを押す。押しを受けたら true（選ばずに捨てたときも）。 */
    select(t) {
      if (t - since < GUARD_MS) return true;
      const button = buttons()[index];
      if (!button) return false;
      button.click();
      return true;
    },
  };
  groups.push(group);
  scanning.set(true);
  show(0, false);
  schedule();

  return {
    destroy() {
      clearTimeout(timer);
      buttons().forEach((b) => b.classList.remove("scan-focus"));
      const at = groups.indexOf(group);
      if (at >= 0) groups.splice(at, 1);
      scanning.set(groups.length > 0);
    },
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

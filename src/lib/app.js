// =====================================================================
// app.js — このアプリに1つだけあるもの（部屋・音・この端末の好み・出来事の知らせ）
// =====================================================================

import { writable, get } from "svelte/store";
import { createSession } from "./session.js";
import { createAudio } from "./audio.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import { playerById } from "./engine.js";
import { HIT_LABELS, TEAM_LABELS, callName } from "./text.js";

export const prefs = writable(loadPrefs());
export function updatePrefs(patch) {
  prefs.set(savePrefs(patch));
  audio.applyVolume();
}

export const session = createSession();
export const audio = createAudio(() => get(prefs));

/** この端末で先に鳴らした押し（pid）。ホストから同じ出来事が届いても、もう鳴らさない。 */
export const predicted = new Set();

/** 画面どうしの小さな知らせ（この端末のスイッチが押された、など）。 */
const listeners = new Map();
export const bus = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  },
  emit(name, detail) {
    for (const fn of listeners.get(name) || []) fn(detail);
  },
};

/** 画面の読み上げ（aria-live）にも出す言葉。 */
export const announcement = writable("");

function say(text, { speak = true } = {}) {
  announcement.set(text);
  if (speak) audio.speak(text);
}

// 出来事 → 音と読み上げ（どの端末でも同じように）。
session.onEvents((events, state) => {
  const myId = get(session).myId;
  for (const e of events) {
    const player = playerById(state, e.playerId);
    const mine = e.pid && predicted.has(e.pid);
    if (mine) predicted.delete(e.pid);
    switch (e.kind) {
      case "turn":
        audio.turn();
        say(e.playerId === myId ? `${callName(player)}の ばん。おしてね` : `${callName(player)}の ばん`);
        break;
      case "swing":
        // 打った音は当たりのよさで。結果（ヒット・アウトなど）は、ボールが止まったとき。
        if (!mine) {
          if (e.contact) audio.batHit(e.q >= 0.85 ? 4 : e.q >= 0.6 ? 3 : e.q >= 0.35 ? 2 : 1);
          else audio.swing();
        }
        break;
      case "result": {
        if (e.n === 0) {
          audio.chime(330, 0, 0.8);
          say(`アウト。${e.outs >= 3 ? "スリーアウト" : `${e.outs}アウト`}`);
        } else {
          if (e.n === 4) audio.cheer(1.6);
          else audio.chime(523.25 + e.n * 110, 0, 0.8);
          const runs = e.runs > 0 ? `。${e.runs}てん はいった` : "";
          say(`${HIT_LABELS[e.n]}${runs}`);
        }
        break;
      }
      case "change":
        audio.turn();
        say(`チェンジ。${TEAM_LABELS[e.team]}の こうげき`);
        break;
      case "cheer":
        if (!mine) audio.cheerPop();
        break;
      case "test":
        if (!mine) audio.test();
        announcement.set(`${callName(player)}の スイッチ`);
        break;
      case "lock":
        if (!mine) audio.lock();
        break;
      case "throw": {
        const roll = state.boccia?.roll;
        audio.roll((roll?.durationMs ?? 1500) / 1000);
        break;
      }
      case "end": {
        audio.fanfare();
        if (e.solo) say("ぜんぶ なげたよ。いちばん ちかい たまに ほし");
        else if (e.team) say(`${TEAM_LABELS[e.team]}の かち。${e.points}てん`);
        else say("どちらも てんは なし");
        break;
      }
      case "done":
        audio.fanfare();
        if (e.mode === "team" && e.score) {
          say(e.winner ? `しあい しゅうりょう。${TEAM_LABELS[e.winner]}の かち` : "しあい しゅうりょう。ひきわけ");
        } else say(`おわり。みんなで ${e.runs}てん`);
        break;
      case "start":
        say(e.game === "baseball" ? "やきゅう、はじめ" : "ボッチャ、はじめ", { speak: false });
        break;
      case "join":
        if (state.screen === "room" && e.playerId !== myId) audio.chime(659.25, 0, 0.6);
        break;
      case "full":
        if (e.playerId === myId) say("あそぶ ひとが いっぱいなので、みるだけで はいりました");
        break;
      default:
    }
  }
});

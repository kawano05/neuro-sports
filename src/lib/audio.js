// =====================================================================
// audio.js — 合図の音・効果音・読み上げ
//
// neuro（src/lib/audio.js）で測って決めた大きさを使う:
//   - 合図の音（押す瞬間を知らせる「ポーン」）は CUE_TONE_GAIN 0.4。声より少し小さく、
//     はっきり聞こえる。倍音を足した「パキッとした」音（bright）。2026-10-21 の打ち合わせで
//     「ポーンとこもった感じ。耳の聞こえにくい子も多いので、もっとパキッとした高い音に」。
//   - 前ぶれの「ピッ」は、合図より約9dB小さい純音（CUE_SOFT_GAIN）。高さと音色で分ける。
//   - 効果音は、合図を覆わない大きさ（合図より下）。iPad のスピーカーでも聞こえるよう、
//     neuro の遊びの場面（PLAY_EFFECT_BOOST_DB +12dB）と同じくらいまで上げる。
//   - 強すぎる音は発作につながりうる（打ち合わせ）。大きさは支援者が3段で選ぶ。
//
// 時刻: 合図はホストの時計で決まる。AudioContext の時計へは、そのつど
//   audioTime = ctx.currentTime + (hostTime − hostNow()) / 1000 で写す。
// =====================================================================

export const CUE_TONE_GAIN = 0.4;
export const CUE_SOFT_GAIN = CUE_TONE_GAIN * 0.36;
/** 効果音のいちばん大きい山。合図（0.4）の下。 */
const EFFECT_PEAK = 0.16;
const TONE_DECAY_S = 0.18;
const BRIGHT_HARMONICS = [0, 1, 0.6, 0.4, 0.25, 0.15, 0.1];

export const VOLUME_LEVELS = { small: 0.45, mid: 0.8, large: 1.15 };

export function createAudio(getPrefs) {
  let ctx = null;
  let master = null;
  let noise = null;
  let bright = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
      applyVolume();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function applyVolume() {
    if (!master) return;
    master.gain.value = VOLUME_LEVELS[getPrefs().volume] ?? VOLUME_LEVELS.mid;
  }

  /** 利用者の操作の中で呼ぶ（iPad は、操作のあとでないと音が出ない）。 */
  function unlock() {
    const c = ensure();
    if (c && c.state !== "running") c.resume().catch(() => {});
  }

  function noiseBuffer(c) {
    if (noise) return noise;
    const length = Math.floor(c.sampleRate * 2);
    noise = c.createBuffer(1, length, c.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return noise;
  }

  function brightWave(c) {
    if (!bright) {
      const imag = Float32Array.from(BRIGHT_HARMONICS);
      bright = c.createPeriodicWave(new Float32Array(imag.length), imag);
    }
    return bright;
  }

  /** 合図の音を、AudioContext の時刻 at に鳴らす。 */
  function toneAt(at, frequency, gain, timbre = "sine", decayS = TONE_DECAY_S) {
    const c = ensure();
    if (!c) return;
    try {
      const osc = c.createOscillator();
      const env = c.createGain();
      if (timbre === "bright") osc.setPeriodicWave(brightWave(c));
      else osc.type = timbre;
      osc.frequency.value = frequency;
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(gain, at + 0.004);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain / 50), at + decayS);
      env.gain.linearRampToValueAtTime(0, at + decayS + 0.02);
      osc.connect(env);
      env.connect(master);
      osc.start(at);
      osc.stop(at + decayS + 0.03);
    } catch {
      /* 古いブラウザ */
    }
  }

  function noiseAt(at, { durationS = 0.2, gain = EFFECT_PEAK, filter = "bandpass", frequency = 1200, q = 1, sweepTo = null } = {}) {
    const c = ensure();
    if (!c) return;
    try {
      const src = c.createBufferSource();
      src.buffer = noiseBuffer(c);
      const band = c.createBiquadFilter();
      band.type = filter;
      band.frequency.value = frequency;
      band.Q.value = q;
      const env = c.createGain();
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.02, durationS / 3));
      env.gain.exponentialRampToValueAtTime(0.0001, at + durationS);
      if (sweepTo) band.frequency.exponentialRampToValueAtTime(sweepTo, at + durationS);
      src.connect(band);
      band.connect(env);
      env.connect(master);
      src.start(at, Math.random() * 1.5);
      src.stop(at + durationS + 0.02);
    } catch {
      /* 古いブラウザ */
    }
  }

  const now = () => ensure()?.currentTime ?? 0;

  /**
   * 合図（前ぶれの「ピッ」と、押す瞬間の「ポーン」）を、ホストの時刻で予約する。
   * @param {"tick"|"now"} kind
   * @param {number} hostTime
   * @param {number} hostNowMs
   */
  function cueAtHost(kind, hostTime, hostNowMs) {
    const c = ensure();
    if (!c || c.state !== "running") return;
    const at = c.currentTime + Math.max(0, (hostTime - hostNowMs) / 1000);
    if (kind === "now") toneAt(at, 880, CUE_TONE_GAIN, "bright");
    else toneAt(at, 660, CUE_SOFT_GAIN, "sine");
  }

  function swing() {
    noiseAt(now(), { durationS: 0.16, frequency: 1200, q: 0.7, sweepTo: 400 });
  }

  /** 打った音。n（1〜4）が大きいほど、長く響く。 */
  function batHit(n) {
    const c = ensure();
    if (!c) return;
    const at = c.currentTime;
    noiseAt(at, { durationS: 0.03, frequency: 3200, q: 1.5 });
    const ring = 0.2 + n * 0.1;
    [
      { f: 1860, level: 0.8 },
      { f: 2730, level: 0.5 },
      { f: 4120, level: 0.25 },
    ].forEach(({ f, level }) => toneAt(at, f, EFFECT_PEAK * level, "sine", ring));
    if (n >= 4) cheer(1.6, 0.25);
  }

  /** 野球: 飛んだボールが地面に落ちた「トン」（低く、短く）。 */
  function land() {
    const c = ensure();
    if (!c) return;
    const at = c.currentTime;
    toneAt(at, 150, EFFECT_PEAK * 0.7, "sine", 0.12);
    noiseAt(at, { durationS: 0.06, gain: EFFECT_PEAK * 0.35, filter: "lowpass", frequency: 520, q: 0.7 });
  }

  /** 歓声・拍手（雑音を細かく刻む）。 */
  function cheer(durationS = 1.2, delayS = 0) {
    const c = ensure();
    if (!c) return;
    const start = c.currentTime + delayS;
    const claps = Math.floor(durationS * 22);
    for (let i = 0; i < claps; i += 1) {
      const at = start + (i / claps) * durationS + Math.random() * 0.03;
      const fade = 1 - i / claps;
      noiseAt(at, { durationS: 0.05, gain: EFFECT_PEAK * (0.35 + 0.4 * Math.random()) * fade + 0.001, frequency: 1500 + Math.random() * 1500, q: 0.9 });
    }
  }

  /** やさしい楽器の音（木琴に近い）。 */
  function chime(frequency, delayS = 0, level = 1) {
    const c = ensure();
    if (!c) return;
    const at = c.currentTime + delayS;
    toneAt(at, frequency, EFFECT_PEAK * 0.9 * level, "triangle", 0.7);
    toneAt(at, frequency * 4, EFFECT_PEAK * 0.15 * level, "sine", 0.12);
  }

  /** 番が来た（ド・ミ）。 */
  function turn() {
    chime(523.25, 0);
    chime(659.25, 0.12);
  }

  /** おうえん（番でない人が押した）。小さく、短く。 */
  function cheerPop() {
    chime(1046.5, 0, 0.45);
  }

  /** スイッチの ためし。 */
  function test() {
    chime(784, 0, 0.8);
  }

  /** ボッチャ: むき・つよさを決めた「カチッ」。 */
  function lock() {
    const c = ensure();
    if (!c) return;
    noiseAt(c.currentTime, { durationS: 0.05, frequency: 2400, q: 2 });
    toneAt(c.currentTime, 1200, EFFECT_PEAK * 0.5, "triangle", 0.08);
  }

  /** ボッチャ: 転がる音（長さ durationS）。 */
  function roll(durationS) {
    const c = ensure();
    if (!c) return;
    noiseAt(c.currentTime + 0.25, { durationS: Math.max(0.4, durationS), gain: EFFECT_PEAK * 0.55, filter: "lowpass", frequency: 380, q: 0.6 });
  }

  /** ボッチャ: 玉どうしが当たった「コン」。 */
  function clack(delayS = 0) {
    const c = ensure();
    if (!c) return;
    const at = c.currentTime + delayS;
    toneAt(at, 1500, EFFECT_PEAK * 0.7, "triangle", 0.09);
    noiseAt(at, { durationS: 0.04, frequency: 2600, q: 2 });
  }

  /** おわりの ファンファーレ。 */
  function fanfare() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => chime(f, i * 0.13));
    cheer(1.4, 0.4);
  }

  // --- 読み上げ ---------------------------------------------------------

  let voice = null;
  function pickVoice() {
    const synth = globalThis.speechSynthesis;
    if (!synth) return null;
    const voices = synth.getVoices?.() || [];
    voice = voices.find((v) => v.lang === "ja-JP" && v.localService) || voices.find((v) => v.lang?.startsWith("ja")) || null;
    return voice;
  }
  globalThis.speechSynthesis?.addEventListener?.("voiceschanged", pickVoice);

  function speak(text) {
    if (!getPrefs().speech) return;
    const synth = globalThis.speechSynthesis;
    const U = globalThis.SpeechSynthesisUtterance;
    if (!synth || !U || !text) return;
    try {
      synth.cancel();
      const u = new U(text);
      u.lang = "ja-JP";
      u.rate = 0.95;
      u.volume = Math.min(1, (VOLUME_LEVELS[getPrefs().volume] ?? 0.8) + 0.2);
      if (voice || pickVoice()) u.voice = voice;
      synth.speak(u);
    } catch {
      /* 読み上げが使えない */
    }
  }

  return {
    unlock,
    applyVolume,
    cueAtHost,
    land,
    swing,
    batHit,
    cheer,
    chime,
    turn,
    cheerPop,
    test,
    lock,
    roll,
    clack,
    fanfare,
    speak,
  };
}

<script>
  // =====================================================================
  // 野球の画面（1つの盤）。
  //
  // 本塁の上で円盤（回転台）が回り、ふちのボールが黄色い帯（あたる ところ）に来たときに
  // 押すと、三塁側のバットが横に振れて打てる。帯の真ん中のオレンジに近いほど、
  // まっすぐ強く、高く飛ぶ。
  //
  // 当たった瞬間に、ほんの少し止めて（ヒットストップ）カメラを少し寄せ、手ごたえを出す。
  // ボールは飛んで（影は地面に残り、ボールは上がって大きく見える）、落ちて「トン」、はねて、転がる。
  // 飛んだ道すじは白い線で残す（どこへ飛んだか分かる）。強い当たりはフェンスをこえてスタンドへ。
  //
  // 打つと、カメラが盤全体へ引いて、ボールを追う。フェンスの区画・穴・止まった場所で
  // 結果が決まる（ヒット・ツーベース・スリーベース・ホームラン・アウト）。止まったら結果を出し、
  // 少し見せてから、またバッターボックスへ寄る。塁・点・アウトは右上の札にまとめる。
  //
  // ※ 仕組みは、本塁の回転台とスイッチで打つ野球盤（ユニバーサル野球）を参考にした。
  //   名前・ロゴ・盤の絵や色・穴の並びは使っていない（独自の盤）。
  //
  // 角度も判定も、ホストの時計（session.hostNow）で見る。どの画面でも同じ位置に見える。
  // =====================================================================
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { session, audio, bus, predicted } from "../lib/app.js";
  import { playerById, TURN_GUARD_MS } from "../lib/engine.js";
  import {
    CONTACT_MS,
    HIT_STOP_MS,
    LAUNCH_DELAY_MS,
    FENCE_R,
    LINE_R,
    fenceR,
    HOME as H,
    INFIELD_R,
    LAUNCH,
    OUT,
    POCKETS,
    WALL,
    ballAngle,
    contactQuality,
    offsetFromSweet,
  } from "../lib/games/baseball.js";
  import { rb, HIT_LABELS, TEAM_LABELS } from "../lib/text.js";
  import { scanGroup } from "../lib/scan.js";
  import PlayerMark from "./PlayerMark.svelte";

  let { onAgain, onBack } = $props();

  const state = $derived($session.state);
  const bb = $derived(state.baseball);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  const batter = $derived(playerById(state, state.turn?.playerId ?? bb?.hit?.playerId));
  // チームで戦う形（打席制・イニング制）。みんなで（アウトなし）は、チームなし。
  const teamMode = $derived(!!bb && bb.mode !== "together");
  const inningsMode = $derived(bb?.mode === "innings");

  // --- 時計 -------------------------------------------------------------
  let now = $state(session.hostNow());
  onMount(() => {
    let raf = 0;
    const loop = () => {
      now = session.hostNow();
      scheduleCues(now);
      checkLanding(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  // 画面の大きさ（球の大きさを、カメラが引いても見える大きさに保つため）。
  let w = $state(0);
  let h = $state(0);

  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp01 = (k) => Math.max(0, Math.min(1, k));
  const easeOut = (k) => 1 - (1 - k) * (1 - k);
  const easeIn = (k) => k * k;
  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const polar = (cx, cy, r, deg) => ({ x: cx + r * Math.cos((deg * Math.PI) / 180), y: cy + r * Math.sin((deg * Math.PI) / 180) });
  /** 本塁から見た角度（センターが 0、左が負）で、盤の上の点。 */
  const spray = (r, s) => polar(H.x, H.y, r, -90 + s);

  // --- 本塁まわりの絵（この中の座標。円盤の中心 = 本塁 = 330,470） ------------------
  const C = { x: 330, y: 470 };
  const R = 160;
  const RB = 128;
  const BALL = 27;
  const SWEET = { x: C.x, y: C.y - RB };
  const PIVOT = { x: 130, y: SWEET.y };
  const REST = 105;
  const CONTACT = 0;
  const FOLLOW = -50;

  function arcPath(r, a0, a1) {
    const p0 = polar(C.x, C.y, r, a0);
    const p1 = polar(C.x, C.y, r, a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }

  // 本塁まわりの絵は、本塁に合わせて 1/4 にして盤に置く（打つ所が LAUNCH に重なる）。
  const S = 0.25;
  const BOX_AT = { x: H.x - C.x * S, y: H.y - C.y * S };

  // --- 盤 ----------------------------------------------------------------
  const BASE_D = 160;
  const FIRST = polar(H.x, H.y, BASE_D, -45);
  const SECOND = { x: H.x, y: H.y - BASE_D * Math.SQRT2 };
  const THIRD = polar(H.x, H.y, BASE_D, -135);
  const STANDS_R = 780;

  /** 結果ごとの色。オレンジはホームランだけ。 */
  const RESULT_COLOR = { 0: "#8A8F99", 1: "#FFFFFF", 2: "#A5D86E", 3: "#C3A6F0", 4: "#FF9F1C" };
  const resultName = (n) => (n === OUT ? (teamMode ? "アウト" : "ヒット") : HIT_LABELS[n]);
  const resultColor = (n) => (n === OUT && !teamMode ? RESULT_COLOR[1] : RESULT_COLOR[n]);

  // フェンスはセンターが遠く、線ぞいが近い（fenceR）。d だけ外（負なら内）へずらした線。
  const fenceLine = (from, to, d = 0) => {
    const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 1.5));
    return Array.from({ length: steps + 1 }, (_, i) => {
      const s = from + ((to - from) * i) / steps;
      const p = spray(fenceR(s) + d, s);
      return `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }).join(" ");
  };
  const fan = (d = 0) => `M ${H.x} ${H.y} ${fenceLine(-45, 45, d).replace(/^M/, "L")} Z`;
  /** 本塁を中心にした、半径 r の扇（内野の土）。 */
  const circleFan = (r) => {
    const a = spray(r, -45);
    const b = spray(r, 45);
    return `M ${H.x} ${H.y} L ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)} Z`;
  };
  const wallArc = (from, to, d) => fenceLine(from, to, d);
  // スタンドの席（決まった並び。フェンスの形にそう）。
  const SEATS = Array.from({ length: 5 }, (_, row) => {
    const count = 26 + row * 2;
    return Array.from({ length: count }, (_, i) => {
      const s = -43 + (86 * i) / (count - 1);
      return { ...spray(fenceR(s) + 40 + row * 30, s), a: s };
    });
  }).flat();

  /** 高さを、画面の上へのずれにする割合（少し後ろから見ている形）。 */
  const LIFT = 1;

  // --- カメラ ------------------------------------------------------------
  const BOX_VIEW = { x: 410, y: 925, w: 180, h: 125 };
  const FIELD_VIEW = { x: 20, y: 170, w: 960, h: 880 };

  // --- あたる ところ・円盤 ----------------------------------------------------
  const zoneHalf = $derived(bb ? Math.min(180, (bb.window / bb.period) * 360) : 0);
  const spinDeg = $derived(bb ? (ballAngle(now, bb.sweetAt, bb.period) * 180) / Math.PI : 0);

  // --- バット（押した瞬間に振る） ------------------------------------------
  let swingAt = $state(-Infinity);
  /** dt: 振りはじめからの時間。hold: 当たった形で止める時間（当たったときだけ）。 */
  function batAngle(dt, hold) {
    if (!(dt >= 0)) return REST;
    if (dt < CONTACT_MS) return lerp(REST, CONTACT, easeIn(dt / CONTACT_MS));
    if (dt < CONTACT_MS + hold) return CONTACT;
    const t = dt - hold;
    if (t > 520) return REST;
    if (t < 200) return lerp(CONTACT, FOLLOW, easeOut((t - CONTACT_MS) / (200 - CONTACT_MS)));
    return lerp(FOLLOW, REST, easeInOut((t - 200) / 320));
  }

  /** 当たりのよさから、打った音の強さ（1〜4）。 */
  const soundLevel = (q) => (q >= 0.85 ? 4 : q >= 0.6 ? 3 : q >= 0.35 ? 2 : 1);

  // --- 打った球（ホストの決定を待たずに、この端末で先に音を出し、円盤からボールを消す） ----
  let localHit = $state(null);
  const hit = $derived.by(() => {
    if (bb?.hit) return bb.hit;
    if (localHit && bb?.phase === "spin" && localHit.ballFrom === bb.ballFrom && now - localHit.t < 1200) return localHit;
    return null;
  });
  $effect(() => {
    if (bb?.ballFrom !== localHit?.ballFrom) localHit = null;
  });

  onMount(() => {
    const offPress = bus.on("press", ({ t, myTurn, pid }) => {
      if (!myTurn) return;
      const s = get(session).state;
      const b = s?.baseball;
      if (!b) return;
      swingAt = t;
      predicted.add(pid);
      if (b.phase === "spin" && t >= b.ballFrom && t >= (s.turn?.since ?? 0) + TURN_GUARD_MS) {
        const offset = offsetFromSweet(t, b.sweetAt, b.period);
        const q = contactQuality(offset, b.window);
        if (q !== null) {
          audio.batHit(soundLevel(q));
          localHit = { t, offset, q, ballFrom: b.ballFrom, playerId: s.turn.playerId };
          return;
        }
      }
      audio.swing();
    });
    const offEvents = session.onEvents((events, s) => {
      for (const e of events) {
        if (e.kind !== "swing" || e.playerId === get(session).myId) continue;
        swingAt = e.contact && s.baseball?.hit ? s.baseball.hit.t : session.hostNow();
      }
    });
    return () => {
      offPress();
      offEvents();
    };
  });

  const batDeg = $derived(batAngle(now - swingAt, hit && hit.t === swingAt ? HIT_STOP_MS : 0));

  const showBallOnDisc = $derived(bb && bb.phase === "spin" && !hit);
  // 当たった形になった瞬間に、星がはじける。
  const sinceContact = $derived(hit ? now - hit.t - CONTACT_MS : -1);
  const burst = $derived(sinceContact >= 0 && sinceContact < 320 ? clamp01(sinceContact / 320) : null);

  // カメラ: 当たった瞬間に少しだけ寄り（1.04倍、0.18秒）、飛び出したら引いて、次のボールの前に戻る。
  const camMix = $derived.by(() => {
    if (!hit) return 0;
    const out = easeInOut(clamp01((now - hit.t - LAUNCH_DELAY_MS) / 620));
    const back = bb?.nextAt ? easeInOut(clamp01((now - (bb.nextAt - 700)) / 700)) : 0;
    return out * (1 - back);
  });
  const punch = $derived(sinceContact >= 0 && sinceContact < 180 ? 1 + 0.04 * Math.sin((Math.PI * sinceContact) / 180) : 1);
  const view = $derived.by(() => {
    const vw = lerp(BOX_VIEW.w, FIELD_VIEW.w, camMix);
    const vh = lerp(BOX_VIEW.h, FIELD_VIEW.h, camMix);
    const cx = lerp(BOX_VIEW.x, FIELD_VIEW.x, camMix) + vw / 2;
    const cy = lerp(BOX_VIEW.y, FIELD_VIEW.y, camMix) + vh / 2;
    return { x: cx - vw / punch / 2, y: cy - vh / punch / 2, w: vw / punch, h: vh / punch };
  });
  /** いまの画面で、1単位が何ピクセルか。 */
  const ppu = $derived(w && h ? Math.min(w / view.w, h / view.h) : 1);
  const ballR = $derived(Math.max(BALL * S, 14 / ppu));

  // 飛ぶ球（ホストが計算したコマを、時刻に合わせて見せる）。コマは [x, y, 高さ]。
  // 飛び出すまで（ヒットストップの間）は、バットの前にとどまる。
  const rolling = $derived.by(() => {
    const roll = bb?.roll;
    if (!roll || !bb.hit) {
      // この端末で先に当たったが、ホストの計算がまだ届いていない: バットの前に見せておく。
      if (hit && now - hit.t < LAUNCH_DELAY_MS + 400) return { x: LAUNCH.x, y: LAUNCH.y, z: 0, stopped: false, inPocket: false, path: "" };
      return null;
    }
    const f = Math.max(0, ((now - bb.hit.t - LAUNCH_DELAY_MS) / 1000) * roll.fps);
    const i = Math.min(roll.frames.length - 1, Math.floor(f));
    const j = Math.min(roll.frames.length - 1, i + 1);
    const k = f - Math.floor(f);
    const [x0, y0, z0 = 0] = roll.frames[i];
    const [x1, y1, z1 = 0] = roll.frames[j];
    const x = lerp(x0, x1, k);
    const y = lerp(y0, y1, k);
    const z = lerp(z0, z1, k);
    // 飛んだ道すじ（空の上の線）。
    const pts = roll.frames.slice(0, i + 1).map(([px, py, pz = 0]) => `${px} ${(py - pz * LIFT).toFixed(0)}`);
    pts.push(`${x.toFixed(0)} ${(y - z * LIFT).toFixed(0)}`);
    return { x, y, z, stopped: i >= roll.frames.length - 1, inPocket: roll.where.kind === "pocket", path: `M ${pts.join(" L ")}` };
  });

  // 落ちた「トン」（ボールごとに1回）。
  let landedFor = null;
  function checkLanding(t) {
    const b = get(session).state?.baseball;
    if (!b?.roll?.landMs || !b.hit || landedFor === b.ballFrom) return;
    const at = b.hit.t + LAUNCH_DELAY_MS + b.roll.landMs;
    if (t < at) return;
    landedFor = b.ballFrom;
    if (t < at + 300) audio.land();
  }

  // ホームランの はなび（センターのスタンドの上）。
  const fireworks = $derived.by(() => {
    if (bb?.phase !== "result" || bb.last?.n !== 4 || !bb.resultAt) return [];
    const k = (now - bb.resultAt) / 1300;
    if (k < 0 || k > 1) return [];
    const base = spray(fenceR(0) + 90, 0);
    return [
      { dx: -150, dy: 10, c: "#FFD400", d: 0 },
      { dx: 150, dy: -10, c: "#FF5C8A", d: 0.15 },
      { dx: 0, dy: -60, c: "#5BC8FF", d: 0.3 },
    ].map((f) => ({ x: base.x + f.dx, y: base.y + f.dy, c: f.c, k: clamp01((k - f.d) / 0.6) }));
  });

  // --- 右上の札（塁・点・アウト・回） -------------------------------------------
  const baseColor = (id) => playerById(state, id)?.color || "#FFFFFF";
  const scoredFlash = $derived(bb?.phase === "result" && bb.last?.scored ? bb.last.scored : 0);

  // --- 合図の音（ピッ・ピッ・ポーン） ------------------------------------
  // ボールが「あたる ところ」の真ん中に来る瞬間に「ポーン」（パキッとした高い音）。
  // その前に2つ「ピッ」。リズムで、来る時を前もって知らせる（見えにくい人にも）。
  const scheduled = new Set();
  function scheduleCues(t) {
    const s = get(session).state;
    const b = s?.baseball;
    if (!b || b.phase !== "spin" || !s.settings.baseball.cue || !s.turn) return;
    const beat = Math.min(b.period / 4, 650);
    const k = Math.ceil((t - b.sweetAt) / b.period);
    for (const kk of [k, k + 1]) {
      const sweet = b.sweetAt + kk * b.period;
      [
        [sweet - 2 * beat, "tick"],
        [sweet - beat, "tick"],
        [sweet, "now"],
      ].forEach(([at, kind]) => {
        if (at < b.ballFrom + TURN_GUARD_MS || at <= t || at > t + 160) return;
        const key = `${b.ballFrom}:${Math.round(at)}`;
        if (scheduled.has(key)) return;
        scheduled.add(key);
        if (scheduled.size > 64) scheduled.delete(scheduled.values().next().value);
        audio.cueAtHost(kind, at, t);
      });
    }
  }

  const resultWord = $derived(bb?.phase === "result" && bb.last ? `${resultName(bb.last.n)}！` : "");
  const hitsBy = (id) => (bb?.log || []).filter((l) => l.playerId === id);
</script>

<div class="baseball" bind:clientWidth={w} bind:clientHeight={h}>
  <svg viewBox={`${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <defs>
      <pattern id="mow" width="48" height="48" patternUnits="userSpaceOnUse">
        <rect width="48" height="48" fill="#5DBB63" />
        <rect width="24" height="48" fill="#54B05A" />
      </pattern>
    </defs>

    <!-- 盤 -->
    <rect x="-600" y="-400" width="2200" height="2000" fill="#4FA656" />
    <path d={fan(STANDS_R - FENCE_R)} fill="#8E9AAF" />
    {#each SEATS as seat}
      <rect x={seat.x - 9} y={seat.y - 5} width="18" height="10" rx="3" fill="#B9C3D4" transform={`rotate(${seat.a} ${seat.x} ${seat.y})`} />
    {/each}
    <path d={fan(0)} fill="url(#mow)" stroke="#1A1A1A" stroke-width="4" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    <path d={circleFan(INFIELD_R)} fill="#E2B57E" />
    <path d={`M ${H.x} ${H.y} L ${FIRST.x} ${FIRST.y} L ${SECOND.x} ${SECOND.y} L ${THIRD.x} ${THIRD.y} Z`} fill="url(#mow)" />
    {#each [-45, 45] as s}
      {@const p0 = spray(72, s)}
      {@const p1 = spray(LINE_R, s)}
      <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="#FFFFFF" stroke-width="4" vector-effect="non-scaling-stroke" />
    {/each}
    {#each [FIRST, SECOND, THIRD] as b}
      <rect x={b.x - 11} y={b.y - 11} width="22" height="22" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="3" vector-effect="non-scaling-stroke" transform={`rotate(45 ${b.x} ${b.y})`} />
    {/each}

    <!-- フェンスの区画（内側に色の帯、名前はフェンスの外のスタンドに） -->
    {#each WALL as wall}
      {@const ms = (wall.from + wall.to) / 2}
      {@const mid = spray(fenceR(ms) + 16, ms)}
      <path d={wallArc(wall.from, wall.to, -14)} fill="none" stroke={resultColor(wall.n)} stroke-width="26" />
      <path d={wallArc(wall.to - 0.4, wall.to + 0.4, -14)} fill="none" stroke="#1A1A1A" stroke-width="28" />
      <!-- 縦書きで、フェンスから外へ（区画がせまくても、となりと重ならない） -->
      <text
        x={mid.x}
        y={mid.y}
        writing-mode="tb"
        text-anchor="end"
        transform={`rotate(${ms.toFixed(1)} ${mid.x.toFixed(1)} ${mid.y.toFixed(1)})`}
        font-size="22"
        font-weight="900"
        fill="#FFFFFF"
        stroke="#1A1A1A"
        stroke-width="6"
        paint-order="stroke">{resultName(wall.n)}</text>
    {/each}

    <!-- 穴（ゆっくり来たボールが落ちる） -->
    {#each POCKETS as p}
      <circle cx={p.x} cy={p.y} r={p.r + 7} fill={resultColor(p.n)} stroke="#1A1A1A" stroke-width="3" vector-effect="non-scaling-stroke" />
      <circle cx={p.x} cy={p.y} r={p.r - 2} fill="#2B2B2B" />
      <text x={p.x} y={p.y + p.r + 30} text-anchor="middle" font-size="22" font-weight="900" fill="#1A1A1A" stroke="#FFFFFF" stroke-width="6" paint-order="stroke">{resultName(p.n)}</text>
    {/each}

    <!-- 本塁まわり（円盤・バッター・バット） -->
    <g transform={`translate(${BOX_AT.x} ${BOX_AT.y}) scale(${S})`}>
      <circle cx={C.x} cy={C.y + 10} r="250" fill="#E2B57E" stroke="#C9965C" stroke-width="6" />
      <rect x="20" y="330" width="170" height="250" rx="6" fill="none" stroke="#FFFFFF" stroke-width="6" opacity="0.9" />
      <rect x="470" y="330" width="170" height="250" rx="6" fill="none" stroke="#FFFFFF" stroke-width="6" opacity="0.9" />
      <!-- 本塁（円盤はこの上で回る） -->
      <path d="M140 380 L520 380 L520 540 L330 650 L140 540 Z" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="6" stroke-linejoin="round" />

      <circle cx={C.x} cy={C.y + 10} r={R + 6} fill="#1A1A1A" opacity="0.25" />
      <circle cx={C.x} cy={C.y} r={R} fill="#FFF3D6" stroke="#1A1A1A" stroke-width="7" />

      <!-- あたる ところ（バットの前） -->
      {#if bb && bb.phase !== "done"}
        {#if zoneHalf >= 180}
          <circle cx={C.x} cy={C.y} r={RB} fill="none" stroke="#FFD84D" stroke-width={BALL * 2 + 12} opacity="0.9" />
        {:else}
          <path d={arcPath(RB, -90 - zoneHalf, -90 + zoneHalf)} fill="none" stroke="#FFD84D" stroke-width={BALL * 2 + 12} stroke-linecap="round" />
        {/if}
        <path d={arcPath(RB, -90 - Math.min(179, zoneHalf / 4), -90 + Math.min(179, zoneHalf / 4))} fill="none" stroke="#FF9F1C" stroke-width={BALL * 2 + 12} stroke-linecap="round" />
      {/if}

      <!-- 回る円盤（目盛りとボール） -->
      <g transform={`rotate(${spinDeg.toFixed(2)} ${C.x} ${C.y})`}>
        {#each Array.from({ length: 12 }, (_, i) => i * 30) as a}
          {@const p0 = polar(C.x, C.y, 42, a)}
          {@const p1 = polar(C.x, C.y, R - 12, a)}
          <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="#D9C49A" stroke-width="5" stroke-linecap="round" />
        {/each}
        <circle cx={C.x} cy={C.y} r={RB} fill="none" stroke="#D9C49A" stroke-width="3" stroke-dasharray="6 10" />
        <circle cx={C.x} cy={C.y} r="30" fill="#1A1A1A" />
        <circle cx={C.x} cy={C.y} r="12" fill="#FFB020" />
        {#if showBallOnDisc}
          <g transform={`translate(${SWEET.x} ${SWEET.y}) rotate(${(-spinDeg).toFixed(1)})`}>
            <circle r={BALL} fill="#FFFFFF" stroke="#1A1A1A" stroke-width="5" />
            <path d="M-11 -18 Q 1 0 -11 18 M11 -18 Q -1 0 11 18" fill="none" stroke="#E0302D" stroke-width="3.6" />
          </g>
        {/if}
      </g>

      <!-- バッター（三塁側。ヘルメットとユニフォームは、その人の色） -->
      <g transform="translate(-20 -56)">
        <ellipse cx="96" cy="452" rx="58" ry="40" fill={batter?.color || "#CCCCCC"} stroke="#1A1A1A" stroke-width="5" />
        <path d="M120 430 Q140 410 150 398" stroke="#1A1A1A" stroke-width="16" stroke-linecap="round" fill="none" />
        <path d="M120 430 Q140 410 150 398" stroke="#F5C9A5" stroke-width="9" stroke-linecap="round" fill="none" />
        <path d="M110 470 Q140 440 150 400" stroke="#1A1A1A" stroke-width="16" stroke-linecap="round" fill="none" />
        <path d="M110 470 Q140 440 150 400" stroke="#F5C9A5" stroke-width="9" stroke-linecap="round" fill="none" />
        <circle cx="86" cy="440" r="32" fill={batter?.color || "#CCCCCC"} stroke="#1A1A1A" stroke-width="5" />
        <path d="M60 428 Q86 400 112 428" fill="none" stroke="#1A1A1A" stroke-width="5" opacity="0.35" />
        <ellipse cx="112" cy="452" rx="16" ry="9" fill="#1A1A1A" opacity="0.85" transform="rotate(35 112 452)" />
      </g>

      <!-- バット（三塁側の軸から、本塁の前を横に振る） -->
      <g transform={`translate(${PIVOT.x} ${PIVOT.y}) rotate(${batDeg.toFixed(1)})`}>
        <path d="M-16 -8 L60 -10 Q170 -16 262 -22 Q284 -22 284 0 Q284 22 262 22 Q170 16 60 10 L-16 8 Z" fill="#C8873F" stroke="#1A1A1A" stroke-width="5" stroke-linejoin="round" />
        <rect x="-16" y="-9" width="62" height="18" rx="7" fill="#1A1A1A" />
        <circle cx="-18" cy="0" r="12" fill="#1A1A1A" />
      </g>

      {#if burst !== null}
        <g transform={`translate(${SWEET.x} ${SWEET.y}) scale(${(0.6 + burst * 1.2).toFixed(2)})`} opacity={(1 - burst).toFixed(2)}>
          <path d="M0 -70 L16 -18 L68 -22 L26 10 L44 62 L0 30 L-44 62 L-26 10 L-68 -22 L-16 -18 Z" fill="#FFF27A" stroke="#1A1A1A" stroke-width="4" stroke-linejoin="round" />
        </g>
      {/if}
    </g>

    <!-- 飛ぶ球: 地面の線・飛んだ道すじ・止まったところの輪・影・球 -->
    {#if rolling}
      {@const air = clamp01(rolling.z / 200)}
      <line x1={LAUNCH.x} y1={LAUNCH.y} x2={rolling.x} y2={rolling.y} stroke="#FFFFFF" stroke-width={3 / ppu} stroke-linecap="round" opacity="0.35" />
      {#if rolling.path}
        <path d={rolling.path} fill="none" stroke="#FFFFFF" stroke-width={4 / ppu} stroke-linecap="round" stroke-linejoin="round" opacity="0.85" />
      {/if}
      {#if bb?.phase === "result"}
        {@const k = clamp01((now - bb.resultAt) / 500)}
        <circle cx={rolling.x} cy={rolling.y} r={(14 + 30 * easeOut(k)) / ppu} fill="none" stroke="#FFFFFF" stroke-width={5 / ppu} opacity={(1 - k * 0.6).toFixed(2)} />
      {/if}
      <!-- 影は地面に残る（高く上がるほど小さく、うすく） -->
      <ellipse cx={rolling.x} cy={rolling.y} rx={ballR * 1.1 * (1 - air * 0.25)} ry={ballR * 0.6 * (1 - air * 0.25)} fill="#1A1A1A" opacity={(0.42 * (1 - air * 0.35)).toFixed(2)} />
      <g transform={`translate(${rolling.x.toFixed(1)} ${(rolling.y - rolling.z * LIFT).toFixed(1)}) scale(${((ballR / BALL) * (rolling.stopped && rolling.inPocket ? 0.75 : 1 + rolling.z / 220)).toFixed(3)})`}>
        <circle r={BALL} fill="#FFFFFF" stroke="#1A1A1A" stroke-width="5" />
        <path d="M-11 -18 Q 1 0 -11 18 M11 -18 Q -1 0 11 18" fill="none" stroke="#E0302D" stroke-width="3.6" />
      </g>
    {/if}

    {#each fireworks as f}
      {#if f.k > 0 && f.k < 1}
        {#each Array.from({ length: 10 }, (_, i) => i * 36) as a}
          {@const p = polar(f.x, f.y, 14 + f.k * 70, a)}
          <circle cx={p.x} cy={p.y} r={9 * (1 - f.k) + 3} fill={f.c} stroke="#1A1A1A" stroke-width="2" />
        {/each}
      {/if}
    {/each}
  </svg>

  {#if resultWord}
    <div class="word" class:hr={bb.last.n === 4} class:out={bb.last.n === OUT && teamMode} aria-hidden="true">{resultWord}</div>
  {/if}

  <!-- 塁・点・アウト -->
  {#if bb}
    <div class="scorebox" aria-label={teamMode ? `あか ${bb.score.red} あお ${bb.score.blue}${inningsMode ? ` アウト ${bb.outs}` : ""}` : `とくてん ${bb.runs}`}>
      {#if bb.mode !== "atbats"}
      <svg class="bases" viewBox="-44 -40 88 64" aria-hidden="true">
        {#each [{ x: 0, y: -22, i: 1 }, { x: 24, y: 2, i: 0 }, { x: -24, y: 2, i: 2 }] as b}
          <rect
            x={b.x - 10}
            y={b.y - 10}
            width="20"
            height="20"
            transform={`rotate(45 ${b.x} ${b.y})`}
            fill={bb.bases[b.i] ? baseColor(bb.bases[b.i]) : "transparent"}
            stroke={bb.bases[b.i] ? "#FFFFFF" : "#6B6B6B"}
            stroke-width="3"
          />
        {/each}
      </svg>
      {/if}
      {#if teamMode}
        <div class="team-board">
          {#if inningsMode}
            <span class="inning">{@html rb(`${bb.inning}回[かい] ${bb.half === 0 ? "表[おもて]" : "裏[うら]"}`)}</span>
          {/if}
          <span class="teams">
            {#each bb.teams as team}
              <span class="team {team}" class:batting={bb.batting === team}>{TEAM_LABELS[team]} <b>{bb.score[team]}</b></span>
            {/each}
          </span>
          {#if inningsMode}
            <span class="outs" aria-hidden="true">
              {#each [0, 1, 2] as i}<span class="out-dot" class:on={i < bb.outs}></span>{/each}
            </span>
          {/if}
        </div>
      {:else}
        <span class="runs">
          <span class="runs-label">{@html rb("得点[とくてん]")}</span>
          <span class="runs-num">{bb.runs}</span>
        </span>
      {/if}
      {#if scoredFlash}<span class="plus">+{scoredFlash}</span>{/if}
    </div>
  {/if}

  {#if batter && bb?.phase !== "done"}
    <div class="batter-tag"><PlayerMark color={batter.color} team={teamMode && bb.teams.length > 1 ? bb.batting : null} size={30} />{batter.name}</div>
  {/if}

  {#if bb?.phase === "done"}
    <div class="done">
      <div class="done-card">
        {#if teamMode && bb.teams.length > 1}
          <p class="done-title">{@html rb(bb.winner ? `${TEAM_LABELS[bb.winner]}の かち！` : "ひきわけ")}</p>
          <p class="done-runs">{TEAM_LABELS.red} {bb.score.red} − {bb.score.blue} {TEAM_LABELS.blue}</p>
        {:else}
          <p class="done-title">{@html rb("おわり！")}</p>
          <p class="done-runs">{@html rb(`みんなで ${teamMode ? bb.score[bb.teams[0]] : bb.runs}てん`)}</p>
        {/if}
        <ul class="done-list">
          {#each state.players.filter((p) => (bb.atBats[p.id] || 0) > 0) as p (p.id)}
            <li>
              <PlayerMark color={p.color} team={teamMode && bb.teams.length > 1 ? p.team : null} size={32} />
              <span class="pname">{p.name}</span>
              {#each hitsBy(p.id) as l}
                <span class="hit" class:n4={l.n === 4} class:out={l.n === OUT}>{resultName(l.n)}</span>
              {/each}
            </li>
          {/each}
        </ul>
        {#if isHost}
          <div class="done-actions" use:scanGroup>
            <button class="btn primary big" type="button" onclick={onAgain}>{@html rb("もういちど")}</button>
            <button class="btn big" type="button" onclick={onBack}>{@html rb("部屋[へや]に もどる")}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .baseball {
    position: relative;
    height: 100%;
    min-height: 0;
    border: var(--border);
    border-radius: 22px;
    overflow: hidden;
    background: #4fa656;
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .word {
    position: absolute;
    top: 6%;
    left: 50%;
    transform: translateX(-50%);
    font-size: clamp(2.2rem, 7vmin, 4.4rem);
    font-weight: 900;
    color: #fff;
    -webkit-text-stroke: 3px #1a1a1a;
    paint-order: stroke fill;
    text-shadow: 0 5px 0 #1a1a1a;
    white-space: nowrap;
    animation: pop 0.35s ease-out;
    pointer-events: none;
  }
  .word.hr {
    color: var(--homerun);
  }
  .word.out {
    color: #c9ccd2;
  }
  @keyframes pop {
    0% {
      transform: translateX(-50%) scale(0.4);
    }
    70% {
      transform: translateX(-50%) scale(1.12);
    }
    100% {
      transform: translateX(-50%) scale(1);
    }
  }
  .scorebox {
    position: absolute;
    top: 10px;
    right: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px 6px 8px;
    background: #1a1a1a;
    color: #fff;
    border-radius: 12px;
  }
  .bases {
    width: clamp(64px, 11vmin, 92px);
    height: auto;
  }
  .runs {
    display: grid;
    justify-items: center;
  }
  .runs-label {
    font-weight: 800;
    font-size: 0.95rem;
  }
  .runs-num {
    font-size: clamp(2rem, 6.5vmin, 3.4rem);
    font-weight: 900;
    line-height: 1;
    color: #fff;
    font-variant-numeric: tabular-nums;
  }
  .team-board {
    display: grid;
    gap: 4px;
    justify-items: start;
  }
  .inning {
    font-weight: 800;
    font-size: 0.95rem;
  }
  .teams {
    display: flex;
    gap: 6px;
  }
  .team {
    padding: 0 8px;
    border-radius: 6px;
    font-weight: 800;
    font-size: 1rem;
    opacity: 0.75;
  }
  .team b {
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
  }
  .team.red {
    background: var(--red);
  }
  .team.blue {
    background: var(--blue);
  }
  .team.batting {
    opacity: 1;
    box-shadow: 0 0 0 3px var(--turn);
  }
  .outs {
    display: flex;
    gap: 5px;
    align-items: center;
  }
  .out-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid #8a8f99;
  }
  .out-dot.on {
    background: #e0302d;
    border-color: #e0302d;
  }
  .plus {
    font-size: clamp(1.4rem, 4.5vmin, 2.2rem);
    font-weight: 900;
    color: #fff;
    animation: pop-in 0.4s ease-out;
  }
  @keyframes pop-in {
    0% {
      transform: scale(0.3);
      opacity: 0;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
  .batter-tag {
    position: absolute;
    left: 10px;
    bottom: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 14px 4px 8px;
    border-radius: 10px;
    background: var(--paper);
    font-weight: 900;
    font-size: clamp(1rem, 3vmin, 1.5rem);
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .done {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(255, 244, 222, 0.82);
    padding: 12px;
  }
  .done-card {
    width: min(620px, 100%);
    max-height: 100%;
    overflow: auto;
    background: var(--paper);
    border-radius: 16px;
    padding: 18px 20px;
    display: grid;
    gap: 10px;
    justify-items: center;
  }
  .done-title {
    margin: 0;
    font-size: clamp(2.2rem, 7vmin, 3.4rem);
    font-weight: 900;
  }
  .done-runs {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 900;
  }
  .done-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
    width: 100%;
  }
  .done-list li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pname {
    font-weight: 900;
    margin-right: 6px;
  }
  .hit {
    padding: 2px 10px;
    border-radius: 8px;
    border: 2px solid var(--rule-strong);
    font-weight: 800;
    background: var(--paper);
  }
  .hit.n4 {
    background: var(--homerun);
    border-color: var(--homerun);
  }
  .hit.out {
    color: var(--ink-soft);
    background: #ecebe8;
    border-color: #ecebe8;
  }
  .done-actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>

<script>
  // =====================================================================
  // 野球の画面（1つの球場）。
  //
  // ふだんはバッターボックスに寄っている。バッターボックスの前で円盤が回り、ふちの
  // ボールが黄色い帯（あたる ところ）に来たときに押すと打てる。帯の真ん中のオレンジに
  // 近いほど遠くへ飛ぶ。帯の広さは、支援者の設定（当たる広さ）と円盤の速さで決まる。
  //
  // 打つと、カメラが球場全体へ引いて、球を追う。球の影と、通った線と、落ちたところの輪で、
  // どこへ飛んだかが分かる。次のボールの前に、またバッターボックスへ寄る。
  // （以前は、バッターボックスと小さな球場を2つ並べていて、球がどこへ飛んだか分かりにくかった。）
  // 塁と得点は、右上の小さな札にまとめる。
  //
  // 角度も判定も、ホストの時計（session.hostNow）で見る。どの画面でも同じ位置に見える。
  // =====================================================================
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { session, audio, bus, predicted } from "../lib/app.js";
  import { playerById, TURN_GUARD_MS } from "../lib/engine.js";
  import { FLIGHT_MS, RUN_MS, ballAngle, judgeSwing, offsetFromSweet } from "../lib/games/baseball.js";
  import { rb, HIT_LABELS } from "../lib/text.js";

  let { onAgain, onBack } = $props();

  const state = $derived($session.state);
  const bb = $derived(state.baseball);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  const batter = $derived(playerById(state, state.turn?.playerId ?? bb?.hit?.playerId));

  // --- 時計 -------------------------------------------------------------
  let now = $state(session.hostNow());
  onMount(() => {
    let raf = 0;
    const loop = () => {
      now = session.hostNow();
      scheduleCues(now);
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

  // --- バッターボックスの絵（この中の座標。本塁が 330,500） ----------------------
  const C = { x: 330, y: 250 };
  const R = 160;
  const RB = 128;
  const BALL = 27;
  const SWEET = { x: C.x, y: C.y + RB };
  const PIVOT = { x: 150, y: SWEET.y };
  const REST = 112;
  const CONTACT = 0;
  const FOLLOW = -58;

  function arcPath(r, a0, a1) {
    const p0 = polar(C.x, C.y, r, a0);
    const p1 = polar(C.x, C.y, r, a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }

  // --- 球場（本塁が 500,1000。上が外野） --------------------------------------
  // バッターボックスの絵は、本塁に合わせて 1/4 にして置く。
  const S = 0.25;
  const BOX_AT = { x: 500 - 330 * S, y: 1000 - 500 * S };
  const toField = (p) => ({ x: BOX_AT.x + p.x * S, y: BOX_AT.y + p.y * S });
  const H = { x: 500, y: 1000 };
  const SWEET_F = toField(SWEET);
  const BASE_D = 160;
  const FIRST = polar(H.x, H.y, BASE_D, -45);
  const SECOND = { x: H.x, y: H.y - BASE_D * Math.SQRT2 };
  const THIRD = polar(H.x, H.y, BASE_D, -135);
  const FENCE_R = 600;
  const STANDS_R = 780;
  /** 落ちるところの、本塁からの距離（何塁打か）。ホームランはフェンスの向こう。 */
  const LAND = { 1: 300, 2: 430, 3: 545, 4: 700 };

  const fan = (r) => {
    const a = polar(H.x, H.y, r, -135);
    const b = polar(H.x, H.y, r, -45);
    return `M ${H.x} ${H.y} L ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)} Z`;
  };
  const arcOnly = (r) => {
    const a = polar(H.x, H.y, r, -135);
    const b = polar(H.x, H.y, r, -45);
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };
  // スタンドの席（決まった並び）。
  const SEATS = Array.from({ length: 5 }, (_, row) => {
    const r = FENCE_R + 40 + row * 30;
    const count = 26 + row * 2;
    return Array.from({ length: count }, (_, i) => {
      const a = -133 + (86 * i) / (count - 1);
      return { ...polar(H.x, H.y, r, a), a };
    });
  }).flat();

  // --- カメラ ------------------------------------------------------------
  const BOX_VIEW = { x: 418, y: 878, w: 164, h: 168 };
  const FIELD_VIEW = { x: 20, y: 170, w: 960, h: 880 };

  // --- あたる ところ・円盤 ----------------------------------------------------
  const zoneHalf = $derived(bb ? Math.min(180, (bb.window / bb.period) * 360) : 0);
  const spinDeg = $derived(bb ? (ballAngle(now, bb.sweetAt, bb.period) * 180) / Math.PI : 0);

  // --- バット（押した瞬間に振る） ------------------------------------------
  let swingAt = $state(-Infinity);
  function batAngle(dt) {
    if (!(dt >= 0) || dt > 520) return REST;
    if (dt < 90) return lerp(REST, CONTACT, easeIn(dt / 90));
    if (dt < 200) return lerp(CONTACT, FOLLOW, easeOut((dt - 90) / 110));
    return lerp(FOLLOW, REST, easeInOut((dt - 200) / 320));
  }
  const batDeg = $derived(batAngle(now - swingAt));

  // --- 打った球（ホストの決定を待たずに、この端末で先に飛ばす） ---------------------
  let localHit = $state(null);
  const hit = $derived.by(() => {
    if (bb?.hit) return bb.hit;
    if (localHit && bb?.phase === "spin" && localHit.ballFrom === bb.ballFrom && now - localHit.t < 1200) return localHit;
    return null;
  });
  $effect(() => {
    // 次のボールになったら、先取りは捨てる。
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
        const n = judgeSwing(offset, b.window);
        if (n > 0) {
          audio.batHit(n);
          localHit = { t, n, offset, ballFrom: b.ballFrom, playerId: s.turn.playerId };
          return;
        }
      }
      audio.swing();
    });
    const offEvents = session.onEvents((events, s) => {
      for (const e of events) {
        if (e.kind !== "swing" || e.playerId === get(session).myId) continue;
        swingAt = e.n > 0 && s.baseball?.hit ? s.baseball.hit.t : session.hostNow();
      }
    });
    return () => {
      offPress();
      offEvents();
    };
  });

  const showBallOnDisc = $derived(bb && bb.phase === "spin" && !hit);
  const burst = $derived(hit && now - hit.t >= 0 && now - hit.t < 320 ? clamp01((now - hit.t) / 320) : null);

  // カメラ: 打つと引いて、次のボールの前に戻る。
  const TOTAL = FLIGHT_MS + RUN_MS;
  const camMix = $derived.by(() => {
    if (!hit) return 0;
    const out = easeInOut(clamp01((now - hit.t - 140) / 620));
    const back = easeInOut(clamp01((now - hit.t - (TOTAL - 700)) / 700));
    return out * (1 - back);
  });
  const view = $derived({
    x: lerp(BOX_VIEW.x, FIELD_VIEW.x, camMix),
    y: lerp(BOX_VIEW.y, FIELD_VIEW.y, camMix),
    w: lerp(BOX_VIEW.w, FIELD_VIEW.w, camMix),
    h: lerp(BOX_VIEW.h, FIELD_VIEW.h, camMix),
  });
  /** いまの画面で、1単位が何ピクセルか。 */
  const ppu = $derived(w && h ? Math.min(w / view.w, h / view.h) : 1);

  // 飛んでいく球。早く振ると左へ、遅いと右へ。地面の影と、通った線を残す。
  const AIR_MS = FLIGHT_MS * 0.78;
  const flight = $derived.by(() => {
    if (!hit) return null;
    const t = now - hit.t - 60;
    if (t < 0) return null;
    const side = Math.max(-1, Math.min(1, hit.offset / (bb?.window || 1)));
    const a = -90 + side * 32;
    const land = polar(H.x, H.y, LAND[hit.n], a);
    const k = clamp01(t / AIR_MS);
    let ground = { x: lerp(SWEET_F.x, land.x, k), y: lerp(SWEET_F.y, land.y, k) };
    let height = Math.sin(Math.PI * k) * (0.35 + 0.22 * hit.n);
    const landed = k >= 1;
    let settle = 0;
    if (landed && hit.n < 4) {
      // 落ちたあと、少しはねて転がる。
      settle = clamp01((t - AIR_MS) / 600);
      ground = polar(H.x, H.y, LAND[hit.n] + 45 * easeOut(settle), a);
      height = Math.abs(Math.sin(Math.PI * settle * 2)) * 0.12 * (1 - settle);
    }
    return { ground, height, land, landed, sinceLand: landed ? t - AIR_MS : 0, a };
  });
  const ballR = $derived(Math.max(BALL * S, 15 / ppu));

  // ホームランの はなび（スタンドの上）。
  const fireworks = $derived.by(() => {
    if (!hit || hit.n !== 4 || !flight?.landed) return [];
    const k = flight.sinceLand / 1300;
    if (k > 1) return [];
    const base = flight.land;
    return [
      { dx: -150, dy: -40, c: "#FFD400", d: 0 },
      { dx: 140, dy: -60, c: "#FF5C8A", d: 0.15 },
      { dx: 0, dy: -110, c: "#5BC8FF", d: 0.3 },
    ].map((f) => ({ x: base.x + f.dx, y: base.y + f.dy, c: f.c, k: clamp01((k - f.d) / 0.6) }));
  });

  // --- 右上の札（塁と得点） ---------------------------------------------------
  // 球が落ちるまでは打つ前の塁、落ちたら打ったあとの塁。
  const landedNow = $derived(!!(bb?.hit && now - bb.hit.t > 60 + AIR_MS));
  const shownBases = $derived(bb ? (bb.phase === "flight" && bb.hit && !landedNow ? bb.prevBases : bb.bases) : [null, null, null]);
  const shownRuns = $derived(bb ? (bb.phase === "flight" && bb.hit && !landedNow ? bb.runs - (bb.scored?.length || 0) : bb.runs) : 0);
  const scoredFlash = $derived(bb?.phase === "flight" && landedNow && bb.scored?.length ? bb.scored.length : 0);
  const baseColor = (id) => playerById(state, id)?.color || "#FFFFFF";

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

  const resultWord = $derived(hit && now - hit.t < TOTAL - 500 ? `${HIT_LABELS[hit.n]}！` : "");
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

    <!-- 球場 -->
    <rect x="-600" y="-400" width="2200" height="2000" fill="#4FA656" />
    <path d={fan(STANDS_R)} fill="#8E9AAF" />
    {#each SEATS as seat}
      <rect x={seat.x - 9} y={seat.y - 5} width="18" height="10" rx="3" fill="#B9C3D4" transform={`rotate(${seat.a + 90} ${seat.x} ${seat.y})`} />
    {/each}
    <path d={fan(FENCE_R)} fill="url(#mow)" stroke="#1A1A1A" stroke-width="4" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    <path d={arcOnly(FENCE_R)} fill="none" stroke="#FFD400" stroke-width="8" vector-effect="non-scaling-stroke" />
    <path d={fan(255)} fill="#E2B57E" />
    <path d={`M ${H.x} ${H.y} L ${FIRST.x} ${FIRST.y} L ${SECOND.x} ${SECOND.y} L ${THIRD.x} ${THIRD.y} Z`} fill="url(#mow)" />
    <circle cx={H.x} cy={H.y - BASE_D * 0.75} r="24" fill="#E2B57E" />
    {#each [-45, -135] as a}
      {@const p0 = polar(H.x, H.y, 72, a)}
      {@const p1 = polar(H.x, H.y, FENCE_R, a)}
      <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="#FFFFFF" stroke-width="4" vector-effect="non-scaling-stroke" />
    {/each}
    {#each [FIRST, SECOND, THIRD] as b}
      <rect x={b.x - 11} y={b.y - 11} width="22" height="22" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="3" vector-effect="non-scaling-stroke" transform={`rotate(45 ${b.x} ${b.y})`} />
    {/each}

    <!-- バッターボックス（円盤・バッター・バット） -->
    <g transform={`translate(${BOX_AT.x} ${BOX_AT.y}) scale(${S})`}>
      <circle cx="330" cy="470" r="250" fill="#E2B57E" stroke="#C9965C" stroke-width="6" />
      <rect x="56" y="350" width="170" height="210" rx="6" fill="none" stroke="#FFFFFF" stroke-width="6" opacity="0.9" />
      <rect x="434" y="350" width="170" height="210" rx="6" fill="none" stroke="#FFFFFF" stroke-width="6" opacity="0.9" />
      <path d="M295 470 L365 470 L365 500 L330 530 L295 500 Z" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="4" stroke-linejoin="round" />

      <circle cx={C.x} cy={C.y + 10} r={R + 6} fill="#1A1A1A" opacity="0.25" />
      <circle cx={C.x} cy={C.y} r={R} fill="#FFF3D6" stroke="#1A1A1A" stroke-width="7" />

      <!-- あたる ところ -->
      {#if bb && bb.phase !== "done"}
        {#if zoneHalf >= 180}
          <circle cx={C.x} cy={C.y} r={RB} fill="none" stroke="#FFD84D" stroke-width={BALL * 2 + 12} opacity="0.9" />
        {:else}
          <path d={arcPath(RB, 90 - zoneHalf, 90 + zoneHalf)} fill="none" stroke="#FFD84D" stroke-width={BALL * 2 + 12} stroke-linecap="round" />
        {/if}
        <path d={arcPath(RB, 90 - Math.min(179, zoneHalf / 4), 90 + Math.min(179, zoneHalf / 4))} fill="none" stroke="#FF9F1C" stroke-width={BALL * 2 + 12} stroke-linecap="round" />
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

      <!-- バッター（ヘルメットとユニフォームは、その人の色） -->
      <g class="batter">
        <ellipse cx="96" cy="452" rx="58" ry="40" fill={batter?.color || "#CCCCCC"} stroke="#1A1A1A" stroke-width="5" />
        <path d="M120 430 Q140 410 150 398" stroke="#1A1A1A" stroke-width="16" stroke-linecap="round" fill="none" />
        <path d="M120 430 Q140 410 150 398" stroke="#F5C9A5" stroke-width="9" stroke-linecap="round" fill="none" />
        <path d="M110 470 Q140 440 150 400" stroke="#1A1A1A" stroke-width="16" stroke-linecap="round" fill="none" />
        <path d="M110 470 Q140 440 150 400" stroke="#F5C9A5" stroke-width="9" stroke-linecap="round" fill="none" />
        <circle cx="86" cy="440" r="32" fill={batter?.color || "#CCCCCC"} stroke="#1A1A1A" stroke-width="5" />
        <path d="M60 428 Q86 400 112 428" fill="none" stroke="#1A1A1A" stroke-width="5" opacity="0.35" />
        <ellipse cx="112" cy="452" rx="16" ry="9" fill="#1A1A1A" opacity="0.85" transform="rotate(35 112 452)" />
      </g>

      <!-- バット -->
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

    <!-- 飛んでいく球: 通った線・落ちたところの輪・影・球 -->
    {#if flight}
      <line x1={SWEET_F.x} y1={SWEET_F.y} x2={flight.ground.x} y2={flight.ground.y} stroke="#FFFFFF" stroke-width={5 / ppu} stroke-linecap="round" opacity="0.85" />
      {#if flight.landed}
        {@const k = clamp01(flight.sinceLand / 500)}
        <circle cx={flight.land.x} cy={flight.land.y} r={(10 + 26 * easeOut(k)) / ppu} fill="none" stroke="#FFFFFF" stroke-width={5 / ppu} opacity={(1 - k * 0.6).toFixed(2)} />
        <circle cx={flight.land.x} cy={flight.land.y} r={7 / ppu} fill="#1A1A1A" opacity="0.5" />
      {/if}
      <ellipse cx={flight.ground.x} cy={flight.ground.y} rx={ballR * 0.95} ry={ballR * 0.5} fill="#1A1A1A" opacity="0.28" />
      <g transform={`translate(${flight.ground.x.toFixed(1)} ${(flight.ground.y - flight.height * (60 / ppu) * 1.2).toFixed(1)}) scale(${(ballR / BALL) * (1 + flight.height * 0.5)})`}>
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
    <div class="word n{hit.n}" aria-hidden="true">{resultWord}</div>
  {/if}

  <!-- 塁と得点 -->
  <div class="scorebox" aria-label={`とくてん ${shownRuns}`}>
    <svg class="bases" viewBox="-44 -40 88 64" aria-hidden="true">
      {#each [{ x: 0, y: -22, i: 1 }, { x: 24, y: 2, i: 0 }, { x: -24, y: 2, i: 2 }] as b}
        <rect
          x={b.x - 10}
          y={b.y - 10}
          width="20"
          height="20"
          transform={`rotate(45 ${b.x} ${b.y})`}
          fill={shownBases[b.i] ? baseColor(shownBases[b.i]) : "transparent"}
          stroke={shownBases[b.i] ? "#FFFFFF" : "#6B6B6B"}
          stroke-width="3"
        />
      {/each}
    </svg>
    <span class="runs">
      <span class="runs-label">{@html rb("得点[とくてん]")}</span>
      <span class="runs-num">{shownRuns}</span>
    </span>
    {#if scoredFlash}<span class="plus">+{scoredFlash}</span>{/if}
  </div>

  {#if batter && bb?.phase !== "done"}
    <div class="batter-tag" style="--pc: {batter.color}">{batter.name}</div>
  {/if}

  {#if bb?.phase === "done"}
    <div class="done">
      <div class="done-card">
        <p class="done-title">{@html rb("おわり！")}</p>
        <p class="done-runs">{@html rb(`みんなで ${bb.runs}てん`)}</p>
        <ul class="done-list">
          {#each state.players.filter((p) => (bb.atBats[p.id] || 0) > 0) as p (p.id)}
            <li style="--pc: {p.color}">
              <span class="dot">{p.name.slice(0, 1)}</span>
              <span class="pname">{p.name}</span>
              {#each hitsBy(p.id) as h}
                <span class="hit n{h.n}">{HIT_LABELS[h.n]}</span>
              {/each}
            </li>
          {/each}
        </ul>
        {#if isHost}
          <div class="done-actions">
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
  .word.n4 {
    color: #ffd400;
  }
  .word.n3 {
    color: #ff9f1c;
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
    gap: 8px;
    padding: 6px 14px 6px 8px;
    background: #1a1a1a;
    color: #fff;
    border-radius: 16px;
    border: 3px solid #fff;
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
    color: #ffd400;
    font-variant-numeric: tabular-nums;
  }
  .plus {
    font-size: clamp(1.4rem, 4.5vmin, 2.2rem);
    font-weight: 900;
    color: #ffd400;
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
    padding: 4px 14px;
    border: 3px solid var(--line);
    border-radius: 999px;
    background: var(--pc);
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
    border: var(--border);
    border-radius: 24px;
    box-shadow: 0 8px 0 var(--line);
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
  .dot {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 3px solid var(--line);
    background: var(--pc);
    font-weight: 900;
  }
  .pname {
    font-weight: 900;
    margin-right: 6px;
  }
  .hit {
    padding: 2px 10px;
    border-radius: 999px;
    border: 2px solid var(--line);
    font-weight: 800;
    background: #fff3b0;
  }
  .hit.n4 {
    background: #ffd400;
  }
  .done-actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>

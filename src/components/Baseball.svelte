<script>
  // =====================================================================
  // 野球の画面。左（縦の画面では下）がバッターボックスの寄り、右（上）が小さな球場。
  //
  // バッターボックスの前で円盤が回る。ふちのボールが、黄色い帯（あたる ところ）に
  // 来たときに押すと打てる。帯の真ん中のオレンジに近いほど遠くへ飛ぶ。
  // 帯の広さは、支援者の設定（当たる広さ）と円盤の速さで決まる（見たとおりに当たる）。
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

  // --- バッターボックスの形（viewBox 0 0 600 660） ---------------------------
  const C = { x: 330, y: 250 };
  const R = 160;
  const RB = 128;
  const BALL = 27;
  const SWEET = { x: C.x, y: C.y + RB };
  const PIVOT = { x: 150, y: SWEET.y };
  const BAT_LEN = 280;
  const REST = 112;
  const CONTACT = 0;
  const FOLLOW = -58;

  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp01 = (k) => Math.max(0, Math.min(1, k));
  const easeOut = (k) => 1 - (1 - k) * (1 - k);
  const easeIn = (k) => k * k;
  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  const polar = (cx, cy, r, deg) => ({ x: cx + r * Math.cos((deg * Math.PI) / 180), y: cy + r * Math.sin((deg * Math.PI) / 180) });

  function arcPath(r, a0, a1) {
    const p0 = polar(C.x, C.y, r, a0);
    const p1 = polar(C.x, C.y, r, a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }

  // あたる ところ（黄色）と、まんなか（オレンジ = ホームラン）の角度の半分。
  const zoneHalf = $derived(bb ? Math.min(180, (bb.window / bb.period) * 360) : 0);

  // 円盤の回転（度）。ボールは円盤に乗って回る。
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

  // 飛んでいく球（バッターボックスの中）。早く振ると左へ、遅いと右へ。
  const flight = $derived.by(() => {
    if (!hit) return null;
    const k = clamp01((now - hit.t - 70) / 720);
    const side = Math.max(-1, Math.min(1, hit.offset / (bb?.window || 1)));
    const to = { x: C.x + side * 260, y: -140 };
    const e = easeOut(k);
    return {
      k,
      x: lerp(SWEET.x, to.x, e),
      y: lerp(SWEET.y, to.y, e),
      scale: 1 + 0.7 * Math.sin(Math.PI * Math.min(1, k * 0.9)),
      side,
    };
  });
  const showBallOnDisc = $derived(bb && bb.phase === "spin" && !hit);
  const burst = $derived(hit && now - hit.t >= 0 && now - hit.t < 320 ? clamp01((now - hit.t) / 320) : null);

  // --- 小さな球場（viewBox 0 0 400 400） ----------------------------------
  const H = { x: 200, y: 352 };
  const BASES = [H, { x: 290, y: 262 }, { x: 200, y: 172 }, { x: 110, y: 262 }, H];
  const FENCE_R = 270;
  const LAND = { 1: 150, 2: 205, 3: 245, 4: 330 };

  function onPath(s) {
    const i = Math.min(3, Math.floor(s));
    const f = s - i;
    return { x: lerp(BASES[i].x, BASES[i + 1].x, f), y: lerp(BASES[i].y, BASES[i + 1].y, f) };
  }

  const fieldBall = $derived.by(() => {
    if (!hit) return null;
    const k = clamp01((now - hit.t) / FLIGHT_MS);
    const side = Math.max(-1, Math.min(1, hit.offset / (bb?.window || 1)));
    const a = -90 + side * 35;
    const land = polar(H.x, H.y, LAND[hit.n], a);
    const e = easeOut(k);
    return {
      k,
      x: lerp(H.x, land.x, e),
      y: lerp(H.y, land.y, e),
      scale: 1 + Math.sin(Math.PI * k) * (0.5 + hit.n * 0.3),
      land,
    };
  });

  // ランナー。打ったあと、球が飛んでいるあいだに走り出す。
  const runners = $derived.by(() => {
    if (!bb) return [];
    const confirmed = bb.phase === "flight" && bb.hit;
    if (!confirmed) {
      const list = bb.bases.map((id, i) => (id ? { id, s: i + 1, scored: false } : null)).filter(Boolean);
      // 先取りの当たり: バッターは本塁に立っている。
      if (hit) list.push({ id: hit.playerId, s: 0, scored: false });
      return list;
    }
    const k = easeInOut(clamp01((now - bb.hit.t - FLIGHT_MS * 0.5) / (FLIGHT_MS * 0.5 + RUN_MS * 0.7)));
    const starts = bb.prevBases.map((id, i) => (id ? { id, from: i + 1 } : null)).filter(Boolean);
    starts.push({ id: bb.hit.playerId, from: 0 });
    return starts.map(({ id, from }) => {
      const at = bb.bases.indexOf(id);
      const to = at >= 0 ? at + 1 : 4;
      return { id, s: lerp(from, to, k), scored: to === 4, k };
    });
  });

  const scoredFlash = $derived(
    bb?.phase === "flight" && bb.scored?.length && now - bb.hit.t > FLIGHT_MS * 0.5 + (FLIGHT_MS * 0.5 + RUN_MS * 0.7) * 0.85
      ? bb.scored.length
      : 0
  );

  // ホームランの はなび（球場の空）。
  const fireworks = $derived.by(() => {
    if (!hit || hit.n !== 4) return [];
    const k = (now - hit.t - FLIGHT_MS * 0.7) / 1400;
    if (k < 0 || k > 1) return [];
    return [
      { x: 90, y: 70, c: "#FFD400", d: 0 },
      { x: 300, y: 55, c: "#FF5C8A", d: 0.15 },
      { x: 200, y: 30, c: "#5BC8FF", d: 0.3 },
    ].map((f) => ({ ...f, k: clamp01((k - f.d) / 0.6) }));
  });

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

  const resultWord = $derived(hit && now - hit.t < FLIGHT_MS + RUN_MS ? `${HIT_LABELS[hit.n]}！` : "");
  const hitsBy = (id) => (bb?.log || []).filter((l) => l.playerId === id);
</script>

<div class="baseball">
  <!-- バッターボックス -->
  <div class="box-view">
    <svg viewBox="0 0 600 660" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <pattern id="mow" width="60" height="60" patternUnits="userSpaceOnUse">
          <rect width="60" height="60" fill="#5DBB63" />
          <rect width="30" height="60" fill="#54B05A" />
        </pattern>
      </defs>
      <rect x="-200" y="-200" width="1000" height="1060" fill="url(#mow)" />
      <circle cx="330" cy="470" r="250" fill="#E2B57E" stroke="#C9965C" stroke-width="6" />
      <!-- バッターボックスの線と本塁 -->
      <rect x="56" y="350" width="170" height="210" rx="6" fill="none" stroke="#FFFFFF" stroke-width="6" opacity="0.9" />
      <rect x="434" y="350" width="170" height="210" rx="6" fill="none" stroke="#FFFFFF" stroke-width="6" opacity="0.9" />
      <path d="M295 470 L365 470 L365 500 L330 530 L295 500 Z" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="4" stroke-linejoin="round" />

      <!-- 円盤の台 -->
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

      <!-- 打った球 -->
      {#if burst !== null}
        <g transform={`translate(${SWEET.x} ${SWEET.y}) scale(${(0.6 + burst * 1.2).toFixed(2)})`} opacity={(1 - burst).toFixed(2)}>
          <path d="M0 -70 L16 -18 L68 -22 L26 10 L44 62 L0 30 L-44 62 L-26 10 L-68 -22 L-16 -18 Z" fill="#FFF27A" stroke="#1A1A1A" stroke-width="4" stroke-linejoin="round" />
        </g>
      {/if}
      {#if flight && flight.k < 1}
        <ellipse cx={flight.x} cy={flight.y + 30 * flight.scale} rx={BALL * 0.9} ry={BALL * 0.45} fill="#1A1A1A" opacity="0.2" />
        <g transform={`translate(${flight.x.toFixed(1)} ${flight.y.toFixed(1)}) scale(${flight.scale.toFixed(2)})`}>
          <circle r={BALL} fill="#FFFFFF" stroke="#1A1A1A" stroke-width="5" />
          <path d="M-11 -18 Q 1 0 -11 18 M11 -18 Q -1 0 11 18" fill="none" stroke="#E0302D" stroke-width="3.6" />
        </g>
      {/if}
    </svg>

    {#if resultWord}
      <div class="word n{hit.n}" aria-hidden="true">{resultWord}</div>
    {/if}
    {#if batter && bb?.phase !== "done"}
      <div class="batter-tag" style="--pc: {batter.color}">{batter.name}</div>
    {/if}
  </div>

  <!-- 小さな球場とランナー -->
  <div class="field-view">
    <svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect x="0" y="0" width="400" height="400" fill="#7FB8E0" />
      <rect x="0" y="0" width="400" height="120" fill="#8E9AAF" />
      {#each Array.from({ length: 9 }, (_, i) => i) as i}
        <rect x={i * 46 + 4} y="14" width="38" height="18" rx="6" fill="#B9C3D4" />
        <rect x={i * 46 + 24} y="48" width="38" height="18" rx="6" fill="#B9C3D4" />
      {/each}
      <path
        d={`M ${H.x} ${H.y} L ${polar(H.x, H.y, FENCE_R, -135).x} ${polar(H.x, H.y, FENCE_R, -135).y} A ${FENCE_R} ${FENCE_R} 0 0 1 ${polar(H.x, H.y, FENCE_R, -45).x} ${polar(H.x, H.y, FENCE_R, -45).y} Z`}
        fill="#5DBB63"
        stroke="#1A1A1A"
        stroke-width="4"
        stroke-linejoin="round"
      />
      <path
        d={`M ${polar(H.x, H.y, FENCE_R, -135).x} ${polar(H.x, H.y, FENCE_R, -135).y} A ${FENCE_R} ${FENCE_R} 0 0 1 ${polar(H.x, H.y, FENCE_R, -45).x} ${polar(H.x, H.y, FENCE_R, -45).y}`}
        fill="none"
        stroke="#FFD400"
        stroke-width="8"
      />
      <path d="M200 392 L320 262 L200 132 L80 262 Z" fill="#E2B57E" stroke="#C9965C" stroke-width="3" />
      <path d="M200 352 L290 262 L200 172 L110 262 Z" fill="#5DBB63" />
      <circle cx="200" cy="262" r="16" fill="#E2B57E" />
      {#each BASES.slice(1, 4) as b}
        <rect x={b.x - 11} y={b.y - 11} width="22" height="22" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="3" transform={`rotate(45 ${b.x} ${b.y})`} />
      {/each}
      <path d="M190 346 L210 346 L210 354 L200 362 L190 354 Z" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="3" />

      {#each runners as r (r.id)}
        {@const p = onPath(r.s)}
        {@const pl = playerById(state, r.id)}
        <g transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} opacity={r.scored && r.k >= 1 ? 0 : 1}>
          <circle r="18" fill={pl?.color || "#CCCCCC"} stroke="#1A1A1A" stroke-width="4" />
          <text y="7" text-anchor="middle" font-size="19" font-weight="900" fill="#1A1A1A">{pl?.name?.slice(0, 1) || ""}</text>
        </g>
      {/each}

      {#each fireworks as f}
        {#if f.k > 0 && f.k < 1}
          {#each Array.from({ length: 10 }, (_, i) => i * 36) as a}
            {@const p = polar(f.x, f.y, 10 + f.k * 50, a)}
            <circle cx={p.x} cy={p.y} r={6 * (1 - f.k) + 2} fill={f.c} stroke="#1A1A1A" stroke-width="1.5" />
          {/each}
        {/if}
      {/each}

      {#if fieldBall && fieldBall.k < 1}
        <circle cx={fieldBall.x} cy={fieldBall.y} r={9 * fieldBall.scale} fill="#FFFFFF" stroke="#1A1A1A" stroke-width="3" />
      {/if}
      {#if scoredFlash}
        <text x={H.x + 48} y={H.y - 8} font-size="40" font-weight="900" fill="#FFFFFF" stroke="#1A1A1A" stroke-width="7" paint-order="stroke">+{scoredFlash}</text>
      {/if}
    </svg>
    <div class="score" aria-label={`とくてん ${bb?.runs ?? 0}`}>
      <span class="score-label">{@html rb("得点[とくてん]")}</span>
      <span class="score-num">{bb?.runs ?? 0}</span>
    </div>
  </div>

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
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 12px;
  }
  @media (orientation: portrait) {
    .baseball {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 2fr) minmax(0, 3fr);
    }
    .field-view {
      order: -1;
    }
  }
  .box-view,
  .field-view {
    position: relative;
    min-height: 0;
    border: var(--border);
    border-radius: 22px;
    overflow: hidden;
    background: #5dbb63;
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .field-view {
    background: #7fb8e0;
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
  .score {
    position: absolute;
    right: 10px;
    bottom: 10px;
    display: grid;
    justify-items: center;
    padding: 4px 16px 6px;
    background: #1a1a1a;
    color: #fff;
    border-radius: 16px;
    border: 3px solid #fff;
  }
  .score-label {
    font-weight: 800;
    font-size: 0.95rem;
  }
  .score-num {
    font-size: clamp(2.2rem, 7vmin, 3.6rem);
    font-weight: 900;
    line-height: 1;
    color: #ffd400;
    font-variant-numeric: tabular-nums;
  }
  .done {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(255, 244, 222, 0.82);
    border-radius: 22px;
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

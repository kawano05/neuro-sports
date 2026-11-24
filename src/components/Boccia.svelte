<script>
  // =====================================================================
  // ボッチャの画面。手前の回転台にランプ（すべり台）が乗っている。
  //   むき   … ランプが左右に首を振る。台のふちの目盛りで向きが分かる。押すと止まる。
  //   つよさ … 玉がランプを上り下りする。高いところ（濃いオレンジの段）ほど遠くへ。
  // 設定で「とどく ところの線」を出すと、止まるところの輪が見える。
  // 横長の画面では、コートを横にして（投げる人が左）、玉を大きく見せる。
  // =====================================================================
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { session, audio, bus, predicted } from "../lib/app.js";
  import { playerById, RAMP_DROP_MS } from "../lib/engine.js";
  import {
    AIM_MAX_DEG,
    BALL_R,
    COURT,
    JACK_R,
    RAMP_EXIT,
    RAMP_TRAVEL,
    TURNTABLE as TT,
    aimAt,
    autoPower,
    powerAt,
    rampExit,
    restingPoint,
  } from "../lib/games/boccia.js";
  import { rb, TEAM_LABELS } from "../lib/text.js";
  import PlayerMark from "./PlayerMark.svelte";

  let { onNextEnd, onBack } = $props();

  const state = $derived($session.state);
  const bc = $derived(state.boccia);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  const thrower = $derived(playerById(state, state.turn?.playerId));
  const TEAM_COLOR = { red: "#E0302D", blue: "#1E6FD9" };

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

  // 横長なら、コートを横にする。
  let w = $state(0);
  let h = $state(0);
  const landscape = $derived(w > h * 1.05);
  const viewBox = $derived(landscape ? "-1180 -30 1210 660" : "-30 -30 660 1210");

  // --- この端末で先に止める（押した瞬間の向き・つよさ） ---------------------------
  let pending = $state(null);
  onMount(() =>
    bus.on("press", ({ t, myTurn, pid }) => {
      if (!myTurn) return;
      const b = get(session).state?.boccia;
      if (!b || (b.phase !== "aim" && b.phase !== "power") || t < b.readyAt) {
        audio.cheerPop();
        predicted.add(pid);
        return;
      }
      predicted.add(pid);
      audio.lock();
      if (b.phase === "aim") pending = { phase: "aim", value: aimAt(t, b.aimT0, b.period), key: b.aimT0 };
      else pending = { phase: "power", value: powerAt(t, b.powerT0, b.period), key: b.powerT0 };
    })
  );

  const angle = $derived.by(() => {
    if (!bc) return 0;
    if (bc.phase === "aim") {
      if (pending?.phase === "aim" && pending.key === bc.aimT0) return pending.value;
      return aimAt(now, bc.aimT0, bc.period);
    }
    if (bc.phase === "power") return bc.angle ?? 0;
    if (bc.roll) return bc.roll.angle;
    return 0;
  });

  const power = $derived.by(() => {
    if (!bc) return 0.5;
    if (bc.phase === "power") {
      if (pending?.phase === "power" && pending.key === bc.powerT0) return pending.value;
      return powerAt(now, bc.powerT0, bc.period);
    }
    if (bc.phase === "roll" && bc.roll) return bc.roll.power;
    if (bc.phase === "aim" && pending?.phase === "aim" && pending.key === bc.aimT0 && bc.presses === 1) return autoPower(pending.value, bc.jack);
    return 0.5;
  });

  /** ランプの上の玉の位置（回転台の中心からの y、上がマイナス）。 */
  const rampY = (p) => -RAMP_EXIT + RAMP_TRAVEL.from + p * (RAMP_TRAVEL.to - RAMP_TRAVEL.from);

  // --- 転がり（ホストが計算したコマを、時刻に合わせて見せる） ---------------------
  let cache = { key: null, snaps: [] };
  function snapshots(roll) {
    if (cache.key === roll.t0) return cache.snaps;
    const exit = rampExit(roll.angle);
    let cur = { jack: [roll.before.jack.x, roll.before.jack.y] };
    for (const b of roll.before.balls) if (!b.out) cur[b.id] = [b.x, b.y];
    cur[roll.thrown.id] = [exit.x, exit.y];
    const snaps = [];
    for (const frame of roll.frames) {
      cur = { ...cur, ...frame };
      snaps.push(cur);
    }
    cache = { key: roll.t0, snaps };
    return snaps;
  }

  const view = $derived.by(() => {
    if (!bc) return { jack: null, balls: [], onRamp: null };
    const team = bc.current?.team || "red";
    if (bc.phase === "roll" && bc.roll) {
      const roll = bc.roll;
      const teamOf = Object.fromEntries([...roll.before.balls, roll.thrown].map((b) => [b.id, b.team]));
      if (now < roll.t0) {
        // ランプを下りている。
        const k = Math.max(0, (now - roll.releasedAt) / RAMP_DROP_MS);
        return {
          jack: roll.before.jack,
          balls: roll.before.balls.filter((b) => !b.out),
          onRamp: { team: roll.thrown.team, y: rampY(roll.power * (1 - Math.min(1, k))) },
        };
      }
      const snaps = snapshots(roll);
      const index = Math.floor(((now - roll.t0) / 1000) * roll.fps);
      if (index < snaps.length) {
        const snap = snaps[Math.max(0, index)];
        const balls = Object.entries(snap)
          .filter(([id]) => id !== "jack")
          .map(([id, [x, y]]) => ({ id, team: teamOf[id], x, y, out: x < 0 || x > COURT.w || y < 0 || y > COURT.h + BALL_R }));
        return { jack: { x: snap.jack[0], y: snap.jack[1] }, balls, onRamp: null };
      }
    }
    const onRamp = bc.phase === "aim" || bc.phase === "power" ? { team, y: rampY(bc.phase === "power" ? power : 0.5) } : null;
    return { jack: bc.jack, balls: bc.balls.filter((b) => !b.out), onRamp };
  });

  // とどく ところ（むきでは向きの線、つよさでは止まるところの輪）。
  const guide = $derived.by(() => {
    if (!bc?.guide || (bc.phase !== "aim" && bc.phase !== "power")) return null;
    const exit = rampExit(angle);
    if (bc.phase === "aim" && bc.presses === 2) {
      const end = restingPoint(angle, 1);
      return { x1: exit.x, y1: exit.y, x2: end.x, y2: end.y, ring: null };
    }
    const p = bc.phase === "aim" ? autoPower(angle, bc.jack) : power;
    const end = restingPoint(angle, p);
    return { x1: exit.x, y1: exit.y, x2: end.x, y2: end.y, ring: end };
  });

  // --- 合図の音 -----------------------------------------------------------
  // むき: ランプがジャックのほうを向いた瞬間に「ポーン」。つよさ: ジャックまで届く高さで「ポーン」。
  const scheduled = new Set();
  function crossings(t0, period, v, from, to, shift = 0) {
    const out = [];
    for (const phase of [v / 2, 1 - v / 2]) {
      const base = t0 - shift + phase * period;
      const m0 = Math.ceil((from - base) / period);
      for (let m = m0; base + m * period <= to; m += 1) out.push(base + m * period);
    }
    return out;
  }
  function scheduleCues(t) {
    const s = get(session).state;
    const b = s?.boccia;
    if (!b || !s.settings.boccia.cue || !s.turn) return;
    let times = [];
    if (b.phase === "aim") {
      const jackDeg = (Math.atan2(b.jack.x - TT.x, TT.y - b.jack.y) * 180) / Math.PI;
      if (Math.abs(jackDeg) > AIM_MAX_DEG) return;
      const v = (jackDeg / AIM_MAX_DEG + 1) / 2;
      times = crossings(b.aimT0, b.period, v, t, t + 160, b.period / 4);
    } else if (b.phase === "power" && b.angle !== null) {
      const v = autoPower(b.angle, b.jack);
      times = crossings(b.powerT0, b.period, v, t, t + 160);
    } else return;
    for (const at of times) {
      if (at < b.readyAt || at <= t) continue;
      const key = `${b.phase}:${b.aimT0}:${Math.round(at)}`;
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      if (scheduled.size > 64) scheduled.delete(scheduled.values().next().value);
      audio.cueAtHost("now", at, t);
    }
  }

  // 玉どうしが当たった音（転がりの途中で、近づいた瞬間）。
  let clackKey = null;
  $effect(() => {
    const roll = bc?.roll;
    if (!roll || bc.phase !== "roll" || clackKey === roll.t0) return;
    clackKey = roll.t0;
    const snaps = snapshots(roll);
    const ids = Object.keys(snaps[0] || {});
    const hits = [];
    const touching = new Set();
    snaps.forEach((snap, i) => {
      for (let a = 0; a < ids.length; a += 1) {
        for (let c = a + 1; c < ids.length; c += 1) {
          const pa = snap[ids[a]];
          const pc = snap[ids[c]];
          if (!pa || !pc) continue;
          const key = `${ids[a]}|${ids[c]}`;
          const close = Math.hypot(pa[0] - pc[0], pa[1] - pc[1]) <= BALL_R * 2 + 3;
          if (close && !touching.has(key)) hits.push(i / roll.fps);
          if (close) touching.add(key);
          else touching.delete(key);
        }
      }
    });
    const delay = Math.max(0, (roll.t0 - session.hostNow()) / 1000);
    hits.slice(0, 6).forEach((s) => audio.clack(delay + s));
  });

  const ticks = Array.from({ length: 9 }, (_, i) => -AIM_MAX_DEG + i * (AIM_MAX_DEG / 4));
  const polar = (r, deg) => ({ x: TT.x + r * Math.sin((deg * Math.PI) / 180), y: TT.y - r * Math.cos((deg * Math.PI) / 180) });
  const result = $derived(bc?.phase === "end" ? bc.result : null);
  const closestIds = $derived(new Set((result?.closest || []).map((c) => c.id)));
</script>

<div class="boccia" bind:clientWidth={w} bind:clientHeight={h}>
  <svg {viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <g transform={landscape ? "rotate(90)" : ""}>
      <!-- 床とコート -->
      <rect x="-200" y="-200" width="1000" height="1600" fill="#9FB7C9" />
      <rect x="0" y="0" width={COURT.w} height={COURT.h} fill="#D6E6F2" stroke="#FFFFFF" stroke-width="8" />
      <rect x="0" y={COURT.h} width={COURT.w} height="260" fill="#BCD0E0" stroke="#FFFFFF" stroke-width="8" />
      <path d={`M ${COURT.w / 2 - 22} ${COURT.h / 2 - 22} L ${COURT.w / 2 + 22} ${COURT.h / 2 + 22} M ${COURT.w / 2 + 22} ${COURT.h / 2 - 22} L ${COURT.w / 2 - 22} ${COURT.h / 2 + 22}`} stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" />

      <!-- とどく ところ -->
      {#if guide}
        <line x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2} stroke="#1A1A1A" stroke-width="5" stroke-dasharray="4 16" stroke-linecap="round" opacity="0.55" />
        {#if guide.ring}
          <circle cx={guide.ring.x} cy={guide.ring.y} r={BALL_R + 8} fill="none" stroke={TEAM_COLOR[bc.current.team]} stroke-width="6" stroke-dasharray="10 8" />
        {/if}
      {/if}

      <!-- いちばん近い玉への線（エンドの終わり） -->
      {#if result && view.jack}
        {#each bc.balls.filter((b) => closestIds.has(b.id)) as b (b.id)}
          <line x1={view.jack.x} y1={view.jack.y} x2={b.x} y2={b.y} stroke={TEAM_COLOR[b.team]} stroke-width="6" stroke-dasharray="12 8" />
        {/each}
      {/if}

      <!-- 玉 -->
      {#each view.balls as b (b.id)}
        <g transform={`translate(${b.x} ${b.y})`} opacity={b.out ? 0.35 : 1}>
          {#if closestIds.has(b.id)}
            <circle r={BALL_R + 12} fill="#FFD400" stroke="#1A1A1A" stroke-width="4" />
          {/if}
          <circle r={BALL_R} fill={TEAM_COLOR[b.team]} stroke="#1A1A1A" stroke-width="5" />
          <circle cx="-7" cy="-8" r="6" fill="#FFFFFF" opacity="0.45" />
        </g>
      {/each}
      {#if view.jack}
        <g transform={`translate(${view.jack.x} ${view.jack.y})`}>
          <circle r={JACK_R + 5} fill="none" stroke="#FFFFFF" stroke-width="3" opacity="0.8" />
          <circle r={JACK_R} fill="#FFFFFF" stroke="#1A1A1A" stroke-width="5" />
        </g>
      {/if}

      <!-- 回転台と目盛り -->
      <circle cx={TT.x} cy={TT.y + 8} r="112" fill="#1A1A1A" opacity="0.25" />
      <circle cx={TT.x} cy={TT.y} r="108" fill="#455A64" stroke="#1A1A1A" stroke-width="6" />
      {#each ticks as a}
        {@const p0 = polar(a === 0 ? 70 : 82, a)}
        {@const p1 = polar(102, a)}
        <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={a === 0 ? "#FFD400" : "#FFFFFF"} stroke-width={a === 0 ? 7 : 5} stroke-linecap="round" />
      {/each}

      <!-- ランプ（向きに合わせて回る） -->
      <g transform={`rotate(${angle.toFixed(2)} ${TT.x} ${TT.y})`}>
        <rect x={TT.x - 36} y={TT.y - RAMP_EXIT - 10} width="72" height={RAMP_EXIT + 140} rx="10" fill="#E7B56A" stroke="#1A1A1A" stroke-width="6" />
        {#each [0, 0.25, 0.5, 0.75, 1] as p, i}
          <line
            x1={TT.x - 30}
            x2={TT.x + 30}
            y1={TT.y + rampY(p)}
            y2={TT.y + rampY(p)}
            stroke={["#FFE7A3", "#FFCF6B", "#FFB03B", "#FF8A1F", "#E8590C"][i]}
            stroke-width={6 + i * 2.5}
            stroke-linecap="round"
          />
        {/each}
        <line x1={TT.x - 36} y1={TT.y - RAMP_EXIT - 4} x2={TT.x - 36} y2={TT.y + 126} stroke="#8C5A2B" stroke-width="10" stroke-linecap="round" />
        <line x1={TT.x + 36} y1={TT.y - RAMP_EXIT - 4} x2={TT.x + 36} y2={TT.y + 126} stroke="#8C5A2B" stroke-width="10" stroke-linecap="round" />
        <path d={`M ${TT.x} ${TT.y - RAMP_EXIT - 40} l -16 22 l 32 0 Z`} fill="#1A1A1A" />
        {#if view.onRamp}
          <circle cx={TT.x} cy={TT.y + view.onRamp.y} r={BALL_R} fill={TEAM_COLOR[view.onRamp.team]} stroke="#1A1A1A" stroke-width="5" />
          <circle cx={TT.x - 7} cy={TT.y + view.onRamp.y - 8} r="6" fill="#FFFFFF" opacity="0.45" />
        {/if}
      </g>
    </g>
  </svg>

  <!-- 点数と、残りの玉 -->
  <div class="board">
    {#each bc?.teams || [] as team}
      <div class="team {team}" class:now={bc.current?.team === team && bc.phase !== "end"}>
        {#if bc.teams.length > 1}
          <span class="team-name">{TEAM_LABELS[team]}</span>
          <span class="team-score">{bc.score[team]}</span>
        {/if}
        <span class="left" aria-label={`のこり ${bc.left[team]}`}>
          {#each Array.from({ length: bc.perTeam }, (_, i) => i) as i}
            <span class="mini" class:used={i >= bc.left[team]}></span>
          {/each}
        </span>
      </div>
    {/each}
  </div>

  {#if thrower && bc?.phase !== "end"}
    <div class="thrower">
      <PlayerMark color={thrower.color} team={bc.current.team} size={30} />{thrower.name}
    </div>
  {/if}

  {#if result}
    <div class="end">
      <div class="end-card">
        {#if bc.teams.length < 2}
          <p class="end-title">{@html rb("いちばん ちかい！")}</p>
        {:else if result.team}
          <p class="end-title" style="color: {TEAM_COLOR[result.team]}">{@html rb(`${TEAM_LABELS[result.team]}の かち！ ${result.points}てん`)}</p>
        {:else}
          <p class="end-title">{@html rb("どちらも 0てん")}</p>
        {/if}
        {#if isHost}
          <div class="end-actions">
            <button class="btn primary big" type="button" onclick={onNextEnd}>{@html rb("つぎの エンド")}</button>
            <button class="btn" type="button" onclick={onBack}>{@html rb("部屋[へや]に もどる")}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .boccia {
    position: relative;
    height: 100%;
    min-height: 0;
    border: var(--border);
    border-radius: 22px;
    overflow: hidden;
    background: #9fb7c9;
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .board {
    position: absolute;
    top: 10px;
    right: 10px;
    display: grid;
    gap: 8px;
  }
  .team {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-radius: var(--radius);
    background: var(--paper);
  }
  .team.now {
    background: var(--turn);
  }
  .team-name {
    font-weight: 900;
    color: #fff;
    padding: 2px 10px;
    border-radius: 10px;
  }
  .team.red .team-name {
    background: var(--red);
  }
  .team.blue .team-name {
    background: var(--blue);
  }
  .team-score {
    font-size: 2rem;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    min-width: 1.2em;
    text-align: center;
  }
  .left {
    display: flex;
    gap: 4px;
  }
  .mini {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--line);
  }
  .team.red .mini {
    background: var(--red);
  }
  .team.blue .mini {
    background: var(--blue);
  }
  .mini.used {
    background: transparent !important;
    opacity: 0.35;
  }
  .thrower {
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
  }
  .end {
    position: absolute;
    inset: 0;
    display: grid;
    align-items: end;
    justify-items: center;
    padding: 14px;
    pointer-events: none;
  }
  .end-card {
    pointer-events: auto;
    background: var(--paper);
    border-radius: 16px;
    padding: 12px 18px;
    display: grid;
    gap: 10px;
    justify-items: center;
  }
  .end-title {
    margin: 0;
    font-size: clamp(1.8rem, 6vmin, 3rem);
    font-weight: 900;
  }
  .end-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>

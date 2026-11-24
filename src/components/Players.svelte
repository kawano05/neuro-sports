<script>
  // 部屋にいる人。番の人は黄色く光る。押した人は、その場で弾む（だれが押したかが分かる）。
  import { onMount } from "svelte";
  import { session } from "../lib/app.js";
  import { rb, TEAM_LABELS } from "../lib/text.js";

  /** compact … 遊んでいるあいだの細い列。full … 待っている部屋の大きい列（ホストの操作つき）。 */
  let { compact = false, showTeams = false } = $props();

  const state = $derived($session.state);
  const myId = $derived($session.myId);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");

  // 押した人を、少しのあいだ光らせる。
  let pulses = $state({});
  onMount(() =>
    session.onEvents((events) => {
      for (const e of events) {
        if (!e.playerId) continue;
        if (e.kind !== "test" && e.kind !== "cheer" && e.kind !== "swing" && e.kind !== "lock") continue;
        const key = `${e.playerId}`;
        pulses = { ...pulses, [key]: { id: e.id, kind: e.kind } };
        setTimeout(() => {
          if (pulses[key]?.id === e.id) {
            const { [key]: _, ...rest } = pulses;
            pulses = rest;
          }
        }, 900);
      }
    })
  );

  function makeTurn(player) {
    if (!isHost || state.screen !== "game" || !player.connected) return;
    session.act({ type: "setTurn", id: player.id });
  }
</script>

<ul class="players" class:compact>
  {#each state.players as player (player.id)}
    {@const turn = state.turn?.playerId === player.id}
    {@const pulse = pulses[player.id]}
    <li
      class="player"
      class:turn
      class:away={!player.connected}
      class:watch={player.role === "watch"}
      class:pulse={!!pulse}
      class:cheer={pulse?.kind === "cheer"}
      style="--pc: {player.color}"
    >
      <button
        class="who"
        type="button"
        disabled={!isHost || state.screen !== "game" || !player.connected}
        onclick={() => makeTurn(player)}
        aria-label={`${player.name}${turn ? "（ばん）" : ""}`}
      >
        <span class="dot" class:red={showTeams && player.team === "red"} class:blue={showTeams && player.team === "blue"}>
          {player.name.slice(0, 1)}
        </span>
        <span class="name">{player.name}{#if player.id === myId}<span class="you">{@html rb("（じぶん）")}</span>{/if}</span>
        {#if pulse?.kind === "cheer"}<span class="flag" aria-hidden="true">📣</span>{/if}
      </button>

      {#if !compact}
        <div class="controls">
          {#if isHost || player.id === myId}
            <button
              class="btn small"
              type="button"
              onclick={() =>
                player.id === myId
                  ? session.setMyRole(player.role === "play" ? "watch" : "play")
                  : session.act({ type: "setRole", id: player.id, role: player.role === "play" ? "watch" : "play" })}
            >
              {@html rb(player.role === "play" ? "あそぶ" : "見[み]るだけ")}
            </button>
          {:else}
            <span class="role">{@html rb(player.role === "play" ? "あそぶ" : "見[み]るだけ")}</span>
          {/if}
          {#if showTeams && player.role === "play"}
            {#if isHost}
              <button
                class="btn small team {player.team}"
                type="button"
                onclick={() => session.act({ type: "setTeam", id: player.id, team: player.team === "red" ? "blue" : "red" })}
              >
                {TEAM_LABELS[player.team]}
              </button>
            {:else}
              <span class="role team {player.team}">{TEAM_LABELS[player.team]}</span>
            {/if}
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .players {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .players.compact {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .player {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    background: var(--paper);
    border: 3px solid var(--line);
    border-radius: 16px;
    transition: transform 0.12s ease;
  }
  .compact .player {
    padding: 4px 8px 4px 4px;
    border-radius: 999px;
  }
  .player.turn {
    background: var(--turn);
    box-shadow: 0 0 0 4px var(--line);
  }
  .player.away {
    opacity: 0.4;
  }
  .player.watch .dot {
    background: var(--muted);
  }
  .player.pulse {
    animation: bump 0.45s ease;
  }
  .player.pulse:not(.turn) {
    background: #fff9c9;
  }
  @keyframes bump {
    0% {
      transform: scale(1);
    }
    35% {
      transform: scale(1.12);
    }
    100% {
      transform: scale(1);
    }
  }
  .who {
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    min-width: 0;
    font-weight: 800;
  }
  .who:disabled {
    cursor: default;
    opacity: 1;
  }
  .dot {
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 3px solid var(--line);
    background: var(--pc);
    font-weight: 900;
    font-size: 1.2rem;
  }
  .compact .dot {
    width: 36px;
    height: 36px;
    font-size: 1rem;
  }
  .dot.red {
    box-shadow: 0 0 0 4px var(--red);
  }
  .dot.blue {
    box-shadow: 0 0 0 4px var(--blue);
  }
  .name {
    font-size: 1.2rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compact .name {
    font-size: 1rem;
  }
  .you {
    font-size: 0.8em;
    color: var(--ink-soft);
    margin-left: 4px;
  }
  .flag {
    font-size: 1.2rem;
  }
  .controls {
    display: flex;
    gap: 8px;
    flex: none;
  }
  .role {
    font-weight: 800;
    padding: 6px 10px;
    border-radius: 12px;
    background: var(--muted);
  }
  .team.red {
    background: var(--red);
    color: #fff;
  }
  .team.blue {
    background: var(--blue);
    color: #fff;
  }
</style>

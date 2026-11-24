<script>
  // 遊んでいる画面の枠。上に「だれの ばん」、まんなかに遊び、下に大きな「おす」。
  // 遊びの画面（ステージ）を押しても、スイッチ1回（neuro と同じ）。
  import { session } from "../lib/app.js";
  import { playerById } from "../lib/engine.js";
  import { rb, GAME_LABELS, TEAM_LABELS } from "../lib/text.js";
  import Players from "./Players.svelte";
  import PressButton from "./PressButton.svelte";
  import Baseball from "./Baseball.svelte";
  import Boccia from "./Boccia.svelte";

  let { surface, onSettings } = $props();

  const state = $derived($session.state);
  const myId = $derived($session.myId);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  const turnPlayer = $derived(playerById(state, state.turn?.playerId));
  const myTurn = $derived(state.turn?.playerId === myId);
  const team = $derived(state.game === "boccia" && state.boccia?.teams?.length > 1 ? state.boccia.current?.team : null);

  const again = () => session.act({ type: "start", game: state.game });
  const back = () => session.act({ type: "stop" });
</script>

<main class="game" data-game={state.game}>
  <header class="top">
    <div class="turn" class:mine={myTurn} style="--pc: {turnPlayer?.color || 'transparent'}" aria-live="polite">
      {#if turnPlayer}
        {#if team}<span class="team-chip {team}">{TEAM_LABELS[team]}</span>{/if}
        <span class="turn-dot">{turnPlayer.name.slice(0, 1)}</span>
        <span class="turn-text">{@html rb(`${turnPlayer.name}さんの ばん`)}</span>
      {:else}
        <span class="turn-text game-name">{@html rb(GAME_LABELS[state.game])}</span>
      {/if}
    </div>
    <div class="tools">
      {#if state.roomCode}
        <span class="code" aria-label={`へやの ばんごう ${state.roomCode}`}>{state.roomCode}</span>
      {/if}
      {#if isHost}
        <button class="btn small" type="button" onclick={() => session.act({ type: "next" })}>{@html rb("つぎの 人[ひと]")}</button>
        <button class="btn small" type="button" onclick={onSettings} aria-label="せってい">⚙</button>
        <button class="btn small" type="button" onclick={back}>{@html rb("おわる")}</button>
      {/if}
    </div>
  </header>

  {#if $session.status === "closed"}
    <p class="notice" role="alert">{@html rb("ホストとの つながりが きれました")}</p>
  {/if}

  <section class="stage" use:surface>
    {#if state.game === "baseball"}
      <Baseball onAgain={again} onBack={back} />
    {:else}
      <Boccia onNextEnd={() => session.act({ type: "nextEnd" })} onBack={back} />
    {/if}
  </section>

  <aside class="people">
    <Players compact showTeams={state.game === "boccia"} />
  </aside>

  <footer class="press-area">
    <PressButton {surface} mode={myTurn ? "turn" : "cheer"} />
  </footer>
</main>

<style>
  .game {
    height: 100dvh;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr) auto auto;
    gap: 10px;
    padding: 10px 12px 14px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .turn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 16px 4px 6px;
    border: var(--border);
    border-radius: 999px;
    background: var(--paper);
    margin-right: auto;
    min-height: 56px;
    max-width: 100%;
  }
  .turn.mine {
    background: var(--turn);
    animation: glow 1.2s ease-in-out infinite;
  }
  @keyframes glow {
    50% {
      box-shadow: 0 0 0 6px rgba(255, 212, 0, 0.55);
    }
  }
  .turn-dot {
    flex: none;
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    border: 3px solid var(--line);
    background: var(--pc);
    font-weight: 900;
    font-size: 1.2rem;
  }
  .turn-text {
    font-size: clamp(1.3rem, 4vmin, 2rem);
    font-weight: 900;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .game-name {
    padding-left: 10px;
  }
  .team-chip {
    padding: 2px 10px;
    border-radius: 999px;
    color: #fff;
    font-weight: 900;
    border: 3px solid var(--line);
  }
  .team-chip.red {
    background: var(--red);
  }
  .team-chip.blue {
    background: var(--blue);
  }
  .tools {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .code {
    font-weight: 900;
    font-size: 1.3rem;
    letter-spacing: 0.12em;
    padding: 4px 10px;
    border: 3px solid var(--line);
    border-radius: 12px;
    background: var(--paper);
  }
  .notice {
    margin: 0;
    padding: 8px 12px;
    border: var(--border);
    border-radius: 14px;
    background: #ffd9d6;
    font-weight: 800;
  }
  .stage {
    min-height: 0;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
  }
  .press-area {
    height: clamp(84px, 15vh, 140px);
  }
  @media (orientation: landscape) and (min-width: 900px) {
    .game {
      grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
      grid-template-rows: auto auto minmax(0, 1fr) auto;
    }
    .top,
    .notice {
      grid-column: 1 / -1;
    }
    .stage {
      grid-column: 1;
      grid-row: 3 / 5;
    }
    .people {
      grid-column: 2;
      grid-row: 3;
      overflow: auto;
    }
    .people :global(.players.compact) {
      display: grid;
    }
    .press-area {
      grid-column: 2;
      grid-row: 4;
      height: clamp(150px, 30vh, 260px);
    }
  }
</style>

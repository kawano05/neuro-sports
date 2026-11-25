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
  import PlayerMark from "./PlayerMark.svelte";
  import Icon from "./Icon.svelte";
  import JoinRequests from "./JoinRequests.svelte";
  import { scanning } from "../lib/scan.js";

  let { surface, onSettings } = $props();

  const state = $derived($session.state);
  const myId = $derived($session.myId);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  const turnPlayer = $derived(playerById(state, state.turn?.playerId));
  const myTurn = $derived(state.turn?.playerId === myId);
  const team = $derived(
    state.game === "boccia"
      ? state.boccia?.teams?.length > 1 ? state.boccia.current?.team : null
      : state.baseball && state.baseball.mode !== "together" && state.baseball.teams.length > 1 ? state.baseball.batting : null
  );
  const showTeams = $derived(state.game === "boccia" || (!!state.baseball && state.baseball.mode !== "together"));

  const again = () => session.act({ type: "start", game: state.game });
  const back = () => session.act({ type: "stop" });
</script>

<main class="game" data-game={state.game}>
  <header class="top">
    <div class="turn" class:mine={myTurn} style="--pc: {turnPlayer?.color || 'transparent'}" aria-live="polite">
      {#if turnPlayer}
        {#if team}<span class="team-chip {team}">{TEAM_LABELS[team]}</span>{/if}
        <PlayerMark color={turnPlayer.color} size={38} />
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
        <button class="btn small icon" type="button" onclick={onSettings} aria-label="せってい"><Icon name="gear" /></button>
        <button class="btn small" type="button" onclick={back}>{@html rb("おわる")}</button>
      {/if}
    </div>
  </header>

  {#if isHost && $session.pending.length}
    <div class="requests"><JoinRequests /></div>
  {/if}

  {#if $session.status === "closed"}
    <div class="notice" role="alert">
      {@html rb("ホストとの つながりが きれました")}
      <button class="btn small" type="button" onclick={() => session.rejoin()}>{@html rb("もういちど はいる")}</button>
    </div>
  {/if}

  <section class="stage" use:surface>
    {#if state.game === "baseball"}
      <Baseball onAgain={again} onBack={back} />
    {:else}
      <Boccia onNextEnd={() => session.act({ type: "nextEnd" })} onBack={back} />
    {/if}
  </section>

  <aside class="people">
    <Players compact {showTeams} />
  </aside>

  <footer class="press-area">
    <PressButton {surface} mode={$scanning ? "choose" : myTurn ? "turn" : "cheer"} />
  </footer>
</main>

<style>
  .game {
    height: 100dvh;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr) auto auto;
    grid-template-areas: "top" "notice" "stage" "people" "press";
    gap: 10px;
    padding: 10px 12px 14px;
  }
  .top {
    grid-area: top;
  }
  .notice,
  .requests {
    grid-area: notice;
  }
  .stage {
    grid-area: stage;
  }
  .people {
    grid-area: people;
  }
  .press-area {
    grid-area: press;
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
    padding: 4px 16px 4px 10px;
    border: 2px solid var(--rule);
    border-radius: var(--radius);
    background: var(--paper);
    margin-right: auto;
    min-height: 56px;
    max-width: 100%;
  }
  .turn.mine {
    background: var(--turn);
    border-color: var(--turn);
    animation: glow 1.2s ease-in-out infinite;
  }
  @keyframes glow {
    50% {
      box-shadow: 0 0 0 6px rgba(255, 212, 0, 0.55);
    }
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
    border-radius: 8px;
    color: #fff;
    font-weight: 900;
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
    border: 2px solid var(--rule);
    border-radius: 10px;
    background: var(--paper);
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0;
    padding: 8px 12px;
    border-left: 6px solid var(--danger);
    border-radius: 10px;
    background: #ffe6e2;
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
      grid-template-areas: "top top" "notice notice" "stage people" "stage press";
    }
    .people {
      overflow: auto;
    }
    .people :global(.players.compact) {
      display: grid;
    }
    .press-area {
      height: clamp(150px, 30vh, 260px);
    }
  }
</style>

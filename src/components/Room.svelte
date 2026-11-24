<script>
  // 待っている部屋。番号と入り方・いる人・遊び（ホストが選ぶ）。
  // ここでスイッチを押すと、自分の名前が全員の画面で弾む（スイッチの ためし）。
  import { session, prefs, updatePrefs } from "../lib/app.js";
  import { activePlayers } from "../lib/engine.js";
  import { rb, GAME_LABELS } from "../lib/text.js";
  import Players from "./Players.svelte";
  import PressButton from "./PressButton.svelte";
  import GameIcon from "./GameIcon.svelte";
  import Icon from "./Icon.svelte";

  let { surface, onSettings } = $props();

  const state = $derived($session.state);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  const code = $derived(state.roomCode);
  const link = $derived(code ? `${location.origin}${location.pathname}#room=${code}` : "");
  const canStart = $derived(activePlayers(state).length > 0);

  let copied = $state(false);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 1800);
    } catch {
      copied = false;
    }
  }

  let editing = $state(false);
  let newName = $state("");
  function startRename() {
    newName = session.me()?.name || "";
    editing = true;
  }
  function saveName() {
    const name = newName.trim().slice(0, 12);
    if (name) {
      session.rename(name);
      updatePrefs({ name });
    }
    editing = false;
  }
</script>

<main class="room">
  <header class="bar">
    <button class="btn small" type="button" onclick={() => session.leave()}>{@html rb("でる")}</button>
    {#if code}
      <div class="code" aria-label={`へやの ばんごう ${code.split("").join(" ")}`}>
        <span class="code-label">{@html rb("部屋[へや]の 番号[ばんごう]")}</span>
        <span class="digits">{code}</span>
      </div>
      <button class="btn small" type="button" onclick={copyLink}>{@html rb(copied ? "コピーしました" : "リンクを コピー")}</button>
    {:else}
      <div class="code solo">{@html rb("ひとりで あそぶ")}</div>
    {/if}
    {#if isHost}
      <button class="btn small icon" type="button" onclick={onSettings} aria-label="せってい"><Icon name="gear" /></button>
    {/if}
  </header>

  {#if $session.status === "closed"}
    <div class="notice" role="alert">
      {@html rb("ホストとの つながりが きれました")}
      <button class="btn small" type="button" onclick={() => session.rejoin()}>{@html rb("もういちど はいる")}</button>
    </div>
  {/if}

  <div class="body">
    <section class="games" aria-label="あそび">
      {#each ["baseball", "boccia"] as game}
        {#if isHost || state.game === game}
          <button
            class="game-card"
            class:chosen={state.game === game}
            type="button"
            disabled={!isHost}
            onclick={() => session.act({ type: "chooseGame", game })}
          >
            <GameIcon {game} />
            <span class="game-name">{@html rb(GAME_LABELS[game])}</span>
          </button>
        {/if}
      {/each}
      {#if isHost}
        <button class="btn primary big start" type="button" disabled={!canStart} onclick={() => session.act({ type: "start", game: state.game })}>
          {@html rb("はじめる")}
        </button>
      {:else}
        <p class="wait">{@html rb("はじまるのを まっています")}</p>
      {/if}
    </section>

    <section class="people" aria-label="いる人">
      <Players showTeams={state.game === "boccia"} />
      {#if editing}
        <form class="rename" onsubmit={(e) => (e.preventDefault(), saveName())}>
          <input type="text" bind:value={newName} maxlength="12" aria-label="なまえ" />
          <button class="btn small primary" type="submit">{@html rb("きめる")}</button>
        </form>
      {:else}
        <button class="btn small rename-btn" type="button" onclick={startRename}>{@html rb("名前[なまえ]を かえる")}</button>
      {/if}
    </section>
  </div>

  <footer class="press-area">
    <PressButton {surface} mode="test" />
  </footer>
</main>

<style>
  .room {
    min-height: 100dvh;
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    grid-template-areas: "bar" "notice" "body" "press";
    gap: 14px;
    padding: 14px 16px 18px;
    max-width: 1200px;
    margin: 0 auto;
  }
  .bar {
    grid-area: bar;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .code {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 6px 16px;
    background: var(--paper);
    border: 2px solid var(--rule);
    border-radius: var(--radius);
    margin-right: auto;
  }
  .code.solo {
    font-weight: 900;
    font-size: 1.3rem;
  }
  .code-label {
    font-weight: 800;
  }
  .digits {
    font-size: clamp(2.2rem, 6vw, 3.2rem);
    font-weight: 900;
    letter-spacing: 0.18em;
    font-variant-numeric: tabular-nums;
  }
  .notice {
    grid-area: notice;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0;
    padding: 10px 14px;
    border-left: 6px solid var(--danger);
    border-radius: 10px;
    background: #ffe6e2;
    font-weight: 800;
  }
  .body {
    grid-area: body;
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    gap: 18px;
    align-items: start;
    min-height: 0;
  }
  @media (max-width: 760px), (orientation: portrait) {
    .body {
      grid-template-columns: 1fr;
    }
  }
  .games {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 14px;
  }
  .game-card {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 14px;
    background: var(--paper);
    border: 2px solid var(--rule);
    border-radius: 16px;
    cursor: pointer;
  }
  .game-card:disabled {
    cursor: default;
  }
  .game-card :global(svg) {
    width: min(120px, 22vw);
    height: min(120px, 22vw);
  }
  .game-card:not(.chosen) {
    opacity: 0.6;
  }
  .game-card.chosen {
    border-color: var(--ink);
    box-shadow: inset 0 0 0 2px var(--ink);
  }
  .game-name {
    font-size: 1.6rem;
    font-weight: 900;
  }
  .start {
    grid-column: 1 / -1;
  }
  .wait {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 1.3rem;
    font-weight: 800;
    text-align: center;
  }
  .people {
    display: grid;
    gap: 12px;
  }
  .rename {
    display: flex;
    gap: 8px;
  }
  .rename-btn {
    justify-self: start;
  }
  .press-area {
    grid-area: press;
    height: clamp(96px, 18vh, 150px);
  }
</style>

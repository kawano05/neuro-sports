<script>
  import { untrack } from "svelte";
  import { session, prefs, updatePrefs, audio } from "../lib/app.js";
  import { normalizeCode, CODE_DIGITS } from "../lib/net.js";
  import { rb } from "../lib/text.js";
  import GameIcon from "./GameIcon.svelte";
  import { scanGroup } from "../lib/scan.js";

  let { initialCode = null, initialKey = null } = $props();

  let name = $state($prefs.name || "");
  let joining = $state(untrack(() => !!initialCode));
  let code = $state(untrack(() => initialCode || ""));
  const validCode = $derived(normalizeCode(code));
  const busy = $derived($session.status === "connecting");
  const waiting = $derived($session.mode === "guest" && $session.status === "waiting");

  function me(role = "play") {
    const trimmed = name.trim().slice(0, 12);
    updatePrefs({ name: trimmed, role });
    return { name: trimmed, role };
  }

  function create() {
    audio.unlock();
    session.host(me());
  }

  function solo() {
    audio.unlock();
    session.solo(me());
  }

  function join(role) {
    audio.unlock();
    if (!validCode) return;
    // リンクから来たときだけ、合言葉を付けて入る（番号を打ちかえたら、合言葉は使わない）。
    const key = validCode === initialCode ? initialKey : null;
    history.replaceState(null, "", key ? `#room=${validCode}&key=${key}` : `#room=${validCode}`);
    session.join(validCode, me(role), key);
  }
</script>

<main class="home">
  <header class="title">
    <div class="icons" aria-hidden="true">
      <GameIcon game="baseball" />
      <GameIcon game="boccia" />
    </div>
    <h1>{@html rb("ひとおし スポーツ")}</h1>
  </header>

  <section class="card">
    <label class="field">
      <span class="label">{@html rb("名前[なまえ]")}</span>
      <input type="text" bind:value={name} maxlength="12" autocomplete="nickname" placeholder="なまえ" />
    </label>

    {#if waiting}
      <p class="wait-host" role="status">{@html rb("ホストが 入[い]れてくれるのを まっています")}</p>
      <div class="actions">
        <button class="btn small" onclick={() => session.leave()}>{@html rb("やめる")}</button>
      </div>
    {:else if !joining}
      <!-- ボタンが順に光り、スイッチで選ぶ（lib/scan.js）。許可を待っているあいだは光らせない（押して「やめる」にならないように）。 -->
      <div class="actions" use:scanGroup>
        <button class="btn primary big" onclick={create} disabled={busy}>{@html rb("部屋[へや]を つくる")}</button>
        <button class="btn big" onclick={() => (joining = true)} disabled={busy}>{@html rb("部屋[へや]に はいる")}</button>
        <button class="btn" onclick={solo} disabled={busy}>{@html rb("ひとりで あそぶ")}</button>
      </div>
    {:else}
      <label class="field">
        <span class="label">{@html rb("部屋[へや]の 番号[ばんごう]")}</span>
        <input
          class="code"
          type="tel"
          inputmode="numeric"
          maxlength={CODE_DIGITS}
          bind:value={code}
          placeholder="000000"
          autocomplete="off"
          onkeydown={(e) => e.key === "Enter" && join("play")}
        />
      </label>
      <div class="actions" use:scanGroup>
        <button class="btn primary big" onclick={() => join("play")} disabled={!validCode || busy}>{@html rb("あそぶ")}</button>
        <button class="btn big" onclick={() => join("watch")} disabled={!validCode || busy}>{@html rb("見[み]るだけ")}</button>
        <button class="btn small" onclick={() => (joining = false)} disabled={busy}>{@html rb("もどる")}</button>
      </div>
    {/if}

    {#if busy}
      <p class="status" role="status">{@html rb("つないでいます…")}</p>
    {:else if $session.error}
      <p class="status error" role="alert">{$session.error}</p>
    {/if}
  </section>
</main>

<style>
  .wait-host {
    margin: 0;
    padding: 14px;
    border-radius: var(--radius);
    background: #fff3b0;
    font-weight: 800;
    font-size: 1.2rem;
    text-align: center;
  }
  .home {
    min-height: 100vh;
    min-height: 100dvh;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 20px;
    padding: 24px 16px 40px;
  }
  .title {
    text-align: center;
  }
  .icons {
    display: flex;
    gap: 16px;
    justify-content: center;
  }
  .icons :global(svg) {
    width: 96px;
    height: 96px;
  }
  h1 {
    margin: 8px 0 0;
    font-size: clamp(2rem, 6vw, 3.2rem);
    font-weight: 900;
    letter-spacing: 0.04em;
  }
  .card {
    width: min(560px, 100%);
    background: var(--paper);
    border: 2px solid var(--rule);
    border-radius: 16px;
    padding: 22px;
    display: grid;
    gap: 18px;
  }
  .field {
    display: grid;
    gap: 6px;
  }
  .label {
    font-weight: 800;
    font-size: 1.05rem;
  }
  .code {
    font-size: 2.4rem !important;
    letter-spacing: 0.3em;
    text-align: center;
  }
  .actions {
    display: grid;
    gap: 14px;
  }
  .status {
    margin: 0;
    font-weight: 800;
    text-align: center;
  }
  .error {
    color: var(--danger);
  }
</style>

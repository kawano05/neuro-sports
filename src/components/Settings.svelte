<script>
  // 支援者の設定。遊びの決まり（速さ・「合った」の広さなど）はホストだけが変えられ、
  // 全員に同じに効く。読み上げと音の大きさは、この端末だけ。
  // 開いているあいだは、スイッチの入力を受けない（キーボードで普通に操作するため）。
  import { untrack } from "svelte";
  import { session, prefs, updatePrefs } from "../lib/app.js";
  import { rb } from "../lib/text.js";

  let { onClose } = $props();

  const state = $derived($session.state);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  // タブ: 野球・ボッチャ・この端末（ホスト）。ゲストは この端末 だけ。
  // 以前は、いま部屋で選んでいる遊びの設定しか出ず、ボッチャの設定が見つからなかった。
  const TABS = [
    ["baseball", "野球[やきゅう]"],
    ["boccia", "ボッチャ"],
    ["device", "この 端末[たんまつ]"],
  ];
  let tab = $state(
    untrack(() => ($session.mode === "host" || $session.mode === "solo" ? $session.state?.game || "baseball" : "device"))
  );

  const GROUPS = {
    baseball: [
      {
        key: "speed",
        label: "円盤[えんばん]の はやさ（1周[しゅう]）",
        options: [["slowest", "いちばん ゆっくり（12秒[びょう]）"], ["slower", "とても ゆっくり（8秒[びょう]）"], ["slow", "ゆっくり"], ["normal", "ふつう"], ["fast", "はやい"]],
      },
      { key: "width", label: "当[あ]たる 広[ひろ]さ", options: [["narrow", "せまい"], ["normal", "ふつう"], ["wide", "ひろい"], ["always", "いつでも"]] },
      {
        key: "format",
        label: "試合[しあい]の 形[かたち]",
        options: [["atbats", "打席制[だせきせい]（1人[ひとり] ◯打席[だせき]）"], ["innings", "イニング制[せい]（3アウト）"], ["together", "みんなで（アウトなし）"]],
      },
      { key: "innings", label: "何回[なんかい]まで", options: [[1, "1回[かい]"], [2, "2回[かい]"], [3, "3回[かい]"]], when: (set) => set.format === "innings" },
      { key: "atBats", label: "ひとり 何打席[なんだせき]", options: [[1, "1"], [2, "2"], [3, "3"], [5, "5"], [0, "ずっと"]], when: (set) => set.format !== "innings" },
      { key: "rotate", label: "交代[こうたい]", options: [["auto", "打[う]ったら つぎの人[ひと]"], ["manual", "支援者[しえんしゃ]が きめる"]] },
      { key: "cue", label: "合図[あいず]の 音[おと]", options: [[true, "あり"], [false, "なし"]] },
    ],
    boccia: [
      { key: "speed", label: "目盛[めも]りの はやさ", options: [["slow", "ゆっくり"], ["normal", "ふつう"], ["fast", "はやい"]] },
      { key: "presses", label: "押[お]す 回数[かいすう]", options: [[1, "1回[かい]（むきだけ）"], [2, "2回[かい]（むき → つよさ）"]] },
      { key: "balls", label: "1チームの 玉[たま]", options: [[1, "1"], [2, "2"], [3, "3"], [6, "6"]] },
      { key: "guide", label: "とどく ところの 線[せん]", options: [[true, "あり"], [false, "なし"]] },
      { key: "cue", label: "合図[あいず]の 音[おと]", options: [[true, "あり"], [false, "なし"]] },
    ],
  };

  let dialog;
  $effect(() => {
    dialog?.querySelector("button")?.focus();
  });
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="panel" role="dialog" aria-modal="true" aria-label="せってい" bind:this={dialog}>
    <header>
      <h2>{@html rb("設定[せってい]")}</h2>
      <button class="btn small" type="button" onclick={onClose}>{@html rb("とじる")}</button>
    </header>

    {#if isHost && state}
      <div class="tabs" role="tablist">
        {#each TABS as [id, label]}
          <button type="button" role="tab" class="tab" class:on={tab === id} aria-selected={tab === id} onclick={() => (tab = id)}>
            {@html rb(label)}
          </button>
        {/each}
      </div>
    {/if}

    {#if isHost && state && tab !== "device"}
      {@const game = tab}
      {#each GROUPS[game].filter((g) => !g.when || g.when(state.settings[game])) as group}
        <fieldset>
          <legend>{@html rb(group.label)}</legend>
          <div class="seg">
            {#each group.options as [value, label]}
              <button
                type="button"
                class="opt"
                class:on={state.settings[game][group.key] === value}
                aria-pressed={state.settings[game][group.key] === value}
                onclick={() => session.act({ type: "settings", game, key: group.key, value })}
              >
                {@html rb(label)}
              </button>
            {/each}
          </div>
        </fieldset>
      {/each}
    {:else}
    <fieldset>
      <legend>{@html rb("読[よ]み上[あ]げ")}</legend>
      <div class="seg">
        {#each [[true, "あり"], [false, "なし"]] as [value, label]}
          <button type="button" class="opt" class:on={$prefs.speech === value} aria-pressed={$prefs.speech === value} onclick={() => updatePrefs({ speech: value })}>
            {@html rb(label)}
          </button>
        {/each}
      </div>
    </fieldset>
    <fieldset>
      <legend>{@html rb("音[おと]の 大[おお]きさ")}</legend>
      <div class="seg">
        {#each [["small", "小[ちい]さめ"], ["mid", "ふつう"], ["large", "大[おお]きめ"]] as [value, label]}
          <button type="button" class="opt" class:on={$prefs.volume === value} aria-pressed={$prefs.volume === value} onclick={() => updatePrefs({ volume: value })}>
            {@html rb(label)}
          </button>
        {/each}
      </div>
    </fieldset>
    <fieldset>
      <legend>{@html rb("光[ひかり]が うつったときの 合図[あいず]")}</legend>
      <div class="seg">
        {#each [["speak", "ことばを 読[よ]む"], ["tick", "小[ちい]さな 音[おと]"], ["none", "なし"]] as [value, label]}
          <button type="button" class="opt" class:on={$prefs.scanFeedback === value} aria-pressed={$prefs.scanFeedback === value} onclick={() => updatePrefs({ scanFeedback: value })}>
            {@html rb(label)}
          </button>
        {/each}
      </div>
    </fieldset>
    <fieldset>
      <legend>{@html rb("えらぶ 光[ひかり]の はやさ（試合[しあい]の おわりなど）")}</legend>
      <div class="seg">
        {#each [[1200, "はやい（1.2秒[びょう]）"], [1600, "ふつう（1.6秒[びょう]）"], [2400, "ゆっくり（2.4秒[びょう]）"], [3200, "とても ゆっくり（3.2秒[びょう]）"]] as [value, label]}
          <button type="button" class="opt" class:on={$prefs.scanMs === value} aria-pressed={$prefs.scanMs === value} onclick={() => updatePrefs({ scanMs: value })}>
            {@html rb(label)}
          </button>
        {/each}
      </div>
    </fieldset>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(26, 26, 26, 0.45);
    display: grid;
    place-items: center;
    padding: 16px;
    z-index: 50;
  }
  .panel {
    width: min(640px, 100%);
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    overflow: auto;
    background: var(--paper);
    border-radius: 16px;
    padding: 18px 20px 22px;
    display: grid;
    gap: 14px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-weight: 900;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 2px solid var(--rule);
  }
  .tab {
    min-height: 48px;
    padding: 4px 14px 2px;
    background: none;
    border: 0;
    border-bottom: 4px solid transparent;
    margin-bottom: -2px;
    font-weight: 800;
    font-size: 1.1rem;
    color: var(--ink-soft);
    cursor: pointer;
  }
  .tab.on {
    color: var(--ink);
    border-bottom-color: var(--ink);
  }
  .tab:focus-visible {
    outline: 3px solid var(--blue);
    outline-offset: -3px;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 6px;
  }
  legend {
    font-weight: 800;
    font-size: 1.05rem;
    margin-bottom: 6px;
  }
  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .opt {
    min-height: 48px;
    padding: 6px 14px;
    border: 2px solid var(--rule-strong);
    border-radius: 10px;
    background: var(--paper);
    font-weight: 800;
    font-size: 1rem;
    cursor: pointer;
  }
  .opt.on {
    background: var(--ink);
    border-color: var(--ink);
    color: #ffffff;
  }
</style>

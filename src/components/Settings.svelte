<script>
  // 支援者の設定。遊びの決まり（速さ・「合った」の広さなど）はホストだけが変えられ、
  // 全員に同じに効く。読み上げと音の大きさは、この端末だけ。
  // 開いているあいだは、スイッチの入力を受けない（キーボードで普通に操作するため）。
  import { session, prefs, updatePrefs } from "../lib/app.js";
  import { rb } from "../lib/text.js";

  let { onClose } = $props();

  const state = $derived($session.state);
  const isHost = $derived($session.mode === "host" || $session.mode === "solo");
  const game = $derived(state?.game || "baseball");

  const GROUPS = {
    baseball: [
      { key: "speed", label: "円盤[えんばん]の はやさ", options: [["slow", "ゆっくり"], ["normal", "ふつう"], ["fast", "はやい"]] },
      { key: "width", label: "当[あ]たる 広[ひろ]さ", options: [["narrow", "せまい"], ["normal", "ふつう"], ["wide", "ひろい"], ["always", "いつでも"]] },
      { key: "outs", label: "アウト", options: [[true, "あり（チームで しあい）"], [false, "なし（みんなで 合計点[ごうけいてん]）"]] },
      { key: "innings", label: "何回[なんかい]まで", options: [[1, "1回[かい]"], [2, "2回[かい]"], [3, "3回[かい]"]], when: (set) => set.outs },
      { key: "atBats", label: "ひとり 何回[なんかい] 打[う]つ", options: [[1, "1"], [3, "3"], [5, "5"], [0, "ずっと"]], when: (set) => !set.outs },
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
      <div class="tabs">
        {#each ["baseball", "boccia"] as g}
          <span class="tab" class:on={game === g}>{@html rb(g === "baseball" ? "野球[やきゅう]" : "ボッチャ")}</span>
        {/each}
      </div>
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
    {/if}

    <h3>{@html rb("この 端末[たんまつ]")}</h3>
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
  h2,
  h3 {
    margin: 0;
    font-weight: 900;
  }
  h3 {
    margin-top: 6px;
    padding-top: 12px;
    border-top: 2px solid var(--rule);
  }
  .tabs {
    display: flex;
    gap: 8px;
  }
  .tab {
    padding: 2px 2px 4px;
    font-weight: 800;
    font-size: 1.1rem;
    opacity: 0.4;
    border-bottom: 3px solid transparent;
  }
  .tab.on {
    opacity: 1;
    border-bottom-color: var(--ink);
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

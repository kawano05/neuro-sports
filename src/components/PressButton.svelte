<script>
  // 画面の大きな「おす」ボタン。スペース・Enter・ニューロノード・クリック・タップと同じ1回。
  // 番のときは明るく大きく、番でないときは「おうえん」になる（押すと、みんなの画面で名前が弾む）。
  import { onMount } from "svelte";
  import { bus } from "../lib/app.js";
  import { rb, plain } from "../lib/text.js";

  let { surface, mode = "turn" } = $props();

  const LABELS = {
    turn: "おす",
    cheer: "おうえん",
    test: "おして ためす",
    choose: "えらぶ",
  };

  let pressedAt = $state(0);
  onMount(() =>
    bus.on("press", () => {
      pressedAt = performance.now();
    })
  );
  let flash = $state(false);
  $effect(() => {
    if (!pressedAt) return;
    flash = true;
    const timer = setTimeout(() => (flash = false), 160);
    return () => clearTimeout(timer);
  });
</script>

<button class="press {mode}" class:flash type="button" data-switch use:surface aria-label={plain(LABELS[mode])}>
  <span class="label">{@html rb(LABELS[mode])}</span>
</button>

<style>
  .press {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    min-height: 84px;
    border: 5px solid var(--line);
    border-radius: 28px;
    background: var(--paper);
    box-shadow: 0 7px 0 var(--line);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    transition: transform 0.06s ease, box-shadow 0.06s ease, background 0.2s ease;
  }
  .press.turn,
  .press.choose {
    background: var(--turn);
  }
  /* 番でないとき（おうえん・ためす）は白。黄色は「いま押せる」だけ。 */
  .press.cheer,
  .press.test {
    background: var(--paper);
  }
  .press.flash,
  .press:active {
    transform: translateY(6px);
    box-shadow: 0 1px 0 var(--line);
  }
  .label {
    font-size: clamp(2rem, 7vh, 3.6rem);
    font-weight: 900;
    letter-spacing: 0.12em;
    line-height: 1;
  }
  .cheer .label,
  .test .label {
    font-size: clamp(1.5rem, 5vh, 2.4rem);
  }
</style>

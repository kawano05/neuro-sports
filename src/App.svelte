<script>
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { session, audio, bus, announcement, predicted } from "./lib/app.js";
  import { createSwitchInput } from "./lib/input.js";
  import { scanSelect, scanning } from "./lib/scan.js";
  import { normalizeCode } from "./lib/net.js";
  import Home from "./components/Home.svelte";
  import Room from "./components/Room.svelte";
  import Game from "./components/Game.svelte";
  import Settings from "./components/Settings.svelte";

  let settingsOpen = $state(false);
  const screen = $derived($session.state ? $session.state.screen : "home");
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const initialCode = normalizeCode(hashParams.get("room"));
  // リンクの合言葉（ホストが配ったリンクから来た人は、許可を待たずに入れる）。
  const initialKey = (hashParams.get("key") || "").replace(/[^a-z0-9]/g, "").slice(0, 40) || null;

  const input = createSwitchInput({
    // 部屋に入る前（ホーム）は、光っているボタンを選ぶときだけ受ける。
    accepting: () => !settingsOpen && (!!get(session).state || get(scanning)),
    onPress(t) {
      audio.unlock();
      // 選ぶ画面（ホーム・部屋・試合のおわり など）では、光っているボタンを押す（lib/scan.js）。
      if (scanSelect(t)) return;
      const s = get(session);
      if (!s.state) return;
      const st = s.state;
      session.press(t, (press) => {
        const myTurn = st?.screen === "game" && st.turn?.playerId === s.myId;
        // 番でないときの押し（スイッチの ためし・おうえん）は、ここで先に鳴らす。
        if (st?.screen !== "game") {
          audio.test();
          predicted.add(press.pid);
        } else if (!myTurn) {
          audio.cheerPop();
          predicted.add(press.pid);
        }
        bus.emit("press", { ...press, myTurn });
      });
    },
    onEscape() {
      settingsOpen = false;
    },
  });

  // 画面が消えないように（遊んでいるあいだ）。使えない環境では何もしない。
  let wakeLock = null;
  async function holdScreen(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => (wakeLock = null));
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {
      wakeLock = null;
    }
  }
  $effect(() => {
    holdScreen(screen !== "home");
  });

  onMount(() => {
    // iPad は、操作のあとでないと音が出ない。最初の操作で音を起こす。
    const unlock = () => audio.unlock();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    // マウスやタッチで押した支援者のボタンに、フォーカスを残さない
    // （残ると、スイッチの Space がそのボタンを押してしまう）。
    const blurAfterClick = (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button && event.detail > 0 && !button.hasAttribute("data-switch")) setTimeout(() => button.blur(), 0);
    };
    window.addEventListener("click", blurAfterClick, true);
    const onVisible = () => {
      if (document.visibilityState === "visible" && screen !== "home") holdScreen(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      input.destroy();
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("click", blurAfterClick, true);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });
</script>

<div class="app" data-screen={screen}>
  {#if screen === "home"}
    <Home {initialCode} {initialKey} />
  {:else if screen === "room"}
    <Room surface={input.surface} onSettings={() => (settingsOpen = true)} />
  {:else}
    <Game surface={input.surface} onSettings={() => (settingsOpen = true)} />
  {/if}

  {#if settingsOpen}
    <Settings onClose={() => (settingsOpen = false)} />
  {/if}

  <div class="sr-only" aria-live="polite">{$announcement}</div>
</div>

<style>
  .app {
    min-height: 100vh;
    min-height: 100dvh;
  }
</style>

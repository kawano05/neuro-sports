// =====================================================================
// input.js — スイッチ1つの受け口（neuro の neuronodeApp.js と同じ決まり）
//
// ニューロノードは、キーボードのスイッチとして入ってくる。機器によって送るキーが
// 違う（Space / Enter のほか、F5・F12 や1文字のキーもある）。受けるキーを限ると
// 「押しているのに何も起きない」が起きるので、遊びの画面では、どのキーでも1回の押しにする。
// 除くのは、修飾キーだけ・修飾キー付き（Ctrl+R など）・Tab・Escape と、文字を打つ欄の中。
// 支援者が設定を開いているあいだも受けない（キーボードで普通に操作するため）。
//
// 画面の「おす」ボタンと、遊びの画面（ステージ）は、pointerdown と click の両方を受ける
// （iOS のスイッチコントロールなどは click しか送らないことがある）。同じ1回の操作から
// 出る重なりは、150ms のあいだ1回にまとめる。
//
// 押した時刻は、入口の最初の1行で取る（performance.now()）。描画のコマに頼らない。
// =====================================================================

const DEDUPE_MS = 150;

const MODIFIER_ONLY = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock", "Dead", "Process", "Fn", "OS"]);

/**
 * @param {{onPress:(t:number, source:string)=>void, accepting:()=>boolean, onEscape?:()=>void}} opts
 *   accepting … いまスイッチとして受けるか（設定を開いているあいだなどは false）
 */
export function createSwitchInput({ onPress, accepting, onEscape }) {
  let lastAt = -Infinity;
  let lastKeyAt = -Infinity;

  function accept(t, source) {
    if (source === "key") lastKeyAt = t;
    if (t - lastAt < DEDUPE_MS) return;
    lastAt = t;
    onPress(t, source);
  }

  function onKeyDown(event) {
    const t = performance.now(); // 最初に計時する
    const target = event.target instanceof Element ? event.target : null;
    const tag = target?.tagName?.toLowerCase();
    if (event.key === "Escape") {
      onEscape?.();
      return;
    }
    if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
    if (!accepting()) return;
    if (MODIFIER_ONLY.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Tab") return;
    if (event.key === " " || event.key === "Enter") {
      // Tab で選んだ普通のボタンは、ブラウザ本来の操作に任せる。
      const interactive = target?.closest?.("button, a[href], summary, [role='button']");
      if (interactive && !interactive.hasAttribute("data-switch")) return;
    }
    event.preventDefault();
    if (event.repeat) return; // 押しっぱなしで続けて来るものは、数えない
    accept(t, "key");
  }

  document.addEventListener("keydown", onKeyDown);

  /**
   * Svelte の use: で付ける。この要素の上で押すと、スイッチ1回。
   * @param {HTMLElement} node
   */
  function surface(node) {
    let pairedClick = false;
    let clearTimer = null;
    const down = (event) => {
      const t = performance.now();
      if (!event.isPrimary || event.button !== 0) return;
      // 中にある普通のボタン（支援者の操作）は除く。
      const inner = event.target instanceof Element ? event.target.closest("button, a[href], input, select, textarea, label") : null;
      if (inner && inner !== node && !inner.hasAttribute("data-switch")) return;
      if (!accepting()) return;
      pairedClick = true;
      accept(t, "pointer");
    };
    const up = () => {
      clearTimeout(clearTimer);
      // click は pointerup のすぐあとに来る。それまでは「対の click」として捨てる。
      clearTimer = setTimeout(() => {
        pairedClick = false;
      }, 0);
    };
    const click = (event) => {
      const t = performance.now();
      if (pairedClick && event.detail !== 0) {
        pairedClick = false;
        return;
      }
      // キーで押したボタンから、あとで出てくる click（detail 0）は、同じ1回。
      if (event.detail === 0 && t - lastKeyAt < 1000) return;
      pairedClick = false;
      const inner = event.target instanceof Element ? event.target.closest("button, a[href], input, select, textarea, label") : null;
      if (inner && inner !== node && !inner.hasAttribute("data-switch")) return;
      if (!accepting()) return;
      accept(t, "click");
    };
    node.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    node.addEventListener("click", click);
    return {
      destroy() {
        clearTimeout(clearTimer);
        node.removeEventListener("pointerdown", down);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
        node.removeEventListener("click", click);
      },
    };
  }

  return {
    surface,
    destroy() {
      document.removeEventListener("keydown", onKeyDown);
    },
  };
}

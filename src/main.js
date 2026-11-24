import { mount } from "svelte";
import { get } from "svelte/store";
import "./styles.css";
import App from "./App.svelte";
import { session } from "./lib/app.js";

const app = mount(App, { target: document.getElementById("app") });

// 開発のときだけ、確かめ用に状態を読めるようにする（公開版には入らない）。
if (import.meta.env.DEV) {
  window.__ns = { session, view: () => get(session), now: () => session.hostNow() };
}

export default app;

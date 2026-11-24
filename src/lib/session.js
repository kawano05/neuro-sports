// =====================================================================
// session.js — この端末から見た「部屋」
//
//   host  … 部屋を作った端末。状態を進める（engine.js）のはここだけ。
//           変わるたびに、状態をまるごと全員へ配る。
//   guest … URL か番号で入った端末。押したら、押した時刻をホストへ送る。
//   solo  … インターネットを使わず、この端末だけで遊ぶ（ホストと同じ動き）。
//
// 時計合わせ: 端末ごとに performance.now() の0点が違う。ゲストはホストへ
// ping を送り、行って帰る時間がいちばん短かった回から、ずれ（offset）を決める。
// hostNow() = performance.now() + offset。円盤の角度も判定も、この時計で見る。
// =====================================================================

import { writable } from "svelte/store";
import { createState, nextWake, reduce, playerById } from "./engine.js";
import { hostRoom, joinRoom, troubleText } from "./net.js";
import { loadPrefs, savePrefs, clientId } from "./prefs.js";

const PING_FAST_MS = 700;
const PING_SLOW_MS = 4000;
const PING_FAST_COUNT = 6;
const CLOCK_SAMPLES = 12;
/** これだけ便りの無いゲストは、抜けたものとする。 */
const GUEST_SILENT_MS = 16000;

export function createSession() {
  const store = writable({
    mode: null, // host | guest | solo | null
    status: "idle", // idle | connecting | open | closed | error
    error: null,
    myId: clientId(),
    code: null,
    state: null,
    trouble: null,
  });
  let current = null;
  store.subscribe((value) => {
    current = value;
  });

  let state = null;
  let net = null;
  let offset = 0;
  let wakeTimer = null;
  let pingTimer = null;
  let liveTimer = null;
  let pingCount = 0;
  const clock = [];
  const eventListeners = new Set();
  let lastEventId = 0;
  // ホスト: 接続 → 人の id、最後に便りがあった時刻。
  const connPlayer = new Map();
  const lastSeen = new Map();

  const hostNow = () => performance.now() + offset;
  const isHostLike = () => current.mode === "host" || current.mode === "solo";

  function emitEvents(next, { silent = false } = {}) {
    const fresh = next.events.filter((e) => e.id > lastEventId);
    lastEventId = Math.max(lastEventId, next.eventSeq);
    if (silent || fresh.length === 0) return;
    for (const listener of eventListeners) listener(fresh, next);
  }

  function setState(next, opts) {
    state = next;
    store.update((v) => ({ ...v, state: next }));
    emitEvents(next, opts);
  }

  // --- ホスト ---------------------------------------------------------

  function dispatch(action) {
    if (!state) return;
    const now = performance.now();
    const next = reduce(state, action, now);
    if (next !== state) {
      setState(next);
      net?.broadcast({ type: "state", state: next });
      savePrefs({ settings: next.settings });
    }
    scheduleWake();
  }

  function scheduleWake() {
    clearTimeout(wakeTimer);
    const at = nextWake(state);
    if (at === null) return;
    wakeTimer = setTimeout(() => dispatch({ type: "tick" }), Math.max(0, at - performance.now()) + 5);
  }

  function startHostState(code, me) {
    const prefs = loadPrefs();
    state = createState({ roomCode: code, settings: prefs.settings });
    lastEventId = 0;
    state = reduce(state, { type: "join", player: { id: current.myId, name: me.name, role: me.role, host: true } }, performance.now());
    setState(state, { silent: true });
  }

  async function host(me) {
    leave();
    offset = 0;
    store.update((v) => ({ ...v, mode: "host", status: "connecting", error: null, code: null }));
    try {
      net = await hostRoom({
        onOpen(conn) {
          lastSeen.set(conn, performance.now());
        },
        onData(conn, msg) {
          lastSeen.set(conn, performance.now());
          // タブが裏に回ると、ホストのタイマーは遅れる（1秒ごと など）。ゲストからの便りは
          // 遅れずに届くので、そのたびに「時間が来たか」も確かめる。
          const due = nextWake(state);
          if (due !== null && performance.now() >= due) dispatch({ type: "tick" });
          onGuestMessage(conn, msg);
        },
        onClose(conn) {
          const id = connPlayer.get(conn);
          connPlayer.delete(conn);
          lastSeen.delete(conn);
          // 同じ人が別の線でつなぎ直していたら、抜けたことにしない。
          if (id && ![...connPlayer.values()].includes(id)) dispatch({ type: "leave", id });
        },
        onTrouble(type) {
          store.update((v) => ({ ...v, trouble: type }));
        },
      });
    } catch (error) {
      // インターネットにつながらなくても、この端末だけで遊べるようにする。
      net = null;
      startHostState(null, me);
      store.update((v) => ({ ...v, mode: "solo", status: "open", error: troubleText(error) }));
      return;
    }
    startHostState(net.code, me);
    store.update((v) => ({ ...v, status: "open", code: net.code }));
    liveTimer = setInterval(checkGuestsAlive, 3000);
  }

  function solo(me) {
    leave();
    offset = 0;
    net = null;
    store.update((v) => ({ ...v, mode: "solo", status: "open", error: null, code: null }));
    startHostState(null, me);
  }

  function checkGuestsAlive() {
    const now = performance.now();
    for (const [conn, seen] of lastSeen) {
      if (now - seen > GUEST_SILENT_MS) {
        lastSeen.delete(conn);
        net?.drop(conn);
        const id = connPlayer.get(conn);
        connPlayer.delete(conn);
        if (id && ![...connPlayer.values()].includes(id)) dispatch({ type: "leave", id });
      }
    }
  }

  function onGuestMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    const id = connPlayer.get(conn);
    switch (msg.type) {
      case "hello": {
        const playerId = String(msg.id || "").slice(0, 40);
        if (!playerId || playerId === current.myId) {
          net.send(conn, { type: "reject", reason: "same-device" });
          return;
        }
        // 同じ人の古い線があれば、閉じる（読み直したとき）。
        for (const [other, otherId] of connPlayer) {
          if (otherId === playerId && other !== conn) {
            connPlayer.delete(other);
            lastSeen.delete(other);
            net.drop(other);
          }
        }
        connPlayer.set(conn, playerId);
        dispatch({ type: "join", player: { id: playerId, name: String(msg.name || ""), role: msg.role } });
        net.send(conn, { type: "welcome", id: playerId, state });
        return;
      }
      case "ping":
        net.send(conn, { type: "pong", c: msg.c, h: performance.now() });
        return;
      case "press":
        if (id) dispatch({ type: "press", playerId: id, t: Number(msg.t), pid: String(msg.pid || "") });
        return;
      case "rename":
        if (id) dispatch({ type: "rename", id, name: msg.name });
        return;
      case "role":
        if (id) dispatch({ type: "setRole", id, role: msg.role });
        return;
      default:
    }
  }

  // --- ゲスト ---------------------------------------------------------

  let lastJoin = null;

  async function join(code, me) {
    leave();
    lastJoin = { code, me };
    offset = 0;
    clock.length = 0;
    lastEventId = 0;
    store.update((v) => ({ ...v, mode: "guest", status: "connecting", error: null, code }));
    try {
      net = await joinRoom(code, {
        onData: onHostMessage,
        onClose() {
          stopTimers();
          store.update((v) => ({ ...v, status: "closed" }));
        },
      });
    } catch (error) {
      net = null;
      store.update((v) => ({ ...v, status: "error", error: troubleText(error) }));
      return false;
    }
    net.send({ type: "hello", id: current.myId, name: me.name, role: me.role });
    ping();
    return true;
  }

  /** 切れたあと、同じ部屋に同じ人として入り直す。 */
  function rejoin() {
    if (!lastJoin) return Promise.resolve(false);
    return join(lastJoin.code, lastJoin.me);
  }

  function ping() {
    clearTimeout(pingTimer);
    if (!net || current.mode !== "guest") return;
    net.send({ type: "ping", c: performance.now() });
    pingCount += 1;
    pingTimer = setTimeout(ping, pingCount < PING_FAST_COUNT ? PING_FAST_MS : PING_SLOW_MS);
  }

  function onPong(msg) {
    const now = performance.now();
    const rtt = now - msg.c;
    if (!(rtt >= 0) || rtt > 5000) return;
    clock.push({ rtt, offset: msg.h + rtt / 2 - now });
    if (clock.length > CLOCK_SAMPLES) clock.shift();
    const best = clock.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    offset = best.offset;
    store.update((v) => ({ ...v, rtt: Math.round(best.rtt) }));
  }

  function onHostMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "welcome":
        store.update((v) => ({ ...v, status: "open" }));
        // 入る前の出来事は鳴らさない。
        lastEventId = msg.state?.eventSeq ?? 0;
        if (msg.state) setState(msg.state, { silent: true });
        return;
      case "state":
        if (!state) {
          // welcome より先に届いた（ホストは、入れたことを全員へ配ってから welcome を送る）。
          lastEventId = msg.state.eventSeq;
          store.update((v) => ({ ...v, status: "open" }));
          setState(msg.state, { silent: true });
          return;
        }
        if (msg.state.seq >= state.seq || msg.state.roomCode !== state.roomCode) setState(msg.state);
        return;
      case "pong":
        onPong(msg);
        return;
      case "reject":
        store.update((v) => ({ ...v, status: "error", error: "おなじ ブラウザの タブどうしでは はいれません" }));
        net?.close();
        net = null;
        return;
      default:
    }
  }

  // --- どちらも -------------------------------------------------------

  let pressSeq = 0;
  /**
   * この端末のスイッチが押された。t は入力の入口で取った performance.now()。
   * prepare は、ホストへ渡す前に呼ぶ（この端末で先に音を鳴らして、pid を覚えるため。
   * ホストの端末では、渡したその場で出来事が返ってくるので、先に覚えておく）。
   * @param {number} tLocal
   * @param {(press:{pid:string, t:number}) => void} [prepare]
   * @returns {{pid:string, t:number}} ホストの時計での時刻
   */
  function press(tLocal, prepare) {
    const t = tLocal + offset;
    pressSeq += 1;
    const pid = `${current.myId.slice(0, 6)}-${pressSeq}`;
    prepare?.({ pid, t });
    if (isHostLike()) dispatch({ type: "press", playerId: current.myId, t, pid });
    else net?.send({ type: "press", t, pid });
    return { pid, t };
  }

  /** ホストだけが使う操作（ゲストでは何もしない）。 */
  function act(action) {
    if (!isHostLike()) return;
    dispatch(action);
  }

  function rename(name) {
    if (isHostLike()) dispatch({ type: "rename", id: current.myId, name });
    else net?.send({ type: "rename", name });
  }

  function setMyRole(role) {
    if (isHostLike()) dispatch({ type: "setRole", id: current.myId, role });
    else net?.send({ type: "role", role });
  }

  function stopTimers() {
    clearTimeout(wakeTimer);
    clearTimeout(pingTimer);
    clearInterval(liveTimer);
    wakeTimer = null;
    pingTimer = null;
    liveTimer = null;
    pingCount = 0;
  }

  function leave() {
    stopTimers();
    net?.close();
    net = null;
    state = null;
    connPlayer.clear();
    lastSeen.clear();
    store.update((v) => ({ ...v, mode: null, status: "idle", state: null, code: null, error: null, trouble: null }));
  }

  return {
    subscribe: store.subscribe,
    host,
    solo,
    join,
    rejoin,
    leave,
    press,
    act,
    rename,
    setMyRole,
    hostNow,
    isHost: () => isHostLike(),
    me: () => (state ? playerById(state, current.myId) : null),
    onEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
}

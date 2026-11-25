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
//
// 入る決まり（知らない人が入れない・なりすませないように）:
//   - 人の id はホストが決める。ゲストが名乗る id は使わない（id は全員に見えるため）。
//   - 入り直しには、ホストが本人にだけ渡した秘密の札（token）を使う。
//   - ホストが配るリンクの合言葉（key）を持って来た人は、そのまま入れる。
//     番号だけで来た人は、ホストが「入れる」を押すまで待つ（そのあいだ、部屋の様子は何も送らない）。
//   - ホストは人を外せる。外した人の札は使えなくなる。
//   - 合言葉も札も、線の上には流さない。入るときのあいさつで、まずホストが「知っている」ことを
//     見せ、ゲストはそれを確かめてから、自分も「知っている」ことを見せる（handshake.js）。
//     にせのホスト（番号を横取りした人）には、合言葉も札も渡らない。
// =====================================================================

import { writable } from "svelte/store";
import { createState, nextWake, reduce, playerById, roomHasSpace } from "./engine.js";
import * as realNet from "./net.js";
import { proof, same, tokenId } from "./handshake.js";
import { loadPrefs, savePrefs, clientId, loadRoomToken, saveRoomToken } from "./prefs.js";

const { randomToken, troubleText } = realNet;

const PING_FAST_MS = 700;
const PING_SLOW_MS = 4000;
const PING_FAST_COUNT = 6;
const CLOCK_SAMPLES = 12;
/** これだけ便りの無いゲストは、抜けたものとする。 */
const GUEST_SILENT_MS = 16000;
/** つないでから、あいさつ（hello → prove → join）を終えるまでの時間。過ぎたら切る。 */
const HANDSHAKE_MS = 10000;

/**
 * @param {{ transport?: { hostRoom: Function, joinRoom: Function } }} [options]
 *   transport はテストで差しかえる（ふだんは net.js の PeerJS）。
 */
export function createSession({ transport = realNet } = {}) {
  const store = writable({
    mode: null, // host | guest | solo | null
    status: "idle", // idle | connecting | open | closed | error
    error: null,
    myId: clientId(),
    code: null,
    state: null,
    trouble: null,
    roomKey: null, // ホストだけ: リンクの合言葉
    pending: [], // ホストだけ: 入りたい人 [{ key, name }]
    hostChecked: null, // ゲストだけ: ホストが合言葉か札を知っていると確かめられたか
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
  // ホスト: 入れた接続 → 人の id、最後に便りがあった時刻。
  const connPlayer = new Map();
  const lastSeen = new Map();
  // ホスト: 入り直しの札 → 人の id、許可を待っている接続、外した人。
  const tokens = new Map();
  const pending = new Map();
  const removed = new Set();
  // ホスト: あいさつの途中の接続 → { at: つないだ時刻, hs?: { ctx, token } }。
  const greeting = new Map();
  let roomKey = null;
  // ゲスト: あいさつの途中のこと（ゲストの乱数・合言葉・札・送ったか）。
  let guestHs = null;
  let guestHsTimer = null;

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
      // 入れた人にだけ配る（許可を待っている人には、部屋の様子を見せない）。
      if (net) for (const conn of connPlayer.keys()) net.send(conn, { type: "state", state: next });
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
    roomKey = randomToken(12);
    store.update((v) => ({ ...v, mode: "host", status: "connecting", error: null, code: null, myId: clientId(), roomKey }));
    try {
      net = await transport.hostRoom({
        onOpen(conn) {
          lastSeen.set(conn, performance.now());
          greeting.set(conn, { at: performance.now(), hs: null });
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
          if (pending.delete(conn)) syncPending();
          greeting.delete(conn);
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
    store.update((v) => ({ ...v, mode: "solo", status: "open", error: null, code: null, myId: clientId() }));
    startHostState(null, me);
  }

  function checkGuestsAlive() {
    const now = performance.now();
    // あいさつを終えない接続は切る（ping だけ送って居座り、あとで印の横流しに使われないように）。
    for (const [conn, g] of greeting) {
      if (now - g.at > HANDSHAKE_MS) {
        greeting.delete(conn);
        lastSeen.delete(conn);
        net?.drop(conn);
      }
    }
    for (const [conn, seen] of lastSeen) {
      if (now - seen > GUEST_SILENT_MS) {
        lastSeen.delete(conn);
        if (pending.delete(conn)) syncPending();
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
        // あいさつ 1/2: ゲストの乱数を受けて、ホストが合言葉（と札）を知っている印を返す。
        if (connPlayer.has(conn) || pending.has(conn)) return;
        if (typeof msg.n !== "string" || !/^[a-z0-9]{8,64}$/.test(msg.n)) return;
        // 「つながった」の知らせより先に hello が届いても、受ける。
        if (!greeting.has(conn)) greeting.set(conn, { at: performance.now(), hs: null });
        const g = greeting.get(conn);
        if (g.hs) return;
        const { local, remote } = net.channel(conn);
        const ctx = { g: msg.n, h: randomToken(16), gf: remote, hf: local };
        // 札は目じるし（tid）で探す。札そのものは送られてこない。
        let token = null;
        if (typeof msg.tid === "string") {
          for (const [tok, owner] of tokens) {
            if (!removed.has(owner) && tokenId(tok) === msg.tid) token = tok;
          }
        }
        g.hs = { ctx, token };
        net.send(conn, { type: "prove", n: ctx.h, k: proof(roomKey, "host", ctx), t: proof(token, "host", ctx) });
        return;
      }
      case "join": {
        // あいさつ 2/2: ゲストの印を確かめて入れる。印が無ければ、許可を待ってもらう。
        const g = greeting.get(conn);
        if (!g?.hs) return;
        greeting.delete(conn);
        const { ctx, token } = g.hs;
        const name = String(msg.name || "").trim().slice(0, 12);
        const role = msg.role === "watch" ? "watch" : "play";
        // 入り直し: 札を知っている人だけ（id では入り直せない）。
        const known = token ? tokens.get(token) : null;
        if (known && !removed.has(known) && same(msg.t, proof(token, "guest", ctx))) {
          admit(conn, { id: known, token, name, role });
          return;
        }
        // リンクの合言葉を知っている人は、そのまま入れる。
        if (same(msg.k, proof(roomKey, "guest", ctx))) {
          admit(conn, { name, role });
          return;
        }
        // 番号だけで来た人は、ホストの許可を待つ。
        pending.set(conn, { key: randomToken(8), name: name || "なまえなし", role });
        syncPending();
        net.send(conn, { type: "wait" });
        return;
      }
      case "ping":
        net.send(conn, { type: "pong", c: msg.c, h: performance.now() });
        return;
      case "press":
        if (id) dispatch({ type: "press", playerId: id, t: Number(msg.t), pid: String(msg.pid || "").slice(0, 24) });
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

  /** 接続を、部屋の人として入れる（id と札はホストが決める）。 */
  function admit(conn, { id = null, token = null, name, role }) {
    const playerId = id || `g${randomToken(10)}`;
    if (!id && !roomHasSpace(state, playerId)) {
      net.send(conn, { type: "reject", reason: "full" });
      setTimeout(() => net?.drop(conn), 500);
      return;
    }
    const tok = token || randomToken(20);
    // 同じ人の古い線があれば、閉じる（読み直したとき）。
    for (const [other, otherId] of connPlayer) {
      if (otherId === playerId && other !== conn) {
        connPlayer.delete(other);
        lastSeen.delete(other);
        net.drop(other);
      }
    }
    tokens.set(tok, playerId);
    connPlayer.set(conn, playerId);
    dispatch({ type: "join", player: { id: playerId, name, role } });
    net.send(conn, { type: "welcome", id: playerId, token: tok, state });
  }

  function syncPending() {
    store.update((v) => ({ ...v, pending: [...pending.values()].map(({ key, name }) => ({ key, name })) }));
  }

  function findPending(key) {
    for (const [conn, p] of pending) if (p.key === key) return [conn, p];
    return [null, null];
  }

  /** ホスト: 待っている人を入れる。 */
  function admitPending(key) {
    const [conn, p] = findPending(key);
    if (!conn) return;
    pending.delete(conn);
    syncPending();
    admit(conn, { name: p.name, role: p.role });
  }

  /** ホスト: 待っている人を入れない。 */
  function denyPending(key) {
    const [conn] = findPending(key);
    if (!conn) return;
    pending.delete(conn);
    syncPending();
    net?.send(conn, { type: "reject", reason: "denied" });
    setTimeout(() => net?.drop(conn), 500);
  }

  /** ホスト: 人を部屋から外す。札も使えなくする。 */
  function removePlayer(id) {
    if (!isHostLike() || id === current.myId) return;
    removed.add(id);
    // 外した人は、リンクの合言葉を知っている。合言葉を作りなおして、前のリンクでは
    // 許可なしに入れないようにする（入っている人は札で入り直せるので困らない）。
    if (net) {
      roomKey = randomToken(12);
      store.update((v) => ({ ...v, roomKey }));
    }
    for (const [tok, owner] of tokens) if (owner === id) tokens.delete(tok);
    for (const [conn, owner] of [...connPlayer]) {
      if (owner !== id) continue;
      connPlayer.delete(conn);
      lastSeen.delete(conn);
      net?.send(conn, { type: "reject", reason: "removed" });
      setTimeout(() => net?.drop(conn), 500);
    }
    dispatch({ type: "remove", id });
  }

  // --- ゲスト ---------------------------------------------------------

  let lastJoin = null;

  async function join(code, me, key = null) {
    leave();
    lastJoin = { code, me, key };
    offset = 0;
    clock.length = 0;
    lastEventId = 0;
    store.update((v) => ({ ...v, mode: "guest", status: "connecting", error: null, code }));
    try {
      net = await transport.joinRoom(code, {
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
    // あいさつ 1/2: 秘密は送らない。乱数と、札の目じるしだけ。
    const token = loadRoomToken(code);
    guestHs = { g: randomToken(16), key: key || null, token, me, sent: false };
    net.send({ type: "hello", n: guestHs.g, tid: token ? tokenId(token) : undefined });
    clearTimeout(guestHsTimer);
    guestHsTimer = setTimeout(() => {
      if (!guestHs || guestHs.sent) return;
      store.update((v) => ({ ...v, status: "error", error: "へやの ホストから へんじが ありません" }));
      net?.close();
      net = null;
    }, HANDSHAKE_MS);
    ping();
    return true;
  }

  /** あいさつ 2/2: ホストの印を確かめる。合えば自分の印を、合わなければ名前だけを送る。 */
  function onProve(msg) {
    if (!guestHs || guestHs.sent || typeof msg.n !== "string") return;
    clearTimeout(guestHsTimer);
    const { local, remote } = net.channel();
    const ctx = { g: guestHs.g, h: msg.n, gf: local, hf: remote };
    const { key, token, me } = guestHs;
    const checked = same(msg.k, proof(key, "host", ctx)) || same(msg.t, proof(token, "host", ctx));
    guestHs.sent = true;
    store.update((v) => ({ ...v, hostChecked: checked }));
    net.send({
      type: "join",
      name: me.name,
      role: me.role,
      k: checked ? proof(key, "guest", ctx) : undefined,
      t: checked ? proof(token, "guest", ctx) : undefined,
    });
  }

  /** 切れたあと、同じ部屋に同じ人として入り直す。 */
  function rejoin() {
    if (!lastJoin) return Promise.resolve(false);
    return join(lastJoin.code, lastJoin.me, lastJoin.key);
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
    // あいさつ（join を送る）より前に来た「入れた・待って」は受けない。
    if ((msg.type === "wait" || msg.type === "welcome") && !guestHs?.sent) return;
    switch (msg.type) {
      case "prove":
        onProve(msg);
        return;
      case "wait":
        store.update((v) => ({ ...v, status: "waiting" }));
        return;
      case "welcome":
        // 自分の id はホストが決める。入り直しの札は、このタブにだけ覚えておく。
        if (typeof msg.token === "string") saveRoomToken(current.code, msg.token);
        store.update((v) => ({ ...v, status: "open", myId: String(msg.id || v.myId) }));
        // 入る前の出来事は鳴らさない。
        lastEventId = msg.state?.eventSeq ?? 0;
        if (msg.state) setState(msg.state, { silent: true });
        return;
      case "state":
        // 入る前（welcome より前）の状態は受けない。
        if (!state) return;
        if (msg.state.seq >= state.seq || msg.state.roomCode !== state.roomCode) setState(msg.state);
        return;
      case "pong":
        onPong(msg);
        return;
      case "reject":
        store.update((v) => ({
          ...v,
          status: "error",
          error:
            msg.reason === "full"
              ? "へやが いっぱいです（20人まで）"
              : msg.reason === "denied"
                ? "ホストが へやに いれませんでした"
                : msg.reason === "removed"
                  ? "へやから はずされました"
                  : "へやに はいれませんでした",
        }));
        // 札を捨てるのは、この線で入れてもらったあとだけ（入る前の「外した」は、にせかもしれない）。
        if (msg.reason === "removed" && state) saveRoomToken(current.code, null);
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
    clearTimeout(guestHsTimer);
    wakeTimer = null;
    pingTimer = null;
    liveTimer = null;
    guestHsTimer = null;
    pingCount = 0;
  }

  function leave() {
    stopTimers();
    net?.close();
    net = null;
    state = null;
    connPlayer.clear();
    lastSeen.clear();
    tokens.clear();
    pending.clear();
    removed.clear();
    greeting.clear();
    guestHs = null;
    roomKey = null;
    store.update((v) => ({ ...v, mode: null, status: "idle", state: null, code: null, error: null, trouble: null, roomKey: null, pending: [], hostChecked: null }));
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
    admitPending,
    denyPending,
    removePlayer,
    hostNow,
    isHost: () => isHostLike(),
    me: () => (state ? playerById(state, current.myId) : null),
    onEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
}

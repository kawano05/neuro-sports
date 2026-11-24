// =====================================================================
// net.js — ブラウザどうしを WebRTC でつなぐ（PeerJS）
//
// GitHub Pages は静的なサイトで、サーバーを置けない。つなぐ相手を見つける
// （シグナリング）だけ、PeerJS の公開サーバー（0.peerjs.com）を使い、そのあとの
// やりとり（ゲームの状態・だれが押したか）は、ブラウザどうしで直接（暗号化されて）流れる。
// 直接つながらないネットワークでは、PeerJS の中継（TURN）を通る。
//
// 部屋の番号は6けた。PeerJS の id は PREFIX + 番号。ほかのアプリとぶつからないよう、
// このアプリだけの前置きを付ける。
//
// 番号は総当たりで見つけられる（前置きは公開のコードに書いてある）。なので番号だけでは
// 入れない: 番号を打って来た人は、ホストが「入れる」を押すまで待つ（session.js）。
// ホストが配るリンクには、推測できない合言葉（key）が付いていて、リンクから来た人はそのまま入れる。
// =====================================================================

export const PEER_PREFIX = "neuro-sports-v2-";
export const CODE_DIGITS = 6;
const OPEN_TIMEOUT_MS = 15000;

export function roomPeerId(code) {
  return `${PEER_PREFIX}${code}`;
}

/** 0 以上 max 未満の、推測できない整数（crypto）。 */
function secureInt(max) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

export function makeRoomCode() {
  return String(10 ** (CODE_DIGITS - 1) + secureInt(9 * 10 ** (CODE_DIGITS - 1)));
}

/** 推測できない文字列（合言葉・入り直しの札）。読み間違えやすい字は使わない。 */
export function randomToken(length = 16) {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length }, () => abc[secureInt(abc.length)]).join("");
}

/** 入力された番号から、数字6けただけを取り出す（全角も受ける）。 */
export function normalizeCode(text) {
  const digits = String(text || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, "");
  return digits.length === CODE_DIGITS ? digits : null;
}

async function loadPeer() {
  const { Peer } = await import("peerjs");
  return Peer;
}

function failure(type, message) {
  const error = new Error(message || type);
  error.type = type;
  return error;
}

function openPeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const options = { debug: 0 };
    const peer = id ? new Peer(id, options) : new Peer(options);
    const timer = setTimeout(() => {
      peer.destroy();
      reject(failure("timeout"));
    }, OPEN_TIMEOUT_MS);
    peer.once("open", () => {
      clearTimeout(timer);
      resolve(peer);
    });
    peer.once("error", (error) => {
      clearTimeout(timer);
      peer.destroy();
      reject(error);
    });
  });
}

/**
 * 部屋を作る（ホスト）。
 * @param {{onOpen:(conn)=>void, onData:(conn, msg)=>void, onClose:(conn)=>void, onTrouble?:(type:string)=>void}} handlers
 * @returns {Promise<{code:string, broadcast:(msg)=>void, send:(conn,msg)=>void, close:()=>void}>}
 */
export async function hostRoom(handlers) {
  const Peer = await loadPeer();
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = makeRoomCode();
    let peer;
    try {
      peer = await openPeer(Peer, roomPeerId(code));
    } catch (error) {
      lastError = error;
      // 同じ番号の部屋がもうある → 別の番号で。
      if (error?.type === "unavailable-id") continue;
      throw error;
    }
    const conns = new Set();
    peer.on("connection", (conn) => {
      conn.on("open", () => {
        conns.add(conn);
        handlers.onOpen?.(conn);
      });
      conn.on("data", (msg) => handlers.onData?.(conn, msg));
      const closed = () => {
        if (!conns.delete(conn)) return;
        handlers.onClose?.(conn);
      };
      conn.on("close", closed);
      conn.on("error", closed);
      conn.peerConnection?.addEventListener?.("connectionstatechange", () => {
        const s = conn.peerConnection?.connectionState;
        if (s === "failed" || s === "closed") closed();
      });
    });
    // 案内役のサーバーとの線が切れても、つながっている人とはそのまま遊べる。
    // 新しい人が入れるように、つなぎ直す。
    peer.on("disconnected", () => {
      handlers.onTrouble?.("signal-lost");
      setTimeout(() => {
        if (!peer.destroyed) peer.reconnect();
      }, 1500);
    });
    peer.on("error", (error) => handlers.onTrouble?.(error?.type || "error"));
    return {
      code,
      broadcast(msg) {
        for (const conn of conns) if (conn.open) conn.send(msg);
      },
      send(conn, msg) {
        if (conn.open) conn.send(msg);
      },
      drop(conn) {
        conns.delete(conn);
        try {
          conn.close();
        } catch {
          /* もう閉じている */
        }
      },
      close() {
        for (const conn of conns) conn.close();
        conns.clear();
        peer.destroy();
      },
    };
  }
  throw lastError || failure("unavailable-id");
}

/**
 * 部屋に入る（ゲスト）。
 * @param {string} code
 * @param {{onData:(msg)=>void, onClose:()=>void}} handlers
 */
export async function joinRoom(code, handlers) {
  const Peer = await loadPeer();
  const peer = await openPeer(Peer, null);
  const conn = peer.connect(roomPeerId(code), { reliable: true, serialization: "json" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.destroy();
      reject(failure("timeout"));
    }, OPEN_TIMEOUT_MS);
    conn.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    peer.once("error", (error) => {
      clearTimeout(timer);
      peer.destroy();
      reject(error);
    });
  });
  let closed = false;
  const onClosed = () => {
    if (closed) return;
    closed = true;
    handlers.onClose?.();
  };
  conn.on("data", (msg) => handlers.onData?.(msg));
  conn.on("close", onClosed);
  conn.on("error", onClosed);
  conn.peerConnection?.addEventListener?.("connectionstatechange", () => {
    const s = conn.peerConnection?.connectionState;
    if (s === "failed" || s === "closed") onClosed();
  });
  return {
    send(msg) {
      if (conn.open) conn.send(msg);
    },
    close() {
      closed = true;
      peer.destroy();
    },
  };
}

/** つながらなかった理由を、利用者に見せる言葉へ。 */
export function troubleText(error) {
  const type = error?.type || "";
  if (type === "peer-unavailable") return "その ばんごうの へやは みつかりませんでした";
  if (type === "timeout") return "つながるまでに じかんが かかりすぎました";
  if (type === "browser-incompatible") return "この ブラウザでは つなげません";
  if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
    return "インターネットに つながっていないようです";
  }
  return "つながりませんでした";
}

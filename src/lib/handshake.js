// =====================================================================
// handshake.js — 入るときの「あいさつ」で、ホストが本物かを確かめる
//
// 困ること: 部屋の番号は6けたで、総当たりで見つけられる。ホストと案内役のサーバー
// （PeerJS）の線が切れたすきに、別の人が同じ番号を名乗ると、そのあいだに来た人は
// にせのホストにつながる。前は、つないですぐに合言葉（key）と入り直しの札（token）を
// 送っていたので、にせのホストに盗まれるおそれがあった。
//
// いまの決まり: 秘密そのものは、どちらからも送らない。秘密を知っていることを、
// 「その場かぎりの印（HMAC）」で見せ合う。
//   1. ゲスト → ホスト  hello { n: ゲストの乱数, tid: 札の目じるし（札からは戻せない） }
//   2. ホスト → ゲスト  prove { n: ホストの乱数, k: 合言葉の印, t: 札の印 }
//   3. ゲストは印を確かめる。合っていれば、自分の印（ゲスト用）を送る。
//      合わなければ、何も秘密を使わずに「入れてください」とだけ送る（ホストの許可待ち）。
//   4. ホストはゲストの印を確かめて入れる。合わなければ、許可待ちにする。
//
// 印には、2人の乱数のほかに、この線の暗号のかぎの指紋（DTLS の fingerprint）を混ぜる。
// にせのホストが、本物のホストとのあいだで印を横流ししても、指紋が合わないので通らない。
//
// 番号だけで来た人は、もともと秘密を持っていないので、ホストを確かめられない
// （名前だけを送って、許可を待つ）。
//
// http の LAN（iPad でのためし）では crypto.subtle が使えないので、SHA-256 はここで書く。
// =====================================================================

const LABEL = "neuro-sports-v3";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function utf8(text) {
  return new TextEncoder().encode(String(text));
}

/** SHA-256（バイト列 → 32バイト）。 */
export function sha256(bytes) {
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000));
  view.setUint32(total - 4, (len * 8) >>> 0);
  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v));
  return out;
}

/** HMAC-SHA256（文字列のかぎ・文字列 → 32バイト）。 */
export function hmac(key, message) {
  let k = utf8(key);
  if (k.length > 64) k = sha256(k);
  const msg = utf8(message);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i += 1) {
    inner[i] = (k[i] || 0) ^ 0x36;
    outer[i] = (k[i] || 0) ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 長さのそろった文字列を、かかる時間を変えずに比べる。 */
export function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 入り直しの札の目じるし。ホストが札を見つけるためだけに使う（ここから札には戻せない）。 */
export function tokenId(token) {
  return hex(sha256(utf8(`${LABEL}|tid|${token}`))).slice(0, 32);
}

/** SDP から、暗号のかぎの指紋を取り出す（並べて1つの文字列に）。 */
export function sdpFingerprints(sdp) {
  const lines = String(sdp || "").match(/^a=fingerprint:[^\r\n]*/gm) || [];
  const prints = lines.map((line) => line.slice("a=fingerprint:".length).trim().replace(/\s+/g, " ").toLowerCase());
  return [...new Set(prints)].sort().join(",");
}

/** RTCPeerConnection から、こちらと相手の指紋。読めなければ空。 */
export function channelOf(pc) {
  try {
    return {
      local: sdpFingerprints((pc?.currentLocalDescription || pc?.localDescription)?.sdp),
      remote: sdpFingerprints((pc?.currentRemoteDescription || pc?.remoteDescription)?.sdp),
    };
  } catch {
    return { local: "", remote: "" };
  }
}

/**
 * 秘密を知っていることの印。side は "host" か "guest"（ホストの印を、ゲストの印として使い回せないように）。
 * ctx: { g: ゲストの乱数, h: ホストの乱数, gf: ゲスト側の指紋, hf: ホスト側の指紋 }
 */
export function proof(secret, side, ctx) {
  if (!secret) return undefined;
  return hex(hmac(secret, [LABEL, side, ctx.g, ctx.h, ctx.gf, ctx.hf].join("|")));
}

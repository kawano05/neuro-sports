// この端末に覚えておくこと（名前・読み上げ・音の大きさ・ホストのときの設定）。
// 保存できない環境（プライベートウィンドウなど）でも動くように、すべて try で包む。

const KEY = "neuro-sports.prefs.v1";
const ID_KEY = "neuro-sports.client.v1";

export const DEFAULT_PREFS = Object.freeze({
  name: "",
  role: "play",
  speech: true,
  volume: "mid", // small | mid | large
  settings: null,
});

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_PREFS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch) {
  try {
    const next = { ...loadPrefs(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return { ...DEFAULT_PREFS, ...patch };
  }
}

let memoryId = null;

/**
 * この端末（タブ）の id。タブごとに別にする（sessionStorage）。
 * 読み直しても同じ id なので、つなぎ直したときに同じ人として戻れる。
 */
export function clientId() {
  if (memoryId) return memoryId;
  const fresh = () => `p${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  try {
    let id = sessionStorage.getItem(ID_KEY);
    if (!id) {
      id = fresh();
      sessionStorage.setItem(ID_KEY, id);
    }
    memoryId = id;
  } catch {
    memoryId = fresh();
  }
  return memoryId;
}

const TOKEN_KEY = (code) => `neuro-sports.token.${code}`;

/**
 * 入り直しの札（ホストが渡す秘密の文字列）。部屋ごとに、このタブにだけ覚えておく。
 * id はほかの人にも見えるので、id では入り直せない（なりすましを防ぐ）。
 */
export function loadRoomToken(code) {
  try {
    return sessionStorage.getItem(TOKEN_KEY(code)) || null;
  } catch {
    return null;
  }
}

export function saveRoomToken(code, token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY(code), token);
    else sessionStorage.removeItem(TOKEN_KEY(code));
  } catch {
    /* 保存できない環境 */
  }
}

// 決まり（純粋関数）の単体テスト。`npm test` で走る。
import assert from "node:assert/strict";
import {
  advanceRunners,
  contactQuality,
  hitWindowMs,
  offsetFromSweet,
  simulateHit,
  wallResult,
  fenceR,
  OUT,
  SPIN_PERIOD_MS,
} from "../src/lib/games/baseball.js";
import {
  BALL_R,
  aimAt,
  autoPower,
  nextTeam,
  powerAt,
  restingPoint,
  scoreEnd,
  simulateThrow,
  triangle,
  AIM_MAX_DEG,
  TURNTABLE,
  placeJack,
} from "../src/lib/games/boccia.js";
import { createState, reduce, activePlayers, TURN_GUARD_MS, MAX_PLAYING, MAX_IN_ROOM, PLAYER_COLORS, WATCH_COLOR, roomHasSpace } from "../src/lib/engine.js";
import { rb, plain } from "../src/lib/text.js";
import { makeRoomCode, normalizeCode, randomToken } from "../src/lib/net.js";
import { sha256, hmac, sdpFingerprints, proof, same, tokenId } from "../src/lib/handshake.js";
import { createSession } from "../src/lib/session.js";
import { get } from "svelte/store";
import nodeCrypto from "node:crypto";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

// --- 野球 -------------------------------------------------------------

test("ずれは (−半周, 半周] に入る", () => {
  assert.equal(offsetFromSweet(1000, 1000, 3000), 0);
  assert.equal(offsetFromSweet(1100, 1000, 3000), 100);
  assert.equal(offsetFromSweet(900, 1000, 3000), -100);
  assert.equal(offsetFromSweet(1000 + 3000 * 5 + 50, 1000, 3000), 50);
  assert.equal(offsetFromSweet(1000 - 3000 * 2 - 50, 1000, 3000), -50);
});

test("当たりのよさ: 真ん中が 1、端が 0、外は空振り", () => {
  assert.equal(contactQuality(0, 400), 1);
  assert.equal(contactQuality(-400, 400), 0);
  assert.equal(contactQuality(200, 400), 0.5);
  assert.equal(contactQuality(401, 400), null);
});

test("「いつでも」は、円盤のどこでも当たる", () => {
  const period = SPIN_PERIOD_MS.normal;
  const w = hitWindowMs("always", period);
  assert.equal(w, period / 2);
  for (let t = 0; t < period; t += 37) assert.notEqual(contactQuality(offsetFromSweet(t, 0, period), w), null);
});

const half = () => 0.5;
/** ばらつき 0 の乱数（ボックス＝ミュラー法で cos(π/2) = 0）。 */
const zero = () => 0.25;

test("真ん中で打つと（ばらつきが無ければ）、まっすぐフェンスのホームランの区画へ", () => {
  const r = simulateHit(0, 600, zero);
  assert.ok(["wall", "over"].includes(r.where.kind), r.where.kind);
  assert.equal(r.n, 4);
  assert.ok(r.frames.length > 10);
});

test("打ったボールは飛んで、落ちて、転がる（コマに高さがある）", () => {
  const r = simulateHit(-60, 600, zero);
  const heights = r.frames.map((f) => f[2]);
  assert.equal(heights[0], 0, "飛び出す時は地面");
  assert.ok(Math.max(...heights) > 60, `高く上がる: ${Math.max(...heights)}`);
  assert.equal(heights.at(-1), 0, "おわりは地面");
  assert.ok(r.landMs > 0 && r.landMs < r.durationMs);
});

test("どの当たりも、おわりは地面（空中で止まって見えない）", () => {
  let seed = 21;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 3000; i += 1) {
    const r = simulateHit((rng() * 2 - 1) * 600, 600, rng);
    assert.equal(r.frames.at(-1)[2], 0, `${i}: ${r.where.kind}`);
  }
});

test("飛んでいる間は、穴に落ちない（センターの穴を飛びこえる）", () => {
  // ばらつき無しで真ん中: センターの穴（本塁から 470）の上を通る。
  const r = simulateHit(0, 600, zero);
  assert.notEqual(r.where.kind, "pocket");
});

test("落ちる前にホームランの区画に届いたら、フェンスをこえてスタンドに入る", () => {
  let found = null;
  for (let i = 1; i < 3000 && !found; i += 1) {
    let k = i;
    const r = simulateHit(0, 600, () => ((k = (k * 48271) % 2147483647) / 2147483647));
    if (r.where.kind === "over") found = r;
  }
  assert.ok(found, "フェンスごえが起きる");
  assert.equal(found.n, 4);
  const s = (Math.atan2(found.stop.x - 500, 1000 - found.stop.y) * 180) / Math.PI;
  assert.ok(Math.hypot(found.stop.x - 500, found.stop.y - 1000) > fenceR(s), "スタンドの中で止まる");
});

test("早く振ると左、遅く振ると右へ飛ぶ", () => {
  const early = simulateHit(-250, 600, zero);
  const late = simulateHit(250, 600, zero);
  assert.ok(early.stop.x < 500 && late.stop.x > 500, `${early.stop.x} / ${late.stop.x}`);
});

test("端で打つと線ぞいに飛び、線ぞいのヒットの区画にも届く", () => {
  for (const offset of [-520, 520]) {
    const r = simulateHit(offset, 600, zero);
    assert.equal(r.where.kind, "wall", `${offset}: ${r.where.kind}`);
    assert.equal(r.n, 1);
  }
});

test("線ぞいのヒットの区画は、ねらえば 2割くらい当たる（以前は1割）", () => {
  let seed = 9;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let hits = 0;
  const N = 2000;
  for (let i = 0; i < N; i += 1) if (simulateHit(540, 600, rng).n === 1) hits += 1;
  assert.ok(hits / N > 0.15, `${hits / N}`);
});

test("野手の位置の穴に、ゆっくり来たボールが落ちたらアウト", () => {
  // 一塁手の穴をねらう: いろいろな強さで、穴に落ちる回がある。
  let pocketOuts = 0;
  for (let i = 0; i < 400; i += 1) {
    let k = i;
    const r = simulateHit(200 + (i % 40) * 10, 600, () => ((k = (k * 16807 + 11) % 2147483647) / 2147483647));
    if (r.where.kind === "pocket") {
      assert.equal(r.n, OUT);
      pocketOuts += 1;
    }
  }
  assert.ok(pocketOuts > 0);
});

test("でたらめに押しても、上手に押しても、アウトは出る（終わらない試合にならない）", () => {
  let seed = 3;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const outRate = (spreadMs) => {
    let outs = 0;
    const N = 3000;
    for (let i = 0; i < N; i += 1) {
      const u = Math.max(1e-9, rng());
      const o = Math.max(-600, Math.min(600, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()) * spreadMs));
      if (simulateHit(o, 600, rng).n === OUT) outs += 1;
    }
    return outs / N;
  };
  assert.ok(outRate(80) > 0.15, "上手な人でもアウトが出る");
  assert.ok(outRate(400) > 0.4);
});

test("フェンスの区画は真ん中ほど長打で、あいだにアウトの区画", () => {
  assert.equal(wallResult(0), 4);
  assert.equal(wallResult(-10), 3);
  assert.equal(wallResult(15), OUT);
  assert.equal(wallResult(20), 2);
  assert.equal(wallResult(-30), OUT);
  assert.equal(wallResult(-40), 1);
});

test("同じ乱数なら、同じところに止まる（ホストだけが計算して配る）", () => {
  assert.deepEqual(simulateHit(123, 600, half), simulateHit(123, 600, half));
});

test("ランナーは打った数だけ進み、本塁に着いたら点", () => {
  let r = advanceRunners([null, null, null], "a", 1);
  assert.deepEqual(r.bases, ["a", null, null]);
  r = advanceRunners(r.bases, "b", 2);
  assert.deepEqual(r.bases, [null, "b", "a"]);
  r = advanceRunners(r.bases, "c", 1);
  assert.deepEqual(r.bases, ["c", null, "b"]);
  assert.deepEqual(r.scored, ["a"]);
  r = advanceRunners(r.bases, "d", 4);
  assert.deepEqual(r.bases, [null, null, null]);
  assert.deepEqual(r.scored.sort(), ["b", "c", "d"]);
});

// --- ボッチャ -----------------------------------------------------------

test("三角の波は 0〜1 を一定の速さで行き来する", () => {
  assert.equal(triangle(0, 0, 1000), 0);
  assert.equal(triangle(250, 0, 1000), 0.5);
  assert.equal(triangle(500, 0, 1000), 1);
  assert.equal(triangle(750, 0, 1000), 0.5);
  assert.equal(triangle(-250, 0, 1000), 0.5);
});

test("むきは真ん中から始まり、±最大角に収まる", () => {
  assert.ok(Math.abs(aimAt(0, 0, 4000)) < 1e-9);
  for (let t = 0; t < 8000; t += 113) assert.ok(Math.abs(aimAt(t, 0, 4000)) <= AIM_MAX_DEG + 1e-9);
  assert.ok(aimAt(500, 0, 4000) > 0);
});

test("つよさは押した瞬間 0 から上る", () => {
  assert.equal(powerAt(1000, 1000, 4000), 0);
  assert.ok(powerAt(1500, 1000, 4000) > 0);
});

test("ぶつからなければ、とどく ところで止まる", () => {
  const court = { jack: { x: 100, y: 100 }, balls: [] };
  const sim = simulateThrow(court, { id: "b1", team: "red" }, 0, 0.5);
  const thrown = sim.balls.find((b) => b.id === "b1");
  const rest = restingPoint(0, 0.5);
  assert.ok(Math.abs(thrown.x - rest.x) < 2, `${thrown.x} vs ${rest.x}`);
  assert.ok(Math.abs(thrown.y - rest.y) < 3, `${thrown.y} vs ${rest.y}`);
  assert.equal(thrown.out, false);
  assert.ok(sim.frames.length > 10);
});

test("「むきだけ」の強さで、ジャックの近くまで行く", () => {
  const jack = { x: 300, y: 450 };
  const power = autoPower(0, jack);
  const sim = simulateThrow({ jack, balls: [] }, { id: "b1", team: "red" }, 0, power);
  const ball = sim.balls[0];
  const d = Math.hypot(ball.x - sim.jack.x, ball.y - sim.jack.y);
  assert.ok(d < BALL_R * 3, `距離 ${d}`);
});

test("強すぎる玉はコートの外（アウト）", () => {
  const sim = simulateThrow({ jack: { x: 100, y: 500 }, balls: [] }, { id: "b1", team: "red" }, 0, 1);
  assert.equal(sim.balls[0].out, true);
});

test("ぶつかった玉は はじかれる", () => {
  const target = { id: "r1", team: "red", x: 300, y: 600 };
  const sim = simulateThrow({ jack: { x: 100, y: 200 }, balls: [target] }, { id: "b1", team: "blue" }, 0, 0.75);
  const moved = sim.balls.find((b) => b.id === "r1");
  assert.ok(sim.hits >= 1);
  assert.ok(moved.y < 600 - 5, `はじかれた先 ${moved.y}`);
});

test("点数: 相手のいちばん近い玉より近い玉の数", () => {
  const jack = { x: 0, y: 0 };
  const balls = [
    { id: "a", team: "red", x: 10, y: 0 },
    { id: "b", team: "red", x: 20, y: 0 },
    { id: "c", team: "blue", x: 30, y: 0 },
    { id: "d", team: "red", x: 40, y: 0 },
    { id: "e", team: "blue", x: 5, y: 0, out: true },
  ];
  const r = scoreEnd(balls, jack);
  assert.equal(r.team, "red");
  assert.equal(r.points, 2);
});

test("次に投げるのは、ジャックから遠いチーム", () => {
  const jack = { x: 0, y: 0 };
  const left = { red: 2, blue: 2 };
  assert.equal(nextTeam([], jack, left), "red");
  assert.equal(nextTeam([{ team: "red", x: 10, y: 0 }], jack, left), "blue");
  const both = [
    { team: "red", x: 10, y: 0 },
    { team: "blue", x: 50, y: 0 },
  ];
  assert.equal(nextTeam(both, jack, left), "blue");
  assert.equal(nextTeam(both, jack, { red: 1, blue: 0 }), "red");
  assert.equal(nextTeam(both, jack, { red: 0, blue: 0 }), null);
});

// --- 部屋（エンジン） -------------------------------------------------------

function room(names) {
  let s = createState({ roomCode: "1234" });
  names.forEach((name, i) => {
    s = reduce(s, { type: "join", player: { id: name, name, host: i === 0 } }, 0);
  });
  return s;
}

/** 打って、止まって、次のボールまで進める。 */
function atBat(s, offset) {
  const who = s.turn.playerId;
  const bb = s.baseball;
  const after = s.turn.since + TURN_GUARD_MS + 10;
  const k = Math.ceil((after - bb.sweetAt) / bb.period);
  const t = bb.sweetAt + k * bb.period + offset;
  s = reduce(s, { type: "press", playerId: who, t, pid: "x" }, t, zero);
  assert.equal(s.baseball.phase, "flight", "当たっていない");
  s = reduce(s, { type: "tick" }, s.baseball.resultAt, zero);
  assert.equal(s.baseball.phase, "result");
  return reduce(s, { type: "tick" }, s.baseball.nextAt, zero);
}

test("野球（アウトなし）: 打って止まったら点が入り、次の人へ", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "together" }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 1000);
  assert.equal(s.baseball.mode, "together");
  assert.equal(s.turn.playerId, "a");
  // 番でない人が押しても、打たない（おうえん）。
  s = reduce(s, { type: "press", playerId: "b", t: s.baseball.sweetAt }, s.baseball.sweetAt);
  assert.equal(s.events.at(-1).kind, "cheer");
  s = atBat(s, 0);
  assert.equal(s.baseball.runs, 1);
  assert.equal(s.turn.playerId, "b");
  assert.equal(s.baseball.phase, "spin");
});

test("野球（アウトなし）: アウトの場所に止まってもヒットにする", () => {
  let s = room(["a"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "together" }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  s = atBat(s, 480);
  assert.equal(s.baseball.log.at(-1).n, 1);
  assert.deepEqual(s.baseball.bases, ["a", null, null]);
});

test("野球: 空振りは数えない", () => {
  let s = room(["a"]);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  const bb = s.baseball;
  const far = bb.sweetAt + bb.period / 2;
  s = reduce(s, { type: "press", playerId: "a", t: far }, far);
  assert.equal(s.baseball.phase, "spin");
  assert.equal(s.events.at(-1).contact, false);
});

test("野球（イニング制）: 3アウトでチェンジ、決めた回でおわって勝ち負け", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "innings" }, 0);
  s = reduce(s, { type: "settings", game: "baseball", key: "innings", value: 1 }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  assert.equal(s.baseball.mode, "innings");
  assert.deepEqual(s.baseball.teams, ["red", "blue"]);
  assert.equal(s.baseball.batting, "red");
  // 赤: 3アウトでチェンジ。
  for (let i = 0; i < 3; i += 1) s = atBat(s, 480);
  assert.equal(s.baseball.batting, "blue");
  assert.equal(s.baseball.half, 1);
  assert.equal(s.turn.playerId, "b");
  assert.equal(s.events.filter((e) => e.kind === "change").at(-1).reason, "outs");
  // 青: ホームラン（1点）のあと2アウト。1人のチームなので3打席で打ち切り → 1回でおわり。青の勝ち。
  s = atBat(s, 0);
  assert.equal(s.baseball.score.blue, 1);
  s = atBat(s, 480);
  s = atBat(s, 480);
  assert.equal(s.baseball.phase, "done");
  assert.equal(s.baseball.winner, "blue");
  assert.equal(s.turn, null);
});

test("野球（打席制・既定）: 赤青が1人ずつ交互に打ち、点はヒットの種類で、決めた数で おわり", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  assert.equal(s.baseball.mode, "atbats");
  assert.equal(s.turn.playerId, "a");
  s = atBat(s, 0); // ホームラン = 4点
  assert.equal(s.baseball.score.red, 4);
  assert.deepEqual(s.baseball.bases, [null, null, null]);
  assert.equal(s.turn.playerId, "b");
  assert.equal(s.baseball.batting, "blue");
  s = atBat(s, 480); // アウト = 0点
  assert.equal(s.baseball.score.blue, 0);
  assert.equal(s.turn.playerId, "a");
  s = atBat(s, 0);
  s = atBat(s, 0);
  assert.equal(s.baseball.phase, "done");
  assert.equal(s.baseball.winner, "red");
});

test("野球（イニング制）: アウトが無くても、打者一巡（3人より少なければ3打席）でチェンジ", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "innings" }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  for (let i = 0; i < 3; i += 1) s = atBat(s, 0);
  assert.equal(s.baseball.batting, "blue");
  assert.equal(s.events.filter((e) => e.kind === "change").at(-1).reason, "round");
});

test("野球（アウトなし）: みんなが決まった数を打ったら おわり", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "together" }, 0);
  s = reduce(s, { type: "settings", game: "baseball", key: "atBats", value: 1 }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  s = atBat(s, 0);
  s = atBat(s, 0);
  assert.equal(s.baseball.phase, "done");
  assert.equal(s.turn, null);
});

test("野球: 番の人がいなくなったら、次の人へ", () => {
  let s = room(["a", "b", "c"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "together" }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  s = reduce(s, { type: "leave", id: "a" }, 100);
  assert.equal(s.turn.playerId, "b");
  assert.equal(activePlayers(s).length, 2);
});

test("ボッチャ: 2回押しで、むき → つよさ → 転がる → 次のチーム", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "start", game: "boccia" }, 0);
  const bc = s.boccia;
  assert.deepEqual(bc.teams, ["red", "blue"]);
  assert.equal(s.turn.playerId, "a");
  const t1 = TURN_GUARD_MS + 200;
  s = reduce(s, { type: "press", playerId: "a", t: t1 }, t1);
  assert.equal(s.boccia.phase, "power");
  assert.equal(typeof s.boccia.angle, "number");
  const t2 = t1 + 1200;
  s = reduce(s, { type: "press", playerId: "a", t: t2 }, t2);
  assert.equal(s.boccia.phase, "roll");
  assert.equal(s.boccia.left.red, 2);
  s = reduce(s, { type: "tick" }, s.boccia.nextAt);
  assert.equal(s.boccia.phase, "aim");
  assert.equal(s.boccia.current.team, "blue");
  assert.equal(s.turn.playerId, "b");
});

test("ボッチャ: ひとりなら1チームで、全部投げたら おわりの結果が出る", () => {
  let s = room(["a"]);
  s = reduce(s, { type: "settings", game: "boccia", key: "presses", value: 1 }, 0);
  s = reduce(s, { type: "settings", game: "boccia", key: "balls", value: 1 }, 0);
  s = reduce(s, { type: "start", game: "boccia" }, 0);
  assert.deepEqual(s.boccia.teams, ["red"]);
  assert.equal(s.boccia.perTeam, 2);
  let now = 0;
  for (let i = 0; i < 2; i += 1) {
    now += TURN_GUARD_MS + 300;
    s = reduce(s, { type: "press", playerId: "a", t: now }, now);
    assert.equal(s.boccia.phase, "roll");
    now = s.boccia.nextAt;
    s = reduce(s, { type: "tick" }, now);
  }
  assert.equal(s.boccia.phase, "end");
  assert.ok(s.boccia.result);
});

test("待っている部屋で押すと「スイッチの ためし」が全員に出る", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "press", playerId: "b", t: 5 }, 5);
  assert.equal(s.events.at(-1).kind, "test");
  assert.equal(s.events.at(-1).playerId, "b");
});

test("見るだけの人には、番が来ない", () => {
  let s = createState({ roomCode: "1234" });
  s = reduce(s, { type: "join", player: { id: "a", name: "a" } }, 0);
  s = reduce(s, { type: "join", player: { id: "w", name: "w", role: "watch" } }, 0);
  s = reduce(s, { type: "join", player: { id: "b", name: "b" } }, 0);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "together" }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  const seen = new Set();
  for (let i = 0; i < 4; i += 1) {
    seen.add(s.turn.playerId);
    s = atBat(s, 0);
  }
  assert.ok(!seen.has("w"));
  assert.deepEqual([...seen].sort(), ["a", "b"]);
});

test("ジャックは、どこに置かれても首振りの幅で狙える", () => {
  for (const [rx, ry] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
    const values = [rx, ry];
    const jack = placeJack(() => values.shift());
    const deg = (Math.atan2(jack.x - TURNTABLE.x, TURNTABLE.y - jack.y) * 180) / Math.PI;
    assert.ok(Math.abs(deg) <= AIM_MAX_DEG, `${deg.toFixed(1)}°`);
  }
});

test("ふりがなの文は1つの span にまとまる（横並びの中で漢字だけ下がらない）", () => {
  const html = rb("部屋[へや]を つくる");
  assert.equal(html, '<span class="rb"><ruby>部屋<rt aria-hidden="true">へや</rt></ruby>を つくる</span>');
  assert.equal(plain("部屋[へや]を つくる"), "へやを つくる");
  assert.ok(!rb("<b>").includes("<b>"));
});

test("あそぶのは8人まで。9人目は見るだけで入り、色は重ならない", () => {
  let s = createState({ roomCode: "1234" });
  for (let i = 0; i < MAX_PLAYING + 1; i += 1) s = reduce(s, { type: "join", player: { id: `p${i}`, name: `p${i}` } }, i);
  const playing = s.players.filter((p) => p.role === "play");
  assert.equal(playing.length, MAX_PLAYING);
  assert.equal(new Set(playing.map((p) => p.color)).size, MAX_PLAYING);
  assert.ok(playing.every((p) => PLAYER_COLORS.includes(p.color)));
  const ninth = s.players.at(-1);
  assert.equal(ninth.role, "watch");
  assert.equal(ninth.color, WATCH_COLOR);
  assert.equal(s.events.at(-1).kind, "full");
  // いっぱいのあいだは、見るだけから あそぶ に変えられない。
  const same = reduce(s, { type: "setRole", id: ninth.id, role: "play" }, 50);
  assert.equal(same, s);
  // ひとり抜けると、変えられる（あいた色をもらう）。
  s = reduce(s, { type: "leave", id: "p0" }, 60);
  s = reduce(s, { type: "setRole", id: ninth.id, role: "play" }, 70);
  const now = s.players.find((p) => p.id === ninth.id);
  assert.equal(now.role, "play");
  assert.ok(PLAYER_COLORS.includes(now.color));
});

test("部屋は20人まで。入り直しの人は入れる", () => {
  let s = createState({ roomCode: "1234" });
  for (let i = 0; i < MAX_IN_ROOM; i += 1) s = reduce(s, { type: "join", player: { id: `p${i}`, name: `p${i}`, role: "watch" } }, i);
  assert.equal(roomHasSpace(s, "new"), false);
  assert.equal(reduce(s, { type: "join", player: { id: "new", name: "new" } }, 99), s);
  assert.equal(roomHasSpace(s, "p3"), true);
});

test("部屋の番号は6けた、札は推測できない文字列", () => {
  for (let i = 0; i < 200; i += 1) assert.match(makeRoomCode(), /^[1-9][0-9]{5}$/);
  assert.equal(normalizeCode("１２３４５６"), "123456");
  assert.equal(normalizeCode("1234"), null);
  const t = randomToken(20);
  assert.match(t, /^[a-z2-9]{20}$/);
  assert.notEqual(randomToken(20), t);
});

test("ホストが外した人は、名前の列から消え、二度と入れない", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "format", value: "together" }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  s = reduce(s, { type: "setTurn", id: "b" }, 10);
  s = reduce(s, { type: "remove", id: "b" }, 20);
  const b = s.players.find((p) => p.id === "b");
  assert.equal(b.removed, true);
  assert.equal(s.turn.playerId, "a");
  assert.equal(reduce(s, { type: "join", player: { id: "b", name: "b" } }, 30), s);
  // ホスト自身は外せない。
  assert.equal(reduce(s, { type: "remove", id: "a" }, 40), s);
});

// --- 入るときのあいさつ（ホストのなりすまし対策） ---------------------------

test("SHA-256 と HMAC は、Node の crypto と同じ値になる", () => {
  const hex = (b) => Buffer.from(b).toString("hex");
  for (const n of [0, 1, 55, 56, 63, 64, 65, 200]) {
    const buf = nodeCrypto.randomBytes(n);
    assert.equal(hex(sha256(new Uint8Array(buf))), nodeCrypto.createHash("sha256").update(buf).digest("hex"));
  }
  for (const [k, m] of [["", ""], ["合言葉", "あいさつ|abc"], ["x".repeat(100), "m".repeat(300)]]) {
    assert.equal(hex(hmac(k, m)), nodeCrypto.createHmac("sha256", Buffer.from(k)).update(Buffer.from(m)).digest("hex"));
  }
});

test("SDP から暗号のかぎの指紋を取り出す（大文字小文字・重なり・並びにかかわらず同じ）", () => {
  const a = "v=0\r\na=fingerprint:sha-256 AB:CD:EF\r\nm=application\r\na=fingerprint:sha-256 AB:CD:EF\r\n";
  const b = "v=0\na=fingerprint:SHA-256 ab:cd:ef\n";
  assert.equal(sdpFingerprints(a), "sha-256 ab:cd:ef");
  assert.equal(sdpFingerprints(a), sdpFingerprints(b));
  assert.equal(sdpFingerprints(""), "");
  assert.notEqual(sdpFingerprints("a=fingerprint:sha-256 11:22"), sdpFingerprints(a));
});

test("ホストの印は、ゲストの印として使い回せない。指紋が違えば合わない", () => {
  const ctx = { g: "gggggggg", h: "hhhhhhhh", gf: "fp-g", hf: "fp-h" };
  assert.notEqual(proof("key", "host", ctx), proof("key", "guest", ctx));
  assert.notEqual(proof("key", "host", ctx), proof("key", "host", { ...ctx, gf: "fp-x" }));
  assert.equal(proof(null, "host", ctx), undefined);
  assert.equal(same(proof("key", "host", ctx), proof("key", "host", { ...ctx })), true);
  assert.equal(same(undefined, undefined), false);
  assert.notEqual(tokenId("tok"), "tok");
});

// 本物の session を、PeerJS の代わりの「線」でつないで、あいさつを通しで確かめる。
{
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}
const clone = (msg) => JSON.parse(JSON.stringify(msg));
const later = (fn) => setImmediate(fn);
const settle = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
};

/** 部屋の番号を持つ相手（本物のホスト）。connect でゲストからの線を1本つくる。 */
function hostEndpoint() {
  let handlers = null;
  const api = {
    code: "123456",
    send(conn, msg) {
      if (conn.open) later(() => conn.toGuest(clone(msg)));
    },
    broadcast() {},
    channel: (conn) => ({ local: conn.hostFp, remote: conn.guestFp }),
    drop(conn) {
      conn.open = false;
    },
    close() {},
  };
  return {
    transport: { hostRoom: async (h) => ((handlers = h), api) },
    connect(guestHandlers, { guestFp, hostFp = "fp-host" }) {
      const conn = { open: true, guestFp, hostFp, toGuest: (m) => guestHandlers.onData(m) };
      handlers.onOpen(conn);
      return {
        send: (msg) => conn.open && later(() => handlers.onData(conn, clone(msg))),
        channel: () => ({ local: guestFp, remote: hostFp }),
        close() {
          conn.open = false;
        },
      };
    },
  };
}

/** ゲストの端末。to が、いま番号を持っている相手（本物か、にせか）。 */
function guestTransport(target, guestFp) {
  return { joinRoom: async (code, handlers) => target().connect(handlers, { guestFp }) };
}

/** にせのホスト: 受けたものを全部覚え、それらしい返事をする。 */
function fakeHost({ welcomeEarly = false } = {}) {
  const seen = [];
  return {
    seen,
    connect(guestHandlers, { guestFp }) {
      const reply = (m) => later(() => guestHandlers.onData(m));
      return {
        send(msg) {
          seen.push(clone(msg));
          if (msg.type === "hello") {
            if (welcomeEarly) reply({ type: "welcome", id: "gfake", token: "faketoken", state: null });
            reply({ type: "prove", n: "nnnnnnnnnnnn", k: "0".repeat(64), t: "0".repeat(64) });
          }
          if (msg.type === "join") reply({ type: "wait" });
        },
        channel: () => ({ local: guestFp, remote: "fp-fake" }),
        close() {},
      };
    },
  };
}

/** にせのホストが、本物のホストへ別の線を張って、あいさつを横流しする。 */
function relayHost(real) {
  const seen = [];
  return {
    seen,
    connect(guestHandlers, { guestFp }) {
      const back = real.connect({ onData: (m) => later(() => guestHandlers.onData(clone(m))) }, { guestFp: "fp-relay-back" });
      return {
        send(msg) {
          seen.push(clone(msg));
          back.send(msg);
        },
        channel: () => ({ local: guestFp, remote: "fp-relay-front" }),
        close() {},
      };
    },
  };
}

const me = (name) => ({ name, role: "play" });
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push({ name, fn });

testAsync("リンクの合言葉で来た人は、ホストを確かめてから、そのまま入る（合言葉は線に流れない）", async () => {
  const real = hostEndpoint();
  const h = createSession({ transport: real.transport });
  await h.host(me("ほすと"));
  const key = get(h).roomKey;
  const sent = [];
  const g = createSession({ transport: guestTransport(() => ({ connect: (hd, o) => { const c = real.connect(hd, o); return { ...c, send: (m) => (sent.push(clone(m)), c.send(m)) }; } }), "fp-g1") });
  await g.join("123456", me("あ"), key);
  await settle();
  assert.equal(get(g).hostChecked, true);
  assert.equal(get(g).status, "open");
  assert.match(get(g).myId, /^g/);
  assert.equal(JSON.stringify(sent).includes(key), false);
  g.leave();
  h.leave();
});

testAsync("番号だけで来た人は、ホストの許可を待つ", async () => {
  const real = hostEndpoint();
  const h = createSession({ transport: real.transport });
  await h.host(me("ほすと"));
  const g = createSession({ transport: guestTransport(() => real, "fp-g2") });
  await g.join("123456", me("い"));
  await settle();
  assert.equal(get(g).status, "waiting");
  assert.equal(get(h).pending.length, 1);
  h.admitPending(get(h).pending[0].key);
  await settle();
  assert.equal(get(g).status, "open");
  g.leave();
  h.leave();
});

testAsync("合言葉が作りなおされても、札を持っている人は同じ人として入り直せる", async () => {
  const real = hostEndpoint();
  const h = createSession({ transport: real.transport });
  await h.host(me("ほすと"));
  const oldKey = get(h).roomKey;
  const a = createSession({ transport: guestTransport(() => real, "fp-a") });
  const b = createSession({ transport: guestTransport(() => real, "fp-b") });
  await b.join("123456", me("び"), oldKey);
  await settle();
  const bId = get(b).myId;
  b.leave();
  sessionStorage.removeItem("neuro-sports.token.123456");
  await a.join("123456", me("え"), oldKey);
  await settle();
  const aId = get(a).myId;
  h.removePlayer(bId); // 合言葉が作りなおされる
  assert.notEqual(get(h).roomKey, oldKey);
  a.leave();
  await a.join("123456", me("え"), oldKey);
  await settle();
  assert.equal(get(a).hostChecked, true);
  assert.equal(get(a).status, "open");
  assert.equal(get(a).myId, aId);
  a.leave();
  h.leave();
});

testAsync("にせのホストには、合言葉も札も、使える印も渡らない", async () => {
  sessionStorage.setItem("neuro-sports.token.123456", "realtoken1234567890x");
  const fake = fakeHost();
  const g = createSession({ transport: guestTransport(() => fake, "fp-g3") });
  await g.join("123456", me("う"), "realkey12345");
  await settle();
  assert.equal(get(g).hostChecked, false);
  const text = JSON.stringify(fake.seen);
  assert.equal(text.includes("realkey12345"), false);
  assert.equal(text.includes("realtoken1234567890x"), false);
  const join = fake.seen.find((m) => m.type === "join");
  assert.equal(join.k, undefined);
  assert.equal(join.t, undefined);
  assert.equal(join.name, "う");
  g.leave();
  sessionStorage.removeItem("neuro-sports.token.123456");
});

testAsync("にせのホストが、あいさつの前に「入れた」と言っても受けない", async () => {
  const fake = fakeHost({ welcomeEarly: true });
  const g = createSession({ transport: guestTransport(() => fake, "fp-g4") });
  await g.join("123456", me("え"), "somekey12345");
  await settle();
  assert.notEqual(get(g).status, "open");
  assert.equal(sessionStorage.getItem("neuro-sports.token.123456"), null);
  g.leave();
});

testAsync("にせのホストが本物へ横流ししても、指紋が合わず、合言葉の人も許可待ちになる", async () => {
  const real = hostEndpoint();
  const h = createSession({ transport: real.transport });
  await h.host(me("ほすと"));
  const key = get(h).roomKey;
  const relay = relayHost(real);
  const g = createSession({ transport: guestTransport(() => relay, "fp-victim") });
  await g.join("123456", me("お"), key);
  await settle();
  assert.equal(get(g).hostChecked, false);
  assert.equal(get(g).status, "waiting");
  assert.equal(get(h).pending.length, 1);
  assert.equal(get(h).state.players.length, 1);
  assert.equal(JSON.stringify(relay.seen).includes(key), false);
  g.leave();
  h.leave();
});

for (const { name, fn } of asyncTests) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

for (const { name, error } of failures) {
  console.error(`✗ ${name}\n  ${error.message}`);
}
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);

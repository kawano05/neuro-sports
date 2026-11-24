// 決まり（純粋関数）の単体テスト。`npm test` で走る。
import assert from "node:assert/strict";
import {
  advanceRunners,
  hitWindowMs,
  judgeSwing,
  offsetFromSweet,
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
import { createState, reduce, activePlayers, TURN_GUARD_MS } from "../src/lib/engine.js";

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

test("真ん中ほど遠くへ飛ぶ", () => {
  assert.equal(judgeSwing(0, 400), 4);
  assert.equal(judgeSwing(100, 400), 4);
  assert.equal(judgeSwing(-150, 400), 3);
  assert.equal(judgeSwing(250, 400), 2);
  assert.equal(judgeSwing(-400, 400), 1);
  assert.equal(judgeSwing(401, 400), 0);
});

test("「いつでも」は、円盤のどこでも当たる", () => {
  const period = SPIN_PERIOD_MS.normal;
  const w = hitWindowMs("always", period);
  assert.equal(w, period / 2);
  for (let t = 0; t < period; t += 37) assert.ok(judgeSwing(offsetFromSweet(t, 0, period), w) >= 1);
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

test("野球: 番の人が「あたる ところ」で押すと打てて、時間が来たら次の人へ", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "start", game: "baseball" }, 1000);
  assert.equal(s.turn.playerId, "a");
  const sweet = s.baseball.sweetAt;
  // 番でない人が押しても、打たない（おうえん）。
  s = reduce(s, { type: "press", playerId: "b", t: sweet }, sweet);
  assert.equal(s.baseball.phase, "spin");
  assert.equal(s.events.at(-1).kind, "cheer");
  // 番の人が、ちょうどで押す → ホームラン。
  s = reduce(s, { type: "press", playerId: "a", t: sweet, pid: "p1" }, sweet + 80);
  assert.equal(s.baseball.phase, "flight");
  assert.equal(s.baseball.hit.n, 4);
  assert.equal(s.baseball.runs, 1);
  // 時間が来たら次の人。
  s = reduce(s, { type: "tick" }, s.baseball.nextAt);
  assert.equal(s.turn.playerId, "b");
  assert.equal(s.baseball.phase, "spin");
});

test("野球: 空振りは数えない", () => {
  let s = room(["a"]);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  const bb = s.baseball;
  const far = bb.sweetAt + bb.period / 2; // 円盤の反対側
  s = reduce(s, { type: "press", playerId: "a", t: far }, far);
  assert.equal(s.baseball.phase, "spin");
  assert.equal(s.events.at(-1).n, 0);
});

test("野球: みんなが決まった数を打ったら おわり", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "atBats", value: 1 }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  for (let i = 0; i < 2; i += 1) {
    const who = s.turn.playerId;
    const t = s.baseball.sweetAt;
    s = reduce(s, { type: "press", playerId: who, t }, t);
    s = reduce(s, { type: "tick" }, s.baseball.nextAt);
  }
  assert.equal(s.baseball.phase, "done");
  assert.equal(s.turn, null);
});

test("野球: 番の人がいなくなったら、次の人へ", () => {
  let s = room(["a", "b", "c"]);
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
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  const seen = new Set();
  for (let i = 0; i < 4; i += 1) {
    seen.add(s.turn.playerId);
    const t = s.baseball.sweetAt;
    s = reduce(s, { type: "press", playerId: s.turn.playerId, t }, t);
    s = reduce(s, { type: "tick" }, s.baseball.nextAt);
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

for (const { name, error } of failures) {
  console.error(`✗ ${name}\n  ${error.message}`);
}
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);

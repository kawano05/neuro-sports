// 決まり（純粋関数）の単体テスト。`npm test` で走る。
import assert from "node:assert/strict";
import {
  advanceRunners,
  contactQuality,
  hitWindowMs,
  offsetFromSweet,
  simulateHit,
  wallResult,
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

test("真ん中で打つと、まっすぐフェンスのホームランの区画へ", () => {
  const r = simulateHit(0, 600, half);
  assert.equal(r.where.kind, "wall");
  assert.equal(r.n, 4);
  assert.ok(r.frames.length > 10);
});

test("早く振ると左、遅く振ると右へ飛ぶ", () => {
  const early = simulateHit(-250, 600, half);
  const late = simulateHit(250, 600, half);
  assert.ok(early.stop.x < 500 && late.stop.x > 500, `${early.stop.x} / ${late.stop.x}`);
});

test("端で打つと弱く、内野の穴に落ちてアウト", () => {
  const r = simulateHit(480, 600, half);
  assert.equal(r.n, OUT);
  assert.equal(r.where.kind, "pocket");
});

test("フェンスの区画は真ん中ほど長打", () => {
  assert.equal(wallResult(0), 4);
  assert.equal(wallResult(-10), 3);
  assert.equal(wallResult(20), 2);
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
  s = reduce(s, { type: "press", playerId: who, t, pid: "x" }, t, half);
  assert.equal(s.baseball.phase, "flight", "当たっていない");
  s = reduce(s, { type: "tick" }, s.baseball.resultAt, half);
  assert.equal(s.baseball.phase, "result");
  return reduce(s, { type: "tick" }, s.baseball.nextAt, half);
}

test("野球（アウトなし）: 打って止まったら点が入り、次の人へ", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "outs", value: false }, 0);
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
  s = reduce(s, { type: "settings", game: "baseball", key: "outs", value: false }, 0);
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

test("野球（チーム）: 3アウトでチェンジ、決めた回でおわって勝ち負け", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "innings", value: 1 }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  assert.equal(s.baseball.mode, "team");
  assert.deepEqual(s.baseball.teams, ["red", "blue"]);
  assert.equal(s.baseball.batting, "red");
  // 赤: ホームラン1本のあと、3アウト。
  s = atBat(s, 0);
  assert.equal(s.baseball.score.red, 1);
  for (let i = 0; i < 3; i += 1) s = atBat(s, 480);
  assert.equal(s.baseball.batting, "blue");
  assert.equal(s.baseball.half, 1);
  assert.equal(s.turn.playerId, "b");
  assert.ok(s.events.some((e) => e.kind === "change"));
  // 青: 3アウト → 1回でおわり。赤の勝ち。
  for (let i = 0; i < 3; i += 1) s = atBat(s, 480);
  assert.equal(s.baseball.phase, "done");
  assert.equal(s.baseball.winner, "red");
  assert.equal(s.turn, null);
});

test("野球（アウトなし）: みんなが決まった数を打ったら おわり", () => {
  let s = room(["a", "b"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "outs", value: false }, 0);
  s = reduce(s, { type: "settings", game: "baseball", key: "atBats", value: 1 }, 0);
  s = reduce(s, { type: "start", game: "baseball" }, 0);
  s = atBat(s, 0);
  s = atBat(s, 0);
  assert.equal(s.baseball.phase, "done");
  assert.equal(s.turn, null);
});

test("野球: 番の人がいなくなったら、次の人へ", () => {
  let s = room(["a", "b", "c"]);
  s = reduce(s, { type: "settings", game: "baseball", key: "outs", value: false }, 0);
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
  s = reduce(s, { type: "settings", game: "baseball", key: "outs", value: false }, 0);
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

for (const { name, error } of failures) {
  console.error(`✗ ${name}\n  ${error.message}`);
}
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);

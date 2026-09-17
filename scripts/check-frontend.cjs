"use strict";
// 前段の束・命令順・部分遷移・窓境界を、描画に依存せず検査する。
const assert = require("node:assert/strict");
const { createReplay } = require("../src/replay-model.cts");
const { stageTransition } = require("../src/geometry.cts");

function operation(id, fetch, decode, execute, end = execute + 3) {
    return [
        id,
        id,
        fetch,
        end,
        0,
        "add x0, x1, x2",
        [
            ["F", "front-0", fetch, decode],
            ["Dc", "front-1", decode, execute],
            ["X", "exec-integer", execute, execute + 1],
            ["W", "rob", execute + 1, end]
        ],
        null,
        execute,
        execute + 1,
        "exec-integer"
    ];
}
function trace(ops, firstCycle = 0, lastCycle = 40) {
    return {
        key: "local-file",
        parser: "onikiri",
        fileName: "frontend.kanata",
        label: "frontend",
        firstCycle,
        lastCycle,
        initialCycle: firstCycle,
        fetchWidth: 2,
        retireWidth: 2,
        machineOrder: "FIFO",
        ops,
        structure: {
            queueCapacity: 8,
            robCapacity: 2048,
            allocationWidth: 2,
            frontNodes: [
                { id: "front-0", names: ["F"] },
                { id: "front-1", names: ["Dc"] }
            ],
            executionNodes: [{ id: "exec-integer", kind: "integer", names: ["X"], pipeCount: 2 }],
            memoryWait: null
        },
        demo: { events: [], bookmarks: [], screenshotCycle: firstCycle, theme: "", provenance: {} }
    };
}
function prepare(input) {
    const source = createReplay({ samples: [] });
    return { source, replay: source.loadData(input) };
}
function position(replay, id, time, node = "front-1") {
    const result = replay.frontend.position(id, node, time);
    assert.ok(result, `${id}: no position in ${node}`);
    assert.ok(Number.isFinite(result.row) && Number.isFinite(result.lane));
    return result;
}
function inspect(replay, times) {
    for (const time of times) {
        for (const node of replay.trace.structure.frontNodes) {
            const visible = replay.ops.filter((op) =>
                op.stages.some((stage, index) => {
                    const next = op.stages[index + 1];
                    const admission = node.id === replay.frontend.fetchNode ? replay.frontend.admission(op.id) : null;
                    const end =
                        admission?.end ?? Math.min(op.end, next ? next.start + stageTransition(next) : stage.end);
                    const start = admission?.start ?? stage.start;
                    return stage.node === node.id && start <= time && time < end;
                })
            );
            for (const [index, op] of visible.entries()) {
                const p = position(replay, op.id, time, node.id);
                assert.ok(p.row >= 0 && p.row < replay.frontend.stages.get(node.id).capacity);
                assert.ok(p.lane >= 0 && p.lane < replay.frontend.lanes);
                for (const other of visible.slice(index + 1)) {
                    const q = position(replay, other.id, time, node.id);
                    if (Math.floor(op.fetch) === Math.floor(other.fetch)) {
                        assert.equal(p.row, q.row, "One Fetch bundle split into different rows");
                        assert.equal(Math.sign(p.lane - q.lane), Math.sign(op.id - other.id));
                    } else {
                        // 入場中の束は入口から移動してくる。既存束の前詰め終了後に台上の間隔を比較する。
                        if (
                            node.id === replay.frontend.fetchNode &&
                            [op, other].some((item) => time < replay.frontend.admission(item.id).start + 0.45)
                        )
                            continue;
                        assert.equal(Math.sign(p.row - q.row), Math.sign(op.fetch - other.fetch));
                        assert.ok(Math.abs(p.row - q.row) >= 1 - 1e-8, "Live bundles overlap during a move");
                    }
                }
            }
        }
    }
}

// 古い束が退出しても、空いた先頭へ新しい束が割り込まない。
const ordered = prepare(trace([operation(10, 0, 1, 3), operation(11, 1, 2, 7), operation(12, 3, 4, 8)]));
assert.equal(position(ordered.replay, 11, 4.1).row, 0);
assert.equal(position(ordered.replay, 12, 4.1).row, 1);
inspect(
    ordered.replay,
    Array.from({ length: 161 }, (_, i) => i * 0.05)
);

// 同じサイクルの命令はID順。記録上の一部退出ではlaneを詰めない。
const splitInput = trace([operation(21, 0.7, 3, 6), operation(20, 0.2, 2, 4), operation(22, 1.1, 4, 8)]);
const immutable = JSON.stringify(splitInput);
const split = prepare(splitInput);
assert.deepEqual(split.replay.frontend.groups, [
    { fetchCycle: 0, ids: [20, 21] },
    { fetchCycle: 1, ids: [22] }
]);
for (const node of ["front-0", "front-1"]) {
    assert.equal(position(split.replay, 20, 3.5, node).lane, 0);
    assert.equal(position(split.replay, 21, 3.5, node).lane, 1);
}
assert.equal(position(split.replay, 21, 5).lane, 1);
assert.equal(position(split.replay, 22, 6.2).row, 1, "A partly occupied bundle released its row early");
assert.equal(position(split.replay, 22, 6.8).row, 0);
inspect(
    split.replay,
    Array.from({ length: 161 }, (_, i) => i * 0.05)
);
assert.equal(JSON.stringify(splitInput), immutable, "Preparing the frontend changed recorded data");

// 最後の命令の退出補間が終わった後だけ、後続の束を連続的に前詰めする。
const exit = 6 + stageTransition(split.replay.ops.find((op) => op.id === 21).stages[2]);
const rows = [exit - 0.001, exit, exit + 0.001, exit + 0.225, exit + 0.45].map(
    (time) => position(split.replay, 22, time).row
);
assert.equal(rows[0], 1);
assert.equal(rows[1], 1);
assert.ok(rows[2] < 1 && rows[2] > 0.99);
assert.ok(Math.abs(rows[3] - 0.5) < 1e-8);
assert.ok(Math.abs(rows[4]) < 1e-8);
assert.ok(rows.every((row, i) => i === 0 || row <= rows[i - 1]));

// 逆シークや描画回数に依存せず、準備した索引だけから同じ場所を返す。
const seekTimes = [5, 6.21, 6.4, 6.5, 7];
const seekBefore = seekTimes.map((time) => position(split.replay, 22, time));
for (const time of [...seekTimes].reverse()) position(split.replay, 22, time);
assert.deepEqual(
    seekTimes.map((time) => position(split.replay, 22, time)),
    seekBefore
);
const sort = Array.prototype.sort;
try {
    Array.prototype.sort = () => {
        throw new Error("Frontend sorted instructions while drawing");
    };
    for (const time of seekTimes) position(split.replay, 22, time);
} finally {
    Array.prototype.sort = sort;
}

// 窓から同じ束の先頭命令が消えても横位置を保ち、新しいFetch束は既存位置を変えない。
const members = [operation(30, 0, 1, 3, 5), operation(31, 0, 1, 8, 12), operation(32, 1, 2, 9, 13)];
const window = prepare(trace(members));
const before = [6, 8.3, 8.6, 9].map((time) => [position(window.replay, 31, time), position(window.replay, 32, time)]);
window.source.loadData(trace([...members.slice(1), operation(33, 10, 11, 14, 17)], 6), { continuityAt: 6 });
assert.equal(position(window.replay, 31, 6).lane, 1, "A retained bundle member changed lane");
assert.deepEqual(
    [6, 8.3, 8.6, 9].map((time) => [position(window.replay, 31, time), position(window.replay, 32, time)]),
    before
);
window.source.loadData(trace(members), { continuityAt: 6 });
assert.deepEqual(
    [6, 8.3, 8.6, 9].map((time) => [position(window.replay, 31, time), position(window.replay, 32, time)]),
    before
);

// 退出直後に前窓の命令がなくなっても、前詰めの残りを次窓へ引き継ぐ。
const gone = operation(40, 0, 1, 3, 3.22);
const staying = operation(41, 1, 2, 8, 11);
const fading = prepare(trace([gone, staying]));
const fadingBefore = [3.3, 3.5, 3.7].map((time) => position(fading.replay, 41, time));
fading.source.loadData(trace([staying], 3.3), { continuityAt: 3.3 });
assert.deepEqual(
    [3.3, 3.5, 3.7].map((time) => position(fading.replay, 41, time)),
    fadingBefore
);
fading.source.loadData(trace([staying], 3.4), { continuityAt: 3.4 });
assert.deepEqual(
    [3.4, 3.5, 3.7].map((time) => position(fading.replay, 41, time)),
    [3.4, 3.5, 3.7].map((time) => position(prepare(trace([gone, staying])).replay, 41, time))
);

// 同じ束の一部だけが窓から消えても、最後の退出に由来する前詰めを保つ。
const priorMember = operation(39, 0, 1, 2, 9);
const partialFade = prepare(trace([priorMember, gone, staying]));
const partialBefore = [3.3, 3.5, 3.7].map((time) => position(partialFade.replay, 41, time));
partialFade.source.loadData(trace([priorMember, staying], 3.3), { continuityAt: 3.3 });
assert.deepEqual(
    [3.3, 3.5, 3.7].map((time) => position(partialFade.replay, 41, time)),
    partialBefore
);

// 後着の古い記録を新しい束の後ろへ追いやらず、必要な前段だけを並べ直す。
const latest = operation(51, 1, 2, 10, 13);
const older = operation(50, 0, 1, 9, 12);
const partial = prepare(trace([latest]));
partial.source.loadData(trace([latest, older]), { continuityAt: 5 });
assert.equal(position(partial.replay, 50, 5).row, 0);
assert.equal(position(partial.replay, 51, 5).row, 1);
inspect(partial.replay, [3, 5, 8.9, 9.3, 9.5]);

// 古い束が次段へ遅れて到着しても、その到着時には一行分の間隔がある。
const late = prepare(trace([operation(60, 0, 8, 12), operation(61, 1, 3, 13)]));
assert.ok(position(late.replay, 61, 7.7).row > 0 && position(late.replay, 61, 7.7).row < 1);
assert.equal(position(late.replay, 61, 8).row, 1);
inspect(late.replay, [7.5, 7.7, 8, 8.2, 8.8, 9]);

// 取消は観測時刻まで残し、未完了の前段を勝手に退出させない。
const canceled = operation(70, 0, 1, 9, 5);
canceled[4] = 1;
canceled[11] = 5;
const unfinished = operation(71, 1, 2, 8, 8);
unfinished[6] = unfinished[6].slice(0, 2);
unfinished[12] = true;
const cancel = prepare(trace([canceled, unfinished]));
assert.equal(position(cancel.replay, 71, 4.9).row, 1);
assert.equal(position(cancel.replay, 71, 5.6).row, 0);
assert.equal(position(cancel.replay, 71, 10000000000).row, 0);
assert.equal(cancel.replay.ops[1].end, Infinity);

// Fだけ4束に固定し、先頭が記録上の次段へ出る時刻に後続を入れる。
const queuedInput = trace(
    Array.from({ length: 12 }, (_, id) => operation(100 + id, id, 20 + id, 40 + id)),
    0,
    60
);
const queuedOriginal = JSON.stringify(queuedInput);
const queued = prepare(queuedInput);
assert.equal(queued.replay.frontend.fetchNode, "front-0");
assert.equal(queued.replay.frontend.fetchCapacity, 4);
assert.equal(queued.replay.frontend.stages.get("front-0").capacity, 4);
assert.deepEqual(queued.replay.frontend.admission(104), { start: 20, end: 24 });
assert.deepEqual(queued.replay.frontend.admission(108), { start: 24, end: 28 });
assert.deepEqual(queued.replay.frontend.pending(10), [104, 105, 106, 107, 108, 109, 110]);
assert.deepEqual(queued.replay.frontend.pending(10, 2), [104, 105]);
assert.deepEqual(queued.replay.frontend.pending(10, 0), []);
assert.deepEqual(queued.replay.frontend.pending(20), [105, 106, 107, 108, 109, 110, 111]);
assert.deepEqual(queued.replay.frontend.pending(-1), []);
assert.deepEqual(queued.replay.frontend.pending(10000000000), []);
assert.deepEqual(queued.replay.frontend.admission(-1), null);
assert.equal(position(queued.replay, 101, 20, "front-0").row, 1);
assert.ok(Math.abs(position(queued.replay, 101, 20.225, "front-0").row - 0.5) < 1e-8);
assert.equal(position(queued.replay, 101, 20.45, "front-0").row, 0);
assert.equal(position(queued.replay, 104, 20, "front-0").row, 3);
for (let time = 0; time < 33; time += 0.125) {
    const admitted = queued.replay.ops.filter((op) => {
        const range = queued.replay.frontend.admission(op.id);
        return range.start <= time && time < range.end;
    });
    assert.ok(new Set(admitted.map((op) => Math.floor(op.fetch))).size <= 4, "F exceeded four admitted bundles");
}
inspect(queued.replay, [10, 20, 20.1, 20.6, 21.6, 24.6, 30.5]);
assert.equal(JSON.stringify(queuedInput), queuedOriginal, "Admission changed trace timestamps or occupancy");

// 4束一斉退出でも、同時刻の新しい4束は異なる行へ入れる。
const wave = prepare(
    trace(Array.from({ length: 12 }, (_, id) => operation(200 + id, id, id < 4 ? 20 : id < 8 ? 21 : 22, 30 + id)))
);
for (let id = 4; id < 12; id++) {
    const start = id < 8 ? 20 : 21;
    assert.equal(wave.replay.frontend.admission(200 + id).start, start);
    assert.equal(position(wave.replay, 200 + id, start, "front-0").row, id % 4);
}
inspect(wave.replay, [19.9, 20, 20.1, 20.6, 21, 21.6]);

// 次段が同時刻に全束を受け入れる記録は、入口→F→次段の0滞在通過にする。
const instantInput = trace(Array.from({ length: 20 }, (_, id) => operation(300 + id, id, 30, 40 + id)));
const instantOriginal = JSON.stringify(instantInput);
const instant = prepare(instantInput);
for (let id = 4; id < 20; id++) assert.deepEqual(instant.replay.frontend.admission(300 + id), { start: 30, end: 30 });
assert.equal(instant.replay.frontend.pending(29.9).length, 16);
assert.deepEqual(instant.replay.frontend.pending(30), []);

assert.deepEqual(instant.replay.frontend.passage(300), { index: 0, count: 20 });
assert.equal(instant.replay.frontend.passage(-1), null);
for (let id = 0; id < 20; id++) {
    assert.deepEqual(instant.replay.frontend.passage(300 + id), { index: id, count: 20 });
    assert.equal(position(instant.replay, 300 + id, 30, "front-0").row, id % 4);
}
assert.equal(JSON.stringify(instantInput), instantOriginal, "Batched handoff changed recorded timing");
// 同時刻にF内で終わる取消は、次段へ進む20束の通過順へ含めない。
const stopped = operation(4000, 20, 30, 40, 30);
stopped[4] = 1;
stopped[11] = 30;
stopped[6] = [["F", "front-0", 20, 30]];
const mixedCancel = prepare(trace([...instantInput.ops, stopped]));
assert.equal(mixedCancel.replay.frontend.passage(4000), null);
assert.equal(mixedCancel.replay.frontend.passage(300).count, 20);
assert.equal(mixedCancel.replay.frontend.passage(319).count, 20);

// 将来の同時退出バッチを理由に、既にFで待つ束の前詰めを先取りしない。
const movingResident = prepare(
    trace(Array.from({ length: 6 }, (_, id) => operation(8000 + id, id, id === 0 ? 10 : 20, 30 + id)))
);
assert.deepEqual(movingResident.replay.frontend.passage(8001), { index: 0, count: 5 });
assert.equal(position(movingResident.replay, 8001, 5, "front-0").row, 1);
assert.ok(Math.abs(position(movingResident.replay, 8001, 10.225, "front-0").row - 0.5) < 1e-8);
assert.equal(position(movingResident.replay, 8001, 10.45, "front-0").row, 0);

// 束内のlaneと通過順を一緒に引き継ぎ、窓から先頭束が消えても再採番しない。
const passingOps = Array.from({ length: 20 }, (_, id) => operation(700 + id, Math.floor(id / 2), 20, 30 + id));
const passage = prepare(trace(passingOps, 0, 60));
const passageBefore = passingOps.map((op) => passage.replay.frontend.passage(op[0]));
passage.source.loadData(trace(passingOps.slice(2), 20.1, 60), { continuityAt: 20.1 });
assert.deepEqual(
    passingOps.slice(2).map((op) => passage.replay.frontend.passage(op[0])),
    passageBefore.slice(2)
);
for (let id = 8; id < 20; id += 2) {
    assert.deepEqual(passage.replay.frontend.passage(700 + id), passage.replay.frontend.passage(701 + id));
    assert.equal(position(passage.replay, 700 + id, 20, "front-0").lane, 0);
    assert.equal(position(passage.replay, 701 + id, 20, "front-0").lane, 1);
}
passage.source.loadData(trace(passingOps.slice(10), 20.2, 60), { continuityAt: 20.2 });
assert.deepEqual(
    passingOps.slice(10).map((op) => passage.replay.frontend.passage(op[0])),
    passageBefore.slice(10)
);
passage.source.loadData(trace(passingOps, 0, 60), { continuityAt: 20.2 });
assert.deepEqual(
    passingOps.map((op) => passage.replay.frontend.passage(op[0])),
    passageBefore
);

// 同じ束の最後の命令がDへ出るまで枠を保ち、部分退出でlaneを詰めない。
const parts = prepare(
    trace([
        operation(400, 0, 10, 30),
        operation(401, 0, 12, 31),
        ...Array.from({ length: 4 }, (_, id) => operation(402 + id, id + 1, 20 + id, 32 + id))
    ])
);
assert.deepEqual(parts.replay.frontend.admission(405), { start: 12, end: 23 });
assert.equal(position(parts.replay, 401, 11, "front-0").lane, 1);
assert.ok(parts.replay.frontend.pending(11).includes(405));
assert.ok(!parts.replay.frontend.pending(12).includes(405));

// 入口で取り消された束は時刻まで待機し、その後Fの枠を取らず消える。
const dropped = operation(504, 4, 8, 20, 8);
dropped[4] = 1;
dropped[11] = 8;
dropped[6] = [["F", "front-0", 4, 8]];
const cancellation = prepare(
    trace([
        ...Array.from({ length: 4 }, (_, id) => operation(500 + id, id, 20 + id, 30 + id)),
        dropped,
        operation(505, 5, 25, 35)
    ])
);
assert.deepEqual(cancellation.replay.frontend.admission(504), { start: Infinity, end: 8 });
assert.deepEqual(cancellation.replay.frontend.pending(7), [504, 505]);
assert.deepEqual(cancellation.replay.frontend.pending(8), [505]);
assert.deepEqual(cancellation.replay.frontend.admission(505), { start: 20, end: 25 });
assert.ok(Number.isFinite(position(cancellation.replay, 504, 8, "front-0").row));

// 空き枠が出る時刻そのもののF取消も、入口から突然3Dへ出さない。
const canceledAtRelease = structuredClone(dropped);
canceledAtRelease[3] = canceledAtRelease[11] = canceledAtRelease[6][0][3] = 20;
const exactCancel = prepare(trace([...cancellation.replay.trace.ops.slice(0, 4), canceledAtRelease]));
assert.deepEqual(exactCancel.replay.frontend.admission(504), { start: Infinity, end: 20 });
assert.deepEqual(exactCancel.replay.frontend.pending(19.9), [504]);
assert.deepEqual(exactCancel.replay.frontend.pending(20), []);
assert.equal(exactCancel.replay.frontend.passage(504), null);

// Fより後で取消になる未来の結果を、Fの入場判断へ混ぜない。
const laterSquash = operation(804, 4, 20, 25, 30);
laterSquash[4] = 1;
laterSquash[11] = 30;
const noFuture = prepare(trace([...cancellation.replay.trace.ops.slice(0, 4), laterSquash]));
assert.deepEqual(noFuture.replay.frontend.admission(804), { start: 20, end: 20 });
assert.deepEqual(noFuture.replay.frontend.passage(804), { index: 1, count: 2 });

// 読込み途中でF終了が未確定でも、後から確定した退出で待機を解放できる。
const incomplete = Array.from({ length: 4 }, (_, id) => {
    const op = operation(900 + id, id, 20 + id, 30 + id);
    op[6] = [["F", "front-0", id, 20 + id]];
    op[12] = true;
    return op;
});
const growing = prepare(trace([...incomplete, operation(904, 4, 24, 34)], 0, 60));
assert.deepEqual(growing.replay.frontend.pending(10), [904]);
assert.ok(Number.isFinite(position(growing.replay, 904, 10, "front-0").row));
growing.source.loadData(
    trace(
        Array.from({ length: 5 }, (_, id) => operation(900 + id, id, 20 + id, 30 + id)),
        0,
        60
    ),
    { continuityAt: 10 }
);
assert.deepEqual(growing.replay.frontend.admission(904), { start: 20, end: 24 });
assert.deepEqual(growing.replay.frontend.pending(20), []);

// 既知の入場と前詰めを隣接窓へ持ち越し、逆シークでも再入場させない。
const retainedIds = queuedInput.ops.slice(1).map((op) => op[0]);
const continuityTimes = [20.1, 20.3, 20.6, 24.1, 24.6];
const previous = retainedIds.map((id) => ({
    admission: queued.replay.frontend.admission(id),
    positions: continuityTimes.map((time) => position(queued.replay, id, time, "front-0"))
}));
queued.source.loadData(trace(queuedInput.ops.slice(1), 20.1, 60), { continuityAt: 20.1 });
assert.deepEqual(
    retainedIds.map((id) => ({
        admission: queued.replay.frontend.admission(id),
        positions: continuityTimes.map((time) => position(queued.replay, id, time, "front-0"))
    })),
    previous
);
queued.source.loadData(queuedInput, { continuityAt: 20.1 });
assert.deepEqual(queued.replay.frontend.pending(10), [104, 105, 106, 107, 108, 109, 110]);
assert.equal(queued.replay.frontend.stages.get("front-0").capacity, 4);

// Fが不明なログへ待機制限を流用せず、観測された前段は従来どおり並べる。
const unknown = trace(Array.from({ length: 8 }, (_, id) => operation(600 + id, id, 20, 30 + id)));
unknown.structure.frontNodes[0].names = ["Unknown"];
unknown.ops.forEach((op) => (op[6][0][0] = "Unknown"));
const generic = prepare(unknown);
assert.equal(generic.replay.frontend.fetchNode, null);
assert.equal(generic.replay.frontend.admission(600), null);
assert.deepEqual(generic.replay.frontend.pending(10), []);
assert.ok(generic.replay.frontend.stages.get("front-0").capacity >= 8);

// 既存の高密度規模でも束を小さな窓内で準備し、行・laneを有限に保つ。
const denseOps = Array.from({ length: 1200 }, (_, id) =>
    operation(id, Math.floor(id / 4), Math.floor(id / 4) + 10, Math.floor(id / 4) + 30)
);
const dense = prepare(trace(denseOps, 0, 340));
assert.equal(dense.replay.frontend.groups.length, 300);
assert.equal(dense.replay.frontend.lanes, 4);
inspect(dense.replay, [10.4, 25.4, 150.2, 310.5]);
assert.equal(dense.replay.frontend.position(-1, "front-0", 0), null);
assert.equal(dense.replay.frontend.position(0, "issue", 0), null);
console.log(
    "Frontend: fixed Fetch admission, simultaneous handoff, pending squash, bundles, compaction, continuity, and 1200 instructions passed"
);

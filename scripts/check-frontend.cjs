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
                    const end = Math.min(op.end, next ? next.start + stageTransition(next) : stage.end);
                    return stage.node === node.id && stage.start <= time && time < end;
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
    "Frontend: Fetch bundles, order, split transitions, smooth compaction, window continuity, cancellation, and 1200 instructions passed"
);

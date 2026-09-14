"use strict";
// 同じ時刻を含む隣接窓・逆シーク・途中更新で、表示位置と記録結果を比較する。
const assert = require("node:assert/strict");
const { createReplay, createRobReplay } = require("../src/replay-model.cts");
const { createPaths } = require("../src/geometry.cts");
const { createScene, styles } = require("../src/scene.cts");

function operation(id, fetch, allocation, issue, end, label = "add", flush = false) {
    return [
        id,
        id,
        fetch,
        end,
        Number(flush),
        label,
        [
            ["F", "front-0", fetch, allocation - 1],
            ["Rn", "front-1", allocation - 1, allocation],
            ["Is", "issue", allocation, issue],
            ["X", "exec-integer", issue, issue + 1],
            ["W", "rob", issue + 1, end]
        ],
        allocation,
        issue,
        issue + 1,
        "exec-integer"
    ];
}
function trace(ops, firstCycle = 0, lastCycle = 20) {
    return {
        key: "local-file",
        fileName: "continuity.kanata",
        parser: "onikiri",
        firstCycle,
        lastCycle,
        initialCycle: firstCycle,
        fetchWidth: 2,
        retireWidth: 2,
        label: "continuity",
        machineOrder: "FIFO",
        ops,
        structure: {
            queueCapacity: 8,
            robCapacity: 8,
            allocationWidth: 2,
            frontNodes: [
                { id: "front-0", names: ["F"] },
                { id: "front-1", names: ["Rn"] }
            ],
            executionNodes: [
                { id: "exec-integer", kind: "integer", names: ["X"], pipeCount: 2 },
                { id: "exec-memory", kind: "memory", names: ["X"], pipeCount: 2 }
            ],
            memoryWait: null
        },
        demo: { events: [], bookmarks: [], screenshotCycle: firstCycle, theme: "", provenance: {} }
    };
}
function fixture(input) {
    const source = createReplay({ samples: [] });
    const replay = source.loadData(input);
    const session = { style: styles.neon };
    const scene = createScene({ replay, session });
    scene.buildLayout();
    const paths = createPaths({ scene, replay, session });
    return { source, replay, scene, paths };
}
function positions(test, times) {
    return new Map(test.replay.ops.map((op) => [op.id, times.map((time) => test.paths.positionAt(op, time))]));
}
function equivalent(before, test, times, ids) {
    const after = positions(test, times);
    for (const id of ids) assert.deepEqual(after.get(id), before.get(id), `Instruction ${id} moved across a window`);
}
function fifo(replay) {
    for (const state of replay.robReplay.snapshots) {
        const slots = state.entries.map((entry) => entry.slot);
        assert.equal(new Set(slots).size, slots.length, "ROB slots overlap");
        state.entries.forEach((entry, index) => {
            assert.equal(entry.slot, (state.head + index) % replay.robReplay.capacity, "ROB lost its circular order");
            assert.ok(entry.op.end > state.time, "An ended instruction remained in ROB");
        });
        assert.equal(state.tail, (state.head + state.entries.length) % replay.robReplay.capacity);
    }
}

const operations = [
    operation(0, 0, 2, 5, 6),
    operation(1, 1, 3, 10, 12),
    operation(2, 2, 4, 11, 13),
    operation(3, 9, 11, 13, 15)
];
const initial = trace(operations, 0, 15);
const next = trace(operations.slice(1), 8, 23);
const immutable = JSON.stringify([initial, next]);
const test = fixture(initial);
const times = [8, 10.2, 10.8, 11.2, 11.8, 12.2, 13.2];
const before = positions(test, times);
const oldSlots = test.replay.ops.slice(1).map((op) => [op.id, op.issueSlot, op.robSlot, op.stages[1].displaySlot]);
const unaligned = fixture(next);
assert.notDeepEqual(
    unaligned.replay.ops.map((op) => op.robSlot),
    oldSlots.map((row) => row[2]),
    "Fixture did not change ROB phase"
);
assert.notDeepEqual(
    unaligned.replay.ops.map((op) => op.issueSlot),
    oldSlots.map((row) => row[1]),
    "Fixture did not change scheduler slots"
);
test.source.loadData(next, { continuityAt: 8 });
equivalent(before, test, times, [1, 2, 3]);
assert.deepEqual(
    test.replay.ops.map((op) => [op.id, op.issueSlot, op.robSlot, op.stages[1].displaySlot]),
    oldSlots
);
fifo(test.replay);
const atEight = JSON.stringify(test.replay.robReplay.stateAt(8));
test.replay.robReplay.stateAt(15);
assert.equal(JSON.stringify(test.replay.robReplay.stateAt(8)), atEight, "Seeking changed the ROB snapshot");
// 逆向きに窓を広げても、共通命令の座標を維持する。
test.source.loadData(initial, { continuityAt: 8 });
equivalent(before, test, times, [1, 2, 3]);
fifo(test.replay);
assert.equal(JSON.stringify([initial, next]), immutable, "Preparing continuity mutated the input trace");
// 継続指定のない別ファイル・遠方移動は、前窓の割当を持ち込まない。
test.source.loadData(next);
assert.deepEqual(test.replay.ops, unaligned.replay.ops);
test.source.loadData(initial);
test.source.loadData(next, { continuityAt: 100 });
assert.deepEqual(test.replay.ops, unaligned.replay.ops);

// 追加された古い命令も、継続命令のRn予約を奪わない。退場補間中も別の場所を使う。
const retained = operation(11, 1, 4, 8, 12);
const added = operation(10, 0, 3.5, 5, 6);
const partial = fixture(trace([retained]));
const rnBefore = positions(partial, [3.8, 4.4]);
partial.source.loadData(trace([added, retained]), { continuityAt: 3.8 });
equivalent(rnBefore, partial, [3.8, 4.4], [11]);
assert.notEqual(partial.replay.ops[0].stages[1].displaySlot, partial.replay.ops[1].stages[1].displaySlot);
const slotsBefore = partial.replay.ops.map((op) => op.issueSlot);
assert.equal(new Set(slotsBefore).size, 2, "New instruction reused an occupied scheduler slot");
fifo(partial.replay);

// 再実行に戻る命令は同じscheduler行を使い、新たな命令はその予約を避ける。
const retry = operation(20, 0, 2, 3, 12);
retry[6] = [
    ["F", "front-0", 0, 1],
    ["Rn", "front-1", 1, 2],
    ["Is", "issue", 2, 3],
    ["X", "exec-integer", 3, 4],
    ["W", "rob", 4, 8],
    ["Is", "issue", 8, 9],
    ["X", "exec-integer", 9, 10],
    ["W", "rob", 10, 12]
];
const contender = operation(21, 5, 7, 10, 13);
const repeated = fixture(trace([retry]));
const retryBefore = positions(repeated, [8.5, 9.15]);
repeated.source.loadData(trace([retry, contender]), { continuityAt: 8.5 });
equivalent(retryBefore, repeated, [8.5, 9.15], [20]);
assert.notEqual(
    repeated.replay.ops[0].issueSlot,
    repeated.replay.ops[1].issueSlot,
    "Retry collided with a newly allocated instruction"
);
fifo(repeated.replay);

// 同じ実行時刻のメモリアクセスは、既存の管路を保ちつつ追加分を空き管路に分ける。
const earlierLoad = operation(30, 0, 2, 3, 5, "ld x1, [x2]");
const load = operation(31, 1, 3, 8, 11, "ld x1, [x2]");
const newLoad = operation(32, 2, 4, 8, 12, "ld x1, [x2]");
const memory = fixture(trace([earlierLoad, load]));
const loadBefore = positions(memory, [8.1, 8.6, 9.5]);
memory.source.loadData(trace([load, newLoad], 8, 20), { continuityAt: 8 });
equivalent(loadBefore, memory, [8.1, 8.6, 9.5], [31]);
assert.notEqual(
    memory.replay.ops[0].pipeLane,
    memory.replay.ops[1].pipeLane,
    "Simultaneous loads collided in one pipe"
);

// ROBの位相合わせはcommitとsquashの時刻・FIFO順序を変えない。
const robOps = [
    { id: 0, allocation: 0, end: 2, flush: false },
    { id: 1, allocation: 1, end: 8, flush: false },
    { id: 2, allocation: 3, end: 5, flush: true },
    { id: 3, allocation: 6, end: 10, flush: false }
];
const rob = createRobReplay(robOps, 4);
const cropped = createRobReplay(robOps.slice(1), 4, { time: 4, state: rob.stateAt(4) });
for (const time of [4, 4.9, 5, 6, 7.9, 8, 10]) {
    assert.deepEqual(cropped.stateAt(time), rob.stateAt(time), `ROB outcome changed at ${time}`);
}
const emptyBefore = createRobReplay([robOps[0]], 4);
const afterEmpty = createRobReplay([robOps[3]], 4, { time: 4, state: emptyBefore.stateAt(4) });
assert.equal(afterEmpty.slots.get(3), 1, "An empty ROB lost its tail phase");
// 補間の予約で増えた行は入力を変更せず、表示だけの容量へ反映する。
const outgoing = operation(40, 0, 2, 4, 7);
const incoming = operation(41, 2, 4, 6, 8);
const small = trace([outgoing]);
small.structure.queueCapacity = 1;
const expanded = fixture(small);
const joined = trace([outgoing, incoming]);
joined.structure.queueCapacity = 1;
expanded.source.loadData(joined, { continuityAt: 4.1 });
assert.equal(expanded.replay.trace.structure.queueCapacity, 2);
assert.equal(joined.structure.queueCapacity, 1);
assert.notEqual(expanded.replay.ops[0].issueSlot, expanded.replay.ops[1].issueSlot);
// 256行に収まらないのが補間予約だけの場合は通常割当に戻し、読める区間を拒否しない。
const fullOps = [
    operation(0, 0, 2, 258, 260),
    ...Array.from({ length: 255 }, (_, i) => operation(i + 1, i + 1, i + 3, 401 + i, 701 + i))
];
const full = trace(fullOps, 0, 259);
full.structure.queueCapacity = 256;
full.structure.robCapacity = 512;
const crowded = fixture(full);
const fullNext = trace([...fullOps, operation(256, 256, 258, 1018, 1020)], 258, 288);
fullNext.structure.queueCapacity = 256;
fullNext.structure.robCapacity = 512;
crowded.source.loadData(fullNext, { continuityAt: 258.1 });
assert.equal(crowded.replay.trace.structure.queueCapacity, 256);
assert.ok(crowded.replay.ops.every((op) => op.issueSlot < 256));
fifo(crowded.replay);

// 境界前のflushは演出中だけ残し、後続のflushを発生前に適用しない。
const canceled = operation(50, 0, 2, 4, 8, "add", true);
const following = operation(51, 9, 11, 12, 15);
const context = fixture(trace([canceled, following], 0, 12));
const eventBefore = context.replay.feedReplay.stateAt(9);
context.source.loadData(trace([canceled, following], 9, 20), { continuityAt: 9 });
assert.deepEqual(context.replay.feedReplay.stateAt(9), eventBefore);
assert.ok(context.replay.flushEvents.includes(8));
assert.equal(context.replay.feedReplay.stateAt(7.9).phase, "flow");
const futureFlush = operation(52, 15, 17, 18, 21, "add", true);
context.source.loadData(trace([futureFlush], 9, 20));
assert.ok(context.replay.flushEvents.includes(21));
assert.equal(context.replay.feedReplay.stateAt(20).phase, "flow");
// 同梱した実トレースでも、終了済みの接頭部を落とした後の生存命令を比較する。
require("../data/traces.js");
for (const demo of globalThis.embeddedFlowTraces) {
    const source = createReplay({ samples: [] });
    const input = { ...demo, key: "local-file" };
    const previous = source.loadData(input);
    const at = demo.firstCycle + 64;
    const slots = new Map(
        previous.ops
            .filter((op) => op.fetch <= at && op.end > at)
            .map((op) => [op.id, { issue: op.issueSlot, rob: op.robSlot }])
    );
    const cropped = {
        ...input,
        firstCycle: at,
        ops: input.ops.filter((op) => (op[4] ? (op[11] ?? op[3]) : op[3]) >= at - 6)
    };
    const next = source.loadData(cropped, { continuityAt: at });
    for (const op of next.ops) {
        if (slots.has(op.id))
            assert.deepEqual(
                { issue: op.issueSlot, rob: op.robSlot },
                slots.get(op.id),
                `${demo.key}: live instruction ${op.id} moved across a window`
            );
    }
    fifo(next);
}
console.log(
    "Trace continuity: shared positions, reservations, retry, memory lanes, FIFO, reverse seek, bounds, context, reset, and five real traces passed"
);

"use strict";
// FP分離は表示の変更に限定し、待機位置・記録時刻・キューをまたぐ依存を保つ。
const assert = require("node:assert/strict");
const { createReplay, createWaitPlayback, measureTransfers } = require("../src/replay-model.cts");

function operation(id, label, allocation, issue, completion = issue + 1) {
    return [
        id,
        id,
        0,
        25,
        0,
        label,
        [
            ["F", "front-0", 0, allocation],
            ["Is", "issue", allocation, issue],
            ["X", "exec-integer", issue, completion],
            ["W", "rob", completion, 25]
        ],
        allocation,
        issue,
        completion,
        "exec-integer"
    ];
}
function fixture(ops, fp = true) {
    return {
        key: "local-file",
        fileName: "mixed.kanata",
        parser: "onikiri",
        firstCycle: 0,
        lastCycle: 25,
        initialCycle: 0,
        fetchWidth: 2,
        retireWidth: 2,
        label: "Mixed",
        machineOrder: "out-of-order",
        ops,
        structure: {
            queueCapacity: 16,
            robCapacity: 32,
            allocationWidth: 2,
            frontNodes: [{ id: "front-0", names: ["F"] }],
            executionNodes: [
                { id: "exec-integer", kind: "integer", names: ["X"], pipeCount: 2 },
                { id: "exec-memory", kind: "memory", names: ["X"], pipeCount: 1 },
                ...(fp ? [{ id: "exec-fp", kind: "fp", names: ["X"], pipeCount: 2 }] : [])
            ],
            memoryWait: null
        },
        demo: { events: [], bookmarks: [], screenshotCycle: 5, theme: "", provenance: {} }
    };
}
const input = fixture([
    operation(0, "add x1, x2, x3", 2, 8),
    operation(1, "fadd.d f1, f2, f3", 2, 10),
    operation(2, "vadd.vv v1, v2, v3", 3, 11),
    operation(3, "flw f1, 0(x1)", 3, 7),
    operation(4, "fsd f1, 0(x1)", 4, 12),
    operation(5, "fmul.d f4, f5, f6", 10, 14)
]);
input.evidence = {
    scheduling: {
        kind: "recorded",
        ops: [
            { id: 0, dependencies: [] },
            { id: 1, dependencies: [{ id: 0, ready: 9 }] },
            { id: 4, dependencies: [{ id: 1, ready: 11 }] }
        ]
    }
};
const original = structuredClone(input);
const source = createReplay({ samples: [] });
const replay = source.loadData(input);
assert.deepEqual(input, original, "Preparing the display modified source observations");
assert.deepEqual(
    replay.ops.map((op) => op.kind),
    ["integer", "fp", "fp", "memory", "memory", "fp"]
);
assert.deepEqual(
    replay.schedulers.map((bank) => bank.id),
    ["issue", "issue-fp"]
);
const [main, fp] = replay.schedulers;
assert.equal(fp.offset, main.capacity);
assert.equal(main.capacity + fp.capacity, replay.trace.structure.queueCapacity);
for (const op of replay.ops) {
    const bank = op.kind === "fp" ? fp : main;
    assert.ok(op.issueSlot >= bank.offset && op.issueSlot < bank.offset + bank.capacity);
    assert.equal(op.stages[1].node, bank.id);
    assert.equal(op.allocation, input.ops[op.id][7]);
    assert.equal(op.issue, input.ops[op.id][8]);
    assert.equal(op.completion, input.ops[op.id][9]);
}
const transfers = measureTransfers(replay.ops, { frontNodes: input.structure.frontNodes });
assert.equal(transfers.get("front-0>issue-fp").peak, 1);
assert.ok(transfers.has("issue-fp>exec-fp"));
assert.ok(!transfers.has("issue>exec-fp"));
const immediate = measureTransfers(
    [
        {
            id: 42,
            fetch: 0,
            allocation: 2,
            end: 5,
            flush: false,
            kind: "fp",
            stages: [
                { node: "front-0", start: 0 },
                { node: "exec-fp", start: 2 }
            ]
        }
    ],
    { frontNodes: input.structure.frontNodes }
);
assert.equal(immediate.get("front-0>issue-fp").peak, 1);
assert.equal(immediate.get("issue-fp>exec-fp").peak, 1);
const matrix = replay.dependencyReplay.stateAt(5);
assert.equal(matrix.rows.length, 5);
assert.equal(new Set(matrix.rows.map((row) => row.slot)).size, 5);
assert.equal(matrix.cells.length, 2);
assert.ok(matrix.cells.some((cell) => cell.consumer === 1 && cell.row >= fp.offset && cell.column < fp.offset));
assert.ok(matrix.cells.some((cell) => cell.consumer === 4 && cell.row < fp.offset && cell.column >= fp.offset));
assert.ok(
    replay.dependencyReplay
        .stateAt(8.3)
        .issues.find((event) => event.id === 0)
        .targets.some((op) => op.id === 1)
);
assert.ok(replay.dependencyReplay.stateAt(9.2).broadcasts.some((event) => event.producer === 0));

// 別窓で整数側が増えて全体番号が変わっても、FP待機列内の位置は継続する。
const oldSlots = new Map(replay.ops.map((op) => [op.id, op.issueSlot - (op.kind === "fp" ? fp.offset : 0)]));
const next = structuredClone(input);
next.firstCycle = 4;
next.ops.push(...Array.from({ length: 8 }, (_, i) => operation(i + 6, "add x1, x2, x3", 10, 15)));
source.loadData(next, { continuityAt: 5 });
const newFp = replay.schedulers[1];
assert.ok(newFp.offset > fp.offset);
for (const op of replay.ops.filter((op) => op.id < 5))
    assert.equal(op.issueSlot - (op.kind === "fp" ? newFp.offset : 0), oldSlots.get(op.id));

// 区間内にFPがなくても、全体の構造で観測済みならFP側を消さない。
source.loadData(fixture([operation(0, "add x1, x2, x3", 2, 8)]));
assert.equal(replay.schedulers.length, 2);
source.loadData(fixture([operation(0, "add x1, x2, x3", 2, 8)], false));
assert.deepEqual(replay.schedulers, [{ id: "issue", offset: 0, capacity: 16 }]);

// 再実行待ちと退出補間を予約し、後から入ったFP命令を重ねない。
const retry = operation(0, "fadd.d f1, f2, f3", 2, 4, 15);
retry[6] = [
    ["Is", "issue", 2, 4],
    ["X", "exec-integer", 4, 5],
    ["Is", "issue", 5, 14],
    ["X", "exec-integer", 14, 15],
    ["W", "rob", 15, 25]
];
source.loadData(fixture([retry, operation(1, "fmul.d f1, f2, f3", 6, 13)]));
assert.notEqual(replay.ops[0].issueSlot, replay.ops[1].issueSlot);

const waiting = fixture([operation(0, "fadd.d f1, f2, f3", 2, 100, 101)]);
waiting.lastCycle = 120;
waiting.ops[0][3] = 120;
waiting.ops[0][6].at(-1)[3] = 120;
source.loadData(waiting);
assert.ok(createWaitPlayback(waiting, replay.ops)(20) > 20, "FP scheduler waits did not allow fast-forward");
console.log("Schedulers: FP/SIMD banks, cross-bank dependencies, retries and window continuity passed");

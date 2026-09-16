"use strict";
// 共通スケジューラと整数/分岐の実行統合は表示に限定し、記録時刻と依存を保つ。
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
                { id: "exec-branch", kind: "branch", names: ["B"], pipeCount: 1 },
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
assert.deepEqual(replay.schedulers, [{ id: "issue", offset: 0, capacity: 16 }]);
for (const op of replay.ops) {
    assert.ok(op.issueSlot >= 0 && op.issueSlot < replay.trace.structure.queueCapacity);
    assert.equal(op.stages[1].node, "issue");
    assert.equal(op.allocation, input.ops[op.id][7]);
    assert.equal(op.issue, input.ops[op.id][8]);
    assert.equal(op.completion, input.ops[op.id][9]);
}
const transfers = measureTransfers(replay.ops, { frontNodes: input.structure.frontNodes });
assert.equal(transfers.get("front-0>issue").peak, 2);
assert.ok(transfers.has("issue>exec-fp"));
assert.ok(transfers.has("issue>exec-integer"));
assert.ok(![...transfers.keys()].some((key) => key.includes("issue-fp") || key.includes("exec-branch")));
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
assert.equal(immediate.get("front-0>issue").peak, 1);
assert.equal(immediate.get("issue>exec-fp").peak, 1);
const matrix = replay.dependencyReplay.stateAt(5);
assert.equal(matrix.rows.length, 5);
assert.equal(new Set(matrix.rows.map((row) => row.slot)).size, 5);
assert.equal(matrix.cells.length, 2);
for (const [consumer, producer] of [
    [1, 0],
    [4, 1]
]) {
    const cell = matrix.cells.find((cell) => cell.consumer === consumer);
    assert.equal(cell.row, replay.ops.find((op) => op.id === consumer).issueSlot);
    assert.equal(cell.column, replay.ops.find((op) => op.id === producer).issueSlot);
}
assert.ok(
    replay.dependencyReplay
        .stateAt(8.3)
        .issues.find((event) => event.id === 0)
        .targets.some((op) => op.id === 1)
);
assert.ok(replay.dependencyReplay.stateAt(9.2).broadcasts.some((event) => event.producer === 0));

// 区間内の種別構成が変わっても、全命令が共通の行番号を引き継ぐ。
const oldSlots = new Map(replay.ops.map((op) => [op.id, op.issueSlot]));
const next = structuredClone(input);
next.firstCycle = 4;
next.ops.push(...Array.from({ length: 8 }, (_, i) => operation(i + 6, "add x1, x2, x3", 10, 15)));
source.loadData(next, { continuityAt: 5 });
assert.deepEqual(replay.schedulers, [{ id: "issue", offset: 0, capacity: 16 }]);
for (const op of replay.ops.filter((op) => op.id < 5)) assert.equal(op.issueSlot, oldSlots.get(op.id));

// INT/BRは同じユニットとレーン集合を使い、分類・FPユニットは維持する。
const launches = fixture([operation(0, "add x1, x2, x3", 2, 8), operation(3, "b.ne 0x100", 2, 8)]);
source.loadData(launches);
const combined = replay.memory.executionNodes.find((node) => node.id === "exec-integer");
assert.equal(combined.kind, "integer");
assert.equal(combined.pipeCount, 3);
assert.deepEqual(combined.names, ["X", "B"]);
assert.ok(!replay.memory.executionNodes.some((node) => node.kind === "branch"));
assert.equal(replay.ops[1].kind, "branch");
assert.equal(replay.ops[1].execution, "exec-integer");
assert.equal(replay.ops[1].stages[2].node, "exec-integer");
assert.notEqual(replay.ops[0].pipeLane, replay.ops[1].pipeLane, "Concurrent INT/BR launches overlap");
assert.equal(replay.memory.executionNodes.find((node) => node.id === "exec-fp").pipeCount, 2);
const oldLanes = new Map(replay.ops.map((op) => [op.id, op.pipeLane]));
const nextLaunches = structuredClone(launches);
nextLaunches.firstCycle = 4;
nextLaunches.ops.push(operation(6, "add x1, x2, x3", 3, 8));
source.loadData(nextLaunches, { continuityAt: 5 });
for (const id of [0, 3]) assert.equal(replay.ops.find((op) => op.id === id).pipeLane, oldLanes.get(id));
assert.equal(new Set(replay.ops.map((op) => op.pipeLane)).size, 3);
source.loadData(launches, { continuityAt: 5 });
for (const id of [0, 3]) assert.equal(replay.ops.find((op) => op.id === id).pipeLane, oldLanes.get(id));

// 区間内にFPがなくても観測済みの実行ユニットを保持し、待機列は増やさない。
source.loadData(fixture([operation(0, "add x1, x2, x3", 2, 8)]));
assert.equal(replay.schedulers.length, 1);
assert.ok(replay.memory.executionNodes.some((node) => node.id === "exec-fp"));
source.loadData(fixture([operation(0, "add x1, x2, x3", 2, 8)], false));
assert.deepEqual(replay.schedulers, [{ id: "issue", offset: 0, capacity: 16 }]);
assert.ok(!replay.memory.executionNodes.some((node) => node.id === "exec-fp"));

// 分岐だけを観測したファイルも同じ表示先へ置き、元構造へ整数ユニットを捏造しない。
const branchOnly = fixture([operation(0, "b.eq 0x100", 2, 8)], false);
branchOnly.structure.executionNodes = [{ id: "exec-branch", kind: "branch", names: ["B"], pipeCount: 1 }];
branchOnly.ops[0][6][2][1] = "exec-branch";
branchOnly.ops[0][10] = "exec-branch";
const originalBranch = structuredClone(branchOnly);
source.loadData(branchOnly);
assert.deepEqual(
    replay.memory.executionNodes.map((node) => [node.id, node.pipeCount]),
    [["exec-integer", 1]]
);
assert.equal(replay.ops[0].execution, "exec-integer");
assert.deepEqual(branchOnly, originalBranch);

// 再実行待ちと退出補間を予約し、後から入ったFP命令を重ねない。
const retry = operation(0, "fadd.d f1, f2, f3", 2, 4, 15);
retry[6] = [
    ["Is", "issue", 2, 4],
    ["X", "exec-integer", 4, 5],
    ["Is", "issue", 5, 14],
    ["X", "exec-integer", 14, 15],
    ["W", "rob", 15, 25]
];
source.loadData(fixture([retry, operation(1, "add x1, x2, x3", 6, 13)]));
assert.notEqual(replay.ops[0].issueSlot, replay.ops[1].issueSlot);

const waiting = fixture([operation(0, "fadd.d f1, f2, f3", 2, 100, 101)]);
waiting.lastCycle = 120;
waiting.ops[0][3] = 120;
waiting.ops[0][6].at(-1)[3] = 120;
source.loadData(waiting);
assert.ok(createWaitPlayback(waiting, replay.ops)(20) > 20, "Unified scheduler FP waits did not allow fast-forward");
console.log("Schedulers: unified queue, INT/BR pipes, mixed dependencies, retries and window continuity passed");

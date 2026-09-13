"use strict";
// ブラウザと同じ有界変換を、記録した時刻・未観測値・区間境界と照合する。
const assert = require("node:assert/strict");
const { toTraceWindow, limits } = require("../src/trace-window.cts");
const { createReplay } = require("../src/replay-model.cts");
const { createScene, styles } = require("../src/scene.cts");
const { createPaths } = require("../src/geometry.cts");
function operation(id, stages, options = {}) {
    return {
        id,
        gid: id + 100,
        rid: id,
        tid: 0,
        retired: true,
        flush: false,
        eof: false,
        fetchedCycle: stages[0][1],
        retiredCycle: stages.at(-1)[2],
        labelName: "add x0, x1, x2",
        labelDetail: "",
        line: id + 1,
        lastParsedCycle: stages.at(-1)[2],
        lastParsedLaneID: 0,
        lastParsedStageID: stages.length - 1,
        prods: [],
        prodCycle: -1,
        consCycle: -1,
        lanes: [
            {
                level: stages.length,
                stages: stages.map(([name, startCycle, endCycle]) => ({ name, startCycle, endCycle, labels: "" }))
            }
        ],
        ...options
    };
}
const instructions = [8, 5, 7, 6].map((issue, id) => {
    const allocation = id + 1,
        complete = [10, 6, 9, 7][id],
        end = id + 12;
    return operation(id, [
        ["F", id * 0.25, allocation],
        ["Sc", allocation, issue],
        ["X", issue, complete],
        ["Rw", complete, end - 1],
        ["Cm", end - 1, end]
    ]);
});
function convert(ops, overrides = {}) {
    return toTraceWindow({
        ops,
        firstCycle: 0,
        lastCycle: 20,
        source: { name: "example.kanata", parser: "onikiri", opCount: ops.length, lastCycle: 100 },
        laneNames: ["main"],
        ...overrides
    });
}
function prepare(trace) {
    const replay = createReplay({ samples: [trace] }).loadTrace(trace.key),
        session = { style: styles.neon };
    const scene = createScene({ replay, session });
    scene.buildLayout();
    return { replay, scene, paths: createPaths({ scene, replay, session }) };
}
const original = JSON.stringify(instructions),
    trace = convert(instructions),
    { replay, scene, paths } = prepare(trace);
assert.equal(JSON.stringify(instructions), original, "Conversion changed the parser's operations");
assert.equal(trace.machineOrder, "out-of-order");
assert.equal(trace.key, "local-file");
assert.deepEqual(
    trace.ops.map((op) => op[7]),
    [1, 2, 3, 4]
);
assert.deepEqual(
    trace.ops.map((op) => op[8]),
    [8, 5, 7, 6]
);
assert.deepEqual(
    trace.ops.map((op) => op[9]),
    [10, 6, 9, 7]
);
assert.deepEqual(
    trace.ops.map((op) => op[3]),
    [12, 13, 14, 15]
);
assert.deepEqual(trace.ops[1][6][0].slice(2), [0.25, 2], "Fractional stage time was extended for appearance");
assert.equal(trace.evidence, undefined, "Unrecorded dependencies or registers were invented");
assert.equal(trace.topDown, null);
for (const cycle of [0, 3, 8.4, 10, 12, 14.4, 18, 3]) {
    for (const op of replay.ops) {
        const position = paths.positionAt(op, cycle);
        assert.ok(position === null || position.every(Number.isFinite));
    }
    const rob = replay.robReplay.stateAt(cycle);
    assert.ok(rob.entries.every(({ op, slot }) => op.allocation <= cycle && op.end > cycle && slot === op.robSlot));
}
const laterAllocation = Array.from({ length: 33 }, (_, id) => {
    const allocation = id + 2,
        issue = id === 0 ? 36 : allocation + 0.5,
        end = id + 60;
    return operation(id, [
        ["F", id * 0.06, allocation],
        ["Sc", allocation, issue],
        ["X", issue, issue + 1],
        ["Rw", issue + 1, end - 1],
        ["Cm", end - 1, end]
    ]);
});
const later = convert(laterAllocation, { firstCycle: 0, lastCycle: 2 });
assert.equal(later.structure.robCapacity, 40, "Capacity ignored allocation after the selected window");
assert.equal(prepare(later).replay.robReplay.stateAt(40).entries.length, 33);
const boundaries = convert(instructions, { firstCycle: 5, lastCycle: 8 });
assert.deepEqual(boundaries.ops, trace.ops, "Selecting a window truncated instruction lifetimes");
assert.equal(
    prepare(boundaries).replay.robReplay.stateAt(5).entries.length,
    4,
    "The left boundary lost allocated instructions"
);

const dependent = structuredClone(instructions);
dependent[3].prods = [
    { opID: 1, type: 0, cycle: 3 },
    { opID: 999999, type: 0, cycle: 3 }
];
const evidence = convert(dependent).evidence;
assert.deepEqual(evidence.scheduling.ops, [
    {
        id: 3,
        dependencies: [
            { id: 1, ready: 6 },
            { id: 999999, ready: null }
        ]
    }
]);
assert.equal(evidence.registers, null);
assert.ok(
    evidence.scheduling.ops.every((op) => op.id === 3),
    "No-edge operations were marked as observed independent operations"
);

const genericOps = [
        operation(50, [
            ["alpha", 2, 2.125],
            ["beta", 2.125, 3],
            ["gamma", 3, 5]
        ])
    ],
    generic = convert(genericOps),
    genericReplay = prepare(generic).replay;
assert.equal(generic.machineOrder, "unknown");
assert.match(generic.demo.provenance.note, /Generic serial stage view/);
assert.deepEqual(generic.ops[0].slice(7, 10), [null, null, null]);
assert.deepEqual(
    generic.ops[0][6].map((s) => [s[0], s[2], s[3]]),
    [
        ["alpha", 2, 2.125],
        ["beta", 2.125, 3],
        ["gamma", 3, 5]
    ]
);
assert.equal(genericReplay.robReplay.stateAt(4).entries.length, 0, "Generic stages invented ROB allocation");
assert.ok(genericReplay.commitGroups.get(5), "Generic fallback discarded observed retirement");

// 先頭の不完全な命令の初見順を、その後の命令のstage順より優先しない。
const unorderedFront = convert([
    operation(0, [["beta", 0, 1]]),
    operation(1, [
        ["alpha", 1, 2],
        ["beta", 2, 3],
        ["gamma", 3, 4]
    ])
]);
assert.deepEqual(
    unorderedFront.structure.frontNodes.map((node) => node.names),
    [["alpha"], ["beta"], ["gamma"]]
);
const cyclicFront = convert([
    operation(0, [
        ["alpha", 0, 1],
        ["beta", 1, 2],
        ["alpha", 2, 3],
        ["gamma", 3, 4]
    ])
]);
assert.equal(new Set(cyclicFront.ops[0][6].map((stage) => stage[1])).size, 1);
assert.deepEqual(
    cyclicFront.ops[0][6].map((stage) => stage[0]),
    ["alpha", "beta", "alpha", "gamma"]
);

// 順序逆転がない短区間でも、RSDの記録区分と再試行を保つ。Wcはsquashの終端例。
function rsdOperation(id, label, retry = false) {
    const timing = [
        ["Np", 0, 1],
        ["F", 1, 2],
        ["Pd", 2, 3],
        ["Dc", 3, 4],
        ["Rn", 4, 5],
        ["Ds", 5, 6],
        ["Sc", 6, 7],
        ["Is", 7, 8],
        ["Rr", 8, 9],
        ["X", 9, 10],
        ["Mt", 10, 11],
        ["Ma", 11, 12],
        ...(retry
            ? [
                  ["Rw", 12, 18],
                  ["Is", 18, 19],
                  ["Rr", 19, 20],
                  ["X", 20, 21],
                  ["Mt", 21, 22],
                  ["Ma", 22, 23],
                  ["Rw", 23, 25]
              ]
            : [["Rw", 12, 25]]),
        ["Cm", 25, 26]
    ].map(([name, start, end]) => [name, start + id * 0.25, end + id * 0.25]);
    return operation(id, timing, { labelName: label });
}
const rsdOps = [
    rsdOperation(0, "sb a2, a3, 0", true),
    rsdOperation(1, "lb a2, a3, 0"),
    rsdOperation(2, "sb a2, a3, 0")
];
rsdOps[2].flush = true;
rsdOps[2].retired = false;
rsdOps[2].lanes[0].stages.pop();
rsdOps[2].lanes[0].stages.push({ name: "Wc", startCycle: 25.5, endCycle: 25.5, labels: "" });
rsdOps[2].retiredCycle = 25.5;
const rsdRaw = JSON.stringify(rsdOps),
    rsd = convert(rsdOps),
    rsdState = prepare(rsd);
assert.equal(JSON.stringify(rsdOps), rsdRaw);
assert.deepEqual(
    rsd.structure.frontNodes.map((node) => node.names),
    [["Np"], ["F"], ["Pd"], ["Dc"], ["Rn"], ["Ds"]]
);
assert.deepEqual(rsd.ops[0].slice(7, 10), [6, 7, 23]);
assert.deepEqual(rsdState.replay.memory.minimum, { load: 3, store: 3 });
assert.equal(rsd.evidence, undefined);
assert.equal(rsdState.scene.nodes.get("register-read").label, "REGISTER READ");
assert.match(rsdState.scene.nodes.get("register-read").detail, /VALUES NOT LOGGED/);
assert.deepEqual(rsdState.replay.registerTags, []);
assert.equal(rsdState.replay.registerReplay.stateAt(15).available, false);
const retriedStore = rsdState.replay.ops[0],
    stableRobSlot = retriedStore.robSlot;
for (const [cycle, node, ready] of [
    [10, "exec-store", false],
    [15, "rob", false],
    [18.5, "register-read", false],
    [20.5, "exec-store", false],
    [24, "rob", true],
    [15, "rob", false]
]) {
    assert.equal(rsdState.paths.stageAt(retriedStore, cycle).node, node);
    assert.equal(retriedStore.completion <= cycle, ready);
    assert.equal(
        rsdState.replay.robReplay.stateAt(cycle).entries.find((entry) => entry.op.id === 0).slot,
        stableRobSlot
    );
    assert.ok(rsdState.paths.positionAt(retriedStore, cycle).every(Number.isFinite));
}
for (const firstCycle of [0, 14, 18]) {
    const small = convert([rsdOps[0]], { firstCycle, lastCycle: firstCycle + 1 });
    assert.deepEqual(small.ops[0], rsd.ops[0], "RSD role mapping changed with local detector coverage");
}
const partialRsd = rsdOperation(3, "lb a2, a3, 0");
partialRsd.lanes[0].stages = partialRsd.lanes[0].stages.filter((stage) => !["Sc", "Is"].includes(stage.name));
const missingAdmission = convert([rsdOps[0], partialRsd]);
assert.deepEqual(missingAdmission.ops[1].slice(7, 10), [null, null, null]);
assert.ok(missingAdmission.ops[1][6].every((stage) => stage[1].startsWith("front-")));

// gem5先頭の無発行命令もRtへ進み、Ds/Is/Cmの通常経路を前段へ並べ替えない。
function gem5Operation(id, stages, options = {}) {
    return operation(id, stages, { labelDetail: "Fetched Tick: 1000", ...options });
}
const gem5Source = { name: "trace.log", parser: "gem5", opCount: 4, lastCycle: 100 };
const gem5Ops = [
    gem5Operation(0, [
        ["F", 0, 1],
        ["Dc", 1, 2],
        ["Rn", 2, 3],
        ["Ds", 3, 4],
        ["Rt", 4, 5]
    ]),
    gem5Operation(1, [
        ["F", 1, 2],
        ["Dc", 2, 3],
        ["Rn", 3, 4],
        ["Ds", 4, 5],
        ["Is", 5, 6],
        ["Cm", 6, 8],
        ["Rt", 8, 9]
    ])
];
const gem5Stages = convert(gem5Ops, { source: gem5Source });
assert.deepEqual(
    gem5Stages.structure.frontNodes.map((node) => node.names),
    [["F"], ["Dc"], ["Rn"]]
);
assert.deepEqual(gem5Stages.ops[0].slice(7, 10), [3, null, null]);
assert.equal(gem5Stages.ops[0][6].at(-1)[1], "commit");
assert.deepEqual(gem5Stages.ops[1].slice(7, 10), [4, 5, 6]);
const memoryResponse = structuredClone(gem5Ops[1]);
memoryResponse.labelName = "ldr x0, [x1]";
memoryResponse.lanes[0].stages.splice(6, 0, { name: "Mc", startCycle: 7, endCycle: 8, labels: "" });
memoryResponse.lanes[0].stages[5].endCycle = 7;
const response = convert([gem5Ops[0], memoryResponse], { source: gem5Source });
assert.equal(response.ops[1][9], 7, "Cm made a memory operation ready before Mc");

// retire:0の個別の最終観測が前後しても、元時刻は保持して群のsquashだけを推定する。
const squashGroup = [
    gem5Ops[0],
    gem5Operation(
        1,
        [
            ["F", 1, 2],
            ["Dc", 2, 3],
            ["Rn", 3, 4],
            ["Ds", 4, 7]
        ],
        { retired: false, flush: true }
    ),
    gem5Operation(
        2,
        [
            ["F", 2, 3],
            ["Dc", 3, 4],
            ["Rn", 4, 5],
            ["Ds", 5, 8]
        ],
        { retired: false, flush: true }
    ),
    gem5Operation(
        3,
        [
            ["F", 3, 4],
            ["Dc", 4, 5],
            ["Rn", 5, 6],
            ["Ds", 6, 9]
        ],
        { retired: false, flush: true }
    )
];
const squashRaw = JSON.stringify(squashGroup),
    squashed = convert(squashGroup, { source: gem5Source });
assert.match(squashed.demo.provenance.note, /Squash timing is inferred/);
assert.deepEqual(
    squashed.ops.slice(1).map((op) => [op[3], op[11]]),
    [
        [7, 9],
        [8, 9],
        [9, 9]
    ]
);
assert.equal(JSON.stringify(squashGroup), squashRaw);
const squashState = prepare(squashed);
assert.equal(squashState.replay.robReplay.stateAt(8.5).entries.length, 3);
assert.equal(squashState.replay.robReplay.stateAt(9).entries.length, 0);
for (const firstCycle of [0, 7, 8]) {
    const partialGroup = convert([squashGroup[1]], {
        source: gem5Source,
        firstCycle,
        lastCycle: firstCycle + 1,
        flushCycles: new Map([[1, 9]])
    });
    assert.equal(partialGroup.ops[0][11], 9, "A boundary window changed indexed squash timing");
    assert.equal(partialGroup.ops[0][3], 7);
}
assert.throws(
    () => convert([squashGroup[1]], { source: gem5Source, flushCycles: new Map([[1, 6]]) }),
    /precedes its last observation/
);

const zero = convert([
    operation(60, [
        ["a", 0, 0.25],
        ["b", 0.25, 0.25],
        ["c", 0.25, 1]
    ])
]);
assert.deepEqual(zero.ops[0][6][1].slice(2), [0.25, 0.25], "A zero-duration event gained a synthetic duration");
const idle = convert([], { firstCycle: 60, lastCycle: 80 });
const idleState = prepare(idle);
assert.deepEqual(idle.ops, []);
assert.equal(idleState.replay.activity.length, 21);
assert.ok(idleState.replay.activity.every((a) => a.active === 0 && a.retired === 0));
assert.ok([...idleState.scene.nodes.values()].every((n) => [n.x, n.z, n.w, n.d].every(Number.isFinite)));
assert.equal(idle.demo.theme, "IDLE INTERVAL");

const unfinished = structuredClone(instructions);
unfinished[3].retired = false;
unfinished[3].eof = true;
unfinished[3].lanes[0].stages = unfinished[3].lanes[0].stages.slice(0, 3);
unfinished[3].lanes[0].stages.at(-1).endCycle = 0;
const incomplete = convert(unfinished),
    roundTrip = JSON.parse(JSON.stringify(incomplete)),
    incompleteState = prepare(roundTrip);
assert.deepEqual(roundTrip, incomplete, "The transferable trace contains Infinity or lost optional data");
assert.equal(incomplete.ops[3][12], true);
assert.equal(incomplete.ops[3][3], 100, "The input's observation boundary was replaced by a fake commit");
assert.equal(incompleteState.replay.ops[3].end, Infinity);
assert.ok(incompleteState.replay.robReplay.snapshots.every((snapshot) => Number.isFinite(snapshot.time)));
assert.ok(
    incompleteState.replay.robReplay.snapshots.every((snapshot) => !snapshot.retired.includes(3)),
    "EOF invented a future ROB retirement event"
);
assert.equal(incompleteState.replay.ops[3].completion, null, "An open execution stage became ready");
assert.ok(![...incompleteState.replay.commitGroups.values()].flat().some((op) => op.id === 3));
assert.equal(incompleteState.replay.activity.at(-1).active, 1);
assert.equal(incompleteState.replay.activity.at(-1).retired, 0);
assert.ok(incompleteState.replay.robReplay.stateAt(20).entries.some((e) => e.op.id === 3));
assert.ok(incompleteState.paths.positionAt(incompleteState.replay.ops[3], 20).every(Number.isFinite));
assert.ok(incompleteState.replay.ops[3].stages.every((s) => s.node !== "commit"));

const readyEof = structuredClone(instructions);
readyEof[3].retired = false;
readyEof[3].eof = true;
readyEof[3].lanes[0].stages.pop();
const readyState = prepare(convert(readyEof));
assert.equal(readyState.replay.ops[3].completion, 7, "EOF discarded an observed execution completion");
assert.equal(readyState.paths.instructionLight(readyState.replay.ops[3], 20).state, "ready");
assert.ok(![...readyState.replay.commitGroups.values()].flat().some((op) => op.id === 3));

const flush = structuredClone(instructions);
flush[3].retired = false;
flush[3].flush = true;
flush[3].retiredCycle = 11;
flush[3].lanes[0].stages = flush[3].lanes[0].stages
    .filter((s) => s.startCycle < 11)
    .map((s) => ({ ...s, endCycle: Math.min(s.endCycle, 11) }));
const flushed = prepare(convert(flush));
assert.ok(flushed.replay.robReplay.stateAt(10.9).entries.some((e) => e.op.id === 3));
assert.ok(!flushed.replay.robReplay.stateAt(11).entries.some((e) => e.op.id === 3));
assert.equal(flushed.paths.instructionLight(flushed.replay.ops[3], 11).state, "squashed");
assert.ok(![...flushed.replay.commitGroups.values()].flat().some((op) => op.id === 3));

const loads = structuredClone(instructions);
for (const op of loads) {
    op.labelName = "ldr x0, [x1]";
    op.lanes[0].stages[3].name = "Cm";
    op.lanes[0].stages[4].name = "Rt";
}
loads[0].lanes[0].stages[4].startCycle = 11.5;
loads[0].lanes[0].stages.splice(4, 0, { name: "Mc", startCycle: 11, endCycle: 11.5, labels: "" });
const loaded = prepare(convert(loads, { source: { name: "memory.txt", parser: "gem5", opCount: 4, lastCycle: 100 } }));
assert.equal(loaded.replay.ops[0].completion, 11, "A load became ready before its recorded Mc response");
assert.equal(loaded.paths.instructionLight(loaded.replay.ops[0], 10.9).state, "waiting");
assert.equal(loaded.paths.instructionLight(loaded.replay.ops[0], 11).state, "ready");

// 500 tick/cycle やファイル名からの ISA 推定をせず、実際の校正点だけを使う。
const stores = structuredClone(instructions);
for (const op of stores) {
    op.labelName = "str x0, [x1]";
    op.labelDetail = `Fetched Tick: ${1000 + op.fetchedCycle * 800}\nStore Tick: ${1000 + (op.retiredCycle + 4) * 800}`;
}
const gem5 = convert(stores, { source: { name: "renamed-input.txt", parser: "gem5", opCount: 9999, lastCycle: 100 } });
assert.deepEqual(
    gem5.storeCompletions,
    stores.map((op) => [op.id, op.retiredCycle + 4])
);
assert.equal(gem5.evidence, undefined);
assert.match(gem5.demo.provenance.note, /9999 instructions/);
stores[3].labelDetail = stores[3].labelDetail.replace("Fetched Tick: 1600", "Fetched Tick: 1601");
assert.deepEqual(
    convert(stores, { source: { name: "bad", parser: "gem5", opCount: 4, lastCycle: 100 } }).storeCompletions,
    []
);

assert.throws(() => convert(instructions, { lastCycle: 101 }), /outside/);
assert.throws(() => convert(instructions, { firstCycle: 0.5 }), /outside/);
assert.throws(
    () =>
        convert(instructions, {
            lastCycle: limits.cycles,
            source: { name: "large", parser: "onikiri", opCount: 4, lastCycle: 10000 }
        }),
    /Select at most/
);
assert.throws(() => convert([...instructions, instructions[0]]), /duplicated/);
assert.throws(() => convert(instructions.map((op, index) => ({ ...op, tid: index % 2 }))), /one hardware thread/);
assert.throws(() => convert([operation(70, [["bad", 4, 3]])]), /ends before fetch|unordered/);
assert.throws(() => convert([operation(70, [["bad", NaN, 3]])]), /supported cycle/);
const nonFifo = structuredClone(instructions);
nonFifo[1].retiredCycle = 11;
nonFifo[1].lanes[0].stages[3].endCycle = 10;
nonFifo[1].lanes[0].stages[4].startCycle = 10;
nonFifo[1].lanes[0].stages[4].endCycle = 11;
assert.throws(() => convert(nonFifo), /one FIFO/);
const dense = Array.from({ length: limits.active + 1 }, (_, id) =>
    operation(id, [
        ["A", 0, 1],
        ["B", 1, 20]
    ])
);
assert.throws(() => convert(dense), /simultaneous instructions/);
const fullRob = Array.from({ length: limits.rob + 1 }, (_, id) => {
    const allocation = id * 0.05 + 0.2,
        issue = id === 0 ? 25 : allocation + 0.1,
        end = 50 + id * 0.05;
    return operation(id, [
        ["F", id * 0.05, allocation],
        ["Sc", allocation, issue],
        ["X", issue, issue + 1],
        ["Rw", issue + 1, end - 1],
        ["Cm", end - 1, end]
    ]);
});
assert.throws(() => convert(fullRob), /ROB requires 232 entries/);
assert.equal(JSON.stringify(instructions), original);
console.log(
    "Trace windows: detected/generic stages, exact times, boundary ROB state, recorded dependencies, EOF, flush, idle windows, tick calibration and explicit limits passed"
);

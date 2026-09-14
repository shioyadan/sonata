"use strict";
// ブラウザと同じ有界変換を、記録した時刻・未観測値・区間境界と照合する。
const assert = require("node:assert/strict");
const { toTraceWindow, limits } = require("../src/trace-window.cts");
const { createReplay } = require("../src/replay-model.cts");
const { createProfiles, limits: profileLimits } = require("../src/trace-structure.cts");
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
assert.deepEqual(
    gem5.storeWaits,
    stores.map((op) => [op.id, op.fetchedCycle, op.retiredCycle, op.retiredCycle + 4])
);
const outstanding = [
    [99, 0, 6, 1000],
    [100, 10, 16, 500]
];
const retiredWindow = convert([], {
    firstCycle: 400,
    lastCycle: 415,
    source: { name: "store-tail", parser: "gem5", opCount: 2, lastCycle: 1000 },
    storeWaits: outstanding
});
assert.deepEqual(retiredWindow.ops, [], "Store waits created drawable retired instructions");
assert.deepEqual(retiredWindow.storeCompletions, []);
assert.deepEqual(retiredWindow.storeWaits, outstanding);
assert.throws(
    () => convert([], { storeWaits: Array.from({ length: limits.operations + 1 }, (_, id) => [id, 0, 1, 1000]) }),
    /outstanding store writes/
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
// 保存順を逆転・重複させても、Coreの2passへはID順で同じ標本を渡す。
const profiles = createProfiles(),
    profileOps = new Map();
for (const op of [...instructions].reverse()) {
    profileOps.set(op.id, op);
    profiles.observe(op, "onikiri", true);
    profiles.observe(op, "onikiri", false);
}
let scans = 0;
const profileSource = { name: "profile.kanata", parser: "onikiri", opCount: 4, lastCycle: 100 };
const readProfileOp = (id) => {
    scans++;
    return profileOps.get(id);
};
const sharedProfile = profiles.get(0, readProfileOp, profileSource);
assert.ok(sharedProfile.detected, "Retire-order writes invalidated the ID-order detector");
assert.equal(sharedProfile.observed, 4, "Repeated writes inflated the structure sample");
assert.equal(scans, 4);
assert.equal(profiles.get(0, readProfileOp, profileSource), sharedProfile);
assert.equal(scans, 4, "An unchanged structure sample was rescanned for another window");
const profileTrace = convert(instructions, { profile: sharedProfile });
for (const op of instructions) {
    const narrow = convert([op], { profile: sharedProfile });
    assert.deepEqual(narrow.structure, profileTrace.structure, "A narrow window changed the file's structure");
    assert.deepEqual(
        narrow.ops[0],
        profileTrace.ops.find((item) => item[0] === op.id),
        "Profile changed recorded stage times"
    );
}

// Is名を持たない汎用Kanataでも、Coreの役割推定後は観測済みの最短値を共有する。
const genericMemoryOps = instructions.map((op, index) => ({
    ...op,
    labelName: index < 2 ? "lw x0, 0(x1)" : "sw x0, 0(x1)"
}));
const genericProfiles = createProfiles();
for (const op of [...genericMemoryOps].reverse()) genericProfiles.observe(op, "onikiri", true);
const genericProfile = genericProfiles.get(0, (id) => genericMemoryOps.find((op) => op.id === id), profileSource);
assert.equal(genericProfile.protocol, null);
assert.ok(genericProfile.detected);
assert.deepEqual(genericProfile.memoryMinimum, { load: 1, store: 1 });
for (const op of genericMemoryOps) {
    const selected = convert([op], { profile: genericProfile });
    assert.deepEqual(prepare(selected).replay.memory.minimum, { load: 1, store: 1 });
}

function profileRsd(id, label, latency, tid = 0) {
    const base = id * 100;
    return operation(
        id,
        [
            ["Np", base, base + 1],
            ["F", base + 1, base + 2],
            ["Pd", base + 2, base + 3],
            ["Dc", base + 3, base + 4],
            ["Rn", base + 4, base + 5],
            ["Ds", base + 5, base + 6],
            ["Sc", base + 6, base + 7],
            ["Is", base + 7, base + 8],
            ["Rr", base + 8, base + 9],
            ["X", base + 9, base + 9 + latency],
            ["Rw", base + 9 + latency, base + 10 + latency],
            ["Cm", base + 10 + latency, base + 11 + latency]
        ],
        { labelName: label, tid }
    );
}
const globalProfiles = createProfiles(),
    globalOps = new Map();
function observeGlobal(op, firstWrite = true) {
    globalOps.set(op.id, op);
    globalProfiles.observe(op, "onikiri", firstWrite);
}
for (let id = 0; id < 2000; id++) observeGlobal(profileRsd(id, "add x0, x1, x2", 1));
observeGlobal(profileRsd(2000, "lw x0, 0(x1)", 35));
observeGlobal(profileRsd(2001, "lw x0, 0(x1)", 3));
observeGlobal(profileRsd(2002, "sw x0, 0(x1)", 5));
observeGlobal(profileRsd(2003, "bne x0, x1", 1));
observeGlobal(profileRsd(2004, "sw x0, 0(x1)", 2, 1));
const unfinishedLoad = profileRsd(2005, "lw x0, 0(x1)", 1);
unfinishedLoad.eof = true;
unfinishedLoad.retired = false;
observeGlobal(unfinishedLoad);
const canceledLoad = profileRsd(2006, "lw x0, 0(x1)", 1);
canceledLoad.flush = true;
canceledLoad.retired = false;
observeGlobal(canceledLoad);
const globalSource = { name: "long.kanata", parser: "onikiri", opCount: globalOps.size, lastCycle: 300000 };
scans = 0;
const readGlobal = (id) => {
    scans++;
    return globalOps.get(id);
};
const completeProfile = globalProfiles.get(0, readGlobal, globalSource);
assert.ok(scans <= profileLimits.perThreadSamples, "Whole-file structure retained every operation");
assert.deepEqual(completeProfile.memoryMinimum, { load: 3, store: 5 });
assert.deepEqual(completeProfile.memoryKinds, ["load", "store"]);
assert.deepEqual(completeProfile.kinds, ["integer", "memory", "branch"]);
const referenceShape = convert([globalOps.get(0)], { source: globalSource, profile: completeProfile });
const referenceMemory = prepare(referenceShape).replay.memory;
for (const id of [2000, 2001, 2002, 2003, 0]) {
    const selected = convert([globalOps.get(id)], {
        firstCycle: id * 100,
        lastCycle: id * 100 + 1,
        source: globalSource,
        profile: globalProfiles.get(0, readGlobal, globalSource)
    });
    assert.deepEqual(
        selected.structure,
        referenceShape.structure,
        "Execution kinds or capacities changed with a different interval"
    );
    const state = prepare(selected);
    assert.deepEqual(state.replay.memory.minimum, { load: 3, store: 5 });
    assert.deepEqual(
        state.replay.memory.executionNodes,
        referenceMemory.executionNodes,
        "Load/store pipe layout depends on local instruction proportions"
    );
    assert.deepEqual(selected.ops[0].slice(2, 5), [globalOps.get(id).fetchedCycle, globalOps.get(id).retiredCycle, 0]);
}
const otherThread = globalProfiles.get(1, readGlobal, globalSource);
assert.deepEqual(otherThread.memoryMinimum, { load: null, store: 2 });
assert.deepEqual(otherThread.memoryKinds, ["store"], "One thread inherited another thread's execution kinds");
assert.equal(completeProfile.observed, 2006);
assert.match(referenceShape.demo.provenance.note, /sample.*256|256.*sample/i);
globalProfiles.clear();
assert.equal(globalProfiles.sampleCount, 0);
assert.throws(() => globalProfiles.get(0, readGlobal, globalSource), /No structure observations/);
observeGlobal(profileRsd(0, "add x0, x1, x2", 1));
const nextFile = globalProfiles.get(0, readGlobal, { ...globalSource, opCount: 1 });
assert.deepEqual(nextFile.memoryKinds, [], "A replacement file inherited load/store observations");
assert.deepEqual(nextFile.memoryMinimum, { load: null, store: null });

// 再試行の短い途中アクセスは、成功した最終アクセスの基準を縮めない。
const retryProfiles = createProfiles();
for (const op of rsdOps) retryProfiles.observe(op, "onikiri", true);
const retryProfile = retryProfiles.get(0, (id) => rsdOps.find((op) => op.id === id), profileSource);
assert.deepEqual(retryProfile.memoryMinimum, { load: 3, store: 3 });
const retryWithProfile = convert(rsdOps, { profile: retryProfile });
assert.deepEqual(retryWithProfile.ops, rsd.ops, "Whole-file memory minima changed retry or completion records");
const fallbackTrace = {
    ...retryWithProfile,
    displayProfile: { ...retryWithProfile.displayProfile, memoryMinimum: { load: null, store: null } }
};
assert.deepEqual(
    prepare(fallbackTrace).replay.memory.minimum,
    { load: 3, store: 3 },
    "Unobserved global minima blocked safe local evidence"
);
const boundedProfiles = createProfiles();
for (let thread = 0; thread < profileLimits.threads; thread++) {
    for (let local = 0; local < profileLimits.perThreadSamples; local++) {
        const op = profileRsd(thread * 1000 + local, "add x0, x1, x2", 1, thread);
        boundedProfiles.observe(op, "onikiri", true);
    }
}
assert.equal(boundedProfiles.sampleCount, profileLimits.totalSamples, "Samples grew with every hardware thread");
assert.throws(
    () => boundedProfiles.observe(profileRsd(0, "add", 1, profileLimits.threads), "onikiri", true),
    /hardware threads/
);
const manyStages = operation(
    0,
    Array.from({ length: profileLimits.stages + 1 }, (_, index) => [`stage-${index}`, index, index + 1])
);
assert.throws(() => createProfiles().observe(manyStages, "onikiri", true), /stage names per thread/);
assert.throws(
    () =>
        createProfiles().observe(operation(0, [["x".repeat(profileLimits.stageNameChars + 1), 0, 1]]), "onikiri", true),
    /characters/
);
const manyEvents = operation(
    0,
    Array.from({ length: profileLimits.sampleStages + 1 }, (_, index) => ["A", index, index + 1])
);
const limitedStages = createProfiles();
limitedStages.observe(manyEvents, "onikiri", true);
assert.equal(
    limitedStages.get(0, () => manyEvents, { ...profileSource, lastCycle: manyEvents.retiredCycle }).sampled,
    0,
    "A single repeated-stage operation exceeded the structure sample's stage budget"
);
assert.equal(JSON.stringify(instructions), original);
console.log(
    "Trace windows: detected/generic stages, exact times, boundary ROB state, recorded dependencies, EOF, flush, idle windows, tick calibration and explicit limits passed"
);

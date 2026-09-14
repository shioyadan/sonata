"use strict";
// パイプの速度、待機、再試行、未観測値を DOM / GPU に依存せず検査する。
const assert = require("node:assert/strict");
const fs = require("node:fs"),
    vm = require("node:vm");
const { createReplay, createRobReplay, createWaitPlayback, createEmptyPlayback } = require("../src/replay-model.cts");
const { instructionType } = require("../src/memory.cts");
const { createScene, styles } = require("../src/scene.cts");
const { createPaths } = require("../src/geometry.cts");
const data = {};
vm.runInNewContext(fs.readFileSync(require.resolve("../data/traces.js"), "utf8"), data);
const samples = data.embeddedFlowTraces;
function setup(trace) {
    const replay = createReplay({ samples: [trace] }).loadTrace(trace.key);
    const session = { style: styles.neon };
    const scene = createScene({ replay, session });
    scene.buildLayout();
    return { replay, scene, paths: createPaths({ scene, replay, session }) };
}
function operation(id, label, complete, options = {}) {
    const end = options.end ?? 22;
    const stages = options.stages ?? [["Is", "exec-memory", 5, complete ?? end]];
    if (complete != null && complete < end) stages.push(["Cm", "rob", complete, end]);
    return [
        id,
        id,
        0,
        end,
        options.flush ? 1 : 0,
        label,
        stages,
        options.allocation === undefined ? (options.flush ? null : 4) : options.allocation,
        5,
        complete,
        "exec-memory"
    ];
}
const trace = {
    ...samples[0],
    key: "fixture",
    firstCycle: 0,
    lastCycle: 40,
    evidence: undefined,
    topDown: undefined,
    retireWidth: 16,
    ops: [
        operation(1, "ldr x0, [x1]", 8),
        operation(2, "ldr x0, [x1]", 15),
        operation(3, "str x0, [x1]", 6),
        operation(4, "add x0, x1, x2", 6),
        operation(5, "ldr x0, [x1]", null, { end: 6, flush: true }),
        operation(6, "ldr x0, [x1]", 5.5, { stages: [["Mc", "exec-memory", 5, 5.5]] }),
        operation(7, "ldr x0, [x1]", null),
        operation(8, "sbfm x0, x1, #0, #7", 6),
        operation(9, "b.ne 0x100", 6),
        operation(10, "amoadd.w x0, x1, (x2)", 6),
        operation(11, "str x0, [x1]", 6),
        operation(12, "ldr x0, [x1]", 18, {
            stages: [
                ["X", "exec-memory", 5, 8],
                ["Ma", "memory-wait", 8, 13],
                ["Is", "issue", 13, 14],
                ["Rr", "register-read", 14, 15],
                ["X", "exec-memory", 15, 18]
            ]
        }),
        operation(13, "str x0, [x1]", 15),
        operation(14, "str x0, [x1]", 13, {
            stages: [
                ["X", "exec-memory", 5, 6],
                ["Rw", "memory-wait", 6, 10],
                ["Is", "issue", 10, 11],
                ["Rr", "register-read", 11, 12],
                ["X", "exec-memory", 12, 13]
            ]
        }),
        operation(15, "str x0, [x1]", null, { end: 10, flush: true, allocation: 4 })
    ],
    storeCompletions: [
        [3, 23.006],
        [5, 25],
        [10, 26]
    ]
};
const original = JSON.stringify(trace);
const { replay, scene, paths } = setup(trace);
assert.equal(JSON.stringify(trace), original, "Preparing memory changed recorded source events");
assert.deepEqual(replay.memory.minimum, { load: 3, store: 1 });
assert.equal(instructionType("sbfm x0, x1, #0, #7"), "integer");
assert.equal(instructionType("sb x1, 0(x2)"), "store");
for (const [label, kind] of [
    ["20000300 r2 = LD.64(r1)", "load"],
    ["20000304 ST.32(r2, r3)", "store"],
    ["20000308 (r2, r3) = LD.64(r1)", "load"],
    ["2000030c BNE(r2, r3)", "branch"],
    ["20000310 r2 = MUL.64(r1, r0)", "integer"],
    ["20000314 r2 = SPST.64(r1)", "integer"],
    ["trace r2 = LD.64(r1)", "integer"],
    ["20000300 note = LD.64(r1)", "integer"]
])
    assert.equal(instructionType(label), kind, `Incorrect classification of ${label}`);
assert.equal(instructionType("bic x0, x1, x2"), "integer");
assert.equal(instructionType("stxr w0, x1, [x2]"), "atomic");
const op = (id) => replay.ops.find((o) => o.id === id);
const exec = (id) => op(id).stages.find((s) => s.node.startsWith("exec"));
function velocity(id) {
    const s = exec(id),
        duration = s.end - s.start;
    const a = paths.positionAt(op(id), s.start + duration * 0.5);
    const b = paths.positionAt(op(id), s.start + duration * 0.8);
    return (b[0] - a[0]) / (duration * 0.3);
}
for (const id of [1, 2, 3, 4, 8, 9]) assert.ok(Math.abs(velocity(id) - 1.5) < 1e-9, `Different pipe speed: ${id}`);
assert.equal(scene.nodes.get("exec-load").latency, 3);
assert.equal(scene.nodes.get("exec-store").latency, 1);
assert.equal(exec(2).end, 8, "A slow response stretched traversal time");
assert.deepEqual(
    op(2).stages.find((s) => s.node === "memory-wait"),
    {
        node: "memory-wait",
        start: 8,
        end: 15,
        names: ["Is"],
        displaySlot: 0
    }
);
assert.deepEqual(paths.positionAt(op(2), 10), paths.positionAt(op(2), 14), "Response wait kept moving");
assert.equal(op(2).completion, 15);
assert.equal(replay.robReplay.stateAt(14).entries.find((e) => e.op.id === 2).op.completion, 15);
assert.ok(
    paths.positionAt(op(5), 5.99)[0] < scene.executionLane(scene.nodes.get("exec-load"), 0).inlet[0] + 0.6,
    "A squashed short access rushed through the entire load pipe"
);
assert.equal(op(7).completion, null, "An unobserved completion was invented");
assert.deepEqual(
    op(12).stages.map((s) => [s.node, s.start, s.end]),
    [
        ["exec-load", 5, 8],
        ["memory-wait", 8, 13],
        ["issue", 13, 14],
        ["register-read", 14, 15],
        ["exec-load", 15, 18],
        ["rob", 18, 22]
    ]
);
assert.deepEqual(
    replay.memory.pendingStores.map(({ id, start, end }) => ({ id, start, end })),
    [{ id: 3, start: 22, end: 23.006 }]
);
assert.equal(op(3).end, 22, "Pending writes delayed instruction commit");
assert.deepEqual(Object.keys(replay.memory.waitSlots), ["load"], "STORE retained a separate waiting-slot allocator");
assert.deepEqual(
    op(13).stages.map((s) => [s.node, s.start, s.end]),
    [
        ["exec-store", 5, 6],
        ["rob", 6, 15],
        ["rob", 15, 22]
    ],
    "A long STORE response remained in the pipe"
);
assert.deepEqual(paths.positionAt(op(13), 7), scene.robCell(op(13).robSlot, 0.19));
assert.equal(paths.instructionLight(op(13), 14.99).state, "waiting");
assert.equal(paths.instructionLight(op(13), 15).state, "ready", "Moving to ROB anticipated STORE completion");
assert.deepEqual(
    op(14).stages.map((s) => [s.node, s.start, s.end]),
    [
        ["exec-store", 5, 6],
        ["rob", 6, 10],
        ["issue", 10, 11],
        ["register-read", 11, 12],
        ["exec-store", 12, 13],
        ["rob", 13, 22]
    ],
    "Moving a STORE wait to ROB changed the retry sequence"
);
assert.equal(paths.stageAt(op(15), 9.99).node, "rob");
assert.equal(paths.instructionLight(op(15), 9.99).state, "waiting", "A squashed STORE became ready");
assert.ok(replay.robReplay.stateAt(9.99).entries.some((e) => e.op.id === 15));
assert.ok(!replay.robReplay.stateAt(10).entries.some((e) => e.op.id === 15), "A squashed STORE retained its ROB entry");
assert.equal(paths.instructionLight(op(15), 10).state, "squashed");
assert.deepEqual(paths.positionAt(op(15), 9.99), scene.robCell(op(15).robSlot, 0.19));
const unknown = setup({ ...trace, ops: [operation(1, "ldr x0, [x1]", null)], storeCompletions: undefined });
assert.equal(unknown.replay.memory.minimum.load, null);
assert.deepEqual(unknown.replay.memory.pendingStores, []);
// 実行開始が抜粋にない待機を、レジスタ読み出しや新しい実行として補完しない。
const partial = setup({
    ...samples.find((s) => s.key === "memory-tide"),
    ops: [
        operation(20, "sw x1, 0(x2)", null, {
            stages: [
                ["Is", "issue", 5, 6],
                ["Mc", "memory-wait", 6, 22]
            ]
        })
    ],
    storeCompletions: undefined
});
assert.ok(partial.scene.nodes.has("register-read"));
partial.scene.registerReadPort = () => assert.fail("Partial store wait invented a register read");
const partialStore = partial.replay.ops[0];
assert.equal(partialStore.stages.at(-1).node, "rob", "A partial STORE wait remained in the pipe");
assert.equal(partialStore.completion, null, "A partial STORE wait invented completion");
assert.ok(partial.paths.positionAt(partialStore, 6.6).every(Number.isFinite));
assert.deepEqual(partial.paths.positionAt(partialStore, 10), partial.scene.robCell(partialStore.robSlot, 0.19));
assert.equal(partial.paths.instructionLight(partialStore, 10).state, "waiting");
for (const label of ["str x0, [x1]", "amoadd.w x0, x1, (x2)"]) {
    const { replay, scene, paths } = setup({
        ...trace,
        storeCompletions: undefined,
        ops: [
            operation(20, label, null, {
                stages: [
                    ["Is", "exec-memory", 5, 6],
                    ["Mc", "memory-wait", 6, 22]
                ]
            })
        ]
    });
    assert.equal(replay.memory.minimum.store, null);
    for (const stage of replay.ops[0].stages) assert.ok(scene.nodes.has(stage.node));
    assert.ok(paths.positionAt(replay.ops[0], 10).every(Number.isFinite));
    assert.ok(
        [...scene.nodes.values()]
            .find((n) => n.pipeCount && n.id !== "exec-integer" && n.id !== "exec-branch")
            .detail.includes("LATENCY ?")
    );
}
// 実際の prepareMemory を経由し、短い通過と長い待機を加速判定でも区別する。
function waitFixture(label, stages, completion, end = 200) {
    const source = {
        ...trace,
        lastCycle: end,
        ops: [operation(1, label, completion, { stages, end })],
        demo: { ...trace.demo, events: [] },
        storeCompletions: undefined,
        displayProfile: { memoryMinimum: { load: 3, store: 1 }, memoryKinds: ["load", "store"] }
    };
    const replay = createReplay({ samples: [source] }).loadTrace(source.key);
    return { source, replay, target: createWaitPlayback(source, replay.ops) };
}
const loadWait = waitFixture(
    "ldr x0, [x1]",
    [
        ["F", "front-0", 0, 4],
        ["Is", "issue", 4, 5],
        ["X", "exec-memory", 5, 8],
        ["Ma", "memory-wait", 8, 70],
        ["Mc", "exec-memory", 70, 120]
    ],
    120
);
assert.deepEqual(
    loadWait.replay.ops[0].stages.slice(2).map(({ node, start, end }) => [node, start, end]),
    [
        ["exec-load", 5, 8],
        ["memory-wait", 8, 120],
        ["rob", 120, 200]
    ]
);
assert.equal(loadWait.target(6), null, "The short LOAD pipe traversal must retain normal speed");
assert.equal(loadWait.target(14), 68, "LOAD WAIT must accelerate up to the next recorded Mc boundary");
assert.equal(loadWait.target(70), null, "A raw transition hidden by display grouping still changes state");
assert.equal(loadWait.target(75.999), null);
assert.equal(loadWait.target(76), 118);
assert.equal(loadWait.target(120), null, "Recorded completion must return to normal speed");
assert.equal(loadWait.target(126), 198);
assert.equal(createEmptyPlayback(loadWait.source)(14), null, "LOAD WAIT must not become an empty interval");
assert.equal(createWaitPlayback(loadWait.source)(76), null, "Without prepared stages, execution remains conservative");
const loadWithGap = structuredClone(loadWait.source);
loadWithGap.ops[0][6] = loadWithGap.ops[0][6].filter(([name]) => name !== "Ma");
const gapReplay = createReplay({ samples: [loadWithGap] }).loadTrace(loadWithGap.key);
assert.equal(
    createWaitPlayback(loadWithGap, gapReplay.ops)(20),
    null,
    "Display grouping must not fabricate waiting across a gap in raw observations"
);
for (const change of ["missing", "unfinished", "unknown"]) {
    const source = structuredClone(loadWait.source);
    if (change === "missing") source.ops[0][6] = [];
    if (change === "unfinished") source.ops[0][12] = true;
    if (change === "unknown") source.ops[0][6][3][1] = "unknown";
    const replay = createReplay({ samples: [source] }).loadTrace(source.key);
    assert.equal(
        createWaitPlayback(source, replay.ops)(20),
        null,
        `${change} observations must block wait acceleration`
    );
}
const retryWait = waitFixture(
    "sw x1, 0(x2)",
    [
        ["F", "front-0", 0, 4],
        ["Is", "issue", 4, 5],
        ["X", "exec-memory", 5, 6],
        ["Rw", "memory-wait", 6, 100],
        ["Is", "issue", 100, 101],
        ["Rr", "register-read", 101, 130],
        ["X", "exec-memory", 130, 131],
        ["Rw", "memory-wait", 131, 180]
    ],
    180,
    240
);
assert.equal(retryWait.replay.ops[0].stages.find((stage) => stage.start === 6).node, "rob");
assert.equal(retryWait.target(12), 98, "A STORE waiting in ROB must return to normal before retry issue");
assert.equal(retryWait.target(100), null);
assert.equal(retryWait.target(110), null, "A retry's register read remains visible even when long");
assert.equal(retryWait.target(130.5), null, "A retried STORE must traverse its pipe at normal speed");
assert.equal(retryWait.target(137), 178);
assert.equal(retryWait.target(180), null);
assert.equal(retryWait.target(186), 238);
console.log("memory wait playback: prepared LOAD/ROB waits, raw transitions, retry reads and unknown intervals");

for (const sample of samples) {
    const before = JSON.stringify(sample),
        { replay, scene, paths } = setup(sample);
    const units = [...scene.nodes.values()].filter((n) => n.pipeCount);
    for (const a of units)
        for (const b of units) {
            if (a === b) continue;
            assert.ok(Math.abs(a.z - b.z) >= (a.d + b.d) / 2, `${sample.key}: overlapping ${a.id}/${b.id}`);
        }
    const launches = new Map();
    for (const o of replay.ops) {
        for (const stage of o.stages.filter((s) => s.node === "exec-load" || s.node === "exec-store")) {
            const key = `${stage.node}:${stage.start}`;
            const lanes = launches.get(key) ?? new Set();
            assert.ok(!lanes.has(o.pipeLane), `${sample.key}: coincident memory launch ${key}`);
            lanes.add(o.pipeLane);
            launches.set(key, lanes);
        }
        const raw = sample.ops.find((t) => t[0] === o.id);
        assert.equal(o.allocation, raw[7]);
        assert.equal(o.issue, raw[8]);
        assert.equal(o.completion, raw[9]);
        assert.equal(o.end, raw[4] ? (raw[11] ?? raw[3]) : raw[3]);
        for (const s of o.stages.filter((s) => s.node === "memory-wait")) {
            if (s.end - s.start > 2)
                assert.deepEqual(paths.positionAt(o, s.start + 1), paths.positionAt(o, s.end - 0.01));
        }
    }
    assert.ok(!scene.nodes.has("store-wait"), `${sample.key}: separate STORE WAIT platform remained`);
    assert.ok(scene.connections.every((c) => c.from !== "store-wait" && c.to !== "store-wait"));
    assert.deepEqual(Object.keys(replay.memory.waitSlots), ["load"]);
    assert.ok(
        replay.ops.every((o) => o.stages.every((s) => !("waiting" in s))),
        "An outlet-wait marker remained"
    );
    const stores = replay.ops.filter((o) => o.memoryKind === "store");
    assert.ok(
        stores.every((o) => o.stages.every((s) => s.node !== "memory-wait")),
        "A STORE occupied LOAD WAIT"
    );
    // 表示先を変えても、割当・コミットから作る ROB の順序と占有は元記録と一致する。
    const recordedRob = createRobReplay(
        sample.ops.map((raw) => ({
            id: raw[0],
            allocation: raw[7],
            completion: raw[9],
            end: raw[4] ? (raw[11] ?? raw[3]) : raw[3],
            flush: !!raw[4]
        })),
        sample.structure.robCapacity
    );
    const robState = (rob, cycle) => {
        const state = rob.stateAt(cycle);
        return {
            head: state.head,
            tail: state.tail,
            entries: state.entries.map(({ op, slot }) => ({
                id: op.id,
                slot,
                ready: op.completion != null && cycle >= op.completion
            }))
        };
    };
    const waits = stores.flatMap((op) =>
        op.stages
            .filter((s) => s.node === "rob" && (op.completion == null || s.start < op.completion))
            .map((stage) => ({ op, stage }))
    );
    for (const { op, stage } of waits) {
        const stationary = stage.start + Math.min(0.9, stage.end - stage.start - 0.001);
        const cycles = [stage.start, stationary, stage.end - 0.001, stage.end, op.completion ?? op.end, op.end];
        for (const cycle of [...cycles, ...cycles.toReversed()])
            assert.deepEqual(robState(replay.robReplay, cycle), robState(recordedRob, cycle));
        assert.equal(paths.instructionLight(op, stage.start).state, "waiting");
        if (stage.end - stage.start > 0.9) {
            const position = scene.robCell(op.robSlot, 0.19);
            assert.deepEqual(paths.positionAt(op, stationary), position, `STORE #${op.id} did not reach its ROB cell`);
            assert.deepEqual(paths.positionAt(op, stage.end - 0.001), position, `STORE #${op.id} moved while waiting`);
        }
    }
    if (sample.key === "memory-tide") {
        const simultaneous = waits.filter(({ stage: s }) => s.start <= 3970.9 && s.end > 3970.9);
        assert.deepEqual(
            Array.from(simultaneous, ({ op }) => op.id),
            [4318, 4323, 4328, 4333, 4338, 4343]
        );
        assert.deepEqual(
            Array.from(simultaneous, ({ op }) => op.robSlot),
            [14, 19, 24, 29, 34, 39]
        );
        for (const { op } of simultaneous) {
            const position = paths.positionAt(op, 3970.9);
            assert.deepEqual(position, scene.robCell(op.robSlot, 0.19));
            for (const { op: other } of simultaneous) {
                if (op === other) continue;
                const otherPosition = paths.positionAt(other, 3970.9);
                assert.ok(
                    Math.hypot(...position.map((v, i) => v - otherPosition[i])) >= 0.24,
                    "STORE ROB cells overlap"
                );
            }
        }
        const retry = stores.find((o) => o.id === 4318),
            times = [3962.9, 3963.4, 3970.9, 3981, 3982.9, 3983, 3985.9, 3986, 3986.9, 3987.9];
        const states = times.map((cycle) => ({
            cycle,
            position: paths.positionAt(retry, cycle),
            stage: paths.stageAt(retry, cycle).node,
            light: paths.instructionLight(retry, cycle),
            rob: robState(replay.robReplay, cycle)
        }));
        assert.equal(states[3].stage, "register-read");
        assert.equal(states[5].stage, "exec-store");
        assert.equal(states[7].stage, "rob");
        assert.equal(states[6].light.state, "executing");
        assert.equal(states[7].light.state, "ready");
        assert.deepEqual(states[8].position, states[2].position, "A retried STORE returned to another ROB cell");
        assert.notDeepEqual(states[1].position, states[2].position, "STORE-to-ROB transfer was not exercised");
        for (const state of states.toReversed()) {
            const entry = state.rob.entries.find((e) => e.id === retry.id);
            assert.equal(entry.slot, 14, "A retry changed the allocated ROB slot");
            assert.equal(entry.ready, state.cycle >= 3986, "A retry anticipated completion");
            assert.deepEqual(
                paths.positionAt(retry, state.cycle),
                state.position,
                "Reverse seek changed the STORE path"
            );
            assert.deepEqual(
                robState(replay.robReplay, state.cycle),
                state.rob,
                "Reverse seek changed STORE ROB state"
            );
        }
    }
    for (const link of scene.connections)
        for (const lane of link.lanes) {
            assert.ok(lane.target[0] > lane.source[0], `${sample.key}: backward ${link.from} -> ${link.to}`);
        }
    for (const kind of ["load", "store"]) {
        const node = scene.nodes.get(`exec-${kind}`);
        if (!node) continue;
        const lane = scene.executionLane(node, 0);
        assert.ok(Math.abs(lane.outlet[0] - lane.inlet[0] - node.latency * 1.17) < 1e-9);
    }
    assert.equal(JSON.stringify(sample), before);
    console.log(
        `${sample.key}: ${JSON.stringify(replay.memory.minimum)}, ${replay.memory.pendingStores.length} recorded pending writes`
    );
}
console.log("Memory paths: equal speeds, stationary waits, retries, partial accesses and recorded writes passed");

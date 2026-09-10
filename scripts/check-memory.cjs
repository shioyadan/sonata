"use strict";
// パイプの速度、待機、再試行、未観測値を DOM / GPU に依存せず検査する。
const assert = require("node:assert/strict");
const fs = require("node:fs"),
    vm = require("node:vm");
const { createReplay } = require("../src/replay-model.cts");
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
    return [id, id, 0, end, options.flush ? 1 : 0, label, stages, options.flush ? null : 4, 5, complete, "exec-memory"];
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
        })
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
const unknown = setup({ ...trace, ops: [operation(1, "ldr x0, [x1]", null)], storeCompletions: undefined });
assert.equal(unknown.replay.memory.minimum.load, null);
assert.deepEqual(unknown.replay.memory.pendingStores, []);
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
        assert.equal(o.issue, raw[8]);
        assert.equal(o.completion, raw[9]);
        assert.equal(o.end, raw[4] ? (raw[11] ?? raw[3]) : raw[3]);
        for (const s of o.stages.filter((s) => s.node === "memory-wait" || s.node === "store-wait")) {
            if (s.end - s.start > 2)
                assert.deepEqual(paths.positionAt(o, s.start + 1), paths.positionAt(o, s.end - 0.01));
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

"use strict";
// 配置と経路は DOM / WebGL なしで準備でき、別の再生インスタンスを変更しない。
const assert = require("node:assert/strict"),
    fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm");
const { createReplay, createDependencyReplay } = require("../src/replay-model.cts"),
    { createPaths } = require("../src/geometry.cts");
const { createScene, styles } = require("../src/scene.cts");
const data = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../data/traces.js"), "utf8"), data);
const samples = data.embeddedFlowTraces,
    original = JSON.stringify(samples);
// 未読込みの状態は描画へ渡さず、準備が成功したときだけ公開する。
const empty = createReplay({ samples: [] });
assert.equal(empty.current, null);
assert.throws(() => empty.loadTrace("missing"), /No traces available/);
assert.equal(empty.current, null);
const broken = {
    ...samples[0],
    key: "broken",
    get lastCycle() {
        throw new Error("Trace preparation interrupted");
    }
};
const source = createReplay({ samples: [...samples, broken] });
assert.equal(source.current, null);
const ready = source.loadTrace(samples[0].key);
assert.equal(source.current, ready);
const preparedOps = ready.ops;
assert.throws(() => source.loadTrace("broken"), /Trace preparation interrupted/);
assert.equal(source.current, ready);
assert.equal(ready.trace, samples[0]);
assert.equal(ready.ops, preparedOps, "A failed load exposed partially prepared instructions");
assert.equal(source.loadTrace("unknown").trace, samples[0], "An unknown key should use the first demo");
const unobserved = createReplay({ samples: [{ ...samples[0], evidence: undefined }] }).loadTrace("");
assert.equal(unobserved.registerReplay.stateAt(unobserved.trace.firstCycle).available, false);

function createFixture() {
    const session = { style: styles.neon },
        source = createReplay({ samples }),
        replay = source.loadTrace(samples[0].key);
    const placement = createScene({ replay, session }),
        paths = createPaths({ scene: placement, replay, session });
    return {
        session,
        replay,
        placement,
        paths,
        load(key) {
            assert.equal(source.loadTrace(key), replay, "Loading replaced the state held by scene / paths");
            placement.buildLayout();
        }
    };
}
function snapshot(scene) {
    const { replay, placement, paths } = scene;
    const positions = replay.ops.map((op) => [
        op.id,
        ...op.stages.map((stage) => {
            const p = paths.positionAt(op, (stage.start + stage.end) / 2);
            if (p)
                assert.ok(
                    p.length === 3 && p.every(Number.isFinite),
                    `Invalid position for ${replay.trace.key}/${op.id}`
                );
            return p;
        })
    ]);
    // JSON にして、後続の変更から独立した値を比較する。
    return JSON.stringify({
        ops: replay.ops,
        nodes: [...placement.nodes],
        connections: placement.connections,
        positions
    });
}
function checkRobMarkerPath({ placement, replay }) {
    const capacity = replay.trace.structure.robCapacity;
    const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
    for (let slot = 0; slot < capacity; slot++) {
        const cell = placement.robCell(slot, 0.1);
        assert.deepEqual(placement.robMarker(slot, 0.1), cell, "A settled ROB marker missed its cell");
        assert.ok(
            distance(placement.robMarker(slot - 0.000001, 0.1), placement.robMarker(slot + 0.000001, 0.1)) < 0.001,
            `ROB marker jumped at a row or wrap boundary: ${slot}`
        );
        if (slot + 1 < capacity) {
            const next = placement.robCell(slot + 1, 0.1),
                middle = placement.robMarker(slot + 0.5, 0.1);
            assert.ok(
                Math.abs(distance(cell, middle) + distance(middle, next) - distance(cell, next)) < 1e-9,
                "ROB marker cut across the serpentine cell path"
            );
        }
    }
    const first = placement.robCell(0, 0.1),
        last = placement.robCell(capacity - 1, 0.1),
        wrap = placement.robMarker(capacity - 0.5, 0.1);
    assert.ok(wrap[2] < Math.min(first[2], last[2]), "The ROB wrap marker crossed occupied cells");
    assert.deepEqual(placement.robMarker(capacity, 0.1), first);
    assert.deepEqual(placement.robMarker(-0.5, 0.1), wrap, "Reverse wrap took a different path");
}
const matteStyles = ["aluminum", "paper"];
assert.deepEqual(Object.keys(styles), ["neon", ...matteStyles], "Available styles or their order changed");
for (const style of matteStyles) assert.equal(styles[style].matte, true, `${style} did not use grounded instructions`);
for (const style of matteStyles.slice(1)) {
    for (const kind of ["integer", "memory", "branch", "red", "blue"])
        assert.deepEqual(
            styles[style].palette[kind],
            styles.aluminum.palette[kind],
            `${kind}: ${style} changed instruction colors`
        );
    assert.notDeepEqual(
        styles[style].structure,
        styles.aluminum.structure,
        `${style} kept the Aluminum material palette`
    );
}
const first = createFixture(),
    second = createFixture();
let instructions = 0;
for (const [index, sample] of samples.entries()) {
    first.load(sample.key);
    second.load(sample.key);
    assert.equal(first.replay.ops.length, sample.ops.length);
    assert.ok(first.placement.nodes.size > 0);
    checkRobMarkerPath(first);
    if (sample.structure.robCapacity <= 224)
        assert.equal(first.placement.nodes.get("rob").d, 8, "Ordinary ROB depth changed");
    const registers = first.placement.nodes.get("register-read");
    if (registers)
        for (const connection of first.placement.connections.filter((c) => c.from === "register-read"))
            for (const lane of connection.lanes)
                assert.ok(
                    Math.abs(lane.source[2] - registers.z) < registers.d / 2,
                    `${sample.key}: ${connection.to} port is outside the register housing`
                );
    const expected = snapshot(first);
    assert.equal(snapshot(second), expected);
    assert.notEqual(first.replay.ops, second.replay.ops);
    assert.notEqual(first.placement.nodes, second.placement.nodes);
    let aluminum;
    for (const style of matteStyles) {
        first.session.style = styles[style];
        first.load(sample.key);
        const current = snapshot(first);
        if (style === "aluminum") aluminum = current;
        else
            assert.equal(current, aluminum, `${sample.key}: ${style} changed the Aluminum layout or instruction paths`);
        first.load(samples[(index + 1) % samples.length].key);
        snapshot(first);
        assert.equal(snapshot(second), expected, "Loading another scene changed an existing scene");
    }
    first.session.style = styles.neon;
    first.load(sample.key);
    assert.equal(snapshot(first), expected, "Reloading a trace changed its layout or paths");
    instructions += sample.ops.length;
}
assert.equal(JSON.stringify(samples), original, "Preparing a scene changed the embedded traces");
console.log(`Scene isolation: ${samples.length} demos and ${instructions} instructions passed without DOM / WebGL`);

// 高密度のローカルログでも、命令を落とさず同じ大きさで段・FIFOへ配置する。
const denseTrace = {
    ...samples[0],
    key: "local-file",
    firstCycle: 0,
    lastCycle: 1100,
    fetchWidth: 16,
    retireWidth: 16,
    evidence: undefined,
    topDown: undefined,
    storeCompletions: [],
    storeWaits: [],
    feedPreview: [],
    demo: { ...samples[0].demo, events: [], bookmarks: [] },
    structure: {
        queueCapacity: 256,
        robCapacity: 2048,
        allocationWidth: 16,
        frontNodes: [
            { id: "front-0", names: ["F"] },
            { id: "front-1", names: ["D"] }
        ],
        executionNodes: [{ id: "exec-integer", kind: "integer", names: ["X"], pipeCount: 16 }],
        memoryWait: null
    },
    ops: Array.from({ length: 1200 }, (_, id) => {
        const fetch = Math.floor(id / 16),
            allocation = 100 + fetch,
            end = 1000 + fetch;
        return [
            id,
            id,
            fetch,
            end,
            0,
            "add x0, x1, x2",
            [
                ["F", "front-0", fetch, 90],
                ["D", "front-1", 90, allocation],
                ["Q", "issue", allocation, allocation + 1],
                ["X", "exec-integer", allocation + 1, allocation + 2],
                ["f", "rob", allocation + 2, end]
            ],
            allocation,
            allocation + 1,
            allocation + 2,
            "exec-integer"
        ];
    })
};
const denseSource = createReplay({ samples: [denseTrace] }),
    denseReplay = denseSource.loadTrace("local-file"),
    denseSession = { style: styles.neon },
    denseScene = createScene({ replay: denseReplay, session: denseSession }),
    densePaths = createPaths({ scene: denseScene, replay: denseReplay, session: denseSession });
denseScene.buildLayout();
function checkSpacing(positions, node, label) {
    assert.equal(
        new Set(positions.map((position) => position.join())).size,
        positions.length,
        `${label}: positions overlapped`
    );
    for (const [index, position] of positions.entries()) {
        assert.ok(position.every(Number.isFinite));
        assert.ok(Math.abs(position[0] - node.x) + 0.12 <= node.w / 2 + 1e-9, `${label}: instruction escaped in X`);
        assert.ok(Math.abs(position[2] - node.z) + 0.12 <= node.d / 2 + 1e-9, `${label}: instruction escaped in Z`);
        for (let next = index + 1; next < positions.length; next++)
            assert.ok(
                Math.hypot(...position.map((value, axis) => value - positions[next][axis])) >= 0.24 - 1e-9,
                `${label}: instruction centers were too close`
            );
    }
}
for (const [time, node] of [
    [85, "front-0"],
    [95, "front-1"],
    [500, "rob"]
]) {
    const positions = denseReplay.ops.map((op) => densePaths.positionAt(op, time));
    assert.equal(positions.filter(Boolean).length, 1200, `${node}: lost visible instructions`);
    checkSpacing(positions, denseScene.nodes.get(node), node);
}
checkSpacing(
    Array.from({ length: 2048 }, (_, slot) => denseScene.robCell(slot)),
    denseScene.nodes.get("rob"),
    "full ROB"
);
checkRobMarkerPath({ placement: denseScene, replay: denseReplay });
const scheduler = denseScene.nodes.get("issue");
assert.equal(scheduler.matrixBanks, 2);
assert.ok(scheduler.matrixDepth <= 128 * 0.14);
checkSpacing(
    Array.from({ length: 256 }, (_, slot) => denseScene.matrixPosition(slot)),
    scheduler,
    "256 scheduler seats"
);
const execution = denseScene.nodes.get("exec-integer");
checkSpacing(
    Array.from({ length: 16 }, (_, slot) => denseScene.executionLane(execution, slot).inlet),
    execution,
    "16 execution lanes"
);
checkSpacing(
    Array.from({ length: 16 }, (_, slot) => denseScene.commitSlot(slot).inlet),
    denseScene.nodes.get("commit"),
    "16 commit lanes"
);
const nodes = [...denseScene.nodes.values()],
    bounds = denseScene.layoutBounds();
for (const node of nodes) {
    assert.ok(node.x - node.w / 2 >= bounds.left && node.x + node.w / 2 <= bounds.right);
    assert.ok(node.z - node.d / 2 >= bounds.back && node.z + node.d / 2 <= bounds.front);
}
for (const [index, front] of denseTrace.structure.frontNodes.entries()) {
    const node = denseScene.nodes.get(front.id),
        next = denseScene.nodes.get(denseTrace.structure.frontNodes[index + 1]?.id ?? "issue");
    assert.ok(node.x + node.w / 2 < next.x - next.w / 2, "Expanded front units overlapped");
}
const firstNode = denseScene.nodes.get("front-0");
assert.ok(denseScene.inputPosition()[0] < firstNode.x - firstNode.w / 2, "Input moved inside the expanded frontend");
const positions = denseReplay.ops.map((op) => densePaths.positionAt(op, 95)),
    slots = denseReplay.ops.map((op) => op.stages[1].displaySlot);
denseSource.loadData({ ...denseTrace, firstCycle: 90, lastCycle: 218 }, { continuityAt: 95 });
denseScene.buildLayout(true);
assert.deepEqual(
    denseReplay.ops.map((op) => op.stages[1].displaySlot),
    slots,
    "Window continuity reassigned frontend seats"
);
assert.deepEqual(
    denseReplay.ops.map((op) => densePaths.positionAt(op, 95)),
    positions,
    "Window continuity moved frontend instructions"
);
console.log("Dense scene: 1200 simultaneous instructions, 2048 ROB entries and 16 lanes passed");

const completedWithoutIssue = {
    ...denseTrace,
    structure: { ...denseTrace.structure, queueCapacity: 16, robCapacity: 32 },
    ops: [
        [
            0,
            0,
            0,
            100,
            0,
            "nop",
            [
                ["F", "front-0", 0, 10],
                ["f", "rob", 10, 100]
            ],
            10,
            null,
            10,
            "exec-integer"
        ]
    ]
};
const nopReplay = createReplay({ samples: [completedWithoutIssue] }).loadTrace("local-file"),
    nopScene = createScene({ replay: nopReplay, session: denseSession });
nopScene.buildLayout();
const nopPaths = createPaths({ scene: nopScene, replay: nopReplay, session: denseSession });
assert.equal(
    nopReplay.dependencyReplay.stateAt(20).rows.length,
    0,
    "A committable operation without issue occupied the scheduler"
);
assert.equal(nopPaths.occupancy(20).issued.length, 0, "Scheduler occupancy ignored an observed completion");
assert.equal(nopReplay.robReplay.stateAt(20).entries.length, 1, "The committable operation disappeared from ROB");

// FP/SIMDは別の待機筐体へ置き、依存列の番号は全schedulerで共有する。
// モデルから受け取る配置契約だけを差し替え、分類器と独立に経路を検査する。
for (const registerRead of [false, true]) {
    const trace = {
        ...denseTrace,
        structure: {
            ...denseTrace.structure,
            queueCapacity: 12,
            robCapacity: 32,
            registerRead: registerRead
                ? { id: "register-read", names: ["Rr"], description: "Recorded read" }
                : undefined,
            executionNodes: [
                { id: "exec-integer", kind: "integer", names: ["X"], pipeCount: 2 },
                { id: "exec-fp", kind: "fp", names: ["X"], pipeCount: 2 }
            ]
        },
        ops: denseTrace.ops.slice(0, 4)
    };
    const replay = createReplay({ samples: [trace] }).loadTrace("local-file");
    replay.schedulers = [
        { id: "issue", offset: 0, capacity: 8 },
        { id: "issue-fp", offset: 8, capacity: 4 }
    ];
    for (const [index, op] of replay.ops.entries()) {
        op.issueSlot = index < 2 ? index : index + 6;
        if (index < 2) continue;
        op.kind = "fp";
        op.execution = "exec-fp";
        for (const stage of op.stages) {
            if (stage.node === "issue") stage.node = "issue-fp";
            if (stage.node === "exec-integer") stage.node = "exec-fp";
        }
    }
    replay.trace = { ...replay.trace, structure: { ...replay.trace.structure, queueCapacity: 12 } };
    replay.dependencyReplay = createDependencyReplay(replay.ops, undefined, 12);
    for (const style of Object.values(styles)) {
        const session = { style },
            scene = createScene({ replay, session });
        scene.buildLayout();
        const paths = createPaths({ scene, replay, session }),
            integer = scene.nodes.get("issue"),
            fp = scene.nodes.get("issue-fp");
        assert.ok(fp.z + fp.d / 2 + 0.5 < integer.z - integer.d / 2, "FP scheduler overlapped the integer bank");
        assert.match(fp.detail, /INFERRED PARTITION/, "The display partition was presented as recorded capacity");
        for (const scheduler of replay.schedulers) {
            const node = scene.nodes.get(scheduler.id);
            checkSpacing(
                Array.from({ length: scheduler.capacity }, (_, row) => scene.matrixPosition(scheduler.offset + row)),
                node,
                `${scheduler.id} seats`
            );
            for (const row of [scheduler.offset, scheduler.offset + scheduler.capacity - 1]) {
                assert.equal(scene.schedulerForRow(row).id, scheduler.id);
                assert.ok(
                    scene.crossesDependencyGrid(scene.matrixPosition(row, 0)),
                    "A scheduler grid was not protected"
                );
                for (const column of [0, 11]) {
                    const position = scene.matrixPosition(row, column);
                    assert.ok(Math.abs(position[0] - node.x) < node.w / 2);
                    assert.ok(Math.abs(position[2] - node.z) < node.d / 2);
                }
                assert.ok(scene.issueRowExit(row)[0] > node.x + node.w / 2);
                assert.ok(scene.wakeBusEntry(row)[2] < node.z - node.d / 2);
                assert.ok(scene.wakeColumnHead(11, row)[2] < node.z - node.d / 2);
            }
        }
        for (const op of replay.ops) {
            const stage = op.stages.find((stage) => stage.node.startsWith("issue")),
                time = stage.end - 0.001;
            assert.deepEqual(paths.positionAt(op, time), scene.matrixPosition(op.issueSlot));
            assert.equal(paths.instructionLight(op, time).state, "waiting");
            const issue = scene.issuePath({ id: op.id, slot: op.issueSlot, column: op.issueSlot });
            assert.deepEqual(issue.origin, scene.matrixPosition(op.issueSlot));
            assert.deepEqual(issue.exit, scene.issueRowExit(op.issueSlot));
            const scheduler = scene.schedulerForRow(op.issueSlot);
            assert.deepEqual(issue.signal.at(-1), scene.matrixPosition(scheduler.offset, op.issueSlot));
            for (const time of [op.issue - 0.001, op.issue, op.issue + 0.1, op.issue + 0.2, op.issue + 0.4])
                assert.ok(
                    paths.positionAt(op, time).every(Number.isFinite),
                    "An FP transfer produced invalid coordinates"
                );
        }
        assert.ok(scene.connections.some(({ from, to }) => from === "front-1" && to === "issue-fp"));
        assert.ok(
            scene.connections.some(
                ({ from, to }) => from === "issue-fp" && to === (registerRead ? "register-read" : "exec-fp")
            )
        );
        assert.ok(scene.connections.some(({ from, to }) => from === "exec-fp" && to === "rob"));
        const units = [...scene.nodes.values()].filter((node) => node.pipeCount);
        for (const [index, node] of units.entries())
            for (const other of units.slice(index + 1))
                assert.ok(
                    Math.abs(node.z - other.z) > (node.d + other.d) / 2,
                    "FP and integer execution units overlapped"
                );
        if (registerRead) {
            const fpPorts = scene.connections.find(
                ({ from, to }) => from === "issue-fp" && to === "register-read"
            ).lanes;
            assert.equal(fpPorts.length, 2, "FP scheduler connected to unrelated integer lanes");
            const fpUnit = scene.nodes.get("exec-fp"),
                lanePositions = Array.from(
                    { length: fpUnit.pipeCount },
                    (_, lane) => scene.executionLane(fpUnit, lane).inlet[2]
                );
            assert.deepEqual(
                fpPorts.map(({ target }) => target[2]),
                lanePositions
            );
        }
    }
}
console.log("FP/SIMD scene: separate schedulers, cross-bank dependency columns and execution routes passed");

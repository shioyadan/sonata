"use strict";
// 配置と経路は DOM / WebGL なしで準備でき、別の再生インスタンスを変更しない。
const assert = require("node:assert/strict"),
    fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm");
const { createReplay } = require("../src/replay-model.cts"),
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
function checkFrontendLayout(placement, replay) {
    const bounds = placement.layoutBounds();
    for (const node of placement.nodes.values()) {
        assert.ok(node.x - node.w / 2 >= bounds.left && node.x + node.w / 2 <= bounds.right);
        assert.ok(node.z - node.d / 2 >= bounds.back && node.z + node.d / 2 <= bounds.front);
    }
    for (const [index, descriptor] of replay.trace.structure.frontNodes.entries()) {
        const node = placement.nodes.get(descriptor.id),
            next = placement.nodes.get(replay.trace.structure.frontNodes[index + 1]?.id ?? "issue");
        assert.equal(node.instructionRows, replay.frontend.lanes, "A frontend stage changed fetch lanes");
        assert.equal(node.instructionSlots, node.instructionGroups * node.instructionRows);
        assert.ok(node.instructionGroups >= replay.frontend.stages.get(node.id).capacity);
        assert.ok(node.x + node.w / 2 < next.x - next.w / 2, "Expanded front units overlapped");
        const first = placement.frontInstructionPosition(node, 0, 0),
            last = placement.frontInstructionPosition(node, node.instructionGroups - 1, node.instructionRows - 1);
        for (const position of [first, last]) {
            assert.ok(Math.abs(position[0] - node.x) + 0.12 <= node.w / 2 + 1e-9);
            assert.ok(Math.abs(position[2] - node.z) + 0.12 <= node.d / 2 + 1e-9);
        }
        assert.ok(first[0] >= last[0], "Younger fetch groups were nearer the frontend exit");
        assert.ok(first[2] <= last[2], "Instruction lanes reversed program order");
        if (node.instructionGroups > 1)
            assert.ok(
                first[0] - placement.frontInstructionPosition(node, 1, 0)[0] >= 0.32 - 1e-9,
                "Fetch groups overlapped in X"
            );
        if (node.instructionRows > 1)
            assert.ok(
                placement.frontInstructionPosition(node, 0, 1)[2] - first[2] >= 0.38 - 1e-9,
                "Fetch lanes overlapped in Z"
            );
    }
    const firstNode = placement.nodes.get(replay.trace.structure.frontNodes[0].id);
    assert.ok(placement.inputPosition()[0] < firstNode.x - firstNode.w / 2, "Input moved inside the frontend");
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
    checkFrontendLayout(first.placement, first.replay);
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
for (const op of denseReplay.ops) {
    const admission = denseReplay.frontend.admission(op.id);
    if (admission.start > op.fetch)
        assert.equal(densePaths.positionAt(op, op.fetch), null, "A full Fetch stage admitted an instruction early");
    if (admission.start >= admission.end) continue;
    const entry = densePaths.positionAt(op, admission.start);
    assert.ok(entry[0] < denseScene.nodes.get("front-0").x - denseScene.nodes.get("front-0").w / 2);
    assert.ok(
        entry[0] <= denseScene.inputPosition()[0] + 0.1 && entry[0] >= denseScene.inputPosition()[0] - 0.9,
        "Fetch entry escaped the fixed input span"
    );
}
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
    const positions = denseReplay.ops.map((op) => densePaths.positionAt(op, time)).filter(Boolean);
    const expected = node === denseReplay.frontend.fetchNode ? 4 * 16 : 1200;
    assert.equal(positions.length, expected, `${node}: visible instruction count differs`);
    if (node === denseReplay.frontend.fetchNode)
        assert.equal(denseReplay.frontend.pending(time).length, 1200 - expected, "Overflow was not held upstream");
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
checkFrontendLayout(denseScene, denseReplay);
const positions = denseReplay.ops.map((op) => densePaths.positionAt(op, 95)),
    seats = denseReplay.ops.map((op) => denseReplay.frontend.position(op.id, "front-1", 95));
for (let index = 0; index < positions.length - 1; index++) {
    const current = positions[index],
        next = positions[index + 1];
    if (denseReplay.ops[index].fetch === denseReplay.ops[index + 1].fetch) {
        assert.equal(current[0], next[0], "Same-fetch instructions were split across rows");
        assert.ok(current[2] < next[2], "Same-fetch instructions reversed program order");
    } else assert.ok(current[0] > next[0], "Fetch groups reversed age order");
}
denseSource.loadData({ ...denseTrace, firstCycle: 90, lastCycle: 218 }, { continuityAt: 95 });
denseScene.buildLayout(true);
assert.deepEqual(
    denseReplay.ops.map((op) => denseReplay.frontend.position(op.id, "front-1", 95)),
    seats,
    "Window continuity reassigned fetch groups"
);
assert.deepEqual(
    denseReplay.ops.map((op) => densePaths.positionAt(op, 95)),
    positions,
    "Window continuity moved frontend instructions"
);
const frontendBounds = () =>
    denseTrace.structure.frontNodes.map(({ id }) => {
        const node = denseScene.nodes.get(id);
        return [node.x, node.w, node.d, node.instructionRows, node.instructionGroups];
    });
const expandedFrontend = frontendBounds();
denseSource.loadData({ ...denseTrace, ops: denseTrace.ops.slice(-16) }, { continuityAt: 95 });
denseScene.buildLayout(true);
assert.deepEqual(frontendBounds(), expandedFrontend, "A smaller window shrank the fetch-group layout");
console.log("Dense scene: 1200 simultaneous instructions, 2048 ROB entries and 16 lanes passed");

// Fの待機束が増える区間へ移っても、本体や入力位置を変えない。
const shortFetchTrace = {
    ...denseTrace,
    ops: denseTrace.ops.map((entry) => {
        const op = structuredClone(entry);
        op[6][0][3] = op[2] + 0.8;
        op[6][1][2] = op[2] + 0.8;
        return op;
    })
};
const fixedSource = createReplay({ samples: [shortFetchTrace] }),
    fixedReplay = fixedSource.loadTrace("local-file"),
    fixedScene = createScene({ replay: fixedReplay, session: denseSession });
fixedScene.buildLayout();
const bodies = () => [...fixedScene.nodes.values()].map(({ id, x, z, w, d, h }) => ({ id, x, z, w, d, h }));
const beforeBodies = bodies(),
    beforeInput = fixedScene.inputPosition(),
    beforeBounds = fixedScene.layoutBounds();
fixedSource.loadData(denseTrace, { continuityAt: 85 });
fixedScene.buildLayout(true);
assert.deepEqual(bodies(), beforeBodies, "Extra Fetch waiting resized or moved a pipeline body");
assert.deepEqual(fixedScene.inputPosition(), beforeInput, "Extra Fetch waiting moved the input stream");
assert.deepEqual(fixedScene.layoutBounds(), beforeBounds, "Extra Fetch waiting changed the camera bounds");
assert.equal(fixedScene.nodes.has("fetch-queue"), false, "Overflow created another growing platform");
assert.equal(fixedScene.nodes.get("front-0").instructionGroups, 4);
checkFrontendLayout(fixedScene, fixedReplay);
const fixedFetchWidth = fixedScene.nodes.get("front-0").w;
fixedSource.loadData({
    ...denseTrace,
    structure: {
        ...denseTrace.structure,
        frontNodes: [
            ...denseTrace.structure.frontNodes,
            { id: "front-2", names: ["Rn"] },
            { id: "front-3", names: ["Ds"] }
        ]
    }
});
fixedScene.buildLayout(true);
assert.equal(fixedScene.nodes.get("front-0").w, fixedFetchWidth, "Observed new stages resized the Fetch body");
console.log("Fixed Fetch: waiting growth preserved stage bodies, input and camera bounds");

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

// 全種類を同じ待機列へ置き、INT / BR 共有ユニットと FP 専用ユニットへ流す。
for (const registerRead of [false, true]) {
    const labels = ["add x0, x1, x2", "b.eq 0x1000", "fadd d0, d1, d2", "vaddps ymm0, ymm1, ymm2"];
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
                { id: "exec-branch", kind: "branch", names: ["X"], pipeCount: 1 },
                { id: "exec-fp", kind: "fp", names: ["X"], pipeCount: 2 }
            ]
        },
        ops: denseTrace.ops.slice(0, labels.length).map((op, index) => {
            const copy = structuredClone(op);
            copy[5] = labels[index];
            return copy;
        })
    };
    const replay = createReplay({ samples: [trace] }).loadTrace("local-file");
    assert.deepEqual(
        replay.ops.map((op) => op.kind),
        ["integer", "branch", "fp", "fp"]
    );
    assert.equal(new Set(replay.ops.map((op) => op.issueSlot)).size, 4, "Mixed instructions shared a waiting slot");
    for (const style of Object.values(styles)) {
        const session = { style },
            scene = createScene({ replay, session });
        scene.buildLayout();
        const paths = createPaths({ scene, replay, session }),
            scheduler = scene.nodes.get("issue"),
            integer = scene.nodes.get("exec-integer"),
            fp = scene.nodes.get("exec-fp");
        assert.equal(scene.nodes.has("issue-fp"), false, "FP retained a separate scheduler");
        assert.equal(scene.nodes.has("exec-branch"), false, "Branch retained a separate execution unit");
        assert.equal(scheduler.label, "SCHEDULER");
        assert.equal(integer.label, "INT / BR");
        assert.equal(integer.pipeCount, 3, "The shared INT / BR unit lost branch bandwidth");
        assert.equal(fp.pipeCount, 2);
        checkSpacing(
            Array.from({ length: 12 }, (_, row) => scene.matrixPosition(row)),
            scheduler,
            "unified scheduler seats"
        );
        for (const row of [0, 11]) {
            assert.ok(
                scene.crossesDependencyGrid(scene.matrixPosition(row, 0)),
                "The scheduler grid was not protected"
            );
            for (const column of [0, 11]) {
                const position = scene.matrixPosition(row, column);
                assert.ok(Math.abs(position[0] - scheduler.x) < scheduler.w / 2);
                assert.ok(Math.abs(position[2] - scheduler.z) < scheduler.d / 2);
            }
            assert.ok(scene.issueRowExit(row)[0] > scheduler.x + scheduler.w / 2);
        }
        assert.ok(scene.wakeBusEntry()[2] < scheduler.z - scheduler.d / 2);
        assert.ok(scene.wakeColumnHead(11)[2] < scheduler.z - scheduler.d / 2);
        for (const op of replay.ops) {
            const stage = op.stages.find((stage) => stage.node === "issue"),
                time = stage.end - 0.001;
            assert.deepEqual(paths.positionAt(op, time), scene.matrixPosition(op.issueSlot));
            assert.equal(paths.instructionLight(op, time).state, "waiting");
            assert.equal(op.execution, op.kind === "fp" ? "exec-fp" : "exec-integer");
            const issue = scene.issuePath({ id: op.id, slot: op.issueSlot, column: op.issueSlot });
            assert.deepEqual(issue.origin, scene.matrixPosition(op.issueSlot));
            assert.deepEqual(issue.exit, scene.issueRowExit(op.issueSlot));
            assert.deepEqual(issue.signal.at(-1), scene.matrixPosition(0, op.issueSlot));
            const unit = scene.nodes.get(op.execution),
                lane = scene.executionLane(unit, (op.pipeLane ?? op.index) % unit.pipeCount);
            assert.equal(issue.port[2], lane.inlet[2], "An issue selected another execution lane");
            for (const time of [op.issue - 0.001, op.issue, op.issue + 0.1, op.issue + 0.2, op.issue + 0.4])
                assert.ok(
                    paths.positionAt(op, time).every(Number.isFinite),
                    "A mixed transfer produced invalid coordinates"
                );
        }
        assert.deepEqual(
            scene.connections.filter(({ from }) => from === "front-1").map(({ to }) => to),
            ["issue"]
        );
        for (const unit of [integer, fp]) {
            assert.ok(
                scene.connections.some(
                    ({ from, to }) => from === (registerRead ? "register-read" : "issue") && to === unit.id
                )
            );
            assert.ok(scene.connections.some(({ from, to }) => from === unit.id && to === "rob"));
        }
        assert.ok(
            Math.abs(integer.z + integer.d / 2 + 0.4 - (fp.z - fp.d / 2)) < 1e-9,
            "The former BR unit left an empty gap"
        );
        assert.ok(Math.abs(integer.z - integer.d / 2 + fp.z + fp.d / 2) < 1e-9, "Execution units were not centered");
        if (registerRead) {
            const ports = scene.connections.find(({ from, to }) => from === "issue" && to === "register-read").lanes;
            assert.equal(ports.length, 5, "The unified scheduler lost execution lanes");
            const lanePositions = [integer, fp].flatMap((unit) =>
                Array.from({ length: unit.pipeCount }, (_, lane) => scene.executionLane(unit, lane).inlet[2])
            );
            assert.deepEqual(
                ports.map(({ target }) => target[2]),
                lanePositions
            );
        }
    }
}
console.log("Unified scene: shared scheduler, INT / BR unit, FP/SIMD routes and wake-up positions passed");

// 再実行で別の管路を使っても、読み出し・接続・実行位置を同じ段の割当へ揃える。
const retryTrace = {
    ...denseTrace,
    lastCycle: 25,
    structure: {
        ...denseTrace.structure,
        queueCapacity: 16,
        robCapacity: 32,
        registerRead: { id: "register-read", names: ["Rr"], description: "Recorded read" },
        executionNodes: [
            { id: "exec-integer", kind: "integer", names: ["X"], pipeCount: 1 },
            { id: "exec-branch", kind: "branch", names: ["B"], pipeCount: 1 }
        ]
    },
    ops: [5, 7, 9, 10].map((start, id) => [
        id,
        id,
        0,
        25,
        0,
        id === 3 ? "b.eq 0x100" : "add x0, x1, x2",
        [
            ["F", "front-0", 0, 1],
            ["Q", "issue", 1, start - 1],
            ["Rr", "register-read", start - 1, start],
            ["X", "exec-integer", start, start + 1],
            ...(id === 0
                ? [
                      ["Q", "issue", 6, 9],
                      ["Rr", "register-read", 9, 10],
                      ["X", "exec-integer", 10, 11]
                  ]
                : []),
            ["W", "rob", id === 0 ? 11 : start + 1, 25]
        ],
        1,
        start,
        id === 0 ? 11 : start + 1,
        "exec-integer"
    ])
};
const retryReplay = createReplay({ samples: [] }).loadData(retryTrace);
const repeated = retryReplay.ops[0];
const retryStage = repeated.stages.find((stage) => stage.node === "exec-integer" && stage.start === 10);
assert.notEqual(retryStage.pipeLane, repeated.pipeLane, "Retry fixture did not exercise another pipe");
for (const style of Object.values(styles)) {
    const session = { style },
        scene = createScene({ replay: retryReplay, session });
    scene.buildLayout();
    const paths = createPaths({ scene, replay: retryReplay, session });
    const lane = scene.executionLane(scene.nodes.get("exec-integer"), retryStage.pipeLane);
    assert.equal(paths.positionAt(repeated, 9.9)[2], lane.inlet[2], "Read selected the first attempt's lane");
    assert.equal(paths.positionAt(repeated, 10.5)[2], lane.inlet[2], "Retry selected the first attempt's lane");
    assert.equal(scene.registerReadPort(repeated, 9.5)[2], lane.inlet[2]);
    assert.notEqual(paths.positionAt(repeated, 10.5)[2], paths.positionAt(retryReplay.ops[3], 10.5)[2]);
    const robPort = scene.connections.find(({ from, to }) => from === "exec-integer" && to === "rob").lanes[
        retryStage.pipeLane
    ].target;
    const passedPort = paths.positionAt(repeated, 11 + 0.82 * 0.7);
    assert.ok(
        Math.hypot(...passedPort.map((value, axis) => value - robPort[axis])) < 1e-9,
        "Retry entered ROB through another pipe's port"
    );
    for (const time of [9, 9.5, 9.99, 10, 10.05, 10.2, 10.5, 11, 11.1]) {
        assert.ok(paths.positionAt(repeated, time).every(Number.isFinite), "Retry transfer is invalid");
    }
}
console.log("INT / BR retries: stage lanes, read ports and paths passed in all styles");

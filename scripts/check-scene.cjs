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
const first = createFixture(),
    second = createFixture();
let instructions = 0;
for (const [index, sample] of samples.entries()) {
    first.load(sample.key);
    second.load(sample.key);
    assert.equal(first.replay.ops.length, sample.ops.length);
    assert.ok(first.placement.nodes.size > 0);
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
    first.session.style = styles.blocks;
    first.load(samples[(index + 1) % samples.length].key);
    snapshot(first);
    assert.equal(snapshot(second), expected, "Loading another scene changed an existing scene");
    first.session.style = styles.neon;
    first.load(sample.key);
    assert.equal(snapshot(first), expected, "Reloading a trace changed its layout or paths");
    instructions += sample.ops.length;
}
assert.equal(JSON.stringify(samples), original, "Preparing a scene changed the embedded traces");
console.log(`Scene isolation: ${samples.length} demos and ${instructions} instructions passed without DOM / WebGL`);

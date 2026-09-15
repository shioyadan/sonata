"use strict";
// Coreの分類と有界な再生窓を比較し、未来の結果・巨大なcycle・欠落文脈を検査する。
const assert = require("node:assert/strict");
const { buildTopDownWindow, recoveryModel, limits } = require("../src/top-down.cts");
const { sampleTopDown } = require("../src/replay-model.cts");
const {
    buildCycleNavigatorData,
    getCycleNavigatorTopDown
} = require("../vendor/konata-core/trace_navigator_analysis.ts");
function operation(id, stages, options = {}) {
    return {
        id,
        gid: id,
        rid: id,
        tid: 0,
        retired: true,
        flush: false,
        eof: false,
        fetchedCycle: stages[0][1],
        retiredCycle: stages.at(-1)[2],
        labelName: "add x0, x1, x2",
        labelDetail: "",
        prods: [],
        prodCycle: -1,
        consCycle: -1,
        line: id + 1,
        lanes: [
            {
                level: stages.length,
                stages: stages.map(([name, startCycle, endCycle]) => ({ name, startCycle, endCycle, labels: "" }))
            }
        ],
        ...options
    };
}
function fixture() {
    const ops = [];
    for (let block = 0; block < 12; block++) {
        const base = block * 30;
        for (let local = 0; local < 4; local++) {
            const allocation = base + local + 1;
            const issue = base + [8, 5, 7, 6][local];
            const complete = base + [10, 6, 9, 7][local];
            const end = base + local + 12;
            ops.push(
                operation(
                    ops.length,
                    [
                        ["F", base + local * 0.25, allocation],
                        ["Sc", allocation, issue],
                        ["X", issue, complete],
                        ["Rw", complete, end - 1],
                        ["Cm", end - 1, end]
                    ],
                    local === 3 ? { labelName: "0x10: bne x0, x1" } : {}
                )
            );
        }
        ops.push(
            operation(
                ops.length,
                [
                    ["F", base + 1, base + 5],
                    ["Sc", base + 5, base + 8]
                ],
                { retired: false, flush: true }
            )
        );
        ops.push(
            operation(ops.length, [
                ["F", base + 13, base + 14],
                ["Sc", base + 14, base + 16],
                ["X", base + 16, base + 18],
                ["Rw", base + 18, base + 19],
                ["Cm", base + 19, base + 20]
            ])
        );
    }
    return ops;
}
function trace(ops) {
    return {
        lastCycle: Math.max(...ops.map((op) => op.retiredCycle)),
        lastID: ops.length - 1,
        stageLevelMap: { laneNum: 1, getLaneName: () => "main" },
        getOpForScan: (id) => ops[id]
    };
}
async function main() {
    const ops = fixture();
    const original = JSON.stringify(ops);
    const core = await buildCycleNavigatorData(trace(ops), { binCycleCount: 1 });
    assert.ok(core.topDown, "Fixture did not expose the Core's scheduling structure");
    const structure = core.topDown.structure;
    const recovery = recoveryModel(ops, structure);
    assert.deepEqual(recovery, {
        minimumCycles: core.topDown.minimumRecoveryCycles,
        sampleCount: core.topDown.minimumRecoverySampleCount
    });
    assert.ok(recovery && recovery.sampleCount >= 10);
    const window = buildTopDownWindow({ ops, firstCycle: 200, lastCycle: 280, structure, recovery });
    for (let cycle = window.firstCycle; cycle <= 280; cycle++) {
        const expected = getCycleNavigatorTopDown(core, cycle, cycle + 1);
        assert.deepEqual(
            window.slots[cycle - window.firstCycle],
            [
                expected.retiringSlots,
                expected.squashedSlots,
                expected.recoveryBubbleSlots,
                expected.frontendBound,
                expected.backendBound,
                expected.unresolvedSlots
            ],
            `Core classification differs at ${cycle}`
        );
    }
    for (const [allocation, observed, outcome] of window.observationTimes.outcomes) {
        if (observed <= allocation || allocation < 200) continue;
        const time = Math.min(observed - 0.01, allocation + 0.5);
        const before = sampleTopDown(window, time);
        assert.ok(before.available);
        const allDelayed = {
            ...window,
            observationTimes: {
                ...window.observationTimes,
                outcomes: window.observationTimes.outcomes.map(([at, notice, category]) => [
                    at,
                    notice > time ? notice + 1000 : notice,
                    category
                ])
            }
        };
        assert.deepEqual(
            sampleTopDown(allDelayed, time),
            before,
            `Future ${outcome ? "squash" : "commit"} changed the current display`
        );
    }
    assert.equal(sampleTopDown(window, 217.5).shares.badSpeculation, 0, "Recovery appeared before its squash notice");
    assert.ok(sampleTopDown(window, 218).shares.badSpeculation > 0, "An observed squash did not classify wasted work");
    assert.equal(
        sampleTopDown(window, 217.5).shares.badSpeculation,
        0,
        "Backward seek retained a later squash outcome"
    );
    const offset = 2 ** 40;
    const shifted = ops.map((op) => ({
        ...op,
        fetchedCycle: op.fetchedCycle + offset,
        retiredCycle: op.retiredCycle + offset,
        lanes: op.lanes.map((lane) => ({
            ...lane,
            stages: lane.stages.map((stage) => ({
                ...stage,
                startCycle: stage.startCycle + offset,
                endCycle: stage.endCycle + offset
            }))
        }))
    }));
    const far = buildTopDownWindow({
        ops: shifted,
        firstCycle: 200 + offset,
        lastCycle: 280 + offset,
        structure,
        recovery
    });
    assert.deepEqual(far.slots, window.slots, "Absolute cycles changed the bounded classification");
    assert.equal(far.slots.length, 89);
    assert.deepEqual(
        far.observationTimes.outcomes.map(([at, notice, category]) => [at - offset, notice - offset, category]),
        window.observationTimes.outcomes
    );
    const farMaximum = buildTopDownWindow({
        ops: shifted,
        firstCycle: offset,
        lastCycle: offset + 511,
        structure,
        recovery
    });
    assert.equal(farMaximum.slots.length, limits.cycles + limits.history);
    const fragmented = ops.filter((op) => op.id % 6 !== 4);
    assert.equal(recoveryModel(fragmented, structure), null, "Noncontiguous context invented branch recovery");
    const unknown = buildTopDownWindow({ ops, firstCycle: 0, lastCycle: 10, structure: null });
    assert.equal(unknown, null);
    const unfinished = [{ ...ops[0], retired: false, eof: true }];
    const partial = buildTopDownWindow({ ops: unfinished, firstCycle: 0, lastCycle: 10, structure, recovery: null });
    assert.deepEqual(partial.observationTimes.outcomes, [], "EOF became an observed retirement");
    assert.equal(partial.slots[1][5], 1);
    const observedFlush = buildTopDownWindow({
        ops,
        firstCycle: 190,
        lastCycle: 210,
        structure,
        endCycle: (op) => op.retiredCycle + (op.flush ? 4 : 0)
    });
    for (const [allocation, notice, outcome] of observedFlush.observationTimes.outcomes)
        if (outcome === 1)
            assert.ok(
                ops.some(
                    (op) =>
                        op.flush &&
                        Math.floor(structure.observe(op).allocationCycle) === allocation &&
                        notice === op.retiredCycle + 4
                )
            );
    assert.equal(
        buildTopDownWindow({ ops: Array(limits.operations + 1).fill(ops[0]), firstCycle: 0, lastCycle: 10, structure }),
        null
    );
    assert.equal(
        buildTopDownWindow({
            ops,
            firstCycle: 0,
            lastCycle: 10,
            structure: { ...structure, allocationStage: { ...structure.allocationStage, width: 1000 } }
        }),
        null
    );
    assert.throws(() => buildTopDownWindow({ ops, firstCycle: 0, lastCycle: 512, structure }), /at most 512/);
    assert.equal(JSON.stringify(ops), original, "Top-down mutated the parser records");
    console.log(
        "Top-down: Core equivalence, 8-cycle history, outcomes, recovery evidence, EOF, sparse context and large absolute cycles passed"
    );
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

"use strict";
const assert = require("node:assert/strict");
const {
    createRobReplay,
    memoryCompletions,
    createFeedReplay,
    codeRewindDuration,
    sampleTopDown,
    flushPlaybackRate,
    advancePlayback,
    createEmptyPlayback,
    createWaitPlayback,
    measureTransfers,
    createDependencyReplay,
    createRegisterReplay,
    findRecoveryBranches
} = require("../src/replay-model.cts");

const matrix = createDependencyReplay(
    [
        { id: 10, allocation: 0, issue: 4, end: 8, issueSlot: 3 },
        { id: 11, allocation: 1, issue: 6, end: 9, issueSlot: 0 },
        { id: 12, allocation: 2, issue: 5, end: 9, issueSlot: 1 },
        { id: 13, allocation: 2, issue: null, end: 4, issueSlot: 2 },
        { id: 14, allocation: 4, issue: 7, end: 9, issueSlot: 3 }
    ],
    {
        kind: "recorded",
        ops: [
            { id: 10, dependencies: [] },
            { id: 14, dependencies: [] },
            { id: 11, dependencies: [{ id: 10, ready: 4 }] },
            { id: 12, dependencies: [{ id: 10, ready: 4 }] },
            { id: 13, dependencies: [{ id: 9, ready: null }] }
        ]
    },
    4
);
const waiting = matrix.stateAt(3);
assert.equal(waiting.rowCount, 4);
assert.equal(waiting.columnCount, 4);
assert.equal(waiting.rows.length, 4);
assert.equal(waiting.cells.length, 2);
assert.equal(waiting.external.length, 1);
assert.equal(waiting.cells[0].column, 3);
assert.equal(waiting.cells[1].column, 3);
assert.ok(waiting.rows.filter((r) => r.id !== 10).every((r) => !r.ready));
const wake = matrix.stateAt(4.2);
assert.equal(wake.rows.length, 3);
assert.ok(wake.rows.every((r) => r.ready));
assert.equal(wake.cells.length, 0, "Reused producer slot must not receive the old dependency");
assert.equal(wake.external.length, 2);
assert.ok(wake.external.every((c) => !c.waiting && c.alpha > 0));
assert.equal(wake.broadcasts.length, 1);
assert.equal(wake.broadcasts[0].column, null);
assert.equal(wake.issues[0].id, 10);
assert.equal(wake.issues[0].column, null, "Issue pulse must not select a reused column");
assert.equal(matrix.stateAt(5.2).issues[0].id, 12);
assert.equal(matrix.stateAt(4.95).external.length, 0);
assert.equal(matrix.stateAt(7).rows.length, 0);
assert.deepEqual(matrix.stateAt(3), waiting, "Matrix replay depends on seek direction");

const registers = createRegisterReplay({
    rows: [1],
    initial: {
        mapping: [[1, 1]],
        values: [[1, "0x10"]],
        owners: [
            [1, 10],
            [3, -4]
        ]
    },
    allocation: {
        initial: [[1, "allocated"]],
        events: [
            { cycle: 1, physical: 2, state: "allocated", reason: "rename" },
            { cycle: 4.5, physical: 2, state: "free", reason: "squash reclamation" },
            { cycle: 5, physical: 2, state: "allocated", reason: "rename" },
            { cycle: 8, physical: 1, state: "free", reason: "commit" }
        ]
    },
    events: [
        { type: "rename", cycle: 1, id: 11, logical: 1, physical: 2, previous: 1 },
        { type: "write", cycle: 2, id: 10, logical: 1, physical: 1, hex: "0x20" },
        { type: "write", cycle: 3, id: 11, logical: 1, physical: 2, hex: "0x30" },
        { type: "restore", cycle: 4, id: 11, logical: 1, physical: 2, previous: 1 },
        { type: "rename", cycle: 5, id: 12, logical: 1, physical: 2, previous: 1 },
        { type: "write", cycle: 6, id: 11, logical: 1, physical: 2, hex: "0xbad" },
        { type: "write", cycle: 7, id: 12, logical: 1, physical: 2, hex: "0x40" }
    ]
});
assert.equal(registers.stateAt(0).rows[0].value, "0x10");
assert.equal(registers.stateAt(2).rows[0].value, null, "An older physical write contaminated a newer mapping");
assert.equal(
    registers.stateAt(2).physical.find((p) => p.physical === 1).value,
    "0x20",
    "A physical value must survive after the RAT selects a newer version"
);
assert.equal(registers.stateAt(3).rows[0].value, "0x30");
assert.equal(registers.stateAt(4).rows[0].physical, 1);
assert.equal(registers.stateAt(4).rows[0].value, "0x20");
assert.equal(registers.stateAt(6).rows[0].value, null, "A stale write corrupted a reused physical register");
assert.equal(registers.stateAt(6).physical.find((p) => p.physical === 2).value, null);
assert.equal(registers.stateAt(7).rows[0].value, "0x40");
assert.equal(registers.stateAt(2).rows[0].value, null);
const allocation = (time, p) => registers.stateAt(time).physical.find((c) => c.physical === p).allocation;
assert.equal(allocation(2, 1), "allocated", "An older version must stay allocated after the RAT switches");
assert.equal(allocation(4.2, 2), "allocated", "RAT rollback must not anticipate delayed squash reclamation");
assert.equal(allocation(4.8, 2), "free");
assert.equal(allocation(5, 2), "allocated");
assert.equal(allocation(7, 1), "allocated");
assert.equal(allocation(8, 1), "free");
assert.equal(allocation(8, 3), "unknown", "An unobserved register must not be advertised as free");
assert.deepEqual(registers.stateAt(4.8).allocationCounts, { allocated: 1, free: 1, unknown: 1 });
const allocationSnapshot = registers.stateAt(4.8);
registers.stateAt(8);
assert.deepEqual(registers.stateAt(4.8), allocationSnapshot);
assert.equal(createRegisterReplay(null).stateAt(4).available, false);

// 従来の 4 サイクル境界でも、スローモーションから連続的に復帰することを確認する。
for (const boundary of [-0.8, 0, 2.8, 4, 5.4]) {
    assert.ok(Math.abs(flushPlaybackRate(boundary - 0.0001, [0]) - flushPlaybackRate(boundary + 0.0001, [0])) < 0.0001);
}
let lastRate = 0.27;
for (let t = 2.8; t <= 5.5; t += 0.01) {
    const rate = flushPlaybackRate(t, [0]);
    assert.ok(rate >= lastRate - 1e-12 && rate <= 1);
    lastRate = rate;
}
assert.equal(flushPlaybackRate(2, [0]), 0.27);
assert.equal(flushPlaybackRate(5.5, [0]), 1);
assert.equal(flushPlaybackRate(2, [0], { reducedMotion: true }), 1);
assert.equal(flushPlaybackRate(4, [0, 3]), 0.27, "A second flush must retain slow motion");
const integrate = (step) => {
    let t = 2.6;
    for (let elapsed = 0; elapsed < 1.5 - 1e-8; elapsed += step)
        t = advancePlayback(t, Math.min(step, 1.5 - elapsed), 4, [0]);
    return t;
};
assert.ok(Math.abs(integrate(1 / 15) - integrate(1 / 120)) < 0.002, "Recovery speed depends on frame rate");
for (const speed of [1, 4, 16]) {
    const t = advancePlayback(-0.001, 0.075, speed, [0]);
    assert.ok(t > 0 && t < 0.9, "Playback skipped the visible beginning of a flush");
}

// 空白の短縮は命令の移動量によらず、全生存期間と記録イベントを保護する。
const emptyOp = (id, fetch, end, { flush = false, flushCycle = null, unfinished = false } = {}) => [
    id,
    id,
    fetch,
    end,
    +flush,
    `op ${id}`,
    [],
    null,
    null,
    null,
    "exec-integer",
    flushCycle,
    unfinished
];
const emptyTrace = (ops, extra = {}) => ({
    key: "local-file",
    firstCycle: 0,
    lastCycle: 200,
    ops,
    demo: {},
    ...extra
});
const spacedOps = emptyTrace([emptyOp(1, 10, 20), emptyOp(2, 100, 110)]),
    originalSpacedOps = structuredClone(spacedOps),
    emptyPlayback = createEmptyPlayback(spacedOps);
assert.equal(emptyPlayback(8), null, "The fetch lead-in must play normally");
assert.equal(emptyPlayback(25.999), null, "Commit animation must finish before skipping");
assert.equal(emptyPlayback(26), 98, "An empty gap must stop two cycles before fetch");
assert.equal(emptyPlayback(82), 98, "Exactly sixteen remaining cycles can be skipped");
assert.equal(emptyPlayback(82.001), null, "A short remaining gap must play normally after seeking");
assert.equal(emptyPlayback(98), null, "The skip destination must not skip again");
assert.equal(emptyPlayback(116), 200);
assert.equal(emptyPlayback(200), null);
assert.equal(emptyPlayback(-1), null);
assert.equal(emptyPlayback(NaN), null);
assert.deepEqual(spacedOps, originalSpacedOps, "Empty playback must preserve recorded instructions and times");
assert.equal(emptyPlayback(26), 98, "Seeking backwards must not alter the empty intervals");

const overlapping = createEmptyPlayback(
    emptyTrace([emptyOp(3, 20, 25), emptyOp(2, 30, 60), emptyOp(1, 10, 40), emptyOp(4, 100, 110)])
);
assert.equal(overlapping(46), null, "One completed instruction does not make overlapping lifetimes empty");
assert.equal(overlapping(66), 98);
const waitingPlayback = createEmptyPlayback(emptyTrace([emptyOp(1, 0, 1000)], { lastCycle: 1200 }));
assert.equal(waitingPlayback(100), null, "A long wait is still an active instruction");
assert.equal(waitingPlayback(1005.999), null);
assert.equal(waitingPlayback(1006), 1200);
const carryIn = createEmptyPlayback(emptyTrace([emptyOp(1, 0, 400)], { firstCycle: 200, lastCycle: 250 }));
assert.equal(carryIn(200), null, "Carry-in lifetimes must not be clipped to the displayed window");

const preview = [{ id: 2, fetch: 1_000_000_000, label: "future", kind: "integer" }];
assert.equal(
    createEmptyPlayback(emptyTrace([emptyOp(1, 0, 20, { unfinished: true })], { feedPreview: preview }))(100),
    null,
    "An unfinished instruction must block skipping even beyond the current window"
);
const deferredFlush = createEmptyPlayback(
    emptyTrace([emptyOp(1, 0, 10, { flush: true, flushCycle: 40 }), emptyOp(2, 100, 110)])
);
assert.equal(deferredFlush(16), null, "The effective squash cycle overrides the retired tuple field");
assert.equal(deferredFlush(45.999), null, "Squash recovery must retain its full six-cycle margin");
assert.equal(deferredFlush(46), 98);
assert.equal(
    createEmptyPlayback(emptyTrace([emptyOp(1, 0, 40, { flush: true, flushCycle: 0 })]))(6),
    200,
    "A recorded squash at cycle zero is not a missing timestamp"
);
assert.equal(
    createEmptyPlayback(emptyTrace([emptyOp(1, 0, 10), emptyOp(2, 30, 40)]))(16),
    null,
    "A short empty interval must retain normal playback"
);

const boundaryWindow = { firstCycle: 16, lastCycle: 32, feedPreview: preview };
assert.equal(createEmptyPlayback(emptyTrace([emptyOp(1, 0, 10)], boundaryWindow))(16), 999_999_998);
assert.equal(
    createEmptyPlayback(emptyTrace([], boundaryWindow))(16),
    999_999_998,
    "A completed instruction leaving the six-cycle context must not change the safe gap boundary"
);
assert.equal(createEmptyPlayback(emptyTrace([], { firstCycle: 16, lastCycle: 32 }))(16), 32);
assert.equal(
    createEmptyPlayback(emptyTrace([], { firstCycle: 16, lastCycle: 32, feedPreview: [] }))(32),
    null,
    "An absent preview does not prove that the next window is empty"
);
assert.equal(createEmptyPlayback(emptyTrace([], { emptyTailUntil: 1_000_000_000 }))(16), 1_000_000_000);
assert.equal(
    createEmptyPlayback(emptyTrace([], { feedPreview: preview, emptyTailUntil: 1_000_000_000 }))(16),
    999_999_998,
    "The next fetch margin also applies to a confirmed empty tail"
);

const pendingStore = createEmptyPlayback(
    emptyTrace([emptyOp(1, 0, 10)], { storeCompletions: [[1, 100]], feedPreview: preview })
);
assert.equal(pendingStore(16), null, "A recorded store completion extends the instruction's pending lifetime");
assert.equal(pendingStore(100), null);
assert.equal(pendingStore(106), 999_999_998);
const orphanStore = createEmptyPlayback(emptyTrace([], { storeCompletions: [[1, 100]], feedPreview: preview }));
assert.equal(orphanStore(0), 98, "A recorded completion without a visible instruction is still an event");
assert.equal(orphanStore(100), null);
assert.equal(orphanStore(106), 999_999_998);
const recordedEvent = createEmptyPlayback(
    emptyTrace([], { demo: { events: [{ kind: "icache-miss", cycle: 50, endCycle: 70, id: 1 }] } })
);
assert.equal(recordedEvent(0), 48);
assert.equal(recordedEvent(60), null);
assert.equal(recordedEvent(76), 200);
const registerEvent = createEmptyPlayback(
    emptyTrace([], { evidence: { registers: { events: [{ cycle: 40 }], reads: [{ cycle: 80 }] } } })
);
assert.equal(registerEvent(0), 38);
assert.equal(registerEvent(40), null);
assert.equal(registerEvent(46), 78);
assert.equal(registerEvent(80), null);
console.log("empty playback: lifetimes, observed events, animation margins and confirmed gap boundaries");

// 生存中でも静止した待機は加速できるが、移動と記録された状態変化を跨がない。
const waitOp = (id, fetch, end, stages = [["F", "front-0", fetch, end]], options) => {
    const op = emptyOp(id, fetch, end, options);
    op[6] = stages;
    return op;
};
const initialWait = emptyTrace([waitOp(1, 0, 111), emptyOp(2, 108, 125)]),
    originalInitialWait = structuredClone(initialWait),
    waitPlayback = createWaitPlayback(initialWait);
assert.equal(waitPlayback(5.999), null, "The initial fetch and entry animation must play normally");
assert.equal(waitPlayback(6), 106, "A long initial fetch wait must stop before the next instruction fetch");
assert.equal(waitPlayback(90), 106);
assert.equal(waitPlayback(90.001), null, "The remaining wait must still be at least sixteen cycles");
assert.equal(waitPlayback(106), null);
assert.equal(waitPlayback(130), null, "Wait acceleration must not enable empty-gap skipping");
assert.equal(waitPlayback(-1), null);
assert.equal(waitPlayback(NaN), null);
assert.deepEqual(initialWait, originalInitialWait, "Wait acceleration must not change recorded stages or times");
assert.equal(waitPlayback(6), 106, "Reverse seeking must not alter the wait boundaries");
assert.equal(createEmptyPlayback(initialWait)(6), null, "The empty-only mode must still preserve live waits");

for (const node of ["front-0", "issue", "rob", "memory-wait"]) {
    const target = createWaitPlayback(emptyTrace([waitOp(1, 0, 200, [["Wait", node, 0, 200]])]));
    assert.equal(target(6), 198, `${node} must permit its recorded stationary interior`);
}
for (const node of ["exec-integer", "exec-branch", "exec-memory", "register-read", "unknown", "commit"]) {
    const target = createWaitPlayback(emptyTrace([waitOp(1, 0, 200), waitOp(2, 0, 100, [["Moving", node, 0, 100]])]));
    assert.equal(target(6), null, `${node} must preserve movement even while another instruction waits`);
    assert.equal(target(106), 198);
}
const stageChanges = createWaitPlayback(
    emptyTrace([
        waitOp(1, 0, 200, [
            ["F", "front-0", 0, 80],
            ["Rn", "front-1", 80, 120],
            ["X", "exec-integer", 120, 130],
            ["Cm", "rob", 130, 200]
        ])
    ])
);
assert.equal(stageChanges(6), 78);
assert.equal(stageChanges(86), 118);
assert.equal(stageChanges(125), null);
assert.equal(stageChanges(136), 198);
const missingStages = createWaitPlayback(
    emptyTrace([
        waitOp(1, 0, 200),
        waitOp(2, 0, 200, [
            ["F", "front-0", 0, 30],
            ["Rn", "front-1", 80, 130]
        ])
    ])
);
assert.equal(missingStages(6), 28);
assert.equal(missingStages(40), null, "A gap in another live instruction's stages is not known waiting");
assert.equal(missingStages(86), 128);
assert.equal(missingStages(150), null, "An unobserved stage tail is not known waiting");
for (const op of [
    emptyOp(2, 0, 200),
    waitOp(2, 0, 200, undefined, { unfinished: true }),
    waitOp(2, 0, Infinity),
    waitOp(2, 0, NaN),
    waitOp(2, 0, -1),
    waitOp(2, 0, 200, [["F", "front-0", 0, Infinity]])
]) {
    assert.equal(
        createWaitPlayback(emptyTrace([waitOp(1, 0, 200), op]))(20),
        null,
        "Missing stages, unfinished instructions and unknown endpoints must block acceleration"
    );
}
const lifecycle = waitOp(1, 0, 200);
lifecycle[7] = 50;
lifecycle[8] = 100;
lifecycle[9] = 150;
const lifecycleWait = createWaitPlayback(emptyTrace([lifecycle]));
assert.equal(lifecycleWait(6), 48);
assert.equal(lifecycleWait(56), 98);
assert.equal(lifecycleWait(106), 148);
assert.equal(lifecycleWait(156), 198);
const squashedWait = createWaitPlayback(
    emptyTrace([waitOp(1, 0, 10, [["F", "front-0", 0, 100]], { flush: true, flushCycle: 100 })])
);
assert.equal(squashedWait(6), 98, "The effective squash cycle determines the end of the wait");
assert.equal(squashedWait(100), null);
assert.equal(
    createWaitPlayback(emptyTrace([waitOp(1, 0, 40, undefined, { flush: true, flushCycle: 0 })]))(6),
    null,
    "A squash at zero must not leave a fabricated wait after the instruction ends"
);

const boundaryWait = [waitOp(1, 0, 1_000_000_000)];
assert.equal(createWaitPlayback(emptyTrace(boundaryWait, { firstCycle: 16, lastCycle: 32 }))(16), 32);
assert.equal(createWaitPlayback(emptyTrace(boundaryWait, boundaryWindow))(16), 999_999_998);
assert.equal(
    createWaitPlayback(emptyTrace(boundaryWait, { lastCycle: 32, emptyTailUntil: 200 }))(16),
    200,
    "Known waits may use a confirmed prefix but may not assume the unobserved remainder"
);
assert.equal(createWaitPlayback(emptyTrace([], { emptyTailUntil: 1_000_000_000 }))(16), null);
for (const extra of [
    { storeCompletions: [[9, 50]] },
    { evidence: { scheduling: { ops: [{ id: 1, dependencies: [{ id: 9, ready: 50 }] }] } } },
    { evidence: { registers: { events: [{ cycle: 50 }] } } },
    { evidence: { registers: { allocation: { events: [{ cycle: 50 }] } } } },
    { evidence: { registers: { reads: [{ cycle: 50 }] } } },
    { demo: { events: [{ kind: "icache-miss", cycle: 50, endCycle: 100, id: 1 }] } }
]) {
    const target = createWaitPlayback(emptyTrace([waitOp(1, 0, 200)], extra));
    assert.equal(target(6), 48, "Recorded side effects must interrupt a stationary wait");
    assert.equal(target(50), null);
    assert.equal(target(55.999), null);
}
const missWait = createWaitPlayback(
    emptyTrace([waitOp(1, 0, 200)], { demo: { events: [{ kind: "icache-miss", cycle: 50, endCycle: 100, id: 1 }] } })
);
assert.equal(missWait(56), 98, "A recorded event's wait may accelerate between its visible start and end");
assert.equal(missWait(106), 198);
// 元命令が窓外へ出た後や直接シークした場合も、各書込み完了の手前で通常速度へ戻す。
const carriedStores = emptyTrace([], {
    firstCycle: 128,
    lastCycle: 256,
    emptyTailUntil: 500,
    storeWaits: [
        [1, 0, 10, 200],
        [2, 20, 30, 400]
    ]
});
const carriedStoreWait = createWaitPlayback(carriedStores);
assert.equal(carriedStoreWait(128), 198);
assert.equal(carriedStoreWait(160), 198, "Seeking into a write wait must retain the nearest completion");
assert.equal(carriedStoreWait(200), null);
assert.equal(carriedStoreWait(205.999), null, "Every write completion keeps its full animation margin");
assert.equal(carriedStoreWait(206), 398, "One completed store must not hide another store's remaining wait");
assert.equal(carriedStoreWait(398), null);
assert.equal(carriedStoreWait(406), null, "Completed stores must not invent a later wait");
assert.equal(createEmptyPlayback(carriedStores)(128), null, "A carried store wait is not empty");
assert.equal(createEmptyPlayback(carriedStores)(206), null);
assert.equal(createEmptyPlayback(carriedStores)(406), 500);
const boundedStore = { ...carriedStores, emptyTailUntil: undefined };
assert.equal(createWaitPlayback(boundedStore)(206), 256, "Store waits must respect the confirmed window horizon");
assert.equal(
    createWaitPlayback({ ...carriedStores, feedPreview: [{ id: 3, fetch: 250 }] })(206),
    248,
    "An out-of-window write wait must stop before an unknown future instruction"
);
const upcomingStore = emptyTrace([], { storeWaits: [[1, 100, 150, 200]] });
assert.equal(createWaitPlayback(upcomingStore)(20), null, "A future store must not create a present wait");
assert.equal(createWaitPlayback(upcomingStore)(140), null, "Write waiting begins at recorded retirement");
assert.equal(createWaitPlayback(upcomingStore)(156), 198);
assert.equal(createEmptyPlayback(upcomingStore)(20), 98);
const legacyStoreOp = waitOp(1, 0, 20);
legacyStoreOp[5] = "str x0, [x1]";
const legacyStore = emptyTrace([legacyStoreOp], { storeCompletions: [[1, 200]], lastCycle: 250 });
assert.equal(createWaitPlayback(legacyStore)(26), 198, "Recorded legacy store completions retain write waits");
assert.equal(createEmptyPlayback(legacyStore)(26), null);
for (const [field, value] of [
    [4, 1],
    [12, true],
    [5, "amoadd.w x0, x1, (x2)"]
]) {
    const op = [...legacyStoreOp];
    op[field] = value;
    assert.equal(
        createWaitPlayback({ ...legacyStore, ops: [op] })(26),
        null,
        "Squashed, unfinished and atomic instructions must not invent post-retirement write waits"
    );
}
assert.equal(
    createWaitPlayback(emptyTrace([], { storeCompletions: [[1, 100]] }))(20),
    null,
    "An orphan legacy completion is an event, not evidence of a preceding wait"
);

console.log("wait playback: stationary stages, observed transitions, unknown intervals and independent empty mode");

// 滞在時間や同一実行モジュール内の重複区間ではなく、境界の通過を数える。
const transfers = measureTransfers(
    [
        {
            id: 1,
            fetch: 0,
            allocation: 1,
            end: 5,
            flush: false,
            stages: [
                { node: "front-0", start: 0 },
                { node: "exec-integer", start: 1 },
                { node: "exec-integer", start: 2 },
                { node: "rob", start: 3 }
            ]
        },
        {
            id: 2,
            fetch: 0,
            allocation: 1,
            end: 5,
            flush: false,
            stages: [
                { node: "front-0", start: 0 },
                { node: "issue", start: 1 },
                { node: "exec-integer", start: 2 },
                { node: "rob", start: 4 }
            ]
        },
        {
            id: 3,
            fetch: 0,
            allocation: 1,
            end: 4,
            flush: true,
            stages: [
                { node: "front-0", start: 0 },
                { node: "issue", start: 1 },
                { node: "exec-integer", start: 2 }
            ]
        },
        {
            id: 4,
            fetch: 0,
            allocation: 1,
            end: 6,
            flush: false,
            stages: [
                { node: "front-0", start: 0 },
                { node: "exec-integer", start: 1 },
                { node: "rob", start: 3 }
            ]
        }
    ],
    { firstCycle: 1, lastCycle: 5, frontNodes: [{ id: "front-0" }] }
);
assert.equal(transfers.get("front-0>issue").peak, 4, "Missing zero-cycle issue rows lost allocation crossings");
assert.equal(transfers.get("issue>exec-integer").peak, 2);
assert.equal(transfers.get("issue>exec-integer").total, 4, "An execution stay was counted more than once");
assert.equal(transfers.get("exec-integer>rob").peak, 2);
assert.equal(transfers.get("rob>commit").peak, 2, "Squash or an out-of-window retirement counted as a transfer");
assert.equal(transfers.has("input>front-0"), false, "Out-of-window fetches affected the width");

// 後方の平均窓に将来のボトルネックが入り込まないことを確認する。
const topDownFixture = {
    firstCycle: 10,
    windowCycles: 2,
    slots: [
        [2, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 2, 0],
        [0, 1, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 2]
    ]
};
assert.equal(sampleTopDown(topDownFixture, 10.5).dominant, "active");
assert.equal(sampleTopDown(topDownFixture, 12).dominant, "mixed");
assert.equal(sampleTopDown(topDownFixture, 13).shares.badSpeculation, 0.5);
assert.equal(sampleTopDown(topDownFixture, 14).shares.unresolved, 0.5);
assert.equal(sampleTopDown(topDownFixture, 12.5).firstCycle, 10.5);
assert.equal(sampleTopDown(topDownFixture, 12.5).lastCycle, 12.5);
assert.equal(
    sampleTopDown(topDownFixture, 12.5).shares.badSpeculation,
    0.25,
    "The window edge must move with the fractional current cycle"
);
assert.equal(sampleTopDown(null, 12).available, false);
assert.equal(sampleTopDown(topDownFixture, 9).available, false);
const causalTopDown = {
    firstCycle: 0,
    windowCycles: 4,
    slots: [
        [1, 1, 0, 0, 0, 0],
        [0, 0, 2, 0, 0, 0],
        [0, 0, 0, 2, 0, 0],
        [0, 0, 0, 0, 2, 0]
    ],
    observationTimes: {
        outcomes: [
            [0, 2, 0],
            [0, 3, 1]
        ],
        recoveryNotices: [null, [3, 3], null, null]
    }
};
const pendingTopDown = sampleTopDown(causalTopDown, 1.5);
assert.equal(pendingTopDown.shares.badSpeculation, 0, "Future squash or recovery leaked into the display");
assert.equal(pendingTopDown.shares.retiring, 0, "A future commit was classified before observation");
assert.equal(pendingTopDown.shares.inFlight, 2 / 3);
assert.equal(pendingTopDown.shares.unresolved, 0);
assert.equal(pendingTopDown.dominant, "active", "Known in-flight work must not be classified as missing evidence");
assert.equal(sampleTopDown(causalTopDown, 2.5).shares.retiring, 0.2);
assert.equal(sampleTopDown(causalTopDown, 2.5).shares.badSpeculation, 0);
assert.equal(sampleTopDown(causalTopDown, 3).shares.badSpeculation, 0.5);
assert.deepEqual(sampleTopDown(causalTopDown, 1.5), pendingTopDown, "Backward seek retained a future outcome");
const busyPipeline = {
    firstCycle: 0,
    windowCycles: 8,
    slots: Array.from({ length: 16 }, () => [2, 0, 0, 0, 0, 0]),
    observationTimes: {
        outcomes: Array.from({ length: 16 }, (_, c) => [
            [c, c + 12, 0],
            [c, c + 12, 0]
        ]).flat(),
        recoveryNotices: Array(16).fill(null)
    }
};
for (const t of [8, 10.5, 13, 15.5]) {
    const state = sampleTopDown(busyPipeline, t);
    assert.equal(state.dominant, "active");
    assert.equal(state.dominantShare, 1);
    assert.equal(state.shares.inFlight, 1);
    assert.equal(
        state.shares.unresolved,
        0,
        "Commit latency longer than the window must not make a busy pipeline permanently pending"
    );
}

// 若い命令が先に完了しても、スロットを解放したり先頭を追い越したりできない。
const fixture = [
    { id: 1, allocation: 0, completion: 4, end: 5, flush: false },
    { id: 2, allocation: 1, completion: 1.5, end: 6, flush: false },
    { id: 3, allocation: 2, completion: 3, end: 8, flush: false },
    { id: 4, allocation: 5, completion: 6, end: 7, flush: true },
    { id: 5, allocation: 7, completion: 8, end: 9, flush: false }
];
const r = createRobReplay(fixture, 3);
assert.deepEqual(
    r.stateAt(4).entries.map((e) => e.op.id),
    [1, 2, 3]
);
assert.equal(r.stateAt(4).head, 0);
assert.equal(r.stateAt(4).tail, 0); // 満杯かどうかは個数で区別する。
assert.equal(r.slots.get(4), 0); // 任意の空きを再利用せず、末尾を循環させる。
assert.deepEqual(
    r.stateAt(5).entries.map((e) => e.op.id),
    [2, 3, 4]
);
assert.equal(r.stateAt(5).head, 1);
assert.equal(r.slots.get(5), 0); // squash では取り消した末尾の開始位置へ巻き戻す。
assert.deepEqual(
    r.stateAt(7).entries.map((e) => e.op.id),
    [3, 5]
);
assert.equal(r.stateAt(9).entries.length, 0);
// 逆向きシークの結果は、直前に描画したフレームに依存しない。
assert.equal(r.stateAt(1).tail, 2);
assert.deepEqual(
    r.stateAt(1).entries.map((e) => e.op.id),
    [1, 2]
);

require("../data/traces.js");
assert.equal(globalThis.embeddedFlowTraces.length, 5);
assert.ok(!globalThis.embeddedFlowTraces.some((t) => t.key === "pressure-release"));
for (const trace of globalThis.embeddedFlowTraces) {
    if (trace.topDown) {
        for (const row of trace.topDown.slots)
            assert.equal(
                row.reduce((sum, n) => sum + n, 0),
                trace.topDown.allocationWidth
            );
        for (let t = trace.firstCycle; t <= trace.lastCycle; t++) {
            const s = sampleTopDown(trace.topDown, t);
            assert.equal(s.cycles, 8);
            assert.equal(s.lastCycle, t);
            assert.equal(s.firstCycle, t - 8);
            assert.ok(Math.abs(Object.values(s.shares).reduce((sum, n) => sum + n, 0) - 1) < 1e-9);
            assert.ok(s.counts.every((n) => n >= 0));
        }
        const notices = trace.topDown.observationTimes,
            firstSquash = Math.min(
                ...notices.outcomes.filter((e) => e[2] === 1).map((e) => e[1]),
                ...notices.recoveryNotices.filter(Boolean).map((e) => e[0])
            );
        for (let t = trace.firstCycle; t < Math.min(firstSquash, trace.lastCycle); t += 0.5)
            assert.equal(
                sampleTopDown(trace.topDown, t).shares.badSpeculation,
                0,
                `${trace.key}: Bad speculation appeared before its first observed squash`
            );
    } else assert.equal(sampleTopDown(trace.topDown, trace.initialCycle).available, false);
    if (trace.evidence.registers) {
        const data = trace.evidence.registers,
            replay = createRegisterReplay(data);
        for (let time = trace.firstCycle; time <= trace.lastCycle; time++) {
            const state = replay.stateAt(time);
            assert.equal(
                Object.values(state.allocationCounts).reduce((n, v) => n + v, 0),
                state.physical.length
            );
            for (const cell of state.physical)
                if (cell.mappedTo.length && data.allocation)
                    assert.equal(
                        cell.allocation,
                        "allocated",
                        `${trace.key} p${cell.physical} at ${time}: mapped register is not allocated`
                    );
            for (const read of data.reads?.filter((r) => r.cycle === time) ?? [])
                assert.notEqual(
                    state.physical.find((p) => p.physical === read.physical)?.allocation,
                    "free",
                    "Reading a register already marked free"
                );
        }
        if (data.allocation) {
            assert.ok(data.allocation.events.some((e) => e.state === "allocated"));
            assert.ok(data.allocation.events.some((e) => e.state === "free"));
        } else assert.equal(replay.stateAt(trace.firstCycle).allocationCounts.unknown, 256);
    }
    if (trace.evidence.registers?.origin === "gem5") {
        const data = trace.evidence.registers,
            replay = createRegisterReplay(data),
            initial = replay.stateAt(trace.firstCycle);
        assert.equal(initial.physical.length, 256);
        if (data.kind === "configuration") {
            assert.equal(initial.rows.length, 32);
            assert.ok(initial.rows.every((r) => r.physical === null && r.value === null && r.event === null));
            assert.equal(data.logicalNames[38], "SP_EL0");
            assert.ok(initial.physical.every((p) => p.value === null));
            assert.equal(data.events.length, 0);
        } else {
            const expected =
                trace.key === "rename-rush"
                    ? { cycle: 404, physical: 83, hex: "0x4a9120" }
                    : { cycle: 1596, physical: 191, hex: "0x4b0780" };
            const event = data.events.find((e) => e.type === "write");
            for (const [key, value] of Object.entries(expected)) assert.equal(event[key], value);
            assert.equal(
                replay.stateAt(event.cycle).physical.find((p) => p.physical === event.physical).value,
                event.hex
            );
            assert.ok(data.reads.length > 400);
            assert.ok(data.events.some((e) => e.type === "restore"));
            const before = replay.stateAt(trace.firstCycle + 0.4);
            replay.stateAt(trace.lastCycle);
            assert.deepEqual(replay.stateAt(trace.firstCycle + 0.4), before);
            if (trace.key === "x86-recovery") {
                for (const op of trace.ops) {
                    if (/:\s+(ld|st)\s/.test(op[5])) assert.equal(op[10], "exec-memory");
                    if (/:\s+wripi?\s/.test(op[5])) assert.equal(op[10], "exec-branch");
                }
            }
        }
    }
    if (trace.key === "memory-tide") {
        const events = trace.demo.events;
        assert.ok(events.some((e) => e.kind === "branch-mispredict" && /Br-pred-miss/.test(e.message)));
        assert.ok(events.some((e) => e.kind === "dcache-miss" && /D\$[ -]miss/.test(e.message)));
        for (const e of events)
            assert.ok(
                trace.ops.some((op) => op[0] === e.id),
                "Recorded event must refer to an embedded instruction"
            );
        assert.ok(trace.ops.some((op) => op[4] && op[3] >= trace.firstCycle && op[3] <= trace.lastCycle));
        for (const op of trace.ops) {
            for (const stage of op[6]) {
                if (stage[0] === "Rr") assert.equal(stage[1], "register-read");
                if (stage[0] === "X") assert.equal(stage[1], op[10]);
            }
        }
        assert.equal(trace.ops.find((o) => o[0] === 4454)[9], 4067, "RSD branch completion must follow X, not Is");
        const data = trace.evidence.registers;
        const write = data.events.filter((e) => e.type === "write" && e.id === 4355);
        assert.equal(write.length, 1);
        assert.equal(write[0].cycle, 4014);
        assert.equal(write[0].hex, "0x0");
        assert.equal(
            write[0].observedCycle,
            4013,
            "A failed cache-miss attempt was presented as the final register value"
        );
        const replay = createRegisterReplay(data),
            allRows = replay.stateAt(4068).rows,
            restored = allRows.filter((r) => [12, 13, 15].includes(r.logical));
        assert.equal(allRows.length, 32);
        assert.equal(allRows.find((r) => r.logical === 20).physical, null);
        assert.equal(allRows.find((r) => r.logical === 0).constant, true);
        assert.deepEqual(
            restored.map((r) => [r.logical, r.physical]),
            [
                [12, 7],
                [13, 11],
                [15, 8]
            ]
        );
        assert.ok(restored.every((r) => r.event.type === "restore"));
    }
    const ops = trace.ops.map((o) => ({
        id: o[0],
        fetch: o[2],
        allocation: o[7],
        completion: o[9],
        end: o[4] ? (o[11] ?? o[3]) : o[3],
        flush: !!o[4],
        execution: o[10],
        stages: o[6].map((s) => ({ node: s[1], start: s[2], end: s[3] }))
    }));
    const flushes = [
        ...new Set(
            ops.filter((o) => o.flush && o.end >= trace.firstCycle && o.end <= trace.lastCycle).map((o) => o.end)
        )
    ];
    const branches = findRecoveryBranches(ops, trace.demo.events, flushes, trace.parser.startsWith("gem5"));
    for (const b of branches) {
        assert.equal(b.op.flush, false);
        assert.ok(b.until > b.cycle);
        if (b.inferred) assert.ok(ops.some((o) => o.id === b.id + 1 && o.flush && o.end === b.cycle));
        else assert.ok(trace.demo.events.some((e) => e.kind === "branch-mispredict" && e.id === b.id));
    }
    if (trace.key === "memory-tide") {
        assert.deepEqual(
            branches.map((b) => b.id),
            [4454, 4470]
        );
        const deps = new Map(trace.evidence.scheduling.ops.map((o) => [o.id, o.dependencies]));
        const loads = trace.ops.filter((o) => o[7] !== null && /: l(?:b|bu|h|hu|w) /.test(o[5]));
        assert.ok(loads.length > 20);
        for (const load of loads)
            assert.equal(deps.get(load[0]).length, 1, `RSD load #${load[0]} must have one base register source`);
    }
    const replay = createRobReplay(ops, trace.structure.robCapacity);
    for (const snapshot of replay.snapshots) {
        const expected = ops
            .filter((o) => o.allocation != null && o.allocation <= snapshot.time && o.end > snapshot.time)
            .sort((a, b) => a.id - b.id);
        assert.deepEqual(
            snapshot.entries.map((e) => e.op.id),
            expected.map((o) => o.id),
            `${trace.key}: FIFO membership`
        );
        assert.equal(new Set(snapshot.entries.map((e) => e.slot)).size, expected.length);
        snapshot.entries.forEach((e, i) =>
            assert.equal(e.slot, (snapshot.head + i) % replay.capacity, `${trace.key}: contiguous FIFO`)
        );
        assert.equal(snapshot.tail, (snapshot.head + expected.length) % replay.capacity);
    }
    const returns = memoryCompletions(ops);
    assert.equal(
        returns.length,
        ops.filter(
            (o) =>
                !o.flush &&
                o.completion != null &&
                o.completion <= o.end &&
                o.stages.some((s) => s.node === "memory-wait" && s.start < o.completion)
        ).length
    );
    for (const e of returns) {
        assert.equal(e.time, e.op.completion);
        assert.ok(!e.op.flush);
    }
    const feed = createFeedReplay(
        [...ops].sort((a, b) => a.fetch - b.fetch || a.id - b.id),
        trace
    );
    for (const event of feed.events) {
        const t = event.time;
        assert.equal(feed.stateAt(t - 0.001).phase, "flow");
        assert.equal(feed.stateAt(t).cursor, feed.cursorAt(t), "Rewind must start without a cursor jump");
        assert.ok(feed.stateAt(t + 0.2).cursor > feed.stateAt(t + 0.6).cursor, "Code cursor must reverse");
        assert.equal(feed.stateAt(t + 1.05).phase, "discard");
        const separated = feed.stateAt(t + 2.1);
        assert.equal(separated.phase, "discard");
        assert.ok(separated.dissolve > 0.5, "Letters must visibly separate");
        assert.ok(
            separated.cancelAlpha > 0.25 && separated.cancelAlpha < feed.stateAt(t + 1.5).cancelAlpha,
            "Letters must fade as they separate"
        );
        assert.equal(separated.flowAlpha, 0, "Incoming code covered the unraveling letters too early");
        assert.equal(feed.stateAt(t + 3.1).phase, "refill");
        assert.ok(feed.stateAt(t + 3.1).flowAlpha > 0);
        assert.ok(feed.stateAt(t + 3.1).cancelAlpha < 1);
        assert.equal(feed.stateAt(t + codeRewindDuration).phase, "flow");
        assert.equal(feed.stateAt(t + codeRewindDuration).cursor, feed.cursorAt(t + codeRewindDuration));
        const before = feed.stateAt(t + 0.6);
        feed.stateAt(trace.lastCycle);
        assert.deepEqual(feed.stateAt(t + 0.6), before, "Rewind must be deterministic after seeking");
        assert.deepEqual(
            before.ids,
            ops
                .filter((o) => o.flush && o.end === t)
                .sort((a, b) => a.fetch - b.fetch || a.id - b.id)
                .map((o) => o.id)
        );
        const reduced = feed.stateAt(t + 0.6, true);
        assert.equal(reduced.phase, "notice");
        assert.equal(reduced.cursor, feed.cursorAt(t + 0.6));
        assert.equal(reduced.cancelAlpha, 0);
    }
    if (!feed.events.length) assert.equal(feed.stateAt(trace.initialCycle).phase, "flow");
    console.log(
        `${trace.key}: ${replay.snapshots.length} FIFO snapshots; ${returns.length} memory broadcasts; ${feed.events.length} code rewinds`
    );
}

require("./check-continuity.cjs");

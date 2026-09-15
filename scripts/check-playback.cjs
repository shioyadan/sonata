"use strict";
const assert = require("node:assert/strict");
const {
    flushPlaybackRate,
    advancePlayback,
    createEmptyPlayback,
    createWaitPlayback
} = require("../src/replay-model.cts");

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
assert.equal(waitPlayback(1.999), null, "The initial fetch and entry animation must play normally");
assert.equal(waitPlayback(2), 106, "A long initial fetch wait must stop before the next instruction fetch");
assert.equal(waitPlayback(98), 106);
assert.equal(waitPlayback(98.001), null, "The remaining wait must still be at least eight cycles");
assert.equal(waitPlayback(106), null);
assert.equal(waitPlayback(130), null, "Wait acceleration must not enable empty-gap skipping");
assert.equal(waitPlayback(-1), null);
assert.equal(waitPlayback(NaN), null);
assert.deepEqual(initialWait, originalInitialWait, "Wait acceleration must not change recorded stages or times");
assert.equal(waitPlayback(2), 106, "Reverse seeking must not alter the wait boundaries");
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
    assert.equal(target(51.999), null);
    assert.equal(target(52), extra.demo ? 98 : 198, "Ordinary side effects keep two cycles of normal playback");
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
assert.equal(carriedStoreWait(201.999), null, "Every write completion keeps its full animation margin");
assert.equal(carriedStoreWait(202), 398, "One completed store must not hide another store's remaining wait");
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

// 20cyごとに段が変わる短い待機も、残8cyと前後2cyの境界を守って扱う。
const shortWait = createWaitPlayback(
    emptyTrace(
        [
            waitOp(1, 0, 40, [
                ["F", "front-0", 0, 20],
                ["Rn", "front-1", 20, 40]
            ])
        ],
        { lastCycle: 40 }
    )
);
assert.equal(shortWait(2), 18);
assert.equal(shortWait(10), 18);
assert.equal(shortWait(10.001), null);
assert.equal(shortWait(18), null);
assert.equal(shortWait(21.999), null);
assert.equal(shortWait(22), 38);
assert.equal(shortWait(10), 18, "Seeking backwards must retain the shorter wait threshold");
const shortHorizon = emptyTrace([waitOp(1, 0, 100)], { firstCycle: 12, lastCycle: 24 });
assert.equal(createWaitPlayback(shortHorizon)(12), 24, "A short confirmed window can contain a useful wait");
assert.equal(createWaitPlayback(shortHorizon)(16.001), null);
assert.equal(
    createEmptyPlayback({ ...shortHorizon, ops: [] })(12),
    null,
    "Empty skipping must retain its sixteen-cycle minimum"
);

const survivingWait = waitOp(1, 0, 200);
const afterRetire = createWaitPlayback(emptyTrace([survivingWait, waitOp(2, 0, 40)]));
assert.equal(afterRetire(41.999), null, "The two-cycle commit exit must finish before acceleration");
assert.equal(afterRetire(42), 198);
for (const stages of [[["F", "front-0", 0, 40]], []]) {
    const afterSquash = createWaitPlayback(
        emptyTrace([survivingWait, waitOp(2, 0, 10, stages, { flush: true, flushCycle: 40 })])
    );
    assert.equal(afterSquash(45.999), null, "Squash recovery must retain six cycles even without recorded stages");
    assert.equal(afterSquash(46), 198);
}
const recoveryNotice = createWaitPlayback(
    emptyTrace([survivingWait], {
        demo: { events: [{ kind: "branch-mispredict", cycle: 40, endCycle: 70, id: 1 }] }
    })
);
assert.equal(recoveryNotice(45.999), null);
assert.equal(recoveryNotice(46), 68);
assert.equal(recoveryNotice(75.999), null);
assert.equal(recoveryNotice(76), 198);
assert.equal(recoveryNotice(46), 68, "Reverse seeking must retain recovery margins");

const notifiedLoad = waitOp(1, 0, 100, [
    ["F", "front-0", 0, 5],
    ["Is", "exec-memory", 5, 30],
    ["Cm", "rob", 30, 100]
]);
notifiedLoad[8] = 5;
notifiedLoad[9] = 30;
const loadWait = createWaitPlayback(emptyTrace([notifiedLoad]), [
    {
        id: 1,
        stages: [
            { names: ["F"], node: "front-0", start: 0, end: 5 },
            { names: ["Is"], node: "exec-load", start: 5, end: 10 },
            { names: ["Is"], node: "memory-wait", start: 10, end: 30 },
            { names: ["Cm"], node: "rob", start: 30, end: 100 }
        ]
    }
]);
assert.equal(loadWait(6), null, "Prepared access movement remains fully protected");
assert.equal(loadWait(12), 28);
assert.equal(loadWait(32.999), null, "The 2.8-cycle LOAD WAIT notification must finish before accelerating");
assert.equal(loadWait(33), 98);

console.log("wait playback: stationary stages, observed transitions, unknown intervals and independent empty mode");

console.log("Playback clock: flush timing, empty gaps and stationary waits passed");

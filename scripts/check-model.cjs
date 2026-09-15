"use strict";
const assert = require("node:assert/strict");
const {
    createDependencyReplay,
    createRegisterReplay,
    measureTransfers,
    sampleTopDown,
    createRobReplay
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
// 区間の前に値だけ観測したセルも残し、書込み元や論理対応は補わない。
const observedOnly = createRegisterReplay({
    rows: [],
    initial: { mapping: [], owners: [], values: [[7, "0x12"]] },
    events: [{ type: "observe", cycle: 8, physical: 7, hex: "0x34" }]
});
assert.equal(observedOnly.stateAt(9).physical[0].value, "0x34");
const earlierValue = observedOnly.stateAt(3).physical[0];
assert.equal(earlierValue.physical, 7);
assert.equal(earlierValue.value, "0x12");
assert.equal(earlierValue.writer, null);
assert.equal(earlierValue.allocation, "unknown");
assert.deepEqual(earlierValue.mappedTo, []);
const checkpointOnly = createRegisterReplay({
    rows: [],
    initial: { mapping: [], owners: [], values: [[7, "0x12"]] },
    events: []
});
assert.equal(checkpointOnly.stateAt(3).physical[0].value, "0x12");

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

// HEAD / TAIL の演出は更新後だけ動き、FIFO のスロット・終了時刻と独立して復元できる。
const recordedRob = JSON.stringify({ slots: [...r.slots], snapshots: r.snapshots });
function markerNear(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}
assert.deepEqual(r.markersAt(-1), { head: 0, tail: 0 });
assert.deepEqual(r.markersAt(0), { head: 0, tail: 0 }, "Allocation moved its marker before being observed");
markerNear(r.markersAt(0.2).tail, 0.5, "TAIL must pass through fractional slots");
markerNear(r.markersAt(0.4).tail, 1, "TAIL must settle promptly after allocation");
markerNear(r.markersAt(2.2).tail, 2.5, "TAIL must move forward through the capacity boundary");
assert.equal(r.markersAt(2.4).tail, 0);
assert.equal(r.markersAt(5).head, 0, "Commit marker anticipated its recorded event");
assert.equal(r.stateAt(5).head, 1, "Marker easing delayed the real HEAD state");
markerNear(r.markersAt(5.2).head, 0.5, "HEAD must move after commit");
markerNear(r.markersAt(8.2).head, 2.5, "HEAD must wrap forward");
assert.equal(r.markersAt(8.4).head, 0);
assert.equal(r.markersAt(7.2).tail, 1, "Equal squash and allocation counts restarted an unchanged TAIL");
const markerSamples = [0.2, 1.1, 2.2, 5.1, 6.35, 7.2, 8.2, 9.4].map((time) => [time, r.markersAt(time)]);
const recreatedRob = createRobReplay(fixture, 3);
for (const [time, expected] of [...markerSamples].reverse()) {
    assert.deepEqual(r.markersAt(time), expected, "Reverse seek changed a marker position");
    assert.deepEqual(recreatedRob.markersAt(time), expected, "Reload changed a marker position");
}
assert.equal(JSON.stringify({ slots: [...r.slots], snapshots: r.snapshots }), recordedRob);

const rollbackRob = createRobReplay(
    [
        { id: 0, allocation: 0, end: 10, flush: false },
        { id: 1, allocation: 1, end: 3, flush: true },
        { id: 2, allocation: 2, end: 3, flush: true }
    ],
    3
);
assert.equal(rollbackRob.markersAt(3).tail, 0);
markerNear(rollbackRob.markersAt(3.1).tail, 2.6875, "Squash must cross the boundary backward");
markerNear(rollbackRob.markersAt(3.2).tail, 2, "Squash must retreat across each removed slot");
assert.equal(rollbackRob.markersAt(3.4).tail, 1);
assert.equal(rollbackRob.markersAt(3.2).head, 0, "Squash moved HEAD");
const rollbackCropped = createRobReplay([{ id: 0, allocation: 0, end: 10, flush: false }], 3, {
    time: 3.1,
    state: rollbackRob.stateAt(3.1),
    markers: rollbackRob.markerStateAt(3.1)
});
for (const time of [3, 3.1, 3.2, 3.4])
    assert.deepEqual(rollbackCropped.markersAt(time), rollbackRob.markersAt(time), "Window lost squash marker motion");
const emptyRob = createRobReplay([], 3, { time: 9.2, state: r.stateAt(9.2), markers: r.markerStateAt(9.2) });
assert.deepEqual(emptyRob.markersAt(9.2), r.markersAt(9.2), "Empty window lost its final commit marker motion");
assert.deepEqual(emptyRob.markersAt(9.4), r.markersAt(9.4));
const fullTurn = createRobReplay(
    Array.from({ length: 3 }, (_, id) => ({ id, allocation: 0, end: 2, flush: false })),
    3
);
markerNear(fullTurn.markersAt(0.2).tail, 1.5, "A full-capacity allocation lost its forward revolution");
markerNear(fullTurn.markersAt(2.2).head, 1.5, "A full-capacity retirement lost its forward revolution");

const denseRob = createRobReplay(
    Array.from({ length: 3 }, (_, id) => ({ id, allocation: id / 10, end: 0.5 + id / 10, flush: false })),
    3
);
for (const time of [0.1, 0.2, 0.5, 0.6, 0.7]) {
    const before = denseRob.markersAt(time - 1e-7),
        after = denseRob.markersAt(time + 1e-7);
    for (const pointer of ["head", "tail"]) {
        const distance = Math.abs(after[pointer] - before[pointer]);
        assert.ok(Math.min(distance, 3 - distance) < 1e-5, `Dense ${pointer} updates jumped at ${time}`);
    }
}
assert.equal(denseRob.markersAt(0.6).tail, 0, "A HEAD update restarted TAIL easing");
assert.deepEqual(denseRob.markersAt(1.1), { head: 0, tail: 0 });

// 前6サイクルの記録が共通な隣接窓では、整数の循環位相と小数の表示位置が一致する。
const windowOps = [
    { id: 0, allocation: 0, end: 2, flush: false },
    { id: 1, allocation: 1, end: 8, flush: false },
    { id: 2, allocation: 3, end: 5, flush: true },
    { id: 3, allocation: 6, end: 10, flush: false }
];
const wholeRob = createRobReplay(windowOps, 4);
const croppedRob = createRobReplay(windowOps.slice(1), 4, { time: 8.1, state: wholeRob.stateAt(8.1) });
for (const time of [6, 6.1, 6.2, 8, 8.1, 8.2, 10, 10.2, 10.4])
    assert.deepEqual(croppedRob.markersAt(time), wholeRob.markersAt(time), `Window changed markers at ${time}`);

// 補間中の終了命令が窓から抜けても、継続時刻・逆シーク・直後の更新を同じ軌道へつなぐ。
const closeOps = [
    { id: 0, allocation: 0, end: 2, flush: false },
    { id: 1, allocation: 1, end: 2.1, flush: false },
    { id: 2, allocation: 1.5, end: 2.3, flush: false }
];
const closeRob = createRobReplay(closeOps, 4);
const closeCropped = createRobReplay(closeOps.slice(2), 4, {
    time: 2.2,
    state: closeRob.stateAt(2.2),
    markers: closeRob.markerStateAt(2.2)
});
for (const time of [2.7, 2.4, 2.3, 2.25, 2.2, 2.15, 2.1]) {
    assert.deepEqual(
        closeCropped.markersAt(time),
        closeRob.markersAt(time),
        `Cropped interpolation changed at ${time}`
    );
    assert.equal(closeCropped.stateAt(time).head, closeRob.stateAt(time).head);
}

// 観測が増えて整数位置が変わった場合は、以前の補間を使って新しい更新を隠さない。
const oldRob = createRobReplay(closeOps.slice(0, 1), 4);
const additionalRob = createRobReplay(closeOps, 4, {
    time: 2.2,
    state: oldRob.stateAt(2.2),
    markers: oldRob.markerStateAt(2.2)
});
assert.deepEqual(additionalRob.markersAt(2.2), closeRob.markersAt(2.2));

console.log("Replay model: dependencies, register ownership, transfers, Top-down and ROB continuity passed");

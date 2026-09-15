"use strict";
const assert = require("node:assert/strict");
const {
    createRobReplay,
    memoryCompletions,
    createFeedReplay,
    codeRewindDuration,
    sampleTopDown,
    createRegisterReplay,
    createReplay,
    findRecoveryBranches
} = require("../src/replay-model.cts");

require("../data/traces.js");
assert.equal(globalThis.embeddedFlowTraces.length, 5);
assert.ok(!globalThis.embeddedFlowTraces.some((t) => t.key === "pressure-release"));
const valuesOnlyTrace = structuredClone(globalThis.embeddedFlowTraces[0]);
valuesOnlyTrace.evidence.registers = {
    rows: [],
    initial: { mapping: [], owners: [], values: [[7, "0x12"]] },
    events: []
};
assert.deepEqual(
    createReplay({ samples: [] }).loadData(valuesOnlyTrace).registerTags,
    [7],
    "Observed-only cells disappeared from the scene layout"
);
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
        const markers = replay.markersAt(snapshot.time + 0.17);
        for (const slot of Object.values(markers))
            assert.ok(Number.isFinite(slot) && slot >= 0 && slot < replay.capacity, `${trace.key}: invalid ROB marker`);
        if (replay.stateAt(snapshot.time + 0.4) === snapshot)
            assert.deepEqual(
                replay.markersAt(snapshot.time + 0.4),
                { head: snapshot.head, tail: snapshot.tail },
                `${trace.key}: ROB markers did not settle at the observed state`
            );
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

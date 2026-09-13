"use strict";
// 区間索引の境界と、全Opを画面用配列に複製しないことをGPUなしで検査する。
const assert = require("node:assert/strict");
const { createFileSession, createTraceIndex, selectOps, maxWindowOps } = require("../src/trace-file.cts");
async function check() {
    const signal = new AbortController().signal;
    const source = Array.from({ length: 32768 }, (_, id) => ({
        id,
        tid: id % 2,
        fetchedCycle: id * 2,
        retiredCycle: id * 2 + 1,
        eof: false,
        retired: true,
        flush: false,
        lanes: []
    }));
    source[0].retiredCycle = 60000;
    source.at(-1).eof = true;
    let visits = 0;
    const trace = {
        lastID: source.length - 1,
        lastCycle: 70000,
        getOpForScan(id) {
            visits++;
            return source[id];
        }
    };
    const indexer = createTraceIndex();
    source.forEach(indexer.observe);
    const index = indexer.finish(trace.lastCycle);
    assert.equal(index.blocks.length, 32);
    assert.deepEqual(index.threads, [0, 1]);
    assert.equal(visits, 0, "Index building must not rescan the compressed store");
    visits = 0;
    const ops = await selectOps(trace, index.blocks, 32000, 32127, 0, signal);
    assert.ok(ops.includes(source[0]), "Long operation crossing the left boundary was lost");
    assert.deepEqual(
        ops.map((op) => op.id),
        source.filter((op) => op.tid === 0 && op.fetchedCycle <= 32127 && op.retiredCycle >= 32000).map((op) => op.id)
    );
    assert.ok(visits <= 2048, `Window selection rescanned the entire trace (${visits} visits)`);
    assert.deepEqual(
        (await selectOps(trace, index.blocks, 69900, 70000, 1, signal)).map((op) => op.id),
        [32767],
        "EOF instruction must remain visible until the end of the trace"
    );
    assert.deepEqual(await selectOps(trace, index.blocks, 61000, 61000, 1, signal), []);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(selectOps(trace, index.blocks, 1, 2, 0, controller.signal), { name: "AbortError" });
    const sparse = createTraceIndex();
    sparse.observe({
        id: 1_000_000_000,
        tid: 0,
        fetchedCycle: 0,
        retiredCycle: 2,
        retired: true,
        flush: false,
        lanes: []
    });
    let sparseVisits = 0;
    const sparseOps = await selectOps(
        {
            lastCycle: 2,
            getOpForScan(id) {
                sparseVisits++;
                assert.equal(id, 1_000_000_000);
                return { id, tid: 0, fetchedCycle: 0, retiredCycle: 2, retired: true, flush: false, lanes: [] };
            }
        },
        sparse.finish(2).blocks,
        0,
        1,
        0,
        signal
    );
    assert.equal(sparseVisits, 1, "Sparse IDs caused a full ID range scan");
    assert.equal(sparseOps.length, 1);
    assert.throws(() => indexer.attach({ opCount: 1 }), /published its store/);
    const dense = {
        lastCycle: 1,
        getOpForScan(id) {
            return { id, tid: 0, fetchedCycle: 0, retiredCycle: 1, retired: true, flush: false, lanes: [] };
        }
    };
    const denseIndex = createTraceIndex();
    for (let id = 0; id <= maxWindowOps; id++) denseIndex.observe(dense.getOpForScan(id));
    await assert.rejects(selectOps(dense, denseIndex.finish(1).blocks, 0, 1, 0, signal), /Too many instructions/);
    const messages = [];
    const session = createFileSession((response) => messages.push(response));
    const complete =
        "O3PipeView:fetch:1000:0x1000:0:1: add r1, r2\nO3PipeView:decode:2000\nO3PipeView:rename:3000\nO3PipeView:dispatch:4000\nO3PipeView:issue:5000\nO3PipeView:complete:6000\nO3PipeView:retire:7000\n";
    const incomplete =
        "O3PipeView:fetch:11000:0x1004:0:2: add r1, r2\nO3PipeView:decode:12000\nO3PipeView:rename:13000\nO3PipeView:dispatch:14000\nO3PipeView:issue:15000\n";
    try {
        await session.open(new File([complete, incomplete], "gem5-eof.log"));
        const loaded = messages.find((m) => m.type === "loaded");
        assert.equal(loaded.source.opCount, 2);
        assert.equal(loaded.source.lastCycle, 14, "Unretired gem5 stages after the last commit were lost");
        await session.window({ type: "window", request: 1, cycle: 10, span: 128, thread: 0 });
        const result = messages.find((m) => m.type === "window").trace;
        assert.equal(result.ops.length, 1);
        assert.equal(result.ops[0][0], 1);
        assert.equal(result.ops[0][12], true);
        assert.equal(result.ops[0][6].at(-1)[3], 14, "Open gem5 stage was given a recorded end");
    } finally {
        session.close();
    }
    const sparseMessages = [];
    const sparseSession = createFileSession((response) => sparseMessages.push(response));
    try {
        await sparseSession.open(
            new File(
                ["Kanata\t0004\nI\t1000000000\t1\t0\nS\t1000000000\t0\tF\nC\t1\nR\t1000000000\t0\t0\n"],
                "sparse.kanata"
            )
        );
        await sparseSession.window({ type: "window", request: 1, cycle: 0, span: 128, thread: 0 });
        assert.equal(sparseMessages.find((m) => m.type === "window").trace.ops[0][0], 1_000_000_000);
    } finally {
        sparseSession.close();
    }
    console.log(
        "Trace index: bounded reads, sparse IDs, carry-in, threads, Kanata/gem5 EOF, cancellation and density limit passed"
    );
}
check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

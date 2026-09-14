"use strict";
// 区間索引の境界と、全Opを画面用配列に複製しないことをGPUなしで検査する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");
const {
    createFileSession,
    createTraceIndex,
    selectOps,
    selectStoreWaits,
    searchOps,
    selectPreview,
    maxWindowOps,
    maxOverviewBins,
    maxSearchHits
} = require("../src/trace-file.cts");
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
    assert.deepEqual(overviewTotals(index.overview), { fetched: 32768, committed: 32767, flushed: 0 });
    assert.ok(index.overview.bins.length <= maxOverviewBins);
    visits = 0;
    const ops = await selectOps(trace, index.blocks, 32000, 32127, 0, signal);
    assert.ok(
        ops.some((op) => op.id === 0),
        "Long operation crossing the left boundary was lost"
    );
    assert.deepEqual(
        ops.map((op) => op.id),
        source.filter((op) => op.tid === 0 && op.fetchedCycle <= 32127 && op.retiredCycle >= 32000).map((op) => op.id)
    );
    assert.ok(visits <= 2048, `Window selection rescanned the entire trace (${visits} visits)`);
    visits = 0;
    const preview = await selectPreview(trace, indexer.previewSnapshot(32128), 32128, trace.lastCycle, 0, signal);
    assert.deepEqual(
        preview.ops.map((op) => op.id),
        source
            .filter((op) => op.tid === 0 && op.fetchedCycle > 32128)
            .slice(0, 24)
            .map((op) => op.id)
    );
    assert.equal(preview.limited, false);
    assert.ok(visits <= 1024, `Text preview reread old long-lived operations (${visits} visits)`);
    assert.ok(
        preview.ops.every((op) => !("end" in op) && !("flush" in op)),
        "Text preview exposed future outcomes"
    );
    const unordered = Array.from({ length: 80 }, (_, id) => ({
        ...source[id],
        id: id * 1024,
        fetchedCycle: 200 - id,
        labelName: "a".repeat(1000)
    }));
    const unorderedIndex = createTraceIndex();
    unordered.forEach((op) => unorderedIndex.observe(op));
    const snapshot = unorderedIndex.previewSnapshot(0);
    const added = { ...unordered[0], id: 1, fetchedCycle: 1 };
    const values = new Map([...unordered, added].map((op) => [op.id, op]));
    unorderedIndex.observe(added);
    const reversed = await selectPreview({ getOpForScan: (id) => values.get(id) }, snapshot, 0, 180, 0, signal);
    assert.deepEqual(
        reversed.ops.map((op) => op.id),
        unordered
            .filter((op) => op.tid === 0 && op.fetchedCycle <= 180)
            .sort((a, b) => a.fetchedCycle - b.fetchedCycle)
            .slice(0, 24)
            .map((op) => op.id)
    );
    assert.ok(reversed.ops.every((op) => op.label.length <= 42));
    assert.ok(
        !reversed.ops.some((op) => op.id === added.id),
        "Text preview included instructions saved after its snapshot"
    );
    let previewReads = 0;
    const crowdedBlocks = Array.from({ length: 66 }, (_, i) => ({
        firstID: i * 1024,
        lastID: (i + 1) * 1024 - 1,
        firstCycle: 0,
        ids: new Uint32Array(32).fill(0xffffffff)
    }));
    const limited = await selectPreview(
        {
            getOpForScan(id) {
                previewReads++;
                return { id, tid: id % 2, fetchedCycle: id + 1, labelName: "add" };
            }
        },
        crowdedBlocks,
        0,
        100000,
        0,
        signal
    );
    assert.equal(limited.limited, true);
    assert.deepEqual(limited.ops, [], "Unconfirmed preview order was presented as an exact prefix");
    assert.equal(previewReads, 65536);
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
        assert.deepEqual(overviewTotals(loaded.source.overview), { fetched: 2, committed: 1, flushed: 0 });
        assert.equal(overviewBin(loaded.source.overview, 6).committed, 1, "Commit was shifted to the Rt display end");
        assert.equal(overviewBin(loaded.source.overview, 7).committed, 0);
        assert.equal(loaded.source.lastCycle, 14, "Unretired gem5 stages after the last commit were lost");
        await session.window({ type: "window", request: 1, cycle: 10, span: 128, thread: 0 });
        const result = messages.find((m) => m.type === "window").trace;
        assert.deepEqual(
            result.ops.map((op) => op[0]),
            [0, 1],
            "The preceding commit context was lost"
        );
        assert.equal(result.firstCycle, 10, "Context expansion changed the selected window");
        assert.equal(result.lastCycle, 14);
        const unfinished = result.ops.find((op) => op[0] === 1);
        assert.equal(unfinished[12], true);
        assert.equal(unfinished[6].at(-1)[3], 14, "Open gem5 stage was given a recorded end");
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
    checkOverview();
    await checkStoreWaits();
    await checkSearch();
    await checkSearchSession();
    await checkScanCancellation();
    await checkWindowCancellation();
    await checkStreaming();
    await checkSettledPrefix();
    await checkFileStructure();
    await checkConcurrentIndex();
    await checkFlushGroups();
    await checkWorkerRequests();
    await checkWorkerCoalescing();
    console.log(
        "Trace index: bounded overview, paged search, sparse IDs, carry-in, flush groups, EOF, streaming windows, parser fallback, snapshots, cancellation and Worker ordering passed"
    );
}

function overviewTotals(overview) {
    return overview.bins.reduce(
        (sum, bin) => ({
            fetched: sum.fetched + bin.fetched,
            committed: sum.committed + bin.committed,
            flushed: sum.flushed + bin.flushed
        }),
        { fetched: 0, committed: 0, flushed: 0 }
    );
}
function overviewBin(overview, cycle) {
    return overview.bins[Math.floor((cycle - overview.firstCycle) / overview.binWidth)];
}
function checkOverview() {
    const index = createTraceIndex();
    const events = [];
    // 遠い時刻から始め、逆順・疎な時刻・再書込み・未完了を混ぜる。
    for (let id = 99999; id >= 0; id--) {
        const cycle = id % 2 ? id * 100000 : id;
        const unfinished = id % 11 === 0,
            flush = !unfinished && id % 3 === 0;
        const op = {
            id,
            tid: id % 3,
            fetchedCycle: cycle,
            retiredCycle: cycle + 8,
            retired: !unfinished && !flush,
            flush,
            eof: unfinished,
            lanes: []
        };
        index.observe(op);
        index.observe(op);
        events.push([cycle, "fetched"]);
        if (!unfinished) events.push([cycle + 8, flush ? "flushed" : "committed"]);
        if (id % 1000 === 0) assert.ok(index.metadata(cycle + 8).overview.bins.length <= maxOverviewBins);
    }
    const result = index.finish(1e12);
    assert.equal(result.overview.scope, "all-threads");
    assert.deepEqual(result.threads, [0, 1, 2]);
    assert.ok(result.overview.firstCycle <= 0);
    assert.ok(result.overview.firstCycle + result.overview.bins.length * result.overview.binWidth > 1e12);
    const expected = result.overview.bins.map(() => ({ fetched: 0, committed: 0, flushed: 0 }));
    for (const [cycle, kind] of events)
        expected[Math.floor((cycle - result.overview.firstCycle) / result.overview.binWidth)][kind]++;
    assert.deepEqual(result.overview.bins, expected, "Merging overview bins changed event counts or their time range");
    assert.equal(result.blocks.length, Math.ceil(100000 / 1024));
    assert.ok(result.blocks.every((block) => block.ids.byteLength === 128 && block.ended.byteLength === 128));
    const before = structuredClone(result.overview);
    index.observe({ id: 100000, tid: 0, fetchedCycle: 1, retiredCycle: 2, retired: true, flush: false, lanes: [] });
    assert.deepEqual(result.overview, before, "Later parser writes mutated a published overview");
    index.clear();
    assert.throws(() => index.metadata(0), /No instructions/);
    index.observe({ id: 0, tid: 1, fetchedCycle: 3, retiredCycle: 7, retired: true, flush: false, lanes: [] });
    assert.equal(index.metadata(7).overview.firstCycle, 3);
    assert.deepEqual(overviewTotals(index.metadata(7).overview), { fetched: 1, committed: 1, flushed: 0 });

    // gem5のfetch-only squashに与えた1cycleの表示延長は観測イベントではない。
    const gem = createTraceIndex();
    gem.observe(
        {
            id: 0,
            tid: 0,
            fetchedCycle: 10,
            retiredCycle: 11,
            retired: false,
            flush: true,
            lanes: [{ stages: [{ name: "F", startCycle: 10, endCycle: 11 }] }]
        },
        "gem5"
    );
    gem.observe(
        {
            id: 1,
            tid: 0,
            fetchedCycle: 11,
            retiredCycle: 16,
            retired: false,
            flush: true,
            lanes: [
                {
                    stages: [
                        { name: "F", startCycle: 11, endCycle: 15 },
                        { name: "Dc", startCycle: 15, endCycle: 16 }
                    ]
                }
            ]
        },
        "gem5"
    );
    const overview = gem.metadata(20).overview;
    assert.equal(overviewBin(overview, 10).flushed, 1);
    assert.equal(overviewBin(overview, 15).flushed, 1);
    assert.equal(overviewBin(overview, 16).flushed, 0, "Inferred flush groups leaked into the overview");
}

// 退役後の書込みを、直前の窓やseek履歴に依存せず、その窓の観測として取得する。
async function checkStoreWaits() {
    const signal = new AbortController().signal;
    const operation = (id, fetch, start, end, tid = 0) => ({
        id,
        tid,
        fetchedCycle: fetch,
        retiredCycle: start + 1,
        retired: true,
        flush: false,
        eof: false,
        labelName: "str x0, [x1]",
        labelDetail: `Fetched Tick: ${1000 + fetch * 800}\nStore Tick: ${1000 + end * 800}`,
        lanes: [{ stages: [{ name: "Rt", startCycle: start, endCycle: start + 1 }] }]
    });
    const ops = [
        operation(0, 0, 6, 1000),
        operation(1024, 10, 16, 700, 1),
        operation(2048, 20, 26, 500),
        operation(3072, 1100, 1106, 2000)
    ];
    const index = createTraceIndex();
    const values = new Map(ops.map((op) => [op.id, op]));
    for (const op of ops) {
        index.observe(op, "gem5");
        index.observe(op, "gem5");
    }
    let reads = 0;
    const trace = {
        getOpForScan(id) {
            reads++;
            return values.get(id);
        }
    };
    const select = (first, last = first + 15, thread = 0) =>
        selectStoreWaits(trace, index.storeSnapshot(first, last), first, last, thread, signal);
    const original = JSON.stringify(ops);
    assert.equal(index.metadata(1107).lastCycle, 2000, "Trace EOF omitted an observed post-retire completion");
    assert.deepEqual(overviewTotals(index.metadata(1107).overview), { fetched: 4, committed: 4, flushed: 0 });
    assert.deepEqual(await selectOps(trace, index.snapshot(400, 415), 400, 415, 0, signal), []);
    reads = 0;
    assert.deepEqual(await select(400), [
        [0, 0, 6, 1000],
        [2048, 20, 26, 500]
    ]);
    assert.equal(reads, 3, "Store selection scanned unrelated future blocks or nonexistent sparse IDs");
    assert.deepEqual(await select(400, 415, 1), [[1024, 10, 16, 700]]);
    assert.deepEqual(await select(500, 500), [
        [0, 0, 6, 1000],
        [2048, 20, 26, 500]
    ]);
    assert.deepEqual(await select(501), [[0, 0, 6, 1000]]);
    assert.deepEqual(await select(1000, 1000), [[0, 0, 6, 1000]]);
    assert.deepEqual(await select(1001), []);
    assert.deepEqual(
        await select(400),
        [
            [0, 0, 6, 1000],
            [2048, 20, 26, 500]
        ],
        "Reverse seek changed store waits"
    );
    assert.deepEqual(await select(0, 5), [], "Future stores became current waits before retire");
    assert.equal(JSON.stringify(ops), original, "Store observation mutated parser operations");

    const snapshot = index.storeSnapshot(400, 415);
    const added = operation(1, 2, 8, 1500);
    values.set(added.id, added);
    index.observe(added, "gem5");
    assert.deepEqual(await selectStoreWaits(trace, snapshot, 400, 415, 0, signal), [
        [0, 0, 6, 1000],
        [2048, 20, 26, 500]
    ]);
    assert.ok(
        (await select(400)).some(([id]) => id === 1),
        "A fresh store snapshot omitted parser additions"
    );
    const incomplete = createTraceIndex();
    incomplete.observe(ops[0], "gem5");
    assert.equal(incomplete.metadata(7).lastCycle, 7, "Store ticks were converted without observed calibration");
    assert.deepEqual(incomplete.storeSnapshot(400, 415).blocks, []);
    incomplete.observe(ops[2], "gem5");
    assert.equal(incomplete.metadata(27).lastCycle, 1000, "A store written before calibration was lost");
    incomplete.clear();
    incomplete.observe(ops[0], "gem5");
    assert.equal(incomplete.storeSnapshot(400, 415).clock, null, "Closing retained the previous file's clock");

    const dense = createTraceIndex();
    const denseOp = (id) => operation(id, id / 100, 200, 1000);
    for (let id = 0; id <= maxWindowOps; id++) dense.observe(denseOp(id), "gem5");
    await assert.rejects(
        selectStoreWaits({ getOpForScan: denseOp }, dense.storeSnapshot(400, 415), 400, 415, 0, signal),
        /outstanding store writes/
    );
    const originalNow = performance.now;
    let elapsed = 0,
        visits = 0;
    performance.now = () => elapsed;
    const controller = new AbortController();
    try {
        const selecting = selectStoreWaits(
            {
                getOpForScan(id) {
                    visits++;
                    elapsed += 9;
                    return denseOp(id);
                }
            },
            dense.storeSnapshot(400, 415),
            400,
            415,
            0,
            controller.signal
        );
        const rejection = assert.rejects(selecting, { name: "AbortError" });
        assert.equal(visits, 1, "Store scan did not yield after an expensive page read");
        controller.abort();
        await rejection;
    } finally {
        performance.now = originalNow;
    }

    const record = (id, fetch, end) => {
        const tick = 1000 + fetch * 1000;
        return `O3PipeView:fetch:${tick}:0x1000:0:${id + 1}: str x0, [x1]\nO3PipeView:decode:${tick + 1000}\nO3PipeView:rename:${tick + 2000}\nO3PipeView:dispatch:${tick + 3000}\nO3PipeView:issue:${tick + 4000}\nO3PipeView:complete:${tick + 5000}\nO3PipeView:retire:${tick + 6000}:store:${1000 + end * 1000}\n`;
    };
    const box = mailbox(),
        session = createFileSession(box.send);
    try {
        await session.open(new File([record(0, 0, 1000), record(1, 10, 500)], "store-tail.gem5"));
        assert.equal(box.messages.find((message) => message.type === "loaded").source.lastCycle, 1000);
        for (const [id, cycle] of [
            [1, 400],
            [2, 600],
            [3, 400],
            [4, 0],
            [5, 990]
        ]) {
            await session.window({ type: "window", request: id, cycle, span: 16, thread: 0 });
            const converted = box.messages.find((message) => message.type === "window" && message.request === id).trace;
            if (cycle >= 400) {
                assert.deepEqual(converted.ops, [], "A retired store was reinserted into drawable operations");
                assert.deepEqual(converted.storeCompletions, []);
                assert.deepEqual(
                    converted.storeWaits,
                    cycle > 500
                        ? [[0, 0, 6, 1000]]
                        : [
                              [0, 0, 6, 1000],
                              [1, 10, 16, 500]
                          ]
                );
            } else {
                assert.deepEqual(converted.storeCompletions, [
                    [0, 1000],
                    [1, 500]
                ]);
                assert.deepEqual(converted.storeWaits, [
                    [0, 0, 6, 1000],
                    [1, 10, 16, 500]
                ]);
            }
        }
    } finally {
        session.close();
    }
}

async function checkSearch() {
    const index = createTraceIndex(),
        ops = new Map();
    const add = (id, tid = 0) => {
        const op = {
            id,
            tid,
            fetchedCycle: id,
            retiredCycle: id + (id % 4) * 10,
            retired: id % 5 !== 0,
            flush: id % 5 === 0,
            eof: id % 17 === 0,
            labelName: `0xABCD: add x${id}, x2`,
            labelDetail: id === 8 ? "Specific Detail" : "",
            lanes: []
        };
        ops.set(id, op);
        index.observe(op);
    };
    // 先に高IDを入れても、結果は実在IDの昇順とする。
    add(1_000_000_000);
    for (let id = 2999; id >= 0; id--) add(id, id % 2);
    const trace = { getOpForScan: (id) => ops.get(id) },
        signal = new AbortController().signal;
    const search = (kind, query, thread = 0, after) =>
        searchOps(
            trace,
            index.searchSnapshot(after),
            { type: "search", request: 1, kind, query, thread, after },
            "onikiri",
            signal
        );
    const page = await search("text", "0xabCD");
    assert.equal(page.hits.length, maxSearchHits);
    assert.equal(page.more, true);
    assert.deepEqual(
        page.hits.map((hit) => hit.id),
        Array.from({ length: 40 }, (_, index) => index * 2)
    );
    const next = await search("text", "0xabCD", 0, page.hits.at(-1).id);
    assert.equal(next.hits[0].id, 80);
    assert.equal(next.hits.length, maxSearchHits);
    const tail = await search("text", "add", 0, 2990);
    assert.deepEqual(
        tail.hits.map((hit) => hit.id),
        [2992, 2994, 2996, 2998, 1_000_000_000]
    );
    assert.equal(tail.more, false);
    assert.equal((await search("text", "specific DETAIL")).hits[0].id, 8);
    const missing = await search("id", "1000000001");
    assert.deepEqual(missing, { hits: [], more: false });
    assert.equal((await search("id", "1000000000")).hits[0].id, 1_000_000_000);
    assert.equal((await search("id", "1", 0)).hits.length, 0);
    assert.equal((await search("id", "1", 1)).hits[0].tid, 1);
    assert.equal((await search("id", "1000000000", 0, 1_000_000_000)).hits.length, 0);
    assert.equal((await search("id", "0")).hits[0].endCycle, null, "Unfinished search result invented an end");
    assert.ok((await search("flush", "")).hits.every((hit) => hit.flush && hit.id % 5 === 0));
    const long = await search("long", "20");
    assert.ok(long.hits.length);
    assert.ok(long.hits.every((hit) => hit.endCycle !== null && hit.endCycle - hit.cycle >= 20 && hit.id % 17 !== 0));
    for (const [kind, query] of [
        ["text", ""],
        ["id", "-1"],
        ["id", "1.5"],
        ["long", "NaN"],
        ["long", ""],
        ["long", "-1"]
    ])
        await assert.rejects(search(kind, query), /Invalid trace search/);

    // 重いpage復元が8msを超えた時点で検索も中断できる。
    const originalNow = performance.now;
    let elapsed = 0,
        scanned = 0;
    performance.now = () => elapsed;
    try {
        const abort = new AbortController();
        const searching = searchOps(
            {
                getOpForScan(id) {
                    scanned++;
                    elapsed += 9;
                    return ops.get(id);
                }
            },
            index.searchSnapshot(),
            { type: "search", request: 1, kind: "text", query: "missing", thread: 0 },
            "onikiri",
            abort.signal
        );
        abort.abort();
        await assert.rejects(searching, { name: "AbortError" });
        assert.equal(scanned, 1, "Search did not yield after an expensive page read");
    } finally {
        performance.now = originalNow;
    }
    const snapshot = index.searchSnapshot(2998);
    add(2_000_000_000);
    const captured = await searchOps(
        trace,
        snapshot,
        { type: "search", request: 1, kind: "text", query: "add", thread: 0, after: 2998 },
        "onikiri",
        signal
    );
    assert.deepEqual(
        captured.hits.map((hit) => hit.id),
        [1_000_000_000],
        "Parser writes expanded a search snapshot"
    );
}

async function checkSearchSession() {
    const box = mailbox(),
        session = createFileSession(box.send);
    const input = controlledInput("Kanata\t0004\n" + kanataOp(0) + `L\t0\t0\t late label\n`);
    const opening = session.open(input);
    const search = (id, kind = "text", query = "add") => ({ type: "search", request: id, kind, query, thread: 0 });
    try {
        const partial = await box.wait((m) => m.type === "loaded");
        assert.deepEqual(overviewTotals(partial.source.overview), { fetched: 1, committed: 1, flushed: 0 });
        await session.search(search(1));
        assert.equal(input.finished, false, "Search waited for EOF");
        assert.equal(box.messages.find((m) => m.type === "search").hits[0].id, 0);
        const old = session.search(search(2));
        const rejected = assert.rejects(old, { name: "AbortError" });
        await session.search(search(3, "id", "0"));
        await rejected;
        assert.ok(!box.messages.some((m) => m.type === "search" && m.request === 2));
        const cancel = session.search(search(4));
        const canceled = assert.rejects(cancel, { name: "AbortError" });
        session.cancelSearch();
        await canceled;
        await assert.rejects(session.search({ ...search(5), thread: 99 }), /Invalid trace search thread/);
        // ズームで得た整数幅を受理し、上下限と小数は拒否する。
        await session.window({ ...request(6), span: 37 });
        for (const span of [15, 513, 16.5, Infinity])
            await assert.rejects(session.window({ ...request(7), span }), /Invalid trace window/);
        input.finish();
        await opening;
        assert.deepEqual(overviewTotals(box.messages.filter((m) => m.type === "loaded").at(-1).source.overview), {
            fetched: 1,
            committed: 1,
            flushed: 0
        });
    } finally {
        session.close();
    }
}

// EOFをテスト側で保持する。タイミングの速さではなく、閉じていない入力への応答を検査する。
function controlledInput(first, name = "stream.kanata") {
    const controllers = new Set();
    let canceled = 0,
        streams = 0,
        finished = false;
    return {
        name,
        size: first.length * 2,
        type: "",
        stream() {
            streams++;
            let current;
            return new ReadableStream({
                start(controller) {
                    current = controller;
                    controllers.add(controller);
                    controller.enqueue(new TextEncoder().encode(first));
                },
                cancel() {
                    canceled++;
                    controllers.delete(current);
                }
            });
        },
        append(text) {
            for (const controller of controllers) controller.enqueue(new TextEncoder().encode(text));
        },
        finish() {
            finished = true;
            for (const controller of controllers) controller.close();
            controllers.clear();
        },
        get finished() {
            return finished;
        },
        get canceled() {
            return canceled;
        },
        get streams() {
            return streams;
        }
    };
}
function mailbox() {
    const messages = [],
        waiting = new Set();
    return {
        messages,
        send(message) {
            messages.push(message);
            for (const waiter of waiting) if (waiter.predicate(message)) waiter.resolve(message);
        },
        wait(predicate) {
            const previous = messages.find(predicate);
            if (previous) return Promise.resolve(previous);
            return new Promise((resolve, reject) => {
                const waiter = {
                    predicate,
                    resolve(message) {
                        clearTimeout(timer);
                        waiting.delete(waiter);
                        resolve(message);
                    }
                };
                const timer = setTimeout(() => {
                    waiting.delete(waiter);
                    reject(new Error(`No matching trace response: ${JSON.stringify(messages.map((m) => m.type))}`));
                }, 5000);
                waiting.add(waiter);
            });
        }
    };
}
function kanataOp(id, end = true) {
    return (
        `I\t${id}\t${id}\t0\nL\t${id}\t0\tadd x1, x2\nS\t${id}\t0\tF\nC\t1\nE\t${id}\t0\tF\nS\t${id}\t0\tX\nC\t1\n` +
        (end ? `R\t${id}\t${id}\t0\n` : "")
    );
}
const request = (id, cycle = 0) => ({ type: "window", request: id, cycle, span: 16, thread: 0 });

// 安価な走査は件数だけで止めず、重いpageでは同じblockの途中で制御を返す。
async function checkScanCancellation() {
    const blocks = [
        { firstID: 0, lastID: 1023, firstCycle: 0, lastCycle: 2048, ids: new Uint32Array(32).fill(0xffffffff) }
    ];
    for (const byTime of [false, true]) {
        const originalNow = performance.now;
        let elapsed = 0;
        performance.now = () => elapsed;
        try {
            for (const preview of [false, true]) {
                const controller = new AbortController();
                let reads = 0;
                const trace = {
                    getOpForScan(id) {
                        reads++;
                        if (byTime) elapsed += 9;
                        return {
                            id,
                            tid: 0,
                            fetchedCycle: id + 1,
                            retiredCycle: id + 2,
                            labelName: "add",
                            retired: true,
                            flush: false,
                            lanes: []
                        };
                    }
                };
                const selecting = preview
                    ? selectPreview(trace, blocks, 0, 2048, 0, controller.signal)
                    : selectOps(trace, blocks, 0, 2048, 0, controller.signal);
                if (byTime) {
                    const rejection = assert.rejects(selecting, { name: "AbortError" });
                    controller.abort();
                    await rejection;
                    assert.equal(
                        reads,
                        1,
                        `${preview ? "Preview" : "Window"} did not yield after an expensive page read`
                    );
                } else {
                    assert.equal(reads, 1024, "A cheap scan yielded solely because of its instruction count");
                    await selecting;
                }
            }
        } finally {
            performance.now = originalNow;
        }
    }
}

async function checkWindowCancellation() {
    const prefix = "Kanata\t0004\n" + Array.from({ length: 512 }, (_, id) => kanataOp(id)).join("");
    const input = controlledInput(prefix, "window-cancel.kanata"),
        box = mailbox(),
        session = createFileSession(box.send);
    const opening = session.open(input);
    try {
        await box.wait((message) => message.type === "loaded" && message.source.opCount === 512);
        const originalNow = performance.now;
        let elapsed = 0;
        performance.now = () => ++elapsed;
        try {
            const first = session.window(request(100));
            const canceledFirst = assert.rejects(first, { name: "AbortError" });
            session.cancelWindow();
            await canceledFirst;
            assert.ok(!box.messages.some((message) => message.type === "window" && message.request === 100));

            const old = session.window(request(101));
            const oldRejected = assert.rejects(old, { name: "AbortError" });
            const latest = session.window(request(102, 200));
            const latestRejected = assert.rejects(latest, { name: "AbortError" });
            await oldRejected;
            session.cancelWindow();
            await latestRejected;
            assert.ok(
                !box.messages.some((message) => message.type === "window"),
                "A canceled window emitted an old result"
            );
        } finally {
            performance.now = originalNow;
        }

        // 旧要求の終了後も新しいcontrollerを保持し、Parserと別の操作は使い続けられる。
        await session.window(request(103, 400));
        assert.ok(box.messages.some((message) => message.type === "window" && message.request === 103));
        assert.equal(input.canceled, 0, "Window cancellation closed the parser's source stream");
        input.append(kanataOp(512));
        await box.wait((message) => message.type === "loaded" && message.source.opCount === 513);
        input.finish();
        await opening;
        assert.equal(box.messages.filter((message) => message.type === "loaded").at(-1).source.complete, true);
        await session.search({ type: "search", request: 104, kind: "id", query: "512", thread: 0 });
        assert.equal(
            box.messages.find((message) => message.type === "search" && message.request === 104).hits[0].id,
            512
        );

        const closing = session.window(request(105));
        const closeRejected = assert.rejects(closing, { name: "AbortError" });
        session.close();
        const before = box.messages.length;
        await closeRejected;
        assert.equal(box.messages.length, before, "Closing a running window emitted a late response");
    } finally {
        if (!input.finished) input.finish();
        session.close();
        await opening.catch(() => undefined);
    }
}

async function checkStreaming() {
    const first = "Kanata\t0004\n" + kanataOp(0);
    const tail = kanataOp(1) + kanataOp(2, false);
    const input = controlledInput(first);
    const box = mailbox(),
        session = createFileSession(box.send);
    const opening = session.open(input);
    let settled = false;
    void opening.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        }
    );
    try {
        const partial = await box.wait((m) => m.type === "loaded");
        assert.equal(partial.source.complete, false);
        assert.equal(partial.source.opCount, 1);
        assert.equal(partial.source.parser, "onikiri");
        assert.equal(partial.source.storedBytes, null);
        assert.equal(partial.source.settledCycle, 2);
        await session.window(request(1));
        assert.equal(settled, false, "A cycle window waited for the input's EOF");
        assert.equal(input.finished, false);
        assert.deepEqual(
            box.messages.find((m) => m.type === "window").trace.ops.map((op) => op[0]),
            [0]
        );
        input.append(tail);
        const updated = await box.wait((m) => m.type === "loaded" && m.source.opCount === 2);
        assert.equal(updated.source.complete, false);
        assert.equal(updated.source.settledCycle, 4, "An unpublished instruction was counted as settled");
        await session.window(request(2, 2));
        assert.ok(box.messages.some((m) => m.type === "window" && m.request === 2));
        input.finish();
        await opening;
        const final = await box.wait((m) => m.type === "loaded" && m.source.complete);
        assert.equal(final.source.opCount, 3, "EOF did not include the final unfinished instruction");
        assert.equal(typeof final.source.storedBytes, "number");
        await session.window(request(3));
        const expected = mailbox(),
            whole = createFileSession(expected.send);
        try {
            await whole.open(new File([first, tail], input.name));
            await whole.window(request(3));
            assert.deepEqual(
                box.messages.find((m) => m.type === "window" && m.request === 3).trace,
                expected.messages.find((m) => m.type === "window").trace,
                "Streaming and complete-file loading disagree after EOF"
            );
        } finally {
            whole.close();
        }
    } finally {
        session.close();
    }

    // 最初の命令が未完了なら中間storeは空のまま。完了を捏造して公開しない。
    const unfinished = controlledInput("Kanata\t0004\n" + kanataOp(0, false));
    const canceledBox = mailbox(),
        canceled = createFileSession(canceledBox.send);
    const canceledOpen = canceled.open(unfinished);
    const rejection = assert.rejects(canceledOpen, /canceled/i);
    // Coreの読取り開始を待って取り消し、保留readと公開timerの両方を終える。
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!canceledBox.messages.some((m) => m.type === "loaded"));
    canceled.close();
    const count = canceledBox.messages.length;
    await rejection;
    assert.ok(unfinished.canceled > 0, "Cancel left the source stream open");
    assert.equal(canceledBox.messages.length, count, "Closed session emitted a late response");
    await assert.rejects(canceled.window(request(1)), { name: "AbortError" });

    // gem5はCoreの並べ替えbufferを超えてから中間storeが公開される。
    const gem5 = Array.from({ length: 18500 }, (_, id) => {
        const time = id * 10000 + 1000;
        return `O3PipeView:fetch:${time}:0x1000:0:${id + 1}: add r1, r2\nO3PipeView:decode:${time + 1000}\nO3PipeView:rename:${time + 2000}\nO3PipeView:dispatch:${time + 3000}\nO3PipeView:issue:${time + 4000}\nO3PipeView:complete:${time + 5000}\nO3PipeView:retire:${time + 6000}\n`;
    }).join("");
    const gemInput = controlledInput(gem5, "stream.gem5"),
        gemBox = mailbox();
    const gemSession = createFileSession(gemBox.send),
        gemOpen = gemSession.open(gemInput);
    try {
        const partial = await gemBox.wait((m) => m.type === "loaded");
        assert.equal(partial.source.parser, "gem5");
        assert.equal(partial.source.settledCycle, null, "An unordered gem5 prefix was declared settled");
        assert.equal(partial.source.complete, false);
        assert.equal(gemInput.streams, 2, "The fixed Core's format fallback contract changed");
        await gemSession.window(request(1));
        assert.equal(gemInput.finished, false);
        gemInput.finish();
        await gemOpen;
        assert.equal(gemBox.messages.filter((m) => m.type === "loaded").at(-1).source.opCount, 18500);
    } finally {
        gemSession.close();
    }
}

async function checkSettledPrefix() {
    const input = controlledInput(
        "Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tF\nC\t50\nI\t1\t1\t0\nS\t1\t0\tF\nC\t150\nR\t0\t0\t0\n"
    );
    const box = mailbox(),
        session = createFileSession(box.send);
    const opening = session.open(input);
    try {
        const first = await box.wait((m) => m.type === "loaded");
        assert.equal(first.source.lastCycle, 200);
        assert.equal(first.source.settledCycle, 50, "The oldest unpublished fetch must bound acceleration");
        await session.window(request(1));
        const oldWindow = box.messages.find((m) => m.type === "window").trace;
        assert.equal(oldWindow.playbackSafeUntil, 50);
        assert.deepEqual(
            oldWindow.ops.map((op) => op[0]),
            [0]
        );
        input.append("R\t1\t1\t0\nI\t2\t2\t0\nS\t2\t0\tF\n");
        const sameCycle = await box.wait((m) => m.type === "loaded" && m.source.opCount === 2);
        assert.equal(sameCycle.source.settledCycle, 200, "An unfinished cycle must remain outside the prefix");
        input.append("C\t50\nR\t2\t2\t0\n");
        const nextCycle = await box.wait((m) => m.type === "loaded" && m.source.opCount === 3);
        assert.equal(nextCycle.source.settledCycle, 250);
        assert.equal(oldWindow.playbackSafeUntil, 50, "New parser progress changed an old window's certificate");
        await session.window(request(2));
        assert.equal(box.messages.find((m) => m.type === "window" && m.request === 2).trace.playbackSafeUntil, 250);
        input.append("C\t-1\nI\t3\t3\t0\nR\t3\t3\t0\n");
        await box.wait((m) => m.type === "loaded" && m.source.settledCycle === null);
        await session.window(request(3));
        assert.equal(box.messages.find((m) => m.type === "window" && m.request === 3).trace.playbackSafeUntil, null);
        input.finish();
        await opening;
    } finally {
        session.close();
    }
}

async function checkFileStructure() {
    let cycle = 0;
    const recorded = new Map();
    function instruction(id, label, latency = 1, tid = 0, flush = false) {
        const first = cycle;
        let text = `I\t${id}\t${id}\t${tid}\nL\t${id}\t0\t${label}\n`;
        for (const [name, duration] of [
            ["Np", 1],
            ["F", 1],
            ["Pd", 1],
            ["Dc", 1],
            ["Rn", 1],
            ["Ds", 1],
            ["Sc", 1],
            ["Is", 1],
            ["Rr", 1],
            ["X", latency],
            ["Rw", 1],
            ["Cm", 1]
        ]) {
            text += `S\t${id}\t0\t${name}\nC\t${duration}\nE\t${id}\t0\t${name}\n`;
            cycle += duration;
        }
        text += `R\t${id}\t${id}\t${flush ? 1 : 0}\nC\t8\n`;
        recorded.set(id, { first, end: cycle });
        cycle += 8;
        return text;
    }
    const prefix =
        "Kanata\t0004\n" + Array.from({ length: 600 }, (_, id) => instruction(id, "add x0, x1, x2")).join("");
    const tail =
        instruction(600, "lw x0, 0(x1)", 30) +
        instruction(601, "lw x0, 0(x1)", 3) +
        instruction(602, "sw x0, 0(x1)", 5) +
        instruction(603, "bne x0, x1") +
        instruction(604, "sw x0, 0(x1)", 2, 1) +
        instruction(605, "bne x0, x1", 1, 0, true);
    const box = mailbox(),
        session = createFileSession(box.send),
        input = controlledInput(prefix, "structure.kanata");
    const opening = session.open(input);
    async function window(id, first = 0, thread = 0) {
        await session.window({ type: "window", request: id, cycle: first, span: 16, thread });
        return box.messages.find((message) => message.type === "window" && message.request === id).trace;
    }
    try {
        await box.wait((message) => message.type === "loaded");
        const initial = await window(100);
        assert.deepEqual(initial.displayProfile.memoryKinds, []);
        input.append(tail);
        await box.wait((message) => message.type === "loaded" && message.source.opCount === 606);
        const partial = await window(101);
        assert.equal(input.finished, false, "Global structure inference waited for EOF");
        assert.deepEqual(partial.displayProfile, {
            memoryMinimum: { load: 3, store: 5 },
            memoryKinds: ["load", "store"]
        });
        assert.deepEqual(
            partial.structure.executionNodes.map((node) => node.kind),
            ["integer", "memory", "branch"]
        );
        input.finish();
        await opening;
        const earliest = await window(102);
        assert.deepEqual(earliest.structure, partial.structure, "EOF changed an already observed file structure");
        for (const id of [600, 601, 602, 603]) {
            const later = await window(103 + id, recorded.get(id).first);
            assert.deepEqual(
                later.structure,
                earliest.structure,
                "File stage structure followed the selected instruction kind"
            );
            assert.deepEqual(later.displayProfile, earliest.displayProfile);
        }
        const revisit = await window(200);
        assert.deepEqual(
            revisit.structure,
            earliest.structure,
            "Returning to the file start lost the global structure"
        );
        assert.deepEqual((await window(201, recorded.get(604).first, 1)).displayProfile, {
            memoryMinimum: { load: null, store: 2 },
            memoryKinds: ["store"]
        });
        // 演出用の直前文脈は取得するが、ユーザーが選んだ時刻を変更しない。
        for (const id of [602, 605]) {
            const first = recorded.get(id).end + 2;
            const context = await window(202 + id, first);
            const op = context.ops.find((item) => item[0] === id);
            assert.ok(op, "The prior commit/squash disappeared at a cycle-window boundary");
            assert.equal(op[3], recorded.get(id).end, "Context expansion changed the recorded end time");
            assert.equal(context.firstCycle, first);
            assert.ok(context.lastCycle <= box.messages.filter((m) => m.type === "loaded").at(-1).source.lastCycle);
        }
    } finally {
        input.finish();
        session.close();
    }
}

async function checkConcurrentIndex() {
    const originalNow = performance.now;
    let elapsed = 0;
    performance.now = () => ++elapsed;
    try {
        const index = createTraceIndex(),
            ops = new Map();
        const add = (id) => {
            const op = {
                id,
                tid: 0,
                fetchedCycle: 0,
                retiredCycle: 5,
                retired: true,
                flush: false,
                labelName: `original ${id}`,
                lanes: []
            };
            ops.set(id, op);
            index.observe(op);
        };
        // 偽時計で8msのyieldを跨ぎ、疎な後続blockのIDも固定されることを確認する。
        for (let block = 0; block < 129; block++) add(block * 1024);
        const snapshot = index.snapshot(0, 5);
        const selecting = selectOps(
            { getOpForScan: (id) => ops.get(id) },
            snapshot,
            0,
            5,
            0,
            new AbortController().signal
        );
        ops.get(0).labelName = "updated by parser";
        add(128 * 1024 + 1);
        add(129 * 1024);
        const selected = await selecting;
        assert.equal(selected.length, 129, "Parser writes expanded an in-flight window's ID snapshot");
        assert.equal(selected[0].labelName, "original 0", "Parser mutation changed an already selected operation");
        assert.equal(index.snapshot(0, 5).length, 130);
        const abort = new AbortController();
        const pending = selectOps({ getOpForScan: (id) => ops.get(id) }, index.snapshot(0, 5), 0, 5, 0, abort.signal);
        abort.abort();
        await assert.rejects(pending, { name: "AbortError" });
    } finally {
        performance.now = originalNow;
    }
}

async function checkFlushGroups() {
    const index = createTraceIndex(),
        kanata = createTraceIndex(),
        ops = new Map();
    const add = (id, end, flush = true) => {
        const op = { id, tid: 0, fetchedCycle: 0, retiredCycle: end, retired: !flush, flush, lanes: [] };
        ops.set(id, op);
        index.observe(op, "gem5");
        // gem5はstoreへ2回書く。重複writeで群を分割・二重登録しない。
        index.observe(op, "gem5");
        kanata.observe(op);
    };
    [5, 6, 9, 7].forEach((end, offset) => add(1022 + offset, end));
    const before = index.snapshot(8, 8);
    assert.equal(before.length, 2, "A flush group crossing ID blocks lost its earlier block");
    assert.ok(before.every((block) => block.flushGroups.length === 1));
    add(1026, 12);
    const trace = { getOpForScan: (id) => ops.get(id) },
        signal = new AbortController().signal;
    const oldCycles = new Map();
    const selected = await selectOps(trace, before, 8, 8, 0, signal, oldCycles);
    assert.deepEqual(
        selected.map((op) => op.id),
        [1022, 1023, 1024, 1025]
    );
    assert.deepEqual(
        selected.map((op) => op.retiredCycle),
        [5, 6, 9, 7],
        "Flush inference changed raw timestamps"
    );
    assert.ok(
        [...oldCycles.values()].every((end) => end === 9),
        "Later parsing changed a flush snapshot"
    );
    const cycles = new Map();
    const updated = await selectOps(trace, index.snapshot(11, 11), 11, 11, 0, signal, cycles);
    assert.deepEqual(
        updated.map((op) => op.id),
        [1022, 1023, 1024, 1025, 1026]
    );
    assert.ok([...cycles.values()].every((end) => end === 12));
    assert.deepEqual(
        (await selectOps(trace, kanata.snapshot(11, 11), 11, 11, 0, signal)).map((op) => op.id),
        [1026],
        "gem5-only inference changed Kanata's recorded flush times"
    );

    // 遅れて入る中間IDは隣接群を結合する。間の非flush IDは群をつながない。
    add(20, 30);
    add(22, 35);
    add(21, 40);
    add(23, 45, false);
    add(24, 60);
    const bridged = new Map();
    const at39 = await selectOps(trace, index.snapshot(39, 39), 39, 39, 0, signal, bridged);
    assert.deepEqual(
        at39.map((op) => op.id),
        [20, 21, 22, 23, 24]
    );
    assert.deepEqual(
        [...bridged],
        [
            [20, 40],
            [21, 40],
            [22, 40],
            [24, 60]
        ]
    );
    assert.deepEqual(
        (await selectOps(trace, index.snapshot(50, 50), 50, 50, 0, signal)).map((op) => op.id),
        [24]
    );

    // 異threadの隣接IDや、後から入る橋渡しIDで別threadのsquashを遅らせない。
    const threaded = createTraceIndex(),
        threadedOps = new Map();
    const addThreaded = (id, tid, end) => {
        const op = { id, tid, fetchedCycle: 0, retiredCycle: end, retired: false, flush: true, lanes: [] };
        threadedOps.set(id, op);
        threaded.observe(op, "gem5");
        threaded.observe(op, "gem5");
    };
    const atThread = async (time, tid) => {
        const cycles = new Map();
        await selectOps(
            { getOpForScan: (id) => threadedOps.get(id) },
            threaded.snapshot(time, time),
            time,
            time,
            tid,
            signal,
            cycles
        );
        return [...cycles];
    };
    addThreaded(100, 0, 10);
    addThreaded(101, 1, 90);
    assert.deepEqual(await atThread(50, 0), [], "Another thread extended an instruction's flush lifetime");
    assert.deepEqual(await atThread(50, 1), [[101, 90]]);
    addThreaded(200, 0, 20);
    addThreaded(202, 0, 30);
    addThreaded(201, 1, 100);
    assert.deepEqual(await atThread(50, 0), [], "A different-thread bridge joined two flush groups");
    addThreaded(300, 0, 20);
    addThreaded(302, 1, 60);
    addThreaded(301, 0, 30);
    assert.deepEqual(
        (await atThread(25, 0)).filter(([id]) => id >= 300),
        [
            [300, 30],
            [301, 30]
        ],
        "A same-thread extension also merged the next thread's group"
    );
    addThreaded(400, 0, 20);
    addThreaded(402, 1, 60);
    addThreaded(401, 1, 40);
    assert.deepEqual(await atThread(50, 0), []);
    assert.deepEqual(
        await atThread(50, 1),
        [
            [101, 90],
            [201, 100],
            [302, 60],
            [401, 60],
            [402, 60]
        ],
        "A backward extension did not respect the thread boundary"
    );
}

async function checkWorkerRequests() {
    const box = mailbox();
    const context = vm.createContext({
        postMessage: box.send,
        Error,
        setTimeout,
        require(name) {
            assert.equal(name, "./trace-file.cts");
            return require("../src/trace-file.cts");
        }
    });
    const workerFile = path.join(__dirname, "../src/trace-worker.cts");
    vm.runInContext(stripTypeScriptTypes(fs.readFileSync(workerFile, "utf8"), { mode: "transform" }), context);
    const input = controlledInput("Kanata\t0004\n" + kanataOp(0));
    context.onmessage({ data: { type: "open", file: input } });
    await box.wait((m) => m.type === "loaded");
    context.onmessage({ data: request(1) });
    context.onmessage({ data: request(2) });
    await box.wait((m) => m.type === "window" && m.request === 2);
    assert.equal(input.finished, false, "Worker queued windows behind the complete parse");
    assert.deepEqual(
        box.messages.filter((m) => m.type === "window").map((m) => m.request),
        [2]
    );
    const search = (id, kind = "text", query = "add") => ({ type: "search", request: id, kind, query, thread: 0 });
    context.onmessage({ data: search(1) });
    context.onmessage({ data: request(3) });
    await box.wait((m) => m.type === "window" && m.request === 3);
    await box.wait((m) => m.type === "search" && m.request === 1);
    assert.equal(input.finished, false, "Concurrent search/window requests waited for EOF");
    context.onmessage({ data: search(2) });
    context.onmessage({ data: search(3, "id", "0") });
    await box.wait((m) => m.type === "search" && m.request === 3);
    assert.ok(!box.messages.some((m) => m.type === "search" && m.request === 2));
    context.onmessage({ data: search(4) });
    context.onmessage({ data: { type: "cancel-search" } });
    context.onmessage({ data: search(5, "id", "invalid") });
    const failed = await box.wait((m) => m.type === "error" && m.request === 5);
    assert.equal(failed.operation, "search", "Search errors cannot be distinguished from independent window IDs");
    assert.ok(!box.messages.some((m) => m.type === "search" && m.request === 4));
    context.onmessage({ data: { ...request(5), span: 513 } });
    await box.wait((m) => m.type === "error" && m.request === 5 && m.operation === "window");
    context.onmessage({ data: request(6) });
    context.onmessage({ data: search(6) });
    context.onmessage({ data: { type: "close" } });
    const before = box.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(box.messages.length, before, "Worker responded after close or ran a queued window");
    assert.ok(input.canceled > 0);
}
// scanの完了を手動で保持し、PCの速さに依存せず要求の合流を検査する。
async function checkWorkerCoalescing() {
    const box = mailbox(),
        activity = mailbox(),
        scans = [],
        gates = new Map();
    const context = vm.createContext({
        postMessage: box.send,
        Error,
        setTimeout,
        require(name) {
            assert.equal(name, "./trace-file.cts");
            return {
                createFileSession(send) {
                    function cancelWindow() {
                        for (const gate of gates.values()) gate.reject(new DOMException("Superseded", "AbortError"));
                        gates.clear();
                    }
                    return {
                        async window(request) {
                            scans.push(request.request);
                            activity.send({ type: "scan", request: request.request });
                            try {
                                await new Promise((resolve, reject) => gates.set(request.request, { resolve, reject }));
                                send({ type: "window", request: request.request, trace: {} });
                            } finally {
                                gates.delete(request.request);
                            }
                        },
                        cancelWindow,
                        async search() {
                            throw new Error("Search fixture failure");
                        },
                        close: cancelWindow
                    };
                }
            };
        }
    });
    const workerFile = path.join(__dirname, "../src/trace-worker.cts");
    vm.runInContext(stripTypeScriptTypes(fs.readFileSync(workerFile, "utf8"), { mode: "transform" }), context);
    context.onmessage({ data: request(1) });
    await activity.wait((m) => m.request === 1);
    for (let id = 2; id <= 1000; id++) context.onmessage({ data: request(id) });
    assert.deepEqual(scans, [1], "A second window scanned while the first was running");
    assert.equal(gates.has(1), false, "New window requests did not cancel the running scan");
    await activity.wait((m) => m.request === 1000);
    assert.deepEqual(scans, [1, 1000], "Superseded window requests were still scanned");
    assert.ok(!box.messages.some((m) => m.request === 1), "A superseded window emitted a result or error");

    // 検索は区間の待ち列へ入れず、同一IDのwindowエラーと区別する。
    context.onmessage({ data: { type: "search", request: 1000, kind: "text", query: "x", thread: 0 } });
    await box.wait((m) => m.type === "error" && m.operation === "search" && m.request === 1000);
    gates.get(1000).reject(new Error("Window fixture failure"));
    await box.wait((m) => m.type === "error" && m.operation === "window" && m.request === 1000);
    context.onmessage({ data: request(1001) });
    context.onmessage({ data: request(1002) });
    await activity.wait((m) => m.request === 1002);
    assert.deepEqual(scans, [1, 1000, 1002], "A failed window prevented the latest request from running");

    // ドラッグ開始は現在のscanと待ち列だけを取り消す。その後の区間取得は再開できる。
    context.onmessage({ data: { type: "cancel-window" } });
    assert.equal(gates.has(1002), false, "Explicit cancellation did not abort the active scan");
    context.onmessage({ data: request(1003) });
    context.onmessage({ data: { type: "cancel-window" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(scans, [1, 1000, 1002], "Explicit cancellation left a pending window runnable");
    assert.ok(!box.messages.some((m) => m.request === 1002 || m.request === 1003));
    context.onmessage({ data: request(1004) });
    await activity.wait((m) => m.request === 1004);
    gates.get(1004).resolve();
    await box.wait((m) => m.type === "window" && m.request === 1004);
    context.onmessage({ data: request(1005) });
    await activity.wait((m) => m.request === 1005);
    context.onmessage({ data: request(1006) });
    context.onmessage({ data: { type: "close" } });
    const before = box.messages.length;
    context.onmessage({ data: request(1007) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(scans, [1, 1000, 1002, 1004, 1005], "Close left queued windows runnable");
    assert.equal(box.messages.length, before, "Closed Worker emitted a late scan response");
}
check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

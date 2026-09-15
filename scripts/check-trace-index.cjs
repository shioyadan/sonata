"use strict";
// 区間索引・検索・走査予算を、圧縮storeの代わりの観測可能な小さな入力で検査する。
const assert = require("node:assert/strict");
const {
    createTraceIndex,
    selectOps,
    selectStoreWaits,
    searchOps,
    selectPreview,
    maxWindowOps,
    maxOverviewBins,
    maxSearchHits
} = require("../src/trace-file.cts");
const { overviewTotals, overviewBin } = require("./trace-test.cjs");

async function checkSelection() {
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

async function check() {
    await checkSelection();
    await checkOverview();
    await checkStoreWaits();
    await checkSearch();
    await checkScanCancellation();
    await checkConcurrentIndex();
    await checkFlushGroups();
    console.log(
        "Trace index: bounded overview/search/preview, sparse IDs, carry-in, store waits, snapshots, flush groups and scan cancellation passed"
    );
}
check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

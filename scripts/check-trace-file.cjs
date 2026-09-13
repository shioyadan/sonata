"use strict";
// 区間索引の境界と、全Opを画面用配列に複製しないことをGPUなしで検査する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");
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
    assert.ok(
        ops.some((op) => op.id === 0),
        "Long operation crossing the left boundary was lost"
    );
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
    await checkStreaming();
    await checkConcurrentIndex();
    await checkFlushGroups();
    await checkWorkerRequests();
    console.log(
        "Trace index: sparse IDs, carry-in, flush groups, EOF, streaming windows, parser fallback, snapshots, cancellation and Worker ordering passed"
    );
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

async function checkConcurrentIndex() {
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
    // 9ブロックに分散させ、scanのyieldを確実に跨ぐ。
    for (let block = 0; block < 9; block++) add(block * 1024);
    const snapshot = index.snapshot(0, 5);
    const selecting = selectOps({ getOpForScan: (id) => ops.get(id) }, snapshot, 0, 5, 0, new AbortController().signal);
    ops.get(0).labelName = "updated by parser";
    add(8 * 1024 + 1);
    add(9 * 1024);
    const selected = await selecting;
    assert.equal(selected.length, 9, "Parser writes expanded an in-flight window's ID snapshot");
    assert.equal(selected[0].labelName, "original 0", "Parser mutation changed an already selected operation");
    assert.equal(index.snapshot(0, 5).length, 10);
    const abort = new AbortController();
    const pending = selectOps({ getOpForScan: (id) => ops.get(id) }, index.snapshot(0, 5), 0, 5, 0, abort.signal);
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
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
        [1, 2]
    );
    context.onmessage({ data: request(3) });
    context.onmessage({ data: { type: "close" } });
    const before = box.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(box.messages.length, before, "Worker responded after close or ran a queued window");
    assert.ok(input.canceled > 0);
}
check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

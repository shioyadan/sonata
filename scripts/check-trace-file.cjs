"use strict";
// 実際のパーサーを通し、EOF・逐次入力・区間変換とセッションの取消を検査する。
const assert = require("node:assert/strict");
const { createFileSession, remoteInput } = require("../src/trace-file.cts");
const { overviewTotals, overviewBin, controlledInput, mailbox, kanataOp, request } = require("./trace-test.cjs");

async function checkEOF() {
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
}

async function checkStoreWaitSession() {
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

// 明示注釈も表示するthreadの命令だけに限定する。
async function checkThreadNotices() {
    const lines = ["Kanata\t0004"];
    for (const id of [0, 1]) lines.push(`I\t${id}\t${id}\t${id}`, `S\t${id}\t0\tF`);
    lines.push("C\t1");
    for (const id of [0, 1]) lines.push(`L\t${id}\t1\tBr-pred-miss-ex`);
    lines.push("C\t3");
    for (const id of [0, 1]) lines.push(`E\t${id}\t0\tF`, `R\t${id}\t${id}\t0`);
    const box = mailbox(),
        session = createFileSession(box.send);
    try {
        await session.open(new File([lines.join("\n") + "\n"], "threads.kanata"));
        for (const thread of [0, 1]) {
            await session.window({ type: "window", request: thread, cycle: 0, span: 16, thread });
            const trace = box.messages.find((m) => m.type === "window" && m.request === thread).trace;
            assert.deepEqual(
                trace.demo.events.map((e) => e.id),
                [thread]
            );
            assert.equal(trace.evidence?.registers ?? null, null, "SMT fabricated shared register values");
        }
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
        instruction(605, "bne x0, x1", 1, 0, true) +
        instruction(606, "20000838 r122 = FADD.d(r121, r118)", 4) +
        instruction(607, "add v0.4s, v1.4s, v2.4s", 2);
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
        await box.wait((message) => message.type === "loaded" && message.source.opCount === 608);
        const partial = await window(101);
        assert.equal(input.finished, false, "Global structure inference waited for EOF");
        assert.deepEqual(partial.displayProfile, {
            memoryMinimum: { load: 3, store: 5 },
            memoryKinds: ["load", "store"]
        });
        assert.deepEqual(
            partial.structure.executionNodes.map((node) => node.kind),
            ["integer", "fp", "memory", "branch"]
        );
        input.finish();
        await opening;
        const earliest = await window(102);
        assert.deepEqual(earliest.structure, partial.structure, "EOF changed an already observed file structure");
        for (const id of [600, 601, 602, 603, 606, 607]) {
            const later = await window(103 + id, recorded.get(id).first);
            assert.deepEqual(
                later.structure,
                earliest.structure,
                "File stage structure followed the selected instruction kind"
            );
            assert.deepEqual(later.displayProfile, earliest.displayProfile);
            if (id >= 606) {
                const op = later.ops.find((item) => item[0] === id);
                assert.equal(op[10], "exec-fp");
                assert.deepEqual(op.slice(2, 4), [recorded.get(id).first, recorded.get(id).end]);
                assert.ok(op[6].some((stage) => stage[1] === "exec-fp"));
            }
        }
        const beforeFP = await window(900, recorded.get(606).first - 32);
        assert.equal(
            beforeFP.feedPreview.find((op) => op.id === 606)?.kind,
            "fp",
            "Feed preview lost FP classification"
        );
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

async function checkRemoteStream() {
    const input = { url: "http://127.0.0.1:4173/trace1", name: "remote.kanata", size: 200 };
    for (const invalid of [
        { url: "file:///tmp/trace" },
        { url: "https://user:secret@example.com/trace" },
        { size: 0 },
        { size: Infinity }
    ])
        assert.throws(() => remoteInput({ ...input, ...invalid }), /Invalid trace source/);
    const original = globalThis.fetch;
    const controller = new AbortController();
    const stream = new ReadableStream();
    try {
        globalThis.fetch = async (url, options) => {
            assert.equal(url.href, input.url);
            assert.equal(options.signal, controller.signal);
            assert.equal(options.redirect, "error", "Remote trace followed a redirect");
            // 巨大ログをBlobやArrayBufferへ変換せず、同じbodyを解析器へ渡す。
            return { ok: true, body: stream };
        };
        const remote = remoteInput(input);
        assert.equal(remote.name, input.name);
        assert.equal(remote.size, input.size);
        assert.equal(await remote.stream(controller.signal), stream);
        globalThis.fetch = async () => ({ ok: false, status: 404 });
        await assert.rejects(remote.stream(controller.signal), /Could not load the trace.*404/);
        globalThis.fetch = async () => ({ ok: true, body: null });
        await assert.rejects(remote.stream(controller.signal), /no body/);
    } finally {
        globalThis.fetch = original;
    }
}

async function check() {
    await checkRemoteStream();
    await checkEOF();
    await checkStoreWaitSession();
    await checkSearchSession();
    await checkWindowCancellation();
    await checkStreaming();
    await checkSettledPrefix();
    await checkFileStructure();
    await checkThreadNotices();
    console.log(
        "Trace file: EOF, store waits, streaming windows/search, parser fallback, safe prefixes, structure, notices and session cancellation passed"
    );
}
check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

"use strict";
// Workerの要求合流・取消・応答順序を、描画や実際のスレッドに依存せず検査する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");
const { controlledInput, mailbox, kanataOp, request } = require("./trace-test.cjs");

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

async function check() {
    await checkWorkerRequests();
    await checkWorkerCoalescing();
    console.log(
        "Trace Worker: concurrent requests, coalescing, cancellation, error routing and late response suppression passed"
    );
}
check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

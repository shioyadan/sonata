"use strict";
import files = require("./trace-file.cts");
// 途中の命令を反復転送せず、圧縮storeも区間変換もこのWorkerが所有する。
const send = (response: files.WorkerResponse) => globalThis.postMessage(response);
const session = files.createFileSession(send);
type WindowRequest = Extract<files.WorkerRequest, { type: "window" }>;
let pendingWindow: WindowRequest | null = null;
let runningWindow = false;
let closed = false;

async function run(request: Extract<files.WorkerRequest, { type: "open" | "window" | "search" }>) {
    if (closed) return;
    try {
        if (request.type === "open")
            await session.open("remote" in request ? files.remoteInput(request.remote) : request.file, request.config);
        else if (request.type === "window") await session.window(request);
        else if (request.type === "search") await session.search(request);
    } catch (error) {
        if (closed) return;
        if (error instanceof Error && error.name === "AbortError") return;
        if (request.type === "open") {
            closed = true;
            pendingWindow = null;
            session.close();
        }
        send({
            type: "error",
            request: request.type === "window" || request.type === "search" ? request.request : undefined,
            operation: request.type === "window" || request.type === "search" ? request.type : undefined,
            message: error instanceof Error ? error.message : String(error)
        });
    }
}
async function drainWindows() {
    if (runningWindow || closed) return;
    runningWindow = true;
    try {
        while (pendingWindow && !closed) {
            // Parserの同期処理中に届いた移動も、重いsnapshotの前に最新一つへまとめる。
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (!pendingWindow || closed) break;
            const request = pendingWindow;
            pendingWindow = null;
            await run(request);
        }
    } finally {
        runningWindow = false;
    }
}
globalThis.onmessage = (event: MessageEvent<files.WorkerRequest>) => {
    const request = event.data;
    if (request.type === "close") {
        closed = true;
        pendingWindow = null;
        session.close();
        send({ type: "closed" });
        return;
    }
    if (closed) return;
    if (request.type === "cancel-window") {
        pendingWindow = null;
        session.cancelWindow();
        return;
    }
    if (request.type === "cancel-search") {
        session.cancelSearch();
        return;
    }
    // 入力のEOFを待たずに検索・区間要求を処理する。区間の実行は一つずつ、
    // 未実行の区間は最新一つだけ保持し、低速なscanの後ろに古い移動を積まない。
    if (request.type === "open" || request.type === "search") void run(request);
    else {
        pendingWindow = request;
        session.cancelWindow();
        void drainWindows();
    }
};

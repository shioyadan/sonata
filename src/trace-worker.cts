"use strict";
import files = require("./trace-file.cts");
// 途中の命令を反復転送せず、圧縮storeも区間変換もこのWorkerが所有する。
const send = (response: files.WorkerResponse) => globalThis.postMessage(response);
const session = files.createFileSession(send);
let pendingWindows = Promise.resolve();
let closed = false;
globalThis.onmessage = (event: MessageEvent<files.WorkerRequest>) => {
    const request = event.data;
    if (request.type === "close") {
        closed = true;
        session.close();
        send({ type: "closed" });
        return;
    }
    if (closed) return;
    async function run() {
        if (closed) return;
        try {
            if (request.type === "open") await session.open(request.file);
            else if (request.type === "window") await session.window(request);
        } catch (error) {
            if (closed) return;
            if (error instanceof Error && error.name === "AbortError") return;
            if (request.type === "open") {
                closed = true;
                session.close();
            }
            send({
                type: "error",
                request: request.type === "window" ? request.request : undefined,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }
    // 入力のEOFを待たずに区間要求を処理する。区間同士だけは直列に保つ。
    if (request.type === "open") void run();
    else pendingWindows = pendingWindows.then(run);
};

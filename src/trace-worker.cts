"use strict";
import files = require("./trace-file.cts");
// 途中の命令を反復転送せず、圧縮storeも区間変換もこのWorkerが所有する。
const send = (response: files.WorkerResponse) => globalThis.postMessage(response);
const session = files.createFileSession(send);
let pending = Promise.resolve();
globalThis.onmessage = (event: MessageEvent<files.WorkerRequest>) => {
    const request = event.data;
    if (request.type === "close") {
        session.close();
        send({ type: "closed" });
        return;
    }
    // 同じstoreの選択処理を重ねず、入力を受け取った順に処理する。
    pending = pending.then(async () => {
        try {
            if (request.type === "open") await session.open(request.file);
            else await session.window(request);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") return;
            if (request.type === "open") session.close();
            send({
                type: "error",
                request: request.type === "window" ? request.request : undefined,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    });
};

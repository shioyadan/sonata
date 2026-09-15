"use strict";
// 実Fileの入力とWorker応答をゲートで止め、途中表示と操作・完了の競合を検査する。
import assert = require("node:assert/strict");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor: waitUntil } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;
const reviewImportDrag = require("./load-test.cjs")(
    "check-import-drag.cts"
) as typeof import("./check-import-drag.cts");

async function reviewStreaming(
    window: BrowserWindow,
    openInput: (name: string, bytes: string | Uint8Array) => Promise<void>,
    fixture: (count: number) => string
) {
    const { evaluate } = createBrowserTest(window);
    const waitFor = (condition: browserTest.PageCallback<[], unknown>, message: string) =>
        waitUntil(() => evaluate(condition), message, {
            diagnostics: () =>
                evaluate(({ sonata }) => ({
                    file: sonata.fileImport,
                    status: document.getElementById("import-status")?.textContent
                }))
        });
    const originalSource = await evaluate(() => globalThis.sonataTraceWorkerSource);
    // 実際のFileの後半をWorker内で止める。固定秒数の遅延や巨大fixtureに依存せず、
    // EOF前に描画・操作できることを確認してから残りの入力を渡す。
    const gate = `
            let releaseInput;
            let delayFirstError = false;
            let testFileName = "";
            const inputGate = new Promise(resolve => releaseInput = resolve);
            File.prototype.stream = function () {
                const file = this;
                testFileName = file.name;
                delayFirstError = file.name === "late-error.kanata";
                let offset = 0;
                return new ReadableStream({
                    async pull(controller) {
                        if (offset >= 524288) await inputGate;
                        if (offset >= file.size) { controller.close(); return; }
                        const bytes = new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer());
                        offset += bytes.length;
                        controller.enqueue(bytes);
                    }
                });
            };
        `;
    const receive = `
            const sendTrace = globalThis.postMessage.bind(globalThis);
            let delayedRequest;
            let holdFinal = false;
            let finalWindow;
            globalThis.postMessage = data => {
                if (testFileName === "drag.kanata" && data.type === "window" && data.trace.firstCycle === 600) {
                    finalWindow = data; sendTrace({type: "test-window-held"}); return;
                }
                if (data.type === "loaded" && data.source.complete && testFileName === "incremental.kanata") holdFinal = true;
                if (holdFinal && data.type === "window") {
                    holdFinal = false; finalWindow = data; sendTrace({type: "test-final-held"}); return;
                }
                if (delayFirstError && data.type === "window") {
                    delayFirstError = false;
                    delayedRequest = data.request;
                    sendTrace({ type: "test-window-held" });
                    return;
                }
                sendTrace(data);
                if (data.type === "loaded" && data.source.complete && delayedRequest !== undefined) {
                    sendTrace({ type: "error", request: delayedRequest, message: "Partial window unavailable" });
                    delayedRequest = undefined;
                }
            };
            const receiveTrace = globalThis.onmessage;
            globalThis.onmessage = event => {
                if (event.data.type === "release-test-input") releaseInput();
                else if (event.data.type === "release-test-window") { sendTrace(finalWindow); finalWindow = null; }
                else receiveTrace(event);
            };
        `;
    async function captureWorker() {
        await evaluate(() => {
            const context = globalThis as typeof globalThis & {
                importTestWorker?: Worker;
                importTestHeld?: boolean;
                importTestFinalHeld?: boolean;
            };
            const NativeWorker = Worker;
            context.importTestHeld = false;
            context.importTestFinalHeld = false;
            globalThis.Worker = new Proxy(NativeWorker, {
                construct(Target, args) {
                    const instance = new Target(...(args as [string | URL, WorkerOptions?]));
                    context.importTestWorker = instance;
                    instance.addEventListener("message", (event) => {
                        if (event.data.type === "test-window-held") context.importTestHeld = true;
                        if (event.data.type === "test-final-held") context.importTestFinalHeld = true;
                    });
                    globalThis.Worker = NativeWorker;
                    return instance;
                }
            });
        });
    }
    try {
        await captureWorker();
        await evaluate(
            (_page, source) => {
                globalThis.sonataTraceWorkerSource = source;
            },
            gate + originalSource + receive
        );
        const contents = fixture(6000);
        assert.ok(Buffer.byteLength(contents) > 524288);
        await openInput("incremental.kanata", contents);
        await waitFor(
            ({ sonata }) =>
                sonata.trace.key === "local-file" &&
                sonata.fileImport.source?.complete === false &&
                !sonata.fileImport.selecting,
            "No trace was displayed before the input reached EOF"
        );
        const partial = await evaluate(({ sonata }) => ({
            count: sonata.fileImport.source!.opCount,
            loading: sonata.fileImport.loading,
            message: document.getElementById("file-partial")!.hidden,
            cancel: document.getElementById("import-cancel")!.hidden
        }));
        assert.ok(partial.count > 0 && partial.count < 6001);
        assert.ok(partial.loading && !partial.message && !partial.cancel);
        await evaluate(async ({ sonata }) => {
            sonata.captureAt(10);
            sonata.setPlaying(true);
            await new Promise((resolve) => setTimeout(resolve, 800));
            sonata.setPlaying(false);
        });
        assert.ok(
            await evaluate(({ sonata }) => sonata.cycle > 10 && sonata.cycle < 20 && sonata.fileImport.loading),
            "Background parsing was treated as a confirmed empty gap"
        );
        await evaluate(() => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = "600";
            document.getElementById("file-go")!.click();
        });
        await waitFor(
            ({ sonata }) => sonata.trace.firstCycle === 600 && !sonata.fileImport.selecting,
            "Seeking was blocked by background trace loading"
        );
        await evaluate(({ sonata }) => {
            sonata.captureAt(620.5);
            sonata.setPlaying(true);
        });
        await waitFor(
            ({ sonata }) => sonata.cycle > 621 && sonata.fileImport.loading,
            "Playback did not advance while the file was loading"
        );
        await evaluate(({ sonata }) => {
            sonata.setPlaying(false);
            sonata.captureAt(621.5);
            document.getElementById("file-bookmark")!.click();
            const name = document.querySelector("#file-bookmarks input") as HTMLInputElement;
            name.focus();
            name.value = "Editing during parsing";
            (globalThis as typeof globalThis & { importTestWorker: Worker }).importTestWorker.postMessage({
                type: "release-test-input"
            });
        });
        await waitFor(
            () => Boolean((globalThis as typeof globalThis & { importTestFinalHeld?: boolean }).importTestFinalHeld),
            "Final refresh was not held"
        );
        assert.ok(
            await evaluate(
                () =>
                    document.activeElement === document.querySelector("#file-bookmarks input") &&
                    (document.activeElement as HTMLInputElement).value === "Editing during parsing"
            ),
            "A source update replaced the bookmark being edited"
        );
        await evaluate(() => {
            const timeline = document.getElementById("timeline") as HTMLInputElement;
            timeline.value = "621.75";
            timeline.dispatchEvent(new Event("input"));
            (globalThis as typeof globalThis & { importTestWorker: Worker }).importTestWorker.postMessage({
                type: "release-test-window"
            });
        });
        await waitFor(({ sonata }) => !sonata.fileImport.busy, "Background loading did not finish");
        const complete = await evaluate(({ sonata }) => ({
            complete: sonata.fileImport.source!.complete,
            count: sonata.fileImport.source!.opCount,
            start: sonata.trace.firstCycle,
            cycle: sonata.cycle,
            finite: sonata.particles.every((p) => p.position.every(Number.isFinite)),
            hidden: document.getElementById("file-partial")!.hidden,
            status: document.getElementById("import-status")!.textContent
        }));
        assert.equal(complete.complete, true);
        assert.equal(complete.count, 6001);
        assert.equal(complete.start, 600);
        assert.equal(complete.cycle, 621.75, "Finishing background loading reset the playback position");
        assert.ok(complete.finite && complete.hidden);
        assert.equal(complete.status, "");
        // 一度途中表示ができた後でも、Cancelは表示とstoreをまとめて閉じる。
        await openInput("incremental.kanata", contents);
        await waitFor(
            ({ sonata }) =>
                sonata.trace.key === "local-file" &&
                sonata.fileImport.source?.complete === false &&
                !sonata.fileImport.selecting,
            "The second background import did not become usable"
        );
        await evaluate(() => document.getElementById("import-cancel")!.click());
        assert.ok(
            await evaluate(
                ({ sonata }) =>
                    sonata.trace.key === "rename-rush" &&
                    sonata.fileImport.source === null &&
                    !sonata.fileImport.busy &&
                    !document.querySelector('#trace-select option[value="local-file"]')
            ),
            "Cancel left a partially imported trace selected"
        );
        // 解析完了と古いwindow応答が、ネイティブrangeのドラッグに重なる。
        await captureWorker();
        await openInput("drag.kanata", contents);
        await waitFor(
            ({ sonata }) =>
                sonata.trace.key === "local-file" && sonata.fileImport.loading && !sonata.fileImport.selecting,
            "The drag fixture did not become usable before EOF"
        );
        await reviewImportDrag(window);

        // 最終loadedと古い部分windowの失敗が交差しても、完成した区間を再取得する。
        // 一度も部分表示できなかった場合はデモの時刻を引き継がず、区間先頭から表示する。
        await captureWorker();
        await openInput("late-error.kanata", contents);
        await waitFor(
            () => Boolean((globalThis as typeof globalThis & { importTestHeld?: boolean }).importTestHeld),
            "The partial window was not held for the completion race"
        );
        await evaluate(() =>
            (globalThis as typeof globalThis & { importTestWorker: Worker }).importTestWorker.postMessage({
                type: "release-test-input"
            })
        );
        await waitFor(
            ({ sonata }) => !sonata.fileImport.busy && sonata.trace.key === "local-file",
            "The final trace was lost after a late partial-window error"
        );
        assert.equal(await evaluate(({ sonata }) => sonata.cycle), 0);
        assert.equal(await evaluate(() => document.getElementById("import-status")!.textContent), "");
        return {
            playbackBeforeEOF: true,
            seekBeforeEOF: true,
            preservePositionAtEOF: true,
            canceledAfterPartial: true,
            nativeDrag: true,
            lateError: true
        };
    } finally {
        await evaluate((_page, source) => {
            const context = globalThis as typeof globalThis & {
                importTestWorker?: Worker;
                importTestHeld?: boolean;
                importTestFinalHeld?: boolean;
            };
            context.importTestWorker?.postMessage({ type: "release-test-input" });
            delete context.importTestWorker;
            delete context.importTestHeld;
            delete context.importTestFinalHeld;
            globalThis.sonataTraceWorkerSource = source;
            document.getElementById("file-close")!.click();
        }, originalSource);
    }
}
export = reviewStreaming;

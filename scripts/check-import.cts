"use strict";
import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import zlib = require("node:zlib");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor: waitUntil } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;
const reviewNavigation = require("./load-test.cjs")("check-navigation.cts") as typeof import("./check-navigation.cts");
const reviewFilePlayback = require("./load-test.cjs")(
    "check-file-playback.cts"
) as typeof import("./check-file-playback.cts");
const reviewImportDrag = require("./load-test.cjs")(
    "check-import-drag.cts"
) as typeof import("./check-import-drag.cts");
const reviewEmptyPlayback = require("./load-test.cjs")(
    "check-empty-playback.cts"
) as typeof import("./check-empty-playback.cts");
const reviewWaitPlayback = require("./load-test.cjs")(
    "check-wait-playback.cts"
) as typeof import("./check-wait-playback.cts");

// 外部の実トレースをCIへ持ち込まず、形式・圧縮・区間移動を実際のFile入力で検査する。
function fixture(count = 320) {
    const lines = ["Kanata\t0004", "C=\t100"];
    for (let id = 0; id < count; id++) {
        lines.push(
            `I\t${id}\t${id}\t${id % 2}`,
            `L\t${id}\t0\t0x1000: add r1, r2, r3`,
            `S\t${id}\t0\tF`,
            "C\t1",
            `E\t${id}\t0\tF`,
            `S\t${id}\t0\tX`,
            "C\t1",
            `E\t${id}\t0\tX`,
            `R\t${id}\t${id}\t0`
        );
    }
    lines.push("C\t1000", `I\t${count}\t${count}\t0`, `L\t${count}\t0\tunfinished add`, `S\t${count}\t0\tF`, "C\t2");
    return lines.join("\n") + "\n";
}
async function reviewImport(window: BrowserWindow, screenshots: string) {
    const test = createBrowserTest(window);
    const { evaluate } = test;
    await evaluate(({ sonata }) => sonata.loadTrace("rename-rush"));
    const waitFor = (
        condition: browserTest.PageCallback<[], unknown>,
        message: string,
        options: Parameters<typeof waitUntil>[2] = {}
    ) =>
        waitUntil(() => evaluate(condition), message, {
            diagnostics: () =>
                evaluate(() => ({
                    status: document.getElementById("import-status")?.textContent,
                    file: globalThis.sonata?.fileImport
                })),
            ...options
        });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-import-"));
    const contents = fixture();
    const debuggerAPI = window.webContents.debugger;
    debuggerAPI.attach("1.3");
    const importFile = async (name: string, bytes: string | Uint8Array) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, bytes);
        const { root } = await debuggerAPI.sendCommand("DOM.getDocument");
        const { nodeId } = await debuggerAPI.sendCommand("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: "#trace-file"
        });
        await debuggerAPI.sendCommand("DOM.setFileInputFiles", { nodeId, files: [file] });
        await waitFor(
            ({ sonata }) => sonata.trace.key === "local-file" && !sonata.fileImport.busy,
            `Trace import failed: ${name}`,
            { timeout: 30000, diagnostics: () => evaluate(() => document.getElementById("import-status")?.textContent) }
        );
    };
    async function checkIncremental() {
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
            const file = path.join(dir, "incremental.kanata");
            fs.writeFileSync(file, fixture(6000));
            assert.ok(fs.statSync(file).size > 524288);
            const { root } = await debuggerAPI.sendCommand("DOM.getDocument");
            const { nodeId } = await debuggerAPI.sendCommand("DOM.querySelector", {
                nodeId: root.nodeId,
                selector: "#trace-file"
            });
            await debuggerAPI.sendCommand("DOM.setFileInputFiles", { nodeId, files: [file] });
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
                () =>
                    Boolean((globalThis as typeof globalThis & { importTestFinalHeld?: boolean }).importTestFinalHeld),
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
            await debuggerAPI.sendCommand("DOM.setFileInputFiles", { nodeId, files: [file] });
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
            const dragFile = path.join(dir, "drag.kanata");
            fs.writeFileSync(dragFile, fixture(6000));
            await debuggerAPI.sendCommand("DOM.setFileInputFiles", { nodeId, files: [dragFile] });
            await waitFor(
                ({ sonata }) =>
                    sonata.trace.key === "local-file" && sonata.fileImport.loading && !sonata.fileImport.selecting,
                "The drag fixture did not become usable before EOF"
            );
            await reviewImportDrag(window);

            // 最終loadedと古い部分windowの失敗が交差しても、完成した区間を再取得する。
            // 一度も部分表示できなかった場合はデモの時刻を引き継がず、区間先頭から表示する。
            await captureWorker();
            const late = path.join(dir, "late-error.kanata");
            fs.writeFileSync(late, fixture(6000));
            await debuggerAPI.sendCommand("DOM.setFileInputFiles", { nodeId, files: [late] });
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
    try {
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        await importFile("<local> & trace.kanata", contents);
        const initial = await evaluate(({ sonata }) => ({
            source: sonata.fileImport.source,
            ops: sonata.trace.ops,
            trace: sonata.trace
        }));
        assert.equal(initial.source?.opCount, 321);
        assert.deepEqual(initial.source?.threads, [0, 1]);
        assert.ok(initial.ops.length < 100, "The whole file was copied into the replay");
        assert.equal(initial.trace.demo.provenance.workloadKnown, false);
        assert.ok(!initial.trace.evidence?.registers && !initial.trace.topDown);
        await evaluate(({ sonata }) => sonata.captureAt(sonata.trace.firstCycle + 0.5));
        assert.ok(
            await evaluate(
                ({ sonata }) =>
                    sonata.particles.length > 0 && sonata.particles.every((p) => p.position.every(Number.isFinite))
            )
        );

        const navigation = await reviewNavigation(window, contents);

        await evaluate(() => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = "600";
            document.getElementById("file-go")!.click();
        });
        await waitFor(
            ({ sonata }) => !sonata.fileImport.busy && sonata.trace.firstCycle === 600,
            "Cycle jump did not finish"
        );
        assert.ok(await evaluate(({ sonata }) => sonata.trace.ops.some((op) => op[0] >= 250)));
        await evaluate(() => {
            const thread = document.getElementById("file-thread") as HTMLSelectElement;
            thread.value = "1";
            thread.dispatchEvent(new Event("change"));
        });
        await waitFor(({ sonata }) => !sonata.fileImport.busy, "Thread switch did not finish");
        assert.ok(await evaluate(({ sonata }) => sonata.trace.ops.every((op) => op[0] % 2 === 1)));

        await importFile("trace.kanata.gz", zlib.gzipSync(contents));
        assert.deepEqual(
            await evaluate(({ sonata }) => sonata.trace.ops),
            initial.ops,
            "gzip changed recorded operations"
        );
        // Zstdも同梱WASMと入れ子Workerから読み込めることを確認する。
        const { Zstd } = await import("@hpcc-js/wasm-zstd");
        const zstd = await Zstd.load();
        await importFile("trace.kanata.zst", zstd.compress(new TextEncoder().encode(contents)));
        assert.deepEqual(
            await evaluate(({ sonata }) => sonata.trace.ops),
            initial.ops,
            "zstd changed recorded operations"
        );
        await evaluate(() => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = "1000";
            document.getElementById("file-go")!.click();
        });
        await waitFor(
            ({ sonata }) => !sonata.fileImport.busy && sonata.trace.firstCycle === 1000,
            "Empty interval did not load"
        );
        assert.deepEqual(await evaluate(({ sonata }) => sonata.trace.ops), []);
        await evaluate(() => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = "1640";
            document.getElementById("file-go")!.click();
        });
        await waitFor(
            ({ sonata }) => !sonata.fileImport.busy && sonata.trace.firstCycle === 1640,
            "EOF interval did not load"
        );
        await evaluate(({ sonata }) => sonata.captureAt(sonata.trace.lastCycle));
        const eof = await evaluate(({ sonata }) => ({
            ops: sonata.trace.ops,
            pieces: sonata.particles.map((p) => ({ id: p.id, position: p.position })),
            commits: sonata.commitSlots.filter((slot) => slot.id !== null)
        }));
        assert.equal(eof.ops.length, 1);
        assert.equal(eof.ops[0][12], true);
        assert.equal(eof.pieces.length, 1, "Unfinished instruction disappeared at EOF");
        assert.ok(eof.pieces[0].position.every(Number.isFinite));
        assert.deepEqual(eof.commits, [], "EOF invented a commit");

        await evaluate(() => {
            const data = new DataTransfer();
            data.items.add(
                new File(
                    [
                        "O3PipeView:fetch:1000:0x00001000:0:10: add r1, r2\nO3PipeView:decode:2000\nO3PipeView:rename:3000\nO3PipeView:dispatch:4000\nO3PipeView:issue:5000\nO3PipeView:complete:6000\nO3PipeView:retire:7000\n"
                    ],
                    "gem5.log"
                )
            );
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
        });
        await waitFor(
            ({ sonata }) => !sonata.fileImport.busy && sonata.trace.parser.startsWith("gem5"),
            "gem5 file drop failed"
        );
        assert.equal(await evaluate(({ sonata }) => sonata.trace.ops.length), 1);
        await evaluate(({ sonata }) => sonata.captureAt(sonata.trace.firstCycle + 1));
        await test.settle({ finish: true });
        fs.writeFileSync(path.join(screenshots, "sonata-import.png"), (await window.webContents.capturePage()).toPNG());

        const memoryFile = [
            { name: "ldr w0, [x1]", complete: 12000 },
            { name: "ldr w2, [x3]", complete: 6000 },
            { name: "str w0, [x4]", complete: 6000 }
        ]
            .map(
                ({ name, complete }, id) =>
                    [
                        `O3PipeView:fetch:1000:0x1000:0:${id + 1}: ${name}`,
                        "O3PipeView:decode:2000",
                        "O3PipeView:rename:3000",
                        "O3PipeView:dispatch:4000",
                        "O3PipeView:issue:5000",
                        `O3PipeView:complete:${complete}`,
                        `O3PipeView:retire:${15000 + id * 1000}`
                    ].join("\n") + "\n"
            )
            .join("");
        await importFile("memory.o3", memoryFile);
        for (const style of ["neon", "aluminum", "paper"]) {
            await evaluate(({ sonata }, name) => {
                document.getElementById(`style-${name}`)!.click();
                sonata.captureAt(5.5);
            }, style);
            const labels = await evaluate(() =>
                [...document.querySelectorAll(".memory-label")].map((element) => {
                    const r = element.getBoundingClientRect();
                    return { text: element.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                })
            );
            assert.equal(labels.length, 3, "Imported memory stages did not produce LOAD / STORE / WAIT labels");
            for (let i = 0; i < labels.length; i++)
                for (let j = i + 1; j < labels.length; j++) {
                    const a = labels[i],
                        b = labels[j];
                    assert.ok(
                        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
                        `Imported memory labels overlap in ${style}: ${a.text} / ${b.text}`
                    );
                }
        }

        await importFile(
            "gem5-eof.log",
            "O3PipeView:fetch:1000:0x1000:0:1: add r1, r2\nO3PipeView:decode:2000\nO3PipeView:rename:3000\nO3PipeView:dispatch:4000\nO3PipeView:issue:5000\nO3PipeView:complete:6000\nO3PipeView:retire:7000\nO3PipeView:fetch:11000:0x1004:0:2: add r1, r2\nO3PipeView:decode:12000\nO3PipeView:rename:13000\nO3PipeView:dispatch:14000\nO3PipeView:issue:15000\n"
        );
        const gem5End = await evaluate(({ sonata }) => {
            sonata.captureAt(sonata.trace.lastCycle);
            return {
                cycle: sonata.cycle,
                count: sonata.trace.ops.length,
                active: sonata.particles.map((p) => p.id),
                finite: sonata.particles.every((p) => p.position.every(Number.isFinite)),
                commits: sonata.commitSlots.filter((s) => s.id !== null),
                titles: [...document.querySelectorAll("#op-progress i")].map((e) => (e as HTMLElement).title)
            };
        });
        assert.equal(gem5End.cycle, 14);
        assert.equal(gem5End.count, 2);
        assert.deepEqual(gem5End.active, [1]);
        assert.ok(gem5End.finite);
        assert.deepEqual(gem5End.commits, []);
        assert.ok(gem5End.titles.every((title) => !title.includes("Infinity")));

        const bounds = window.getBounds();
        for (const [width, height] of [
            [320, 568],
            [390, 844],
            [620, 430],
            [932, 430]
        ]) {
            window.setSize(width, height);
            await waitFor(
                () =>
                    document.getElementById("mobile-details")!.getBoundingClientRect().width > 0 &&
                    Boolean(document.querySelector("#mobile-panel #file-tools")),
                "Mobile trace tools did not appear"
            );
            // 二段時間軸と再生は設定dialogを開かずに操作できる。
            const visible = await evaluate(() =>
                [
                    "file-overview",
                    "file-previous",
                    "file-next",
                    "file-zoom-in",
                    "file-zoom-out",
                    "file-first",
                    "file-last",
                    "timeline",
                    "play",
                    "scene"
                ].map((id) => {
                    const r = document.getElementById(id)!.getBoundingClientRect();
                    return {
                        id,
                        x: r.x,
                        y: r.y,
                        right: r.right,
                        bottom: r.bottom,
                        width: r.width,
                        height: r.height,
                        vw: innerWidth,
                        vh: innerHeight
                    };
                })
            );
            assert.ok(
                visible.every(
                    (r) =>
                        r.x >= 0 &&
                        r.y >= 0 &&
                        r.right <= r.vw + 1 &&
                        r.bottom <= r.vh + 1 &&
                        r.width > 0 &&
                        r.height > 0
                ),
                `Mobile timelines or scene are clipped: ${JSON.stringify(visible)}`
            );
            assert.ok(
                visible.filter((r) => r.id.startsWith("file-")).every((r) => r.width >= 44 && r.height >= 44),
                `Mobile file targets are too small: ${JSON.stringify(visible)}`
            );
            assert.ok(
                visible.find((r) => r.id === "timeline")!.bottom <= visible.find((r) => r.id === "file-overview")!.y,
                "The detail timeline should be above the trace overview on mobile"
            );
            if (width > 600) {
                assert.ok(
                    await evaluate(() => {
                        const controls = document.getElementById("file-detail-controls")!.getBoundingClientRect();
                        const playback = document.querySelector(".playback")!.getBoundingClientRect();
                        const flush = document.getElementById("next-flush")!.getBoundingClientRect();
                        return [playback, flush].every(
                            (neighbor) =>
                                controls.left >= neighbor.right ||
                                controls.right <= neighbor.left ||
                                controls.top >= neighbor.bottom ||
                                controls.bottom <= neighbor.top
                        );
                    }),
                    "Landscape window controls overlap playback controls"
                );
            }
            await evaluate(() => {
                (document.querySelector(".file-navigation-options") as HTMLDetailsElement).open = true;
            });
            const controls = await evaluate(() =>
                ["file-cycle", "file-span", "file-go", "file-close"].map((id) => {
                    const r = document.getElementById(id)!.getBoundingClientRect();
                    return { id, x: r.x, right: r.right, width: r.width, height: r.height, viewport: innerWidth };
                })
            );
            assert.ok(
                controls.every((r) => r.x >= 0 && r.right <= r.viewport && r.width >= 44 && r.height >= 44),
                `Mobile navigation controls are clipped: ${JSON.stringify(controls)}`
            );
            await evaluate(() => {
                (document.querySelector(".file-navigation-options") as HTMLDetailsElement).open = false;
                document.getElementById("mobile-details")!.click();
            });
            await waitFor(
                () =>
                    (document.getElementById("mobile-panel") as HTMLDialogElement).open &&
                    Boolean(document.querySelector("#mobile-panel #file-tools")),
                "Search tools did not open in mobile settings"
            );
            await evaluate(() => document.getElementById("mobile-close")!.click());
            await test.settle();
            fs.writeFileSync(
                path.join(screenshots, `sonata-import-mobile-${width}.png`),
                (await window.webContents.capturePage()).toPNG()
            );
        }
        window.setBounds(bounds);
        await waitFor(
            () =>
                !(document.getElementById("mobile-panel") as HTMLDialogElement).open &&
                Boolean(document.querySelector("main .telemetry #file-tools")),
            "Trace tools did not return to desktop"
        );

        await evaluate(() => {
            globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
            globalThis.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        assert.ok(
            await evaluate(
                ({ sonata }) =>
                    sonata.trace.key === "rename-rush" &&
                    sonata.fileImport.source === null &&
                    document.getElementById("file-detail-controls")!.hidden &&
                    !document.querySelector('#trace-select option[value="local-file"]')
            ),
            "Restoring the page left a closed file selected"
        );

        // 不正な入力と取消で古いWorkerの結果が現デモを書き換えない。
        await evaluate(() => {
            const data = new DataTransfer();
            data.items.add(new File(["this is not a processor trace"], "invalid.txt"));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, cancelable: true }));
        });
        await waitFor(
            ({ sonata }) => !sonata.fileImport.busy && Boolean(document.getElementById("import-status")?.textContent),
            "Invalid trace did not report an error"
        );
        assert.equal(await evaluate(({ sonata }) => sonata.trace.key), "rename-rush");
        await evaluate(() => {
            const data = new DataTransfer();
            data.items.add(new File(["Kanata\t0004\n", "\n".repeat(1_000_000)], "cancel.kanata"));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, cancelable: true }));
            document.getElementById("import-cancel")!.click();
        });
        await waitFor(
            ({ sonata }) => !sonata.fileImport.busy && sonata.fileImport.source === null,
            "Cancel did not release the file"
        );
        await evaluate(({ sonata }) => sonata.loadTrace("rename-rush"));
        await checkIncremental();
        await importFile("one-cycle.kanata", "Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tF\n");
        assert.equal(await evaluate(() => document.getElementById("playhead")!.style.left), "0%");
        await evaluate(({ sonata }) => sonata.loadTrace("rename-rush"));
        const continuity = await reviewFilePlayback(window);
        const emptyPlayback = await reviewEmptyPlayback(window);
        const waitPlayback = await reviewWaitPlayback(window);
        return {
            formats: ["Kanata", "gem5", "gzip", "zstd"],
            sourceOps: 321,
            windowOps: initial.ops.length,
            cycleJump: 600,
            threads: 2,
            invalidInput: true,
            canceled: true,
            playbackBeforeEOF: true,
            seekBeforeEOF: true,
            preservePositionAtEOF: true,
            navigation,
            continuity,
            emptyPlayback,
            waitPlayback
        };
    } finally {
        debuggerAPI.detach();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
export = reviewImport;

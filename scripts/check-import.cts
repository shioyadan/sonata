"use strict";
import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import zlib = require("node:zlib");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor: waitUntil } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

// 外部の実トレースをCIへ持ち込まず、形式・圧縮・区間移動を実際のFile入力で検査する。
function fixture() {
    const lines = ["Kanata\t0004", "C=\t100"];
    for (let id = 0; id < 320; id++) {
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
    lines.push("C\t1000", "I\t320\t320\t0", "L\t320\t0\tunfinished add", "S\t320\t0\tF", "C\t2");
    return lines.join("\n") + "\n";
}
async function reviewImport(window: BrowserWindow, screenshots: string) {
    const test = createBrowserTest(window);
    const { evaluate } = test;
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
        window.setSize(390, 844);
        await waitFor(
            () =>
                document.getElementById("mobile-details")!.getBoundingClientRect().width > 0 &&
                Boolean(document.querySelector("#mobile-panel #file-window")),
            "Mobile trace controls did not appear"
        );
        await evaluate(() => document.getElementById("mobile-details")!.click());
        await waitFor(
            () =>
                (document.getElementById("mobile-panel") as HTMLDialogElement).open &&
                Boolean(document.querySelector("#mobile-panel #file-window")),
            "File navigation did not move into the mobile panel"
        );
        const controls = await evaluate(() => {
            document.getElementById("file-go")!.scrollIntoView({ block: "center" });
            return ["trace-open", "file-cycle", "file-span", "file-go", "file-previous", "file-next", "file-close"].map(
                (id) => {
                    const r = document.getElementById(id)!.getBoundingClientRect();
                    return { id, x: r.x, right: r.right, width: r.width, height: r.height, viewport: innerWidth };
                }
            );
        });
        assert.ok(
            controls.every((r) => r.x >= 0 && r.right <= r.viewport && r.width >= 44 && r.height >= 44),
            `Mobile file controls are clipped or too small: ${JSON.stringify(controls)}`
        );
        await test.settle();
        fs.writeFileSync(
            path.join(screenshots, "sonata-import-mobile.png"),
            (await window.webContents.capturePage()).toPNG()
        );
        window.setBounds(bounds);
        await waitFor(
            () =>
                !(document.getElementById("mobile-panel") as HTMLDialogElement).open &&
                !document.querySelector("#mobile-panel #file-window"),
            "File navigation did not return to desktop"
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
        return {
            formats: ["Kanata", "gem5", "gzip", "zstd"],
            sourceOps: 321,
            windowOps: initial.ops.length,
            cycleJump: 600,
            threads: 2,
            invalidInput: true,
            canceled: true
        };
    } finally {
        debuggerAPI.detach();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
export = reviewImport;

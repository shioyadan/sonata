"use strict";
// 読み込んだ構造のラベルと、狭い画面でも使える二段時間軸・File操作を検査する。
import assert = require("node:assert/strict");
import fs = require("node:fs");
import path = require("node:path");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor: waitUntil } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

async function reviewLayout(
    window: BrowserWindow,
    screenshots: string,
    importFile: (name: string, bytes: string | Uint8Array) => Promise<void>
) {
    const test = createBrowserTest(window);
    const { evaluate } = test;
    const waitFor = (condition: browserTest.PageCallback<[], unknown>, message: string) =>
        waitUntil(() => evaluate(condition), message);
    const bounds = window.getBounds();
    try {
        const mixedFile = [
            { name: "ldr w0, [x1]", complete: 12000 },
            { name: "ldr w2, [x3]", complete: 6000 },
            { name: "str w0, [x4]", complete: 6000 },
            { name: "add x0, x1, x2", issue: 9000, complete: 10000 },
            { name: "fadd d0, d1, d2", issue: 10000, complete: 12000 },
            { name: "add v0.4s, v1.4s, v2.4s", issue: 11000, complete: 13000 }
        ]
            .map(
                ({ name, issue = 5000, complete }, id) =>
                    [
                        `O3PipeView:fetch:1000:0x1000:0:${id + 1}: ${name}`,
                        "O3PipeView:decode:2000",
                        "O3PipeView:rename:3000",
                        "O3PipeView:dispatch:4000",
                        `O3PipeView:issue:${issue}`,
                        `O3PipeView:complete:${complete}`,
                        `O3PipeView:retire:${15000 + id * 1000}`
                    ].join("\n") + "\n"
            )
            .join("");
        await importFile("mixed-fp.o3", mixedFile);
        assert.equal(await evaluate(({ sonata }) => sonata.schedulers.length), 2);
        assert.equal(await evaluate(({ sonata }) => sonata.ops.filter((op) => op.kind === "fp").length), 2);
        assert.ok(await evaluate(({ sonata }) => sonata.executionNodes.some((node) => node.id === "exec-fp")));
        for (const style of ["neon", "aluminum", "paper"]) {
            await evaluate(({ sonata }, name) => {
                document.getElementById(`style-${name}`)!.click();
                sonata.captureAt(5.5);
            }, style);
            const bankCheck = await evaluate(({ sonata }) => {
                const banks = sonata.schedulers;
                const particles = sonata.particles;
                const waiting = sonata.ops.filter((op) => op.allocation! <= 5.5 && op.issue! > 5.5);
                return {
                    rows: banks.map((bank) => bank.grid!.rows.length),
                    capacities: banks.map((bank) => bank.capacity),
                    columns: banks.map((bank) => bank.grid!.columns.length),
                    total: sonata.dependencyMatrix.columnCount,
                    placements: waiting.map((op) => {
                        const bank = banks.find((bank) => bank.id === (op.kind === "fp" ? "issue-fp" : "issue"))!;
                        const particle = particles.find((particle) => particle.id === op.id)!;
                        const p = particle?.pathPosition;
                        return Boolean(
                            p &&
                                Math.abs(p[0] - bank.bounds.x) < bank.bounds.w / 2 &&
                                Math.abs(p[2] - bank.bounds.z) < bank.bounds.d / 2
                        );
                    }),
                    fpCount: document.getElementById("issue-fp-count")!.textContent,
                    fpVisible: !document.getElementById("fp-queue")!.hidden,
                    unknownRegisters: !sonata.trace.evidence?.registers
                };
            });
            assert.deepEqual(bankCheck.rows, bankCheck.capacities);
            assert.ok(bankCheck.columns.every((count) => count === bankCheck.total));
            assert.equal(bankCheck.placements.length, 3);
            assert.ok(bankCheck.placements.every(Boolean), `Waiting instructions escaped their scheduler in ${style}`);
            assert.ok(bankCheck.fpVisible && bankCheck.fpCount!.startsWith("2 /"));
            assert.ok(bankCheck.unknownRegisters, "FP display invented register evidence");
            const labels = await evaluate(() =>
                [...document.querySelectorAll(".stage-label")].map((element) => {
                    const r = element.getBoundingClientRect();
                    return { text: element.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                })
            );
            assert.equal(
                await evaluate(() => document.querySelectorAll(".memory-label").length),
                3,
                "Imported memory stages did not produce LOAD / STORE / WAIT labels"
            );
            assert.ok(labels.some((label) => label.text!.includes("FP / SIMD SCHEDULER")));
            for (let i = 0; i < labels.length; i++)
                for (let j = i + 1; j < labels.length; j++) {
                    const a = labels[i],
                        b = labels[j];
                    assert.ok(
                        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
                        `Imported stage labels overlap in ${style}: ${a.text} / ${b.text}`
                    );
                }
        }

        await test.settle();
        fs.writeFileSync(
            path.join(screenshots, "import-fp-schedulers.png"),
            (await window.webContents.capturePage()).toPNG()
        );
        await evaluate(({ sonata }) => sonata.captureAt(10.5));
        assert.ok(
            await evaluate(({ sonata }) =>
                sonata.particles.some((particle) => {
                    const op = sonata.ops.find((op) => op.id === particle.id)!;
                    return (
                        op.kind === "fp" &&
                        op.stages.some(
                            (stage) =>
                                stage.node === "exec-fp" && stage.start <= sonata.cycle && sonata.cycle < stage.end
                        )
                    );
                })
            ),
            "FP execution did not render after issue"
        );

        await importFile(
            "gem5-eof.log",
            "O3PipeView:fetch:1000:0x1000:0:1: add r1, r2\nO3PipeView:decode:2000\nO3PipeView:rename:3000\nO3PipeView:dispatch:4000\nO3PipeView:issue:5000\nO3PipeView:complete:6000\nO3PipeView:retire:7000\nO3PipeView:fetch:11000:0x1004:0:2: add r1, r2\nO3PipeView:decode:12000\nO3PipeView:rename:13000\nO3PipeView:dispatch:14000\nO3PipeView:issue:15000\n"
        );
        assert.equal(await evaluate(({ sonata }) => sonata.schedulers.length), 1);
        assert.ok(await evaluate(() => document.getElementById("fp-queue")!.hidden));
        await evaluate(({ sonata }) => sonata.captureAt(sonata.trace.lastCycle));
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

        return {
            memoryLabels: ["neon", "aluminum", "paper"],
            mobileWidths: [320, 390, 620, 932],
            restoredDesktop: true
        };
    } finally {
        window.setBounds(bounds);
    }
}
export = reviewLayout;

"use strict";
// 冒頭の長いfetch待機を実Fileで再生し、加速と通常速度への復帰を確かめる。
import assert = require("node:assert/strict");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

function fixture() {
    return (
        [0, 108, 250]
            .map((fetch, id) => {
                const start = 1000 + fetch * 1000;
                const decode = start + (id === 0 ? 111000 : 4000);
                return [
                    `O3PipeView:fetch:${start}:0x1000:0:${id + 1}: ${id === 1 ? "str x0, [x1]" : "add x1, x2, x3"}`,
                    `O3PipeView:decode:${decode}`,
                    `O3PipeView:rename:${decode + 1000}`,
                    `O3PipeView:dispatch:${decode + 2000}`,
                    `O3PipeView:issue:${decode + 3000}`,
                    `O3PipeView:complete:${decode + 4000}`,
                    `O3PipeView:retire:${decode + 6000}${id === 1 ? ":store:501000" : ""}`
                ].join("\n");
            })
            .join("\n") + "\n"
    );
}

function memoryFixture(kind: "load" | "store") {
    return (
        [0, 10]
            .map((fetch, id) => {
                const tick = (cycle: number) => 1000 + cycle * 1000;
                const complete = kind === "load" ? (id === 0 ? 7 : 114) : fetch + 5;
                return [
                    `O3PipeView:fetch:${tick(fetch)}:0x1000:0:${id + 1}: ${kind === "load" ? "ldr x0, [x1]" : "str x0, [x1]"}`,
                    `O3PipeView:decode:${tick(fetch + 1)}`,
                    `O3PipeView:rename:${tick(fetch + 2)}`,
                    `O3PipeView:dispatch:${tick(fetch + 3)}`,
                    `O3PipeView:issue:${tick(fetch + 4)}`,
                    `O3PipeView:complete:${tick(complete)}`,
                    `O3PipeView:retire:${tick(complete + 1)}${kind === "store" ? `:store:${tick(300 + id * 50)}` : ""}`
                ].join("\n");
            })
            .join("\n") + "\n"
    );
}

async function reviewWaitPlayback(window: BrowserWindow) {
    const { evaluate } = createBrowserTest(window);
    const state = () =>
        evaluate(({ sonata }) => ({
            cycle: sonata.cycle,
            start: sonata.trace.firstCycle,
            end: sonata.trace.lastCycle,
            complete: sonata.fileImport.source?.complete,
            busy: sonata.fileImport.busy,
            playing: sonata.playing,
            status: document.getElementById("file-window-status")!.textContent
        }));
    const until = (condition: (value: Awaited<ReturnType<typeof state>>) => boolean, message: string) =>
        waitFor(async () => condition(await state()), message, { diagnostics: state });
    const playAt = (cycle: number) =>
        evaluate(({ sonata }, cycle) => {
            sonata.captureAt(cycle);
            sonata.setPlaying(true);
        }, cycle);
    const toggle = (id: string, checked: boolean) =>
        evaluate(
            (_page, id, checked) => {
                const input = document.getElementById(id) as HTMLInputElement;
                input.checked = checked;
                input.dispatchEvent(new Event("change"));
            },
            id,
            checked
        );
    async function open(text: string) {
        await evaluate((_page, text) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([text], "wait-playback.log"));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
        }, text);
        await until((s) => Boolean(s.complete) && !s.busy, "The waiting file did not load");
    }
    async function go(cycle: number) {
        await evaluate((_page, cycle) => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = String(cycle);
            document.getElementById("file-go")!.click();
        }, cycle);
        await until((s) => s.start === cycle && !s.busy, "The waiting window did not load");
    }
    async function partialWait() {
        const prefix = "Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tF\nC\t50\nI\t1\t1\t0\nS\t1\t0\tF\nC\t150\nR\t0\t0\t0\n";
        const original = await evaluate(() => globalThis.sonataTraceWorkerSource);
        try {
            await evaluate((_page, prefix) => {
                // 実際のParserへ渡す後半だけを止め、読み込み時間に依存せず安全境界を検査する。
                globalThis.sonataTraceWorkerSource = `
                    let release;
                    const gate = new Promise(resolve => release = resolve);
                    File.prototype.stream = function () {
                        const file = this;
                        let offset = 0;
                        return new ReadableStream({async pull(controller) {
                            if (offset) await gate;
                            if (offset >= file.size) { controller.close(); return; }
                            const end = offset ? file.size : ${prefix.length};
                            controller.enqueue(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
                            offset = end;
                        }});
                    };
                    ${globalThis.sonataTraceWorkerSource}
                    const receive = onmessage;
                    const send = postMessage.bind(globalThis);
                    let source, invalid = false, windows = 0;
                    globalThis.postMessage = data => {
                        if (data.type === "loaded") source = data.source;
                        if (invalid && data.type === "window") {
                            data.trace.playbackSafeUntil = null;
                            if (++windows > 2) {
                                send({type: "error", message: "Invalid prefix triggered repeated refresh"});
                                return;
                            }
                        }
                        send(data);
                    };
                    onmessage = event => {
                        if (event.data.type === "release-wait-input") { invalid = false; release(); }
                        else if (event.data.type === "invalidate-wait-prefix") {
                            invalid = true;
                            send({type: "loaded", source: {...source, settledCycle: 1000}});
                        } else receive(event);
                    };
                `;
                const NativeWorker = Worker;
                globalThis.Worker = new Proxy(NativeWorker, {
                    construct(Target, args) {
                        const worker = new Target(...(args as [string | URL, WorkerOptions?]));
                        (globalThis as typeof globalThis & { waitTestWorker?: Worker }).waitTestWorker = worker;
                        globalThis.Worker = NativeWorker;
                        return worker;
                    }
                });
                const transfer = new DataTransfer();
                transfer.items.add(new File([prefix, "C\t30\nR\t1\t1\t0\n"], "partial-wait.kanata"));
                document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
            }, prefix);
            await waitFor(
                async () =>
                    evaluate(
                        ({ sonata }) =>
                            sonata.trace.key === "local-file" &&
                            !sonata.fileImport.selecting &&
                            sonata.fileImport.loading
                    ),
                "The partial wait did not become available"
            );
            assert.equal(await evaluate(({ sonata }) => sonata.trace.playbackSafeUntil), 50);
            await playAt(8);
            await until(
                (s) => s.status!.includes("Fast-forwarding wait"),
                "The settled prefix did not accelerate before EOF"
            );
            await until(
                (s) => s.cycle >= 48 && !s.status!.includes("Fast-forwarding wait"),
                "Acceleration crossed an unpublished fetch"
            );
            await evaluate(({ sonata }) => sonata.setPlaying(false));
            const partial = await state();
            assert.equal(partial.complete, false);
            assert.ok(partial.cycle < 50, "The pending instruction's arrival was skipped");
            // 正の古いloadedと、警告後のnull境界を持つ窓応答が交差しても再取得を繰り返さない。
            await evaluate(() =>
                (globalThis as typeof globalThis & { waitTestWorker: Worker }).waitTestWorker.postMessage({
                    type: "invalidate-wait-prefix"
                })
            );
            await waitFor(
                async () =>
                    evaluate(({ sonata }) => sonata.trace.playbackSafeUntil === null && !sonata.fileImport.selecting),
                "The invalidated prefix did not settle"
            );
            await evaluate(async () => new Promise((resolve) => setTimeout(resolve, 150)));
            assert.ok(!(await state()).status!.includes("Invalid prefix"));
            await evaluate(() =>
                (globalThis as typeof globalThis & { waitTestWorker: Worker }).waitTestWorker.postMessage({
                    type: "release-wait-input"
                })
            );
            await until((s) => Boolean(s.complete) && !s.busy, "The final wait window did not refresh");
            assert.deepEqual(await evaluate(({ sonata }) => sonata.trace.ops.map((op) => op[0])), [0, 1]);
            assert.equal((await state()).cycle, partial.cycle, "Completing the input moved paused playback");
        } finally {
            await evaluate((_page, original) => {
                const context = globalThis as typeof globalThis & { waitTestWorker?: Worker };
                context.waitTestWorker?.postMessage({ type: "release-wait-input" });
                delete context.waitTestWorker;
                globalThis.sonataTraceWorkerSource = original;
                document.getElementById("file-close")!.click();
            }, original);
        }
    }
    try {
        assert.equal(
            await evaluate(() => (document.getElementById("file-speed-waits") as HTMLInputElement).checked),
            true
        );
        await evaluate((_page, text) => {
            const speed = document.getElementById("speed") as HTMLSelectElement;
            speed.value = "4";
            speed.dispatchEvent(new Event("change"));
            const transfer = new DataTransfer();
            transfer.items.add(new File([text], "fetch-wait.log"));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
        }, fixture());
        await until((s) => Boolean(s.complete) && !s.busy, "The fetch-wait file did not load");
        const original = await evaluate(({ sonata }) => JSON.stringify(sonata.trace.ops));
        assert.ok(
            await evaluate(({ sonata }) => sonata.trace.storeCompletions?.some(([, cycle]) => cycle >= 500)),
            "The fixture needs a future store completion to guard against blocking earlier fetch waiting"
        );
        assert.ok(
            await evaluate(({ sonata }) =>
                sonata.trace.ops.some((op) =>
                    op[6].some((stage) => stage[0] === "F" && stage[2] === 0 && stage[3] === 111)
                )
            ),
            "The fixture must retain the observed 111-cycle fetch stage"
        );
        await playAt(8);
        await until((s) => s.status!.includes("Fast-forwarding wait"), "Stationary fetch waiting was not accelerated");
        await until(
            (s) => s.cycle >= 106 && !s.status!.includes("Fast-forwarding wait"),
            "Playback did not return to normal before the next fetch"
        );
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        assert.ok((await state()).cycle < 108, "Acceleration skipped the next instruction's arrival");
        assert.equal(
            await evaluate(({ sonata }) => JSON.stringify(sonata.trace.ops)),
            original,
            "Acceleration changed the recorded stages or times"
        );

        await playAt(8);
        await until((s) => s.status!.includes("Fast-forwarding wait"), "The repeated wait did not accelerate");
        await toggle("file-speed-waits", false);
        const disabled = await state();
        await evaluate(async ({ sonata }) => {
            await new Promise((resolve) => setTimeout(resolve, 650));
            sonata.setPlaying(false);
        });
        const stopped = await state();
        assert.ok(
            stopped.cycle > disabled.cycle && stopped.cycle - disabled.cycle < 4,
            "Turning wait acceleration off did not restore normal speed"
        );
        assert.ok(!stopped.status!.includes("Fast-forwarding wait"));
        await toggle("file-speed-waits", true);
        await playAt(8);
        await until((s) => s.status!.includes("Fast-forwarding wait"), "The wait did not accelerate after enabling");
        await evaluate(({ sonata }) => {
            sonata.setPlaying(false);
            document.getElementById("next")!.click();
        });
        const paused = await state();
        await evaluate(async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
        });
        assert.equal((await state()).cycle, paused.cycle, "Pausing left automatic acceleration active");
        assert.equal(paused.playing, false);
        assert.equal(paused.cycle, Math.floor(paused.cycle));
        assert.ok(!paused.status!.includes("Fast-forwarding wait"));

        await toggle("file-loop", true);
        await playAt(8);
        await evaluate(async ({ sonata }) => {
            await new Promise((resolve) => setTimeout(resolve, 650));
            sonata.setPlaying(false);
        });
        assert.ok((await state()).cycle < 12, "Loop window was accelerated");
        await toggle("file-loop", false);
        await evaluate(() => {
            const span = document.getElementById("file-span") as HTMLSelectElement;
            span.value = "16";
            span.dispatchEvent(new Event("change"));
        });
        await until((s) => s.end - s.start === 15 && !s.busy, "The narrow wait window did not load");
        await playAt((await state()).start + 7);
        await until(
            (s) => s.start > 16 && s.cycle < 108 && s.status!.includes("Fast-forwarding wait"),
            "Waiting did not accelerate across small windows"
        );
        const continued = await evaluate(async ({ sonata }) => {
            const before = sonata.cycle;
            await new Promise((resolve) => setTimeout(resolve, 350));
            sonata.setPlaying(false);
            return sonata.cycle - before;
        });
        assert.ok(continued > 3, "The next window silently returned to normal waiting speed");

        await open(memoryFixture("load"));
        assert.equal(await evaluate(({ sonata }) => sonata.memoryTiming.minimum.load), 3);
        const loadPosition = await evaluate(({ sonata }) => {
            sonata.captureAt(25);
            const before = sonata.particles.find((p) => p.id === 1)!;
            sonata.captureAt(30);
            const after = sonata.particles.find((p) => p.id === 1)!;
            return { before: before.pathPosition, after: after.pathPosition, state: after.state };
        });
        assert.equal(loadPosition.state, "waiting", "The slow load must have reached LOAD WAIT");
        assert.deepEqual(loadPosition.after, loadPosition.before, "The candidate load wait is still moving");
        await playAt(25);
        await until((s) => s.status!.includes("Fast-forwarding wait"), "LOAD WAIT was not accelerated");
        await until(
            (s) => s.cycle >= 112 && !s.status!.includes("Fast-forwarding wait"),
            "The load completion was not approached at normal speed"
        );
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        assert.ok((await state()).cycle < 114, "The recorded load completion was skipped");

        await open(memoryFixture("store"));
        await go(250);
        const stores = await evaluate(({ sonata }) => ({
            ops: sonata.trace.ops.length,
            waits: sonata.trace.storeWaits
        }));
        assert.equal(stores.ops, 0, "Retired stores must not be reintroduced as live instructions");
        assert.deepEqual(
            stores.waits?.map(([, , , end]) => end).sort((a, b) => a - b),
            [300, 350]
        );
        await playAt(250);
        await until((s) => s.status!.includes("Fast-forwarding wait"), "Post-retire store waiting did not accelerate");
        await until(
            (s) => s.cycle >= 298 && !s.status!.includes("Fast-forwarding wait"),
            "The first store completion was skipped"
        );
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        assert.ok((await state()).cycle < 300);
        await playAt(306);
        await until(
            (s) => s.status!.includes("Fast-forwarding wait"),
            "Waiting between store completions did not accelerate"
        );
        await until(
            (s) => s.cycle >= 348 && !s.status!.includes("Fast-forwarding wait"),
            "The last store completion was skipped"
        );
        await until((s) => !s.playing && s.cycle === 350, "Playback stopped before the last recorded store completion");
        await go(250);
        await playAt(250);
        await until(
            (s) => s.status!.includes("Fast-forwarding wait"),
            "Reverse seeking changed the observed store wait"
        );
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        await partialWait();
        return {
            incrementalWait: true,
            fetchWait: true,
            nextEvent: true,
            offAndPause: true,
            loop: true,
            narrowWindows: true,
            loadWait: true,
            storeCompletions: true,
            reverseStoreSeek: true
        };
    } finally {
        await evaluate(() => {
            document.getElementById("file-close")!.click();
            (document.getElementById("file-speed-waits") as HTMLInputElement).checked = true;
            (document.getElementById("file-loop") as HTMLInputElement).checked = false;
        });
    }
}
export = reviewWaitPlayback;

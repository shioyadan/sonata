"use strict";
// 実Fileの空白を飛ばし、待機・手動操作・遅い応答を飛ばさないことを検査する。
import assert = require("node:assert/strict");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

function fixture(fetches: number[], tail = 0, waiting = 0) {
    const lines = ["Kanata\t0004", "C=\t0"];
    let cycle = 0;
    for (const [id, fetch] of fetches.entries()) {
        if (fetch > cycle) lines.push(`C\t${fetch - cycle}`);
        lines.push(
            `I\t${id}\t${id}\t0`,
            `L\t${id}\t0\tadd x1, x2, x3`,
            `S\t${id}\t0\tF`,
            "C\t1",
            `E\t${id}\t0\tF`,
            `S\t${id}\t0\tX`,
            `C\t${1 + waiting}`,
            `E\t${id}\t0\tX`,
            `R\t${id}\t${id}\t0`
        );
        cycle = fetch + 2 + waiting;
    }
    if (tail) lines.push(`C\t${tail}`);
    return lines.join("\n") + "\n";
}

async function reviewEmptyPlayback(window: BrowserWindow) {
    const { evaluate } = createBrowserTest(window);
    const originalSource = await evaluate(() => globalThis.sonataTraceWorkerSource);
    const state = () =>
        evaluate(({ sonata }) => ({
            start: sonata.trace.firstCycle,
            end: sonata.trace.lastCycle,
            cycle: sonata.cycle,
            complete: sonata.fileImport.source?.complete,
            sourceEnd: sonata.fileImport.source?.lastCycle,
            playing: sonata.playing,
            busy: sonata.fileImport.busy,
            status: document.getElementById("file-window-status")!.textContent
        }));
    const until = (condition: (s: Awaited<ReturnType<typeof state>>) => boolean, message: string) =>
        waitFor(async () => condition(await state()), message, { diagnostics: state });
    async function open(text: string) {
        await evaluate((_page, text) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([text], "empty-playback.kanata"));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
        }, text);
        await until((s) => Boolean(s.complete) && !s.busy, "The empty playback file did not load");
    }
    async function playAt(cycle: number) {
        await evaluate(({ sonata }, cycle) => {
            sonata.captureAt(cycle);
            sonata.setPlaying(true);
        }, cycle);
    }
    async function pauseAfterDelay() {
        await evaluate(async ({ sonata }) => {
            // 自動skipの猶予を越えて実際の再生時計を観察する。
            await new Promise((resolve) => setTimeout(resolve, 800));
            sonata.setPlaying(false);
        });
    }
    try {
        await evaluate(() => {
            const speed = document.getElementById("speed") as HTMLSelectElement;
            speed.value = "4";
            speed.dispatchEvent(new Event("change"));
            (document.getElementById("file-skip-empty") as HTMLInputElement).checked = true;
        });
        await open(fixture([0, 110]));
        await playAt(10);
        await until((s) => s.cycle >= 108, "An empty gap within the visible window was not skipped");
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        assert.equal((await state()).start, 0, "An in-window skip needlessly changed the visible window");
        assert.ok((await state()).cycle < 110, "Skipping hid the next instruction's arrival");

        await open(fixture([0, 1_000_000]));
        await playAt(10);
        await until(
            (s) => s.start === 999998 && s.cycle < 1000000 && !s.busy,
            "A large gap did not jump directly to the next fetch"
        );
        assert.ok((await state()).playing, "The automatic jump paused playback");
        assert.match((await state()).status!, /Skipped .* empty cycles/);
        await evaluate(({ sonata }) => sonata.setPlaying(false));

        await open(fixture([0, 1_000_000]));
        await evaluate(() => {
            const span = document.getElementById("file-span") as HTMLSelectElement;
            span.value = "16";
            span.dispatchEvent(new Event("change"));
            const speed = document.getElementById("speed") as HTMLSelectElement;
            speed.value = "128";
            speed.dispatchEvent(new Event("change"));
        });
        await until((s) => s.end === 15 && !s.busy, "The narrow window did not settle");
        await playAt(10);
        await until((s) => s.start === 999998, "Small windows reset the idle timer and prevented fast-forward");
        await evaluate(({ sonata }) => {
            sonata.setPlaying(false);
            const speed = document.getElementById("speed") as HTMLSelectElement;
            speed.value = "4";
            speed.dispatchEvent(new Event("change"));
        });

        // OFFの再生と1cycle送りは実サイクルを保つ。
        await open(fixture([0, 1_000_000]));
        await evaluate(() => {
            const toggle = document.getElementById("file-skip-empty") as HTMLInputElement;
            toggle.checked = false;
            toggle.dispatchEvent(new Event("change"));
        });
        await playAt(10);
        await pauseAfterDelay();
        assert.ok((await state()).cycle > 10 && (await state()).cycle < 20, "Disabling empty skipping was ignored");
        await evaluate(({ sonata }) => {
            (document.getElementById("file-skip-empty") as HTMLInputElement).checked = true;
            sonata.captureAt(20);
            document.getElementById("next")!.click();
        });
        assert.equal((await state()).cycle, 21);
        assert.equal((await state()).playing, false);
        await evaluate(() => ((document.getElementById("file-loop") as HTMLInputElement).checked = true));
        await playAt(10);
        await pauseAfterDelay();
        assert.ok((await state()).cycle < 20, "Loop window skipped outside its visible interval");

        await open(fixture([0], 0, 1000));
        await playAt(20);
        await pauseAfterDelay();
        assert.ok(
            (await state()).cycle > 20 && (await state()).cycle < 30,
            "A live instruction's long wait was skipped"
        );
        const stores =
            [1000, 11000, 1000001000]
                .map((tick, id) =>
                    [
                        `O3PipeView:fetch:${tick}:0x1000:0:${id + 1}: ${id === 0 ? "str x0, [x1]" : "add x1, x2, x3"}`,
                        `O3PipeView:decode:${tick + 1000}`,
                        `O3PipeView:rename:${tick + 2000}`,
                        `O3PipeView:dispatch:${tick + 3000}`,
                        `O3PipeView:issue:${tick + 4000}`,
                        `O3PipeView:complete:${tick + 5000}`,
                        `O3PipeView:retire:${tick + 6000}${id === 0 ? ":store:1001000" : ""}`
                    ].join("\n")
                )
                .join("\n") + "\n";
        await open(stores);
        assert.ok(
            await evaluate(({ sonata }) => sonata.trace.storeCompletions?.some(([, time]) => time > 900)),
            "The store fixture needs an observed late write completion"
        );
        await playAt(126.99);
        await until((s) => s.start === 127 && s.cycle > 127, "Store waiting did not cross the local window boundary");
        assert.equal(
            await evaluate(({ sonata }) => sonata.trace.storeCompletions?.length ?? 0),
            0,
            "The next window must omit the original store to test its retained completion"
        );
        await pauseAfterDelay();
        assert.ok((await state()).cycle < 140, "Window switching forgot the pending store and skipped its write wait");
        await evaluate(() => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = "500";
            document.getElementById("file-go")!.click();
        });
        await until((s) => s.start === 500 && !s.busy, "The manual store-wait seek did not finish");
        await playAt(500);
        await pauseAfterDelay();
        assert.ok((await state()).cycle < 510, "A manual seek forgot the previously observed store write wait");
        await open(fixture([0], 1_000_000));
        const end = (await state()).sourceEnd!;
        assert.ok(end > 100000, "The fixture needs a long empty tail");
        await playAt(10);
        await until((s) => !s.playing && s.cycle === end, "Playback did not skip an empty tail and stop at EOF");

        // 次fetchの窓を取得中に停止し、取り消した応答が後から来ても元の位置を保つ。
        await evaluate((_page, original) => {
            globalThis.sonataTraceWorkerSource =
                original +
                `
                const nativeSend = globalThis.postMessage.bind(globalThis);
                let held;
                globalThis.postMessage = data => {
                    if (data.type === 'window' && data.trace.firstCycle === 999998) {
                        held = data; nativeSend({type: 'test-empty-held'});
                    } else nativeSend(data);
                };
                const nativeReceive = globalThis.onmessage;
                globalThis.onmessage = event => {
                    if (event.data.type === 'test-empty-release') {
                        if (held) nativeSend(held);
                        held = null;
                        nativeSend({type: 'test-empty-released'});
                    } else nativeReceive(event);
                };
            `;
            const context = globalThis as typeof globalThis & {
                emptyTestWorker?: Worker;
                emptyHeld?: boolean;
                emptyReleased?: boolean;
            };
            const Native = Worker;
            globalThis.Worker = new Proxy(Native, {
                construct(Target, args) {
                    const worker = new Target(...(args as [string | URL, WorkerOptions?]));
                    context.emptyTestWorker = worker;
                    worker.addEventListener("message", (event) => {
                        if (event.data.type === "test-empty-held") context.emptyHeld = true;
                        if (event.data.type === "test-empty-released") context.emptyReleased = true;
                    });
                    globalThis.Worker = Native;
                    return worker;
                }
            });
        }, originalSource);
        await open(fixture([0, 1_000_000]));
        await playAt(10);
        await waitFor(
            () => evaluate(() => Boolean((globalThis as typeof globalThis & { emptyHeld?: boolean }).emptyHeld)),
            "The automatic window response was not held"
        );
        assert.equal((await state()).status, "Skipping empty cycles…");
        await evaluate(() => document.getElementById("play")!.click());
        const stopped = await state();
        await evaluate(() =>
            (globalThis as typeof globalThis & { emptyTestWorker: Worker }).emptyTestWorker.postMessage({
                type: "test-empty-release"
            })
        );
        await waitFor(
            () =>
                evaluate(() => Boolean((globalThis as typeof globalThis & { emptyReleased?: boolean }).emptyReleased)),
            "The held automatic response was not released"
        );
        assert.deepEqual(
            { cycle: (await state()).cycle, start: (await state()).start, playing: (await state()).playing },
            { cycle: stopped.cycle, start: stopped.start, playing: false },
            "A late skip response moved or resumed paused playback"
        );
        assert.equal((await state()).busy, false);
        return {
            withinWindow: true,
            millionCycleGap: true,
            narrowWindowAt32x: true,
            emptyTail: true,
            waitingPreserved: true,
            storeWaitAcrossWindows: true,
            loopAndOff: true,
            lateResponse: true
        };
    } finally {
        await evaluate((_page, original) => {
            globalThis.sonataTraceWorkerSource = original;
            document.getElementById("file-close")!.click();
            (document.getElementById("file-skip-empty") as HTMLInputElement).checked = true;
            const context = globalThis as typeof globalThis & {
                emptyTestWorker?: Worker;
                emptyHeld?: boolean;
                emptyReleased?: boolean;
            };
            delete context.emptyTestWorker;
            delete context.emptyHeld;
            delete context.emptyReleased;
        }, originalSource);
    }
}
export = reviewEmptyPlayback;

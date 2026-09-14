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
        return { fetchWait: true, nextEvent: true, offAndPause: true, loop: true, narrowWindows: true };
    } finally {
        await evaluate(() => {
            document.getElementById("file-close")!.click();
            (document.getElementById("file-speed-waits") as HTMLInputElement).checked = true;
            (document.getElementById("file-loop") as HTMLInputElement).checked = false;
        });
    }
}
export = reviewWaitPlayback;

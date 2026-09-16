"use strict";
// 読み込み途中の実Fileで、ネイティブrangeの操作と遅い区間応答を交差させる。
import assert = require("node:assert/strict");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

async function reviewImportDrag(window: BrowserWindow) {
    const test = createBrowserTest(window);
    const { evaluate } = test;
    const state = () =>
        evaluate(({ sonata }) => {
            const range = document.getElementById("file-overview") as HTMLInputElement;
            const rect = range.getBoundingClientRect();
            return {
                value: Number(range.value),
                min: Number(range.min),
                max: Number(range.max),
                left: parseFloat(document.getElementById("file-viewport")!.style.left),
                cycle: sonata.cycle,
                start: sonata.trace.firstCycle,
                end: sonata.trace.lastCycle,
                sourceEnd: sonata.fileImport.source!.lastCycle,
                complete: sonata.fileImport.source!.complete,
                selecting: sonata.fileImport.selecting,
                playing: sonata.playing,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            };
        });
    const ready = (condition: (s: Awaited<ReturnType<typeof state>>) => boolean, message: string) =>
        waitFor(async () => condition(await state()), message, { diagnostics: state });
    const initial = await state();
    await evaluate(({ sonata }) => {
        (document.getElementById("file-cycle") as HTMLInputElement).value = "600";
        document.getElementById("file-go")!.click();
        sonata.setPlaying(true);
    });
    await waitFor(
        () =>
            evaluate(() =>
                Boolean(
                    (
                        globalThis as typeof globalThis & {
                            importTestHeld?: boolean;
                        }
                    ).importTestHeld
                )
            ),
        "The stale window was not held before dragging"
    );
    const y = Math.round(initial.y + initial.height / 2);
    const x = (fraction: number) => Math.round(initial.x + initial.width * fraction);
    const mouse = (type: "mouseDown" | "mouseMove" | "mouseUp", fraction: number) =>
        window.webContents.sendInputEvent({
            type,
            x: x(fraction),
            y,
            button: "left",
            clickCount: 1,
            modifiers: type === "mouseMove" ? ["leftbuttondown"] : []
        });
    const followsInput = (s: Awaited<ReturnType<typeof state>>) => {
        const expected = ((s.value - s.min) / (s.max - s.min + 2)) * 100;
        assert.ok(Math.abs(s.left - expected) < 0.01, "The visible window did not follow the range input");
    };
    // 解析中は初期maxが古くなる。現在の軸上で指定した位置に達するまで待ち、
    // 25%のmouseDownを55%のmouseMoveとして誤認しない。
    const atFraction = (s: Awaited<ReturnType<typeof state>>, fraction: number) =>
        Math.abs((s.value - s.min) / (s.max - s.min) - fraction) < 0.02;
    mouse("mouseDown", 0.25);
    await ready((s) => !s.selecting && atFraction(s, 0.25), "Dragging did not cancel the pending window");
    mouse("mouseMove", 0.55);
    await ready((s) => atFraction(s, 0.55), "The native range did not move before EOF");
    const held = await state();
    followsInput(held);
    await evaluate(() => {
        const worker = (globalThis as typeof globalThis & { importTestWorker: Worker }).importTestWorker;
        worker.postMessage({ type: "release-test-window" });
        worker.postMessage({ type: "release-test-input" });
    });
    await ready((s) => s.complete && s.sourceEnd > held.sourceEnd, "Parsing did not continue during the drag");
    const completed = await state();
    assert.equal(completed.max, held.max, "EOF changed the range axis while the pointer was down");
    assert.equal(completed.value, held.value, "A late response overwrote the native range value");
    assert.equal(completed.start, initial.start, "A stale window was applied while dragging");
    assert.equal(completed.cycle, held.cycle, "The playback clock advanced during the drag");
    assert.ok(completed.playing && !completed.selecting, "Dragging lost playback intent or started a refresh");
    followsInput(completed);
    mouse("mouseMove", 0.75);
    await ready((s) => atFraction(s, 0.75), "The range stopped dragging after a source update");
    const selected = await state();
    followsInput(selected);
    mouse("mouseUp", 0.75);
    await ready((s) => !s.selecting && s.start === selected.value, "The released window was not displayed");
    assert.equal((await state()).max, completed.sourceEnd - 1, "The latest axis was not restored after release");
    assert.ok((await state()).playing, "Releasing the range paused playback");
    // ドラッグ開始で先読みを取り消しても、ローカル区間の終わりから次へ進む。
    const end = (await state()).end;
    await evaluate(({ sonata }) => {
        sonata.captureAt(sonata.trace.lastCycle - 0.01);
        sonata.setPlaying(true);
    });
    await ready(
        (s) => s.start === end && s.cycle > end && s.playing,
        "Playback stopped at the window boundary after dragging"
    );
    await evaluate(({ sonata }) => sonata.setPlaying(false));

    // タッチ取消の後にも時計と次のドラッグが使えることを、実入力で確認する。
    const debuggerAPI = window.webContents.debugger;
    await debuggerAPI.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    try {
        await debuggerAPI.sendCommand("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: x(0.2), y }]
        });
        await debuggerAPI.sendCommand("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: x(0.4), y }]
        });
        await ready(
            (s) => s.value > completed.sourceEnd * 0.3 && s.value < completed.sourceEnd * 0.5,
            "Touch could not drag the overview"
        );
        followsInput(await state());
        await debuggerAPI.sendCommand("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await ready((s) => s.value === s.start && !s.selecting, "Touch cancellation left the overview in a drag");
        const before = await state();
        await evaluate(({ sonata }) => sonata.setPlaying(true));
        await ready((s) => s.cycle > before.cycle, "Playback remained frozen after touch cancellation");
        await evaluate(({ sonata }) => sonata.setPlaying(false));
    } finally {
        await debuggerAPI.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    mouse("mouseDown", 0.3);
    mouse("mouseMove", 0.5);
    await ready(
        // 直前のtouchMove（約40%）ではなく、新しいmouseMoveの到着を待つ。
        (s) => s.value > completed.sourceEnd * 0.48 && s.value < completed.sourceEnd * 0.52,
        "A subsequent drag did not start"
    );
    const second = await state();
    followsInput(second);
    mouse("mouseUp", 0.5);
    await ready((s) => s.start === second.value && !s.selecting, "A subsequent drag did not finish");
}
export = reviewImportDrag;

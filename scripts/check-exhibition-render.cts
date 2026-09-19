"use strict";
// 展示制御の時計だけを進め、切替・Worker・画面操作は実際のブラウザ経路で確認する。
import assert = require("node:assert/strict");
import fs = require("node:fs");
import path = require("node:path");
import type { BrowserWindow } from "electron";
const { createBrowserTest, waitFor, loadPage } = require("./load-test.cjs")(
    "browser-test.cts"
) as typeof import("./browser-test.cts");

async function reviewExhibition(window: BrowserWindow, entry: string, screenshots: string, basic = false) {
    const { evaluate, settle } = createBrowserTest(window);
    const state = () =>
        evaluate(({ sonata }) => ({
            ...sonata.exhibition,
            trace: sonata.trace.key,
            playing: sonata.playing,
            mode: sonata.camera.mode,
            loaded: sonata.hasTrace,
            cache: sonata.sampleCache,
            hash: location.hash,
            status: document.getElementById("exhibition-status")!.textContent
        }));
    const until = (check: (value: Awaited<ReturnType<typeof state>>) => boolean, message: string) =>
        waitFor(async () => check(await state()), message, { diagnostics: state });
    const touring = (key?: string) =>
        until(
            (s) => s.phase === "playing" && s.playing && s.loaded && (!key || s.trace === key),
            `Exhibition did not play ${key ?? "a sample"}`
        );
    async function exit() {
        await evaluate(({ $ }) => $("exhibition-exit").click());
        assert.equal((await state()).active, false);
    }
    async function layout() {
        await settle();
        const result = await evaluate(() => {
            const ids = ["exhibition-exit", "exhibition-status"];
            if (document.body.dataset.exhibition === "playing")
                ids.push("exhibition-title", "exhibition-description", "exhibition-explore");
            else ids.push("exhibition-resume");
            return {
                width: document.documentElement.scrollWidth,
                viewport: innerWidth,
                canvas: (() => {
                    const rect = document.getElementById("scene")!.getBoundingClientRect();
                    return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
                })(),
                touring: document.body.dataset.exhibition === "playing",
                height: innerHeight,
                items: ids.map((id) => {
                    const el = document.getElementById(id)!;
                    const r = el.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return {
                        id,
                        visible: r.width > 0 && r.height > 0,
                        fits: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1,
                        hit: el.contains(hit) || hit === el
                    };
                })
            };
        });
        assert.ok(result.width <= result.viewport, "Exhibition overflowed horizontally");
        assert.ok(
            result.canvas.width > 100 && result.canvas.height > 100,
            `Exhibition lost its scene: ${JSON.stringify(result.canvas)}`
        );
        if (result.touring) {
            assert.equal(result.canvas.top, 0, "The exhibition retained the mobile HUD offset");
            assert.equal(result.canvas.height, result.height, "The exhibition canvas did not fill the viewport");
        }
        for (const item of result.items) {
            assert.ok(
                item.visible && item.fits,
                `Exhibition control was outside the viewport: ${JSON.stringify(item)}`
            );
            if (item.id === "exhibition-exit" || item.id === "exhibition-resume" || item.id === "exhibition-explore")
                assert.ok(item.hit, `Exhibition action was covered: ${item.id}`);
        }
    }

    // 全画面の許可がなくてもボタンから開始でき、終了で元の操作設定を戻す。
    await evaluate(({ sonata, $ }) => {
        sonata.setPlaying(false);
        const select = $("speed") as HTMLSelectElement;
        select.value = "8";
        select.dispatchEvent(new Event("change"));
        const original = document.documentElement.requestFullscreen;
        document.documentElement.requestFullscreen = () => Promise.reject(new Error("Fullscreen denied by test"));
        $("exhibition-start").click();
        document.documentElement.requestFullscreen = original;
    });
    await touring("rename-rush");
    assert.equal((await state()).mode, "cinema");
    assert.ok((await state()).hash.includes("exhibit=1"));
    await layout();
    if (basic) {
        await exit();
        assert.equal((await state()).playing, false);
        assert.equal(await evaluate(() => (document.getElementById("speed") as HTMLSelectElement).value), "8");
        return { startsWithoutFullscreen: true, exits: true, preservesSettings: true };
    }

    const keys = await evaluate(() => globalThis.sonataDemoCatalog.map((sample) => sample.key));
    const seen = [(await state()).trace];
    for (let turn = 0; turn < keys.length; turn++) {
        const expected = keys[(keys.indexOf((await state()).trace) + 1) % keys.length];
        await evaluate(({ sonata }) => sonata.setCycle(sonata.trace.lastCycle));
        await touring(expected);
        seen.push(expected);
    }
    assert.equal(new Set(seen).size, keys.length, "The tour skipped a sample");
    assert.deepEqual(
        [...(await state()).cache].sort(),
        [...keys].sort(),
        "A full tour did not retain its bounded cache"
    );

    // 触った操作は通し、保留中のドラッグやダイアログには自動復帰を割り込ませない。
    await evaluate(({ sonata, $ }) => {
        $("scene").dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true, cancelable: true }));
        sonata.advanceExhibition(29);
    });
    assert.equal((await state()).phase, "exploring");
    await evaluate(({ sonata, $ }) => {
        $("license-panel").showModal();
        sonata.advanceExhibition(60);
    });
    assert.equal((await state()).phase, "exploring");
    await evaluate(({ sonata, $ }) => {
        $("license-panel").close();
        $("scene").focus();
        document.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 91 }));
        sonata.advanceExhibition(60);
    });
    assert.equal((await state()).phase, "exploring");
    await evaluate(({ sonata }) => {
        document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 91 }));
        sonata.advanceExhibition(31);
    });
    await touring("rename-rush");

    // range/selectに残ったフォーカスだけで、無操作復帰を永久に止めない。
    await evaluate(({ sonata, $ }) => {
        $("exhibition-explore").click();
        $("timeline").focus();
        $("timeline").dispatchEvent(new Event("input", { bubbles: true }));
        sonata.advanceExhibition(31);
    });
    await touring("rename-rush");
    assert.equal(await evaluate(() => document.activeElement?.id), "scene");

    for (const [width, height, style] of [
        [1440, 1000, "neon"],
        [390, 844, "paper"],
        [320, 568, "aluminum"],
        [932, 430, "neon"]
    ] as const) {
        await evaluate(({ $ }) => $("exhibition-explore").click());
        window.setSize(width, height);
        await waitFor(
            () => evaluate((_page, width) => innerWidth === width, width),
            "Exhibition resize did not finish"
        );
        await evaluate(({ $ }, style) => {
            $(`style-${style}`).click();
            $("exhibition-resume").click();
        }, style);
        await touring();
        await layout();
        await waitFor(
            () => evaluate(({ sonata }) => Math.abs(sonata.camera.radius - sonata.camera.targetRadius) < 0.05),
            "The exhibition camera did not fit the scene"
        );
        const frame = await evaluate(({ sonata, gl }) => {
            sonata.setCycle(sonata.trace.demo.screenshotCycle);
            const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const shades = new Set<number>();
            for (let i = 0; i < pixels.length; i += 64)
                shades.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
            return {
                shades: shades.size,
                error: gl.getError(),
                visible: sonata.particles.filter(
                    (p) =>
                        p.screen[0] >= 0 && p.screen[0] <= innerWidth && p.screen[1] >= 0 && p.screen[1] <= innerHeight
                ).length
            };
        });
        assert.equal(frame.error, 0);
        assert.ok(
            frame.shades > 50 && frame.visible > 0,
            `The exhibition did not draw instructions: ${JSON.stringify(frame)}`
        );
        fs.writeFileSync(
            path.join(screenshots, `exhibition-${style}-${width}.png`),
            (await window.webContents.capturePage()).toPNG()
        );
        await evaluate(({ $ }) => $("exhibition-explore").click());
        await layout();
        await evaluate(({ $ }) => $("exhibition-resume").click());
        await touring();
    }
    await evaluate(({ $ }) => {
        $("exhibition-exit").focus();
        $("exhibition-exit").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
    });
    assert.equal((await state()).active, false, "Escape was ignored on a focused button");
    assert.ok(!(await state()).hash.includes("exhibit=1"));
    assert.equal(await evaluate(() => (document.getElementById("speed") as HTMLSelectElement).value), "8");

    window.setSize(1440, 1000);
    // 全画面で起動済みの場合も、ブラウザがEscを消費した際のfullscreenchangeで終了する。
    await evaluate(({ $ }) => {
        Object.defineProperty(document, "fullscreenElement", {
            configurable: true,
            get: () => document.documentElement
        });
        $("exhibition-start").click();
    });
    await touring();
    await evaluate(() => {
        Reflect.deleteProperty(document, "fullscreenElement");
        document.dispatchEvent(new Event("fullscreenchange"));
    });
    assert.equal((await state()).active, false, "Leaving pre-existing fullscreen did not end the tour");
    const direct = entry.split("#")[0] + "#exhibit=1&demo=wide-open";
    await loadPage(window, direct);
    await touring("wide-open");
    assert.equal(
        await evaluate(() => Boolean(document.fullscreenElement)),
        false,
        "A deep link unexpectedly entered fullscreen"
    );
    // ファイル読込みは展示を終了し、その後の無操作時間でもFileを差し替えない。
    await evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(
            new File(["Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tF\nC\t3\nE\t0\t0\tF\nR\t0\t0\t0\n"], "exhibition.kanata")
        );
        document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
    });
    await until((s) => s.trace === "local-file" && !s.active, "Opening a File did not leave the exhibition");
    await evaluate(({ sonata }) => sonata.advanceExhibition(120));
    assert.equal((await state()).trace, "local-file");

    // 全失敗時は高速に再試行し続けず、待機から再開する。正常なWorkerへ戻せば回復する。
    await loadPage(window, entry.split("#")[0]);
    await waitFor(() => evaluate(() => Boolean(globalThis.sonata)), "The exhibition failure page did not initialize");
    const workerSource = await evaluate(() => globalThis.sonataTraceWorkerSource);
    await evaluate(() => {
        globalThis.sonataTraceWorkerSource =
            "globalThis.fetch = () => new Promise(() => {});\n" + globalThis.sonataTraceWorkerSource;
        location.hash = "exhibit=1";
    });
    await until((s) => s.phase === "loading", "The exhibition did not wait for its sample");
    const cancelPoint = await evaluate(() => {
        const r = document.getElementById("trace-loading-cancel")!.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    // pointerdownで探索へ切り替えてボタンを消さず、clickで展示と取得を終了する。
    window.webContents.sendInputEvent({ type: "mouseDown", ...cancelPoint, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...cancelPoint, button: "left", clickCount: 1 });
    await until((s) => !s.active, "Canceling a loading sample left the exhibition active");
    assert.ok(await evaluate(() => document.getElementById("trace-loading")!.hidden));
    await evaluate((_page, source) => {
        globalThis.sonataTraceWorkerSource = source;
    }, workerSource);
    await evaluate(() => {
        globalThis.sonataTraceWorkerSource =
            "globalThis.fetch = async () => new Response('Not found', {status:404});\n" +
            globalThis.sonataTraceWorkerSource;
        location.hash = "exhibit=1";
    });
    for (let attempt = 0; attempt < keys.length; attempt++) {
        await until((s) => s.phase === "waiting", "The failed sample did not become a recoverable wait");
        if (attempt < keys.length - 1)
            await evaluate(({ sonata }) => {
                sonata.advanceExhibition(2.1);
                sonata.advanceExhibition(0.5);
            });
    }
    await evaluate(({ sonata }) => sonata.advanceExhibition(10));
    assert.equal((await state()).phase, "waiting", "All failed samples were retried without backoff");
    await evaluate(({ sonata }, source) => {
        globalThis.sonataTraceWorkerSource = source;
        sonata.advanceExhibition(30);
        sonata.advanceExhibition(0.5);
    }, workerSource);
    await touring();
    await exit();
    return {
        allDemos: true,
        boundedCache: true,
        idleRecovery: true,
        activeInteractionProtected: true,
        stylesAndMobile: true,
        escape: true,
        deepLink: true,
        fileEndsTour: true,
        cancelWhileLoading: true,
        failureRecovery: true
    };
}
export = reviewExhibition;

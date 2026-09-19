"use strict";
// 展示制御の時計だけを進め、切替・Worker・画面操作は実際のブラウザ経路で確認する。
import assert = require("node:assert/strict");
import fs = require("node:fs");
import path = require("node:path");
import type { BrowserWindow } from "electron";
const { createBrowserTest, waitFor, loadPage } = require("./load-test.cjs")(
    "browser-test.cts"
) as typeof import("./browser-test.cts");

declare global {
    var exhibitionRandom: (() => number) | undefined;
}

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
            style: sonata.visualStyle,
            telemetryVisible:
                document.getElementById("scene-telemetry")!.getBoundingClientRect().height > 0 &&
                getComputedStyle(document.getElementById("scene-telemetry")!).visibility !== "hidden",
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
        assert.equal((await state()).telemetryVisible, false, "Exhibition metrics remained after exit");
    }
    const keys = await evaluate(() => globalThis.sonataDemoCatalog.map((sample) => sample.key));
    async function nextDemo(random: number) {
        const before = await state();
        const expected = keys[(keys.indexOf(before.trace) + 1) % keys.length];
        await evaluate(({ sonata }, random) => {
            globalThis.exhibitionRandom = Math.random;
            Math.random = () => random;
            sonata.setCycle(sonata.trace.lastCycle);
        }, random);
        try {
            await touring(expected);
            const after = await state();
            assert.notEqual(after.style, before.style, "A new demo repeated the previous exhibition style");
            return after;
        } finally {
            await evaluate(() => {
                Math.random = globalThis.exhibitionRandom!;
                delete globalThis.exhibitionRandom;
            });
        }
    }
    async function telemetry() {
        const snapshots = await evaluate(({ sonata, $ }) => {
            const trace = sonata.trace;
            const original = trace.topDown;
            const cycle = sonata.cycle;
            const read = (at: number) => {
                sonata.setCycle(at);
                const topDown = sonata.topDown;
                return {
                    cycle: sonata.cycle,
                    shownCycle: Number($("exhibition-cycle").textContent!.replaceAll(",", "")),
                    ipc: $("exhibition-ipc").textContent,
                    expectedIPC: sonata.stats.ipc.toFixed(2),
                    occupancy: (["issue", "rob"] as const).map((name) => {
                        const meter = $(`exhibition-${name}-meter`) as HTMLProgressElement;
                        const count = sonata.stats[name];
                        const capacity = name === "issue" ? trace.structure.queueCapacity : trace.structure.robCapacity;
                        return {
                            count,
                            capacity,
                            text: $(`exhibition-${name}-count`).textContent,
                            value: meter.value,
                            max: meter.max
                        };
                    }),
                    classification: $("bound-scene").dataset.bound,
                    expectedClassification: topDown.available ? topDown.dominant : "unavailable",
                    window: $("bound-scene-window").textContent,
                    barHidden: $("bound-scene-bar").hidden,
                    shares: [...$("bound-scene-bar").children].map((el) => {
                        const item = el as HTMLElement;
                        const key = item.dataset.bound as keyof typeof sonata.topDownVisual.shares;
                        return {
                            actual: Number.parseFloat(item.style.width) / 100,
                            expected: sonata.topDownVisual.shares[key]
                        };
                    }),
                    unknownHidden: $("bound-scene-key").querySelector<HTMLElement>('[data-bound="unresolved"]')!.hidden
                };
            };
            try {
                const values = [read(trace.firstCycle), read(trace.demo.screenshotCycle), read(trace.firstCycle)];
                // 実デモに不明値がない場合も、表示用に判定結果を補完しないことを確認する。
                trace.topDown = null;
                values.push(read(trace.firstCycle + 1));
                trace.topDown = {
                    firstCycle: trace.firstCycle,
                    windowCycles: 1,
                    slots: [[0, 0, 0, 0, 0, 1]],
                    method: "test"
                };
                values.push(read(trace.firstCycle + 1));
                return values;
            } finally {
                trace.topDown = original;
                sonata.setCycle(cycle);
            }
        });
        for (const value of snapshots) {
            assert.ok(Math.abs(value.shownCycle - value.cycle) < 0.011, "Exhibition cycle lagged behind playback");
            assert.equal(value.ipc, value.expectedIPC, "Exhibition throughput differed from the playback model");
            for (const meter of value.occupancy) {
                assert.equal(meter.text, `${meter.count} / ${meter.capacity}`);
                assert.equal(meter.value, meter.count);
                assert.equal(meter.max, meter.capacity);
            }
            assert.equal(value.classification, value.expectedClassification);
            if (value.classification !== "unavailable") {
                assert.match(value.window!, /ESTIMATE/);
                assert.equal(value.barHidden, false);
                for (const share of value.shares) {
                    assert.ok(typeof share.expected === "number");
                    assert.ok(Math.abs(share.actual - share.expected) < 1e-7);
                }
            } else {
                assert.equal(value.window, "UNAVAILABLE");
                assert.equal(value.barHidden, true);
            }
        }
        assert.equal(snapshots[3].classification, "unavailable");
        assert.equal(snapshots[4].classification, "unresolved");
        assert.equal(snapshots[4].unknownHidden, false, "Unresolved slots disappeared from the exhibition legend");
        assert.equal((await state()).phase, "playing", "Inspecting metrics interrupted the exhibition");
    }
    async function layout() {
        await settle();
        const result = await evaluate(() => {
            const ids = ["exhibition-exit", "exhibition-status"];
            if (document.body.dataset.exhibition === "playing")
                ids.push(
                    "exhibition-title",
                    "exhibition-description",
                    "exhibition-explore",
                    "scene-telemetry",
                    "bound-scene",
                    "exhibition-ipc",
                    "exhibition-cycle-label"
                );
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
                occupancyVisible: document.getElementById("exhibition-rob-meter")!.getBoundingClientRect().height > 0,
                compact: matchMedia("(max-width: 760px), (max-width: 1000px) and (max-height: 600px)").matches,
                collisions: (() => {
                    if (document.body.dataset.exhibition !== "playing") return [];
                    const r = document.getElementById("scene-telemetry")!.getBoundingClientRect();
                    return [
                        ".exhibition-actions",
                        ".exhibition-caption",
                        ".world-bottom",
                        ".flush-alert.visible"
                    ].filter((selector) => {
                        const el = document.querySelector(selector);
                        if (!el) return false;
                        const b = el.getBoundingClientRect();
                        return (
                            b.width > 0 &&
                            b.height > 0 &&
                            r.left < b.right &&
                            r.right > b.left &&
                            r.top < b.bottom &&
                            r.bottom > b.top
                        );
                    });
                })(),
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
            assert.equal(
                result.occupancyVisible,
                !result.compact,
                "Exhibition occupancy did not adapt to the viewport"
            );
            assert.deepEqual(result.collisions, [], "Exhibition telemetry overlapped its caption or controls");
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
        $("style-paper").click();
        const original = document.documentElement.requestFullscreen;
        document.documentElement.requestFullscreen = () => Promise.reject(new Error("Fullscreen denied by test"));
        $("exhibition-start").click();
        document.documentElement.requestFullscreen = original;
    });
    await touring("rename-rush");
    assert.equal((await state()).mode, "cinema");
    assert.equal((await state()).style, "paper", "Starting the tour discarded the selected style");
    assert.ok((await state()).hash.includes("exhibit=1"));
    await layout();
    await telemetry();
    if (basic) {
        await nextDemo(0);
        await exit();
        assert.equal((await state()).playing, false);
        assert.equal((await state()).style, "paper", "Exiting kept an automatically chosen style");
        assert.equal(await evaluate(() => (document.getElementById("speed") as HTMLSelectElement).value), "8");
        return {
            startsWithoutFullscreen: true,
            exits: true,
            preservesSettings: true,
            randomStyle: true,
            telemetry: true
        };
    }

    const seen = [(await state()).trace];
    const seenStyles = new Set([(await state()).style]);
    for (const [random, expectedStyle] of [
        [0, "neon"],
        [0.999, "paper"],
        [0.999, "aluminum"],
        [0, "neon"],
        [0.999, "paper"],
        [0, "neon"]
    ] as const) {
        const next = await nextDemo(random);
        assert.equal(next.style, expectedStyle, "The exhibition ignored its random style choice");
        seen.push(next.trace);
        seenStyles.add(next.style);
    }
    assert.deepEqual([...seenStyles].sort(), ["aluminum", "neon", "paper"]);
    assert.equal(new Set(seen).size, keys.length, "The tour skipped a sample");
    assert.deepEqual(
        [...(await state()).cache].sort(),
        [...keys].sort(),
        "A full tour did not retain its bounded cache"
    );
    await exit();
    assert.equal((await state()).style, "paper", "Exiting did not restore the manual style");
    await evaluate(() => {
        location.hash = "exhibit=1&demo=rename-rush";
    });
    await touring("rename-rush");

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
    assert.equal((await state()).style, "paper", "Idle return changed the style of the same demo");

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
        [932, 430, "neon"],
        [667, 375, "neon"]
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
        assert.equal((await state()).style, style, "Resuming changed a manually selected style");
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
        assert.equal(
            await evaluate(({ sonata, $ }) => {
                sonata.setCycle(sonata.flushEvents[0] + 0.1);
                return $("flush-alert").classList.contains("visible");
            }),
            true,
            "The exhibition did not show its flush notification"
        );
        await layout();
        if (width === 667)
            fs.writeFileSync(
                path.join(screenshots, "exhibition-flush-667.png"),
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
    assert.equal((await state()).style, "neon", "Exiting lost the last manual style choice");
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
    assert.equal((await state()).telemetryVisible, false, "Loading showed results from the previous demo");
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
        assert.equal((await state()).telemetryVisible, false, "An unavailable sample kept stale metrics visible");
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
        telemetry: true,
        randomStyles: true,
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

"use strict";
import assert = require("node:assert/strict");
import fs = require("node:fs");
import path = require("node:path");
import type { BrowserWindow } from "electron";
const { createBrowserTest, waitFor } = require("./load-test.cjs")(
    "browser-test.cts"
) as typeof import("./browser-test.cts");

// CIでは代表的な操作と実描画を確認し、全時刻走査や描画障害の注入は全検査で扱う。
async function reviewSmoke(window: BrowserWindow, screenshots: string, begin: (name: string) => () => void) {
    const { evaluate, sampleFrame, settle } = createBrowserTest(window);
    const wait = (condition: () => Promise<unknown>, message: string) =>
        waitFor(condition, message, {
            diagnostics: () =>
                evaluate(() => ({
                    ready: document.readyState,
                    status: document.getElementById("renderer-status")?.textContent,
                    camera: globalThis.sonata?.camera,
                    hidden: document.hidden
                }))
        });
    const readFrame = (cycle: number | null = null) =>
        sampleFrame(() =>
            evaluate(({ sonata, gl }, cycle) => {
                sonata.captureAt(cycle ?? sonata.trace.demo.screenshotCycle);
                const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
                gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                // rendererの診断もgetErrorを読むので、その前にこのフレームのエラーを保存する。
                const error = gl.getError();
                let colored = 0;
                for (let i = 0; i < pixels.length; i += 4)
                    if (
                        Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) -
                            Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >
                        40
                    )
                        colored++;
                return {
                    trace: sonata.trace.key,
                    cycle: sonata.cycle,
                    style: sonata.visualStyle,
                    shape: sonata.renderer.instructionShape,
                    particles: sonata.particles.length,
                    finite: sonata.particles.every((particle) => particle.position.every(Number.isFinite)),
                    colored,
                    error
                };
            }, cycle)
        );
    const checkFrame = (frame: Awaited<ReturnType<typeof readFrame>>) => {
        assert.equal(frame.error, 0, `${frame.trace}/${frame.style}: WebGL returned an error`);
        assert.ok(
            frame.colored > 1000 && frame.particles > 0 && frame.finite,
            `Empty or invalid frame: ${JSON.stringify(frame)}`
        );
    };
    let done = begin("smoke/startup and playback");
    await wait(() => evaluate(({ $ }) => !!globalThis.sonata && $("fallback").hidden), "Smoke page did not initialize");
    assert.equal(await evaluate(() => document.querySelectorAll("script[src],link[rel=stylesheet]").length), 0);
    const initial = await evaluate(({ sonata, $ }) => ({
        playing: sonata.playing,
        cycle: sonata.cycle,
        style: sonata.visualStyle,
        motion: $("motion-effects").getAttribute("aria-pressed")
    }));
    assert.equal(initial.playing, true, "Playback did not start automatically");
    assert.equal(initial.style, "neon");
    assert.equal(initial.motion, "true");
    await wait(
        () => evaluate(({ sonata }, cycle) => sonata.cycle !== cycle, initial.cycle),
        "Automatic playback did not advance"
    );
    await evaluate(({ $ }) => $("play").click());
    const paused = await evaluate(({ sonata }) => ({ playing: sonata.playing, cycle: sonata.cycle }));
    assert.equal(paused.playing, false);
    await settle();
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), paused.cycle, "Paused playback advanced");
    await evaluate(({ $ }) => $("play").click());
    await wait(
        () => evaluate(({ sonata }, cycle) => sonata.playing && sonata.cycle !== cycle, paused.cycle),
        "Playback did not resume"
    );
    const seek = await evaluate(({ sonata, $ }) => {
        const target = sonata.trace.firstCycle + 2;
        $("timeline").value = String(target);
        $("timeline").dispatchEvent(new Event("input"));
        return { target, cycle: sonata.cycle, playing: sonata.playing };
    });
    assert.equal(seek.cycle, seek.target, "Timeline did not seek to the requested cycle");
    assert.equal(seek.playing, false, "Seeking did not pause playback");
    window.focus();
    await evaluate(({ $, state }) => {
        $("scene").focus();
        state.keyReleased = false;
        document.addEventListener("keyup", () => (state.keyReleased = true), { once: true });
    });
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await wait(() => evaluate(({ state }) => state.keyReleased), "Step key was not delivered");
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), seek.target + 1, "Right arrow did not step one cycle");
    await evaluate(({ $ }) => {
        if ($("auto-camera").getAttribute("aria-pressed") === "true") $("auto-camera").click();
    });
    done();

    done = begin("smoke/demos");
    const keys = await evaluate(() =>
        [...document.querySelectorAll<HTMLOptionElement>("#trace-select option")].map((option) => option.value)
    );
    assert.deepEqual(keys, ["branch-storm", "wide-open", "memory-tide", "rename-rush", "x86-recovery"]);
    const demos = [];
    for (const key of keys) {
        await evaluate((_page, key) => {
            const select = document.querySelector<HTMLSelectElement>("#trace-select")!;
            select.value = key;
            select.dispatchEvent(new Event("change"));
        }, key);
        const frame = await readFrame();
        assert.equal(frame.trace, key, "Demo selector did not load the requested trace");
        checkFrame(frame);
        demos.push(frame);
    }
    done();

    done = begin("smoke/styles and stores");
    await evaluate(({ sonata }) => {
        sonata.loadTrace("memory-tide");
        sonata.captureAt(3970.9);
    });
    const styles = [];
    for (const [style, shape] of [
        ["neon", "glow"],
        ["aluminum", "metal-puck"],
        ["paper", "paper-box"]
    ]) {
        const unchanged = await evaluate(({ sonata, $ }, style) => {
            $("style-" + style).click();
            return sonata.cycle === 3970.9 && sonata.trace.key === "memory-tide" && !sonata.playing;
        }, style);
        assert.equal(unchanged, true, "Changing style reset the trace or playback");
        const frame = await readFrame(3970.9);
        assert.equal(frame.cycle, 3970.9);
        assert.equal(frame.style, style);
        assert.equal(frame.shape, shape);
        checkFrame(frame);
        const stores = await evaluate(({ sonata }) =>
            [4318, 4323, 4328, 4333, 4338, 4343].map((id) => {
                const op = sonata.ops.find((op) => op.id === id);
                const stage = op?.stages.find((stage) => stage.start <= sonata.cycle && stage.end > sonata.cycle);
                const entry = sonata.rob.entries.find((entry) => entry.id === id);
                return { id, node: stage?.node, slot: entry?.slot, ready: entry?.ready };
            })
        );
        assert.deepEqual(
            stores.map((store) => store.slot),
            [14, 19, 24, 29, 34, 39]
        );
        assert.ok(
            stores.every((store) => store.node === "rob" && store.ready === false),
            "Pending stores did not wait in the ROB"
        );
        styles.push({ ...frame, stores });
    }
    fs.writeFileSync(
        path.join(screenshots, "sonata-smoke-desktop.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    done();

    done = begin("smoke/licenses and mobile");
    await evaluate(({ $ }) => $("license-open").click());
    assert.equal(
        await evaluate(
            ({ $ }) =>
                $("license-panel").open &&
                $("license-text").textContent.includes("Embedded Microprocessor Benchmark Consortium")
        ),
        true
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait(() => evaluate(({ $ }) => !$("license-panel").open), "Licenses did not close");
    const desktopSize = window.getContentSize();
    try {
        window.setContentSize(390, 844);
        await wait(
            () =>
                evaluate(
                    ({ sonata, $ }) =>
                        innerWidth === 390 &&
                        innerHeight === 844 &&
                        sonata.camera.compact &&
                        $("mobile-panel").contains(document.querySelector(".telemetry"))
                ),
            "Mobile sidebar did not move into its panel"
        );
        const layout = await evaluate(() => {
            const fits = (element: Element) => {
                const r = element.getBoundingClientRect();
                return (
                    r.left >= 0 &&
                    r.right <= innerWidth &&
                    r.top >= 0 &&
                    r.bottom <= innerHeight &&
                    r.width >= 44 &&
                    r.height >= 44 &&
                    element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
                );
            };
            return {
                overflow:
                    document.documentElement.scrollWidth > innerWidth ||
                    document.documentElement.scrollHeight > innerHeight,
                controls: ["play", "timeline", "mobile-details", "style-neon", "style-aluminum", "style-paper"].map(
                    (id) => ({ id, fits: fits(document.getElementById(id)!) })
                )
            };
        });
        assert.equal(layout.overflow, false, "Mobile playback required scrolling");
        assert.ok(
            layout.controls.every((control) => control.fits),
            `Mobile controls are unreachable: ${JSON.stringify(layout)}`
        );
        await settle();
        fs.writeFileSync(
            path.join(screenshots, "sonata-smoke-mobile.png"),
            (await window.webContents.capturePage()).toPNG()
        );
        await evaluate(({ $ }) => $("mobile-details").click());
        assert.equal(
            await evaluate(({ $ }) => $("mobile-panel").open && $("mobile-panel").contains(document.activeElement)),
            true
        );
    } finally {
        // 開いたダイアログごと画面を戻し、通常操作での復帰を待つ。
        window.setContentSize(desktopSize[0], desktopSize[1]);
    }
    await wait(
        () =>
            evaluate(
                ({ sonata, $ }, width, height) =>
                    innerWidth === width &&
                    innerHeight === height &&
                    !sonata.camera.compact &&
                    !$("mobile-panel").open &&
                    document.querySelector("main")!.contains(document.querySelector(".telemetry")) &&
                    !$("mobile-panel").contains(document.activeElement),
                desktopSize[0],
                desktopSize[1]
            ),
        "Desktop sidebar or focus did not return"
    );
    done();
    return {
        initial,
        playback: true,
        seek: true,
        keyboardStep: true,
        demos,
        styles,
        licenses: true,
        mobile: true,
        desktopRestore: true
    };
}
export = reviewSmoke;

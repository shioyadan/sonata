"use strict";
import assert = require("node:assert/strict");
import fs = require("node:fs");
import path = require("node:path");
import type { BrowserWindow, KeyboardInputEvent, MouseInputEvent } from "electron";
const {
    createBrowserTest,
    waitFor: waitUntil,
    pageScript
} = require("./load-test.cjs")("browser-test.cts") as typeof import("./browser-test.cts");

// 実ブラウザへの入力、故障の注入、状態を待ってからの検査を組み合わせる。
// 別リポジトリや元ログに依存せず、コピー済みの配布 HTML を使う。
interface Frame {
    colored: number;
    error: number;
    particles: number;
    shape: string;
    upright: boolean;
    pieceShadows?: unknown;
}

async function reviewBrowser(window: BrowserWindow, entry: string, screenshots?: string) {
    const { evaluate, settle } = createBrowserTest(window);
    const matteStyles = ["aluminum", "paper"];
    const instructionShape = (style: string) => {
        if (style === "neon") return "glow";
        if (style === "paper") return "paper-box";
        if (style === "aluminum") return "metal-puck";
        throw new Error("Unknown visual style: " + style);
    };
    const waitFor = (condition: () => Promise<unknown>, message: string) =>
        waitUntil(condition, message, {
            diagnostics: () =>
                evaluate(() => ({
                    ready: document.readyState,
                    focus: document.activeElement?.id,
                    status: document.getElementById("renderer-status")?.textContent,
                    fallback: document.getElementById("fallback")?.hidden,
                    playing: globalThis.sonata?.playing
                }))
        });
    const ready = () =>
        waitFor(
            () =>
                evaluate(
                    ({ $ }) => !!globalThis.sonata && globalThis.sonata.renderer.error === 0 && $("fallback").hidden
                ),
            "Renderer did not initialize"
        );
    const readFrame = (): Promise<Frame> =>
        evaluate((page) => {
            const sonata = page.sonata;
            sonata.captureAt(sonata.trace.demo.screenshotCycle);
            const gl = page.gl;
            const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            let colored = 0;
            for (let i = 0; i < pixels.length; i += 4)
                if (Math.max(...pixels.subarray(i, i + 3)) - Math.min(...pixels.subarray(i, i + 3)) > 40) colored++;
            return {
                colored,
                error: gl.getError(),
                particles: sonata.particles.length,
                shape: sonata.renderer.instructionShape,
                upright: sonata.pieces.every((piece) => piece.rotation.every((v, i) => v === (i === 3 ? 1 : 0)))
            };
        });
    const press = async (keyCode: string, modifiers: KeyboardInputEvent["modifiers"] = []) => {
        // main process からの入力配送を keyup と2フレームで確認し、否定条件も送信後に判定する。
        await evaluate(({ state }) => {
            state.keyReleased = false;
            return document.addEventListener("keyup", () => (state.keyReleased = true), { once: true, capture: true });
        });
        window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        if (keyCode === "Space" || keyCode.length === 1)
            window.webContents.sendInputEvent({
                type: "char",
                keyCode: keyCode === "Space" ? " " : keyCode,
                modifiers
            });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        await waitFor(() => evaluate(({ state }) => state.keyReleased), "Keyboard input was not delivered");
        await settle();
    };

    await window.loadFile(entry);
    await ready();
    window.focus();
    const first = await evaluate(({ sonata, $ }) => {
        sonata.setPlaying(false);
        sonata.setCycle(sonata.trace.firstCycle);
        $("scene").focus();
        return sonata.cycle;
    });
    await press("Right");
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), first + 1, "Right arrow did not step one cycle");
    await press("Left");
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), first, "Left arrow did not step back");
    await press("Left");
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), first, "Left arrow escaped the trace start");
    await evaluate(({ sonata }) => sonata.setCycle(sonata.trace.lastCycle));
    await press("Right");
    assert.equal(
        await evaluate(({ sonata }) => sonata.cycle === sonata.trace.lastCycle),
        true,
        "Right arrow escaped the trace end"
    );
    await evaluate(({ sonata }) => sonata.setCycle(sonata.trace.firstCycle));
    await press("Space");
    assert.equal(await evaluate(({ sonata }) => sonata.playing), true, "Space did not start playback");
    await press("Space");
    assert.equal(await evaluate(({ sonata }) => sonata.playing), false, "Space did not pause playback");
    await press("C");
    assert.equal(await evaluate(({ sonata }) => sonata.camera.mode), "cinema", "C did not open Cinema");
    await press("Escape");
    assert.equal(await evaluate(({ sonata }) => sonata.camera.mode), "orbit", "Escape did not leave Cinema");

    // 入力欄の矢印操作は、その値だけを変える。全体の1サイクル移動と混同しない。
    const cycle = await evaluate(({ sonata, $ }) => {
        sonata.setCycle(sonata.trace.firstCycle + 10);
        $("bloom").value = "100";
        $("bloom").focus();
        return sonata.cycle;
    });
    await press("Right");
    assert.equal(await evaluate(({ $ }) => $("bloom").value), "101", "Focused range did not receive the arrow key");
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), cycle, "A focused range also stepped playback");
    await evaluate(({ $ }) => $("timeline").focus());
    await press("Right");
    assert.ok(
        Math.abs((await evaluate(({ sonata }) => sonata.cycle)) - cycle - 0.01) < 1e-7,
        "Timeline key also triggered the global cycle shortcut"
    );
    await evaluate(({ $ }) => $("speed").focus());
    await press("C");
    assert.equal(await evaluate(({ sonata }) => sonata.camera.mode), "orbit", "A focused select activated Cinema");

    // button の Space はブラウザ標準の click を一度だけ発生させる。
    await evaluate(({ sonata, $ }) => {
        sonata.setPlaying(false);
        return $("play").focus();
    });
    await press("Space");
    assert.equal(await evaluate(({ sonata }) => sonata.playing), true, "Focused play button toggled playback twice");
    await press("Space");
    assert.equal(await evaluate(({ sonata }) => sonata.playing), false);
    await evaluate(({ $ }) => $("license-open").focus());
    await press("Space");
    assert.equal(
        await evaluate(({ $ }) => $("license-panel").open && $("license-panel").contains(document.activeElement)),
        true,
        "Keyboard did not open and focus Licenses"
    );
    await press("Tab");
    assert.equal(
        await evaluate(({ $ }) => $("license-panel").contains(document.activeElement)),
        true,
        "Tab escaped the modal"
    );
    await press("C");
    assert.equal(
        await evaluate(({ sonata }) => sonata.camera.mode),
        "orbit",
        "Modal key activated the global shortcut"
    );
    await press("Escape");
    assert.equal(
        await evaluate(({ $ }) => !$("license-panel").open && document.activeElement?.id === "license-open"),
        true,
        "Escape did not close Licenses and restore focus"
    );

    // 実際の右ボタン入力で、回転や選択に干渉せずズームできることを確認する。
    await evaluate(({ sonata, $ }) => {
        sonata.captureAt(sonata.trace.demo.screenshotCycle);
        if ($("auto-camera").getAttribute("aria-pressed") === "true") $("auto-camera").click();
        return $("zoom-fit").click();
    });
    await waitFor(
        () =>
            evaluate(
                ({ sonata }) =>
                    Math.abs(sonata.camera.radius - 32.5) < 0.01 && Math.abs(sonata.camera.azimuth - 0.2) < 0.001
            ),
        "Fit did not settle before zoom input"
    );
    const cameraBefore = await evaluate(({ sonata }) => sonata.camera);
    const area = await evaluate(({ $ }) => {
        const r = $("scene").getBoundingClientRect();
        return {
            x: Math.round(r.left + r.width * 0.5),
            top: Math.round(r.top + r.height * 0.15),
            bottom: Math.round(r.top + r.height * 0.85)
        };
    });
    const drag = async (from: number, to: number, button: MouseInputEvent["button"] = "right") => {
        await evaluate(({ $, state }) => {
            state.pointerReleased = false;
            return $("scene").addEventListener("pointerup", () => (state.pointerReleased = true), { once: true });
        });
        window.webContents.sendInputEvent({ type: "mouseDown", x: area.x, y: from, button, clickCount: 1 });
        for (let i = 1; i <= 6; i++)
            window.webContents.sendInputEvent({
                type: "mouseMove",
                x: area.x,
                y: Math.round(from + ((to - from) * i) / 6),
                button
            });
        window.webContents.sendInputEvent({ type: "mouseUp", x: area.x, y: to, button, clickCount: 1 });
        await waitFor(() => evaluate(({ state }) => state.pointerReleased), "Zoom drag did not release its pointer");
        await settle();
        return evaluate(({ sonata }) => sonata.camera);
    };
    const close = await drag(area.bottom, area.top);
    assert.equal(close.targetRadius, 3, "Right drag did not reach the detailed zoom limit");
    assert.ok(
        Math.abs(close.azimuth - cameraBefore.azimuth) < 0.002 &&
            Math.abs(close.elevation - cameraBefore.elevation) < 0.002,
        "Right drag also orbited the camera"
    );
    assert.equal(close.pointers, 0, "Right drag left a captured pointer");
    await waitFor(() => evaluate(({ sonata }) => sonata.camera.radius < 3.01), "Detailed zoom did not settle");
    if (screenshots)
        fs.writeFileSync(
            path.join(screenshots, "sonata-detail-zoom.png"),
            (await window.webContents.capturePage()).toPNG()
        );
    const far = await drag(area.top, area.bottom);
    assert.equal(far.targetRadius, 62, "Downward right drag did not zoom back out");
    await evaluate(({ $ }) => $("zoom-fit").click());
    const left = await drag(area.bottom, area.bottom - 60, "left");
    assert.equal(left.targetRadius, 32.5, "Left drag also zoomed the camera");
    assert.ok(Math.abs(left.elevation - close.elevation) > 0.02, "Left drag no longer orbits");
    await evaluate(({ $ }) => {
        $("zoom-fit").click();
        for (let i = 0; i < 20; i++) $("zoom-in").click();
    });
    assert.equal(await evaluate(({ sonata }) => sonata.camera.targetRadius), 3, "Zoom button kept the old limit");
    await evaluate(({ $ }) => {
        for (let i = 0; i < 30; i++) $("zoom-out").click();
    });
    assert.equal(
        await evaluate(({ sonata }) => sonata.camera.targetRadius),
        62,
        "Zoom-out button escaped the far limit"
    );
    await evaluate(({ $, state }) => {
        $("zoom-fit").click();
        state.wheelReceived = false;
        return $("scene").addEventListener("wheel", () => (state.wheelReceived = true), { once: true });
    });
    window.webContents.sendInputEvent({
        type: "mouseWheel",
        x: area.x,
        y: Math.round((area.top + area.bottom) / 2),
        deltaY: 5000
    });
    await waitFor(() => evaluate(({ state }) => state.wheelReceived), "Wheel zoom was not delivered");
    assert.equal(await evaluate(({ sonata }) => sonata.camera.targetRadius), 3, "Wheel zoom kept the old limit");
    await evaluate(({ $ }) => $("zoom-fit").click());
    assert.equal(await evaluate(({ sonata }) => sonata.camera.targetRadius), 32.5, "Fit did not leave detailed zoom");

    // 初期化失敗時にもユーザー向けの案内と権利表示を開けることを確認する。
    const debuggerAPI = window.webContents.debugger;
    debuggerAPI.attach("1.3");
    let injected: { identifier: string } | null = null;
    try {
        await debuggerAPI.sendCommand("Page.enable");
        injected = await debuggerAPI.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: pageScript(() => {
                const original = HTMLCanvasElement.prototype.getContext;
                // overload ごとの戻り値は原実装へ委ね、WebGL 2 だけ取得失敗へ置き換える。
                HTMLCanvasElement.prototype.getContext = function (
                    this: HTMLCanvasElement,
                    type: string,
                    ...args: unknown[]
                ) {
                    return type === "webgl2"
                        ? null
                        : (Reflect.apply(original, this, [type, ...args]) as RenderingContext | null);
                } as typeof original;
            })
        });
        await window.loadFile(entry);
        assert.equal(await evaluate(({ $ }) => $("fallback").hidden), false, "Missing WebGL did not show the fallback");
        assert.equal(await evaluate(({ $ }) => $("renderer-status").textContent), "WebGL 2 unavailable");
        assert.equal(
            await evaluate(() => typeof globalThis.sonata),
            "undefined",
            "Fault injection did not disable WebGL initialization"
        );
        await evaluate(({ $ }) => $("license-open").focus());
        await press("Space");
        assert.equal(
            await evaluate(
                ({ $ }) =>
                    $("license-panel").open &&
                    $("license-text").textContent.includes("Embedded Microprocessor Benchmark Consortium")
            ),
            true,
            "WebGL failure made license notices inaccessible"
        );
        await press("Escape");
        assert.equal(await evaluate(({ $ }) => $("license-panel").open), false);
    } finally {
        try {
            if (injected)
                await debuggerAPI.sendCommand("Page.removeScriptToEvaluateOnNewDocument", {
                    identifier: injected.identifier
                });
        } finally {
            debuggerAPI.detach();
        }
    }
    await window.loadFile(entry);
    await ready();

    // 全スタイルで context を失わせ、材質テクスチャ・影も復旧後に再生成できることを確認する。
    const contextRecoveries = [];
    for (const visualStyle of ["neon", ...matteStyles]) {
        await evaluate(({ $ }, key) => $("style-" + key).click(), visualStyle);
        const available = await evaluate(({ gl, state }) => {
            state.context = gl.getExtension("WEBGL_lose_context");
            if (!state.context) return false;
            state.context.loseContext();
            return true;
        });
        assert.equal(available, true, "The context-loss extension is unavailable");
        await waitFor(
            () => evaluate(({ $ }) => $("renderer-status").textContent === "Graphics context lost"),
            "Context loss was not reported"
        );
        assert.equal(await evaluate(({ $ }) => $("fallback").hidden), false);
        const stopped = await evaluate(({ sonata }) => sonata.cycle);
        await settle();
        assert.equal(
            await evaluate(({ sonata }) => sonata.cycle),
            stopped,
            "The playback clock advanced while graphics were lost"
        );
        await evaluate(({ state }) => state.context!.restoreContext());
        await waitFor(
            () => evaluate((page) => !!globalThis.sonata && page.$("fallback").hidden && !page.gl.isContextLost()),
            "Restored graphics did not recover the app"
        );
        await ready();
        assert.equal(
            await evaluate(({ sonata }) => sonata.visualStyle),
            "neon",
            "Context recovery changed the default style"
        );
        await evaluate(({ $ }, key) => $("style-" + key).click(), visualStyle);
        const resumed = await evaluate(({ sonata }) => {
            sonata.setPlaying(true);
            return sonata.cycle;
        });
        await waitFor(
            () => evaluate(({ sonata }, cycle) => sonata.cycle > cycle, resumed),
            "Playback did not resume after graphics recovery"
        );
        const frame = await readFrame();
        assert.equal(frame.error, 0, "Restored graphics returned a WebGL error");
        assert.equal(frame.shape, instructionShape(visualStyle), "Context recovery changed the instruction shape");
        assert.ok(
            frame.colored > 1000 && frame.particles > 0,
            `Restored graphics left an empty frame: ${JSON.stringify(frame)}`
        );
        if (visualStyle === "paper" || visualStyle === "aluminum")
            assert.ok(frame.upright, `${visualStyle}: context recovery rotated a sliding instruction`);
        if (visualStyle !== "neon") {
            await evaluate(({ sonata }) => {
                sonata.loadTrace("rename-rush");
                return sonata.captureAt(459.4);
            });
            frame.pieceShadows = await require("./check-piece-shadows.cjs")(window);
        }
        contextRecoveries.push({ style: visualStyle, ...frame });
    }
    // MSAAなしでも紙の折り面・金属パック・投影影を描画できる。
    const withoutMSAA = [];
    debuggerAPI.attach("1.3");
    injected = null;
    try {
        await debuggerAPI.sendCommand("Page.enable");
        injected = await debuggerAPI.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
            source: pageScript(() => {
                const original = WebGL2RenderingContext.prototype.getInternalformatParameter;
                WebGL2RenderingContext.prototype.getInternalformatParameter = function (target, format, pname) {
                    return pname === this.SAMPLES
                        ? new Int32Array(0)
                        : Reflect.apply(original, this, [target, format, pname]);
                };
            })
        });
        await window.loadFile(entry);
        await ready();
        await evaluate(({ sonata, $ }) => {
            sonata.setPlaying(false);
            if ($("auto-camera").getAttribute("aria-pressed") === "true") $("auto-camera").click();
            $("style-aluminum").click();
            for (let i = 0; i < 4; i++) $("zoom-in").click();
        });
        await waitFor(
            () => evaluate(({ sonata }) => Math.abs(sonata.camera.radius - sonata.camera.targetRadius) < 0.01),
            "Material close-up without MSAA did not settle"
        );
        for (const style of matteStyles) {
            await evaluate(({ $ }, key) => $("style-" + key).click(), style);
            await settle();
            const frame = {
                ...(await readFrame()),
                ...(await evaluate(({ sonata }) => ({
                    samples: sonata.renderer.msaaSamples,
                    pieces: sonata.renderer.pieceInstances
                })))
            };
            assert.equal(frame.samples, 0, "MSAA fallback was not exercised");
            if (style === "paper" || style === "aluminum")
                assert.ok(frame.upright, `${style}: MSAA fallback rotated a sliding instruction`);
            assert.equal(frame.error, 0, "Instruction rendering without MSAA returned a WebGL error");
            assert.ok(
                frame.colored > 1000 && frame.particles > 0 && frame.pieces > 0,
                "Instruction fallback left an empty frame"
            );
            assert.equal(
                await evaluate(({ sonata }) => sonata.renderer.instructionShape),
                instructionShape(style),
                "MSAA fallback changed the instruction shape"
            );
            await evaluate(({ sonata }) => {
                sonata.loadTrace("rename-rush");
                return sonata.captureAt(459.4);
            });
            frame.pieceShadows = await require("./check-piece-shadows.cjs")(window);
            await settle();
            if (screenshots)
                fs.writeFileSync(
                    path.join(screenshots, `sonata-style-${style}-no-msaa.png`),
                    (await window.webContents.capturePage()).toPNG()
                );
            withoutMSAA.push({ style, ...frame });
        }
    } finally {
        try {
            if (injected)
                await debuggerAPI.sendCommand("Page.removeScriptToEvaluateOnNewDocument", {
                    identifier: injected.identifier
                });
        } finally {
            debuggerAPI.detach();
        }
    }
    await window.loadFile(entry);
    await ready();
    return {
        keyboard: {
            stepping: true,
            bounds: true,
            playback: true,
            cinema: true,
            focusedControls: true,
            modalFocus: true
        },
        camera: {
            rightDrag: true,
            leftOrbit: true,
            buttons: true,
            wheel: true,
            fit: true,
            minRadius: 3,
            maxRadius: 62
        },
        unavailable: { fallback: true, licenses: true },
        contextRecovery: { clockPaused: true, playbackResumed: true, styles: contextRecoveries },
        withoutMSAA
    };
}
// 命令の描画直前に色だけを黒/白へ置き換え、不透明な中心画素が背景に依存しないことを確認する。
// 命令を省いた対照フレームでは同じ座標に背景差が出るため、描画の差し替え自体も検証できる。
async function reviewPieceOpacity(window: BrowserWindow) {
    const { evaluate, sampleFrame } = createBrowserTest(window);
    const originalPieces = await evaluate(({ sonata }) => sonata.pieces);
    const frames = [];
    for (const style of ["aluminum", "paper"]) {
        const frame = await sampleFrame(() =>
            evaluate(({ sonata, gl, $ }, key) => {
                const original = { style: sonata.visualStyle, cycle: sonata.cycle };
                const draw = gl.drawArraysInstanced;
                let background = 0,
                    omitPieces = false,
                    intercepted = 0;
                gl.drawArraysInstanced = function (mode, first, vertices, count) {
                    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
                    if (
                        vertices !== 6 ||
                        !gl.getUniformLocation(program, "uPuck") ||
                        !gl.getUniformLocation(program, "uLight")
                    )
                        return draw.call(this, mode, first, vertices, count);
                    const color = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
                    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
                    gl.disable(gl.SCISSOR_TEST);
                    gl.clearColor(background, background, background, 1);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    gl.clearColor(color[0], color[1], color[2], color[3]);
                    if (scissor) gl.enable(gl.SCISSOR_TEST);
                    intercepted++;
                    if (!omitPieces) return draw.call(this, mode, first, vertices, count);
                };
                const read = (value: number, omit = false) => {
                    background = value;
                    omitPieces = omit;
                    sonata.captureAt(459.4);
                    const particle = sonata.particles.find((p) => p.id === 761);
                    if (!particle) throw new Error("Opacity fixture is not visible");
                    const scale = sonata.renderer.pixelRatio;
                    const x = Math.floor(particle.screen[0] * scale);
                    const y = Math.floor(gl.drawingBufferHeight - particle.screen[1] * scale);
                    if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight)
                        throw new Error("Opacity fixture is outside the canvas");
                    const pixel = new Uint8Array(4);
                    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                    return [...pixel];
                };
                try {
                    $("style-" + key).click();
                    const black = read(0),
                        white = read(1),
                        repeated = read(0),
                        controlBlack = read(0, true),
                        controlWhite = read(1, true);
                    return { black, white, repeated, controlBlack, controlWhite, intercepted, error: gl.getError() };
                } finally {
                    gl.drawArraysInstanced = draw;
                    $("style-" + original.style).click();
                    sonata.captureAt(original.cycle);
                }
            }, style)
        );
        assert.ok(frame.intercepted >= 5, `${style}: the instruction background was not replaced`);
        assert.equal(frame.error, 0, `${style}: the opacity fixture caused a WebGL error`);
        assert.deepEqual(frame.repeated, frame.black, `${style}: restoring the background changed the same frame`);
        const difference = Math.max(...frame.black.slice(0, 3).map((v, i) => Math.abs(v - frame.white[i])));
        const controlDifference = Math.min(
            ...frame.controlBlack.slice(0, 3).map((v, i) => Math.abs(v - frame.controlWhite[i]))
        );
        assert.ok(controlDifference > 200, `${style}: the control did not expose the changed background`);
        assert.equal(difference, 0, `${style}: opaque instruction still transmits the background`);
        frames.push({ style, difference, controlDifference, ...frame });
    }
    assert.deepEqual(
        await evaluate(({ sonata }) => sonata.pieces),
        originalPieces,
        "Restoring the style and cycle changed instruction poses"
    );
    return frames;
}
reviewBrowser.pieceOpacity = reviewPieceOpacity;
export = reviewBrowser;

"use strict";
// 実際のHTTP取得と、HTML単体のFile読込みを分けて検査する。
import assert = require("node:assert/strict");
import fs = require("node:fs");
import path = require("node:path");
import url = require("node:url");
const { pathToFileURL } = url;
import type { BrowserWindow } from "electron";
const { createBrowserTest, waitFor } = require("./load-test.cjs")(
    "browser-test.cts"
) as typeof import("./browser-test.cts");

declare global {
    var demoReview:
        | {
              Worker: typeof Worker;
              source: string;
              release?: () => void;
              started?: boolean;
              pending?: Promise<void>;
          }
        | undefined;
}

async function reviewDemoLoading(
    window: BrowserWindow,
    offlineEntry: string,
    baseURL: string,
    requests: string[],
    screenshots: string
) {
    const { evaluate } = createBrowserTest(window);
    const state = () =>
        evaluate(({ sonata }) => ({
            loaded: sonata.hasTrace,
            key: sonata.trace.key,
            playing: sonata.playing,
            status: document.getElementById("demo-status")!.textContent,
            file: sonata.fileImport.source?.name,
            complete: sonata.fileImport.source?.complete,
            busy: sonata.fileImport.busy,
            loading: !document.getElementById("trace-loading")!.hidden,
            sceneVisible: getComputedStyle(document.getElementById("scene")!).visibility !== "hidden"
        }));
    const until = (check: (value: Awaited<ReturnType<typeof state>>) => boolean, message: string) =>
        waitFor(async () => check(await state()), message, { diagnostics: state });
    const ready = () => waitFor(() => evaluate(() => Boolean(globalThis.sonata)), "The empty app did not initialize");
    const sampleRequests = () => requests.filter((url) => new URL(url).pathname.startsWith("/samples/"));
    const fileText = "Kanata\t0004\nI\t0\t0\t0\nS\t0\t0\tF\nC\t3\nE\t0\t0\tF\nR\t0\t0\t0\n";
    async function openFile() {
        await evaluate((_page, text) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([text], "offline.kanata"));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
        }, fileText);
        await until(
            (s) => s.key === "local-file" && Boolean(s.complete) && !s.busy,
            "The standalone app did not open a File"
        );
    }
    async function select(key: string) {
        await evaluate((_page, key) => {
            const input = document.getElementById("trace-select") as HTMLSelectElement;
            input.value = key;
            input.dispatchEvent(new Event("change"));
        }, key);
        await until((s) => s.loaded && s.key === key, `The selected sample did not load: ${key}`);
    }
    async function inject(key: string, mode: "delay" | "late-window" | "missing" | "invalid" | "mismatch") {
        await evaluate(
            (_page, key, mode, text) => {
                const original = globalThis.Worker;
                const workers: Worker[] = [];
                const control = (globalThis.demoReview = {
                    Worker: original,
                    source: globalThis.sonataTraceWorkerSource
                } as NonNullable<typeof globalThis.demoReview>);
                const entry = globalThis.sonataDemoCatalog.find((entry) => entry.key === key)!;
                const intercept = (target: string, mode: string, text: string) => {
                    const fetch = globalThis.fetch.bind(globalThis);
                    let release: () => void;
                    const gate = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    globalThis.addEventListener("message", (event) => {
                        if (event.data?.type !== "sample-test-release") return;
                        event.stopImmediatePropagation();
                        release();
                    });
                    globalThis.fetch = async (input, init) => {
                        const url = new URL(input instanceof Request ? input.url : String(input));
                        if (!url.pathname.endsWith(target) || mode === "late-window") return fetch(input, init);
                        if (mode === "missing") return new Response("Not found", { status: 404 });
                        if (mode === "invalid") return new Response("invalid gzip bytes");
                        if (mode === "mismatch")
                            return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")));
                        globalThis.postMessage({ type: "sample-test-started" });
                        await gate;
                        return fetch(input, init);
                    };
                };
                globalThis.sonataTraceWorkerSource = `(${intercept.toString()})(${JSON.stringify(entry.url)},${JSON.stringify(mode)},${JSON.stringify(text)});\n${control.source}`;
                globalThis.Worker = new Proxy(original, {
                    construct(target, args: ConstructorParameters<typeof Worker>) {
                        const worker = new target(...args);
                        workers.push(worker);
                        worker.addEventListener("message", (event) => {
                            if (
                                mode === "late-window" &&
                                event.data?.type === "window" &&
                                event.data.trace.fileName === entry.name
                            ) {
                                const receive = worker.onmessage!;
                                control.release = () => receive.call(worker, event);
                                control.started = true;
                                event.stopImmediatePropagation();
                                return;
                            }
                            if (event.data?.type !== "sample-test-started") return;
                            event.stopImmediatePropagation();
                            control.started = true;
                        });
                        return worker;
                    }
                });
                control.release = () =>
                    workers.forEach((worker) => worker.postMessage({ type: "sample-test-release" }));
            },
            key,
            mode,
            fileText
        );
    }
    async function restore() {
        await evaluate(async () => {
            const control = globalThis.demoReview;
            if (!control) return;
            globalThis.Worker = control.Worker;
            globalThis.sonataTraceWorkerSource = control.source;
            control.release?.();
            await control.pending;
            delete globalThis.demoReview;
        });
    }
    async function delayed(key: string, mode: "delay" | "late-window" = "delay") {
        await inject(key, mode);
        await evaluate(({ sonata }, key) => {
            globalThis.demoReview!.pending = sonata.loadTrace(key);
        }, key);
        await waitFor(
            () => evaluate(() => Boolean(globalThis.demoReview?.started)),
            "The delayed sample request did not start"
        );
        const waiting = await state();
        assert.ok(waiting.loading && !waiting.sceneVisible, "A pending sample kept the previous scene visible");
        assert.match(await evaluate(() => document.getElementById("trace-loading-message")!.textContent!), /Loading/);
    }

    try {
        const beforeOffline = requests.length;
        await window.loadURL(`${pathToFileURL(offlineEntry).href}#demo=rename-rush`);
        await ready();
        assert.equal((await state()).loaded, false);
        assert.ok(await evaluate(() => !document.getElementById("trace-welcome")!.hidden));
        assert.ok(await evaluate(() => (document.getElementById("welcome-demo-select") as HTMLSelectElement).disabled));
        for (const [width, height] of [
            [1440, 1000],
            [320, 568],
            [390, 844],
            [932, 430]
        ]) {
            window.setSize(width, height);
            await waitFor(
                () => evaluate((_page, width) => innerWidth === width, width),
                "The empty page did not resize"
            );
            const layout = await evaluate(() => {
                const open = document.getElementById("welcome-open")!;
                const bounds = open.getBoundingClientRect();
                return {
                    fits:
                        bounds.left >= 0 &&
                        bounds.right <= innerWidth &&
                        bounds.top >= 0 &&
                        bounds.bottom <= innerHeight,
                    hit: document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.id,
                    width: document.documentElement.scrollWidth
                };
            });
            assert.ok(layout.fits, "The empty page hid the File button outside the viewport");
            assert.equal(layout.hit, "welcome-open", "The File button was covered");
            assert.ok(layout.width <= width, "The empty page overflowed horizontally");
            const actions = await evaluate(() =>
                ["exhibition-start", "fullscreen"].map((id) => {
                    const el = document.getElementById(id)!;
                    const r = el.getBoundingClientRect();
                    return {
                        top: r.top,
                        height: r.height,
                        width: r.width,
                        hit: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
                        named: Boolean(el.getAttribute("aria-label"))
                    };
                })
            );
            assert.equal(actions[0].top, actions[1].top, "Header actions were not aligned");
            assert.equal(actions[0].height, actions[1].height, "Header actions had different heights");
            assert.ok(actions.every((a) => a.width >= 44 && a.height >= 44 && a.hit && a.named));
            fs.writeFileSync(
                path.join(screenshots, `welcome-${width}.png`),
                (await window.webContents.capturePage()).toPNG()
            );
        }
        window.setSize(1440, 1000);
        await openFile();
        assert.equal(await evaluate(({ sonata }) => sonata.trace.ops[0][0]), 0);
        await evaluate(() => document.getElementById("file-close")!.click());
        assert.equal((await state()).loaded, false, "Closing a standalone File fabricated a demo");
        assert.deepEqual(
            requests.slice(beforeOffline),
            [pathToFileURL(offlineEntry).href],
            "The standalone HTML requested a dependency"
        );

        const beforeRoot = sampleRequests().length;
        await window.loadURL(baseURL);
        await ready();
        assert.equal((await state()).loaded, false);
        assert.equal(sampleRequests().length, beforeRoot, "The empty page fetched samples eagerly");
        assert.equal(
            await evaluate(() => typeof (globalThis as Record<string, unknown>).embeddedFlowTraces),
            "undefined"
        );
        await window.loadURL(`${baseURL}sonata.html#demo=../unknown`);
        await ready();
        assert.equal((await state()).loaded, false);
        assert.equal(sampleRequests().length, beforeRoot, "An unknown demo key became a request URL");

        await window.loadURL(baseURL);
        await ready();
        await window.loadURL(`${baseURL}sonata.html#demo=rename-rush`);
        await ready();
        await until((s) => s.key === "rename-rush" && s.loaded, "The demo link did not load its sample");
        const fetched = sampleRequests()
            .slice(beforeRoot)
            .map((url) => new URL(url).pathname);
        assert.deepEqual([...new Set(fetched)], ["/samples/gem5-arm-registers.log.gz"]);
        assert.ok(fetched.length >= 1 && fetched.length <= 2, "Format detection repeatedly downloaded the trace");
        assert.ok((await state()).playing, "The first sample did not start playback");
        const original = await evaluate(({ sonata }) => ({
            ops: JSON.stringify(sonata.trace.ops),
            bookmarks: sonata.trace.demo.bookmarks.length,
            registers: sonata.trace.evidence?.registers
        }));
        assert.ok(original.bookmarks > 0 && original.registers, "The external sample lost its recorded annotations");
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        await evaluate(() => {
            location.hash = "demo=memory-tide";
        });
        await until((s) => s.loaded && s.key === "memory-tide", "Changing the demo link did not load its sample");
        const beforeCached = sampleRequests().length;
        await select("rename-rush");
        assert.equal(sampleRequests().length, beforeCached, "A cached sample was fetched again");
        assert.equal(await evaluate(({ sonata }) => JSON.stringify(sonata.trace.ops)), original.ops);
        assert.equal((await state()).playing, false, "Sample switching discarded the pause state");

        for (const mode of ["missing", "invalid", "mismatch"] as const) {
            await inject("wide-open", mode);
            const message = await evaluate(async ({ sonata }) => {
                try {
                    await sonata.loadTrace("wide-open");
                    return "";
                } catch (error) {
                    return String(error);
                }
            });
            assert.ok(message, `${mode}: bad sample input was accepted`);
            assert.equal((await state()).key, "rename-rush", `${mode}: a failed load replaced the current trace`);
            assert.ok((await state()).status);
            assert.equal((await state()).playing, false);
            assert.ok(!(await state()).loading && (await state()).sceneVisible, "Sample failure hid the old trace");
            await restore();
        }
        await evaluate(() => document.getElementById("demo-retry")!.click());
        await until((s) => s.key === "wide-open", "Retry did not load the failed sample");

        await delayed("branch-storm", "late-window");
        await openFile();
        await restore();
        assert.equal((await state()).key, "local-file", "An old demo response replaced the user's File");
        assert.equal((await state()).loading, false, "The new File remained covered by sample loading");
        await inject("x86-recovery", "missing");
        await evaluate(async ({ sonata }) => {
            try {
                await sonata.loadTrace("x86-recovery");
            } catch {}
        });
        assert.equal((await state()).key, "local-file", "A failed demo request discarded the user's File");
        assert.equal((await state()).file, "offline.kanata");
        await restore();
        await evaluate(() => document.getElementById("file-close")!.click());
        assert.equal((await state()).key, "wide-open", "Closing a File did not restore the last successful sample");

        await delayed("x86-recovery");
        await select("memory-tide");
        await restore();
        assert.equal((await state()).key, "memory-tide", "An older sample response won a newer selection");
        assert.equal((await state()).loading, false, "The latest sample remained covered");
        await evaluate(({ sonata }) => sonata.setPlaying(true));
        await delayed("x86-recovery");
        const heldCycle = await evaluate(({ sonata }) => sonata.cycle);
        for (const [width, height, style] of [
            [1440, 1000, "neon"],
            [390, 844, "paper"],
            [320, 568, "aluminum"]
        ] as const) {
            window.setSize(width, height);
            await evaluate((_page, style) => document.getElementById(`style-${style}`)!.click(), style);
            await waitFor(() => evaluate((_page, width) => innerWidth === width, width), "Loading did not resize");
            const layout = await evaluate(() => {
                const cancel = document.getElementById("trace-loading-cancel")!;
                const r = cancel.getBoundingClientRect();
                return {
                    fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
                    hit: cancel.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
                    overflow: document.documentElement.scrollWidth > innerWidth
                };
            });
            assert.ok(layout.fits && layout.hit && !layout.overflow, "Loading cancellation was not accessible");
            fs.writeFileSync(
                path.join(screenshots, `trace-loading-${width}.png`),
                (await window.webContents.capturePage()).toPNG()
            );
        }
        assert.equal(await evaluate(({ sonata }) => sonata.cycle), heldCycle, "The hidden trace kept advancing");
        await evaluate(() => document.getElementById("trace-loading-cancel")!.click());
        await restore();
        assert.equal((await state()).key, "memory-tide", "A canceled sample request replaced the current trace");
        assert.ok(!(await state()).loading && (await state()).sceneVisible, "Cancel did not reveal the old scene");
        assert.ok((await state()).playing, "Cancel discarded the playback intent");
        await waitFor(
            () => evaluate(({ sonata }, cycle) => sonata.cycle !== cycle, heldCycle),
            "Cancel left playback frozen"
        );
        window.setSize(1440, 1000);

        // 大きい構造を初回から収め、自動回転中の切替でも追従する。手動zoomは保持する。
        await window.loadURL(`${baseURL}sonata.html#demo=namd-flow`);
        await ready();
        await until((s) => s.loaded && s.key === "namd-flow", "The NAMD demo link did not load");
        await evaluate(({ sonata }) => sonata.setPlaying(false));
        const large = await evaluate(({ sonata }) => sonata.camera);
        assert.ok(large.targetRadius > 32.5, "The first large sample kept the default camera radius");
        assert.ok(
            large.targetFocus.some((v) => v !== 0),
            "The first large sample was not centered"
        );
        assert.equal(
            await evaluate(() => document.getElementById("auto-camera")!.getAttribute("aria-pressed")),
            "true"
        );
        await select("rename-rush");
        const small = await evaluate(({ sonata }) => sonata.camera);
        assert.ok(small.targetRadius < large.targetRadius, "Switching demos did not refit the camera");
        await select("namd-flow");
        assert.equal(await evaluate(({ sonata }) => sonata.camera.targetRadius), large.targetRadius);
        await evaluate(() => document.getElementById("zoom-in")!.click());
        const zoomed = await evaluate(({ sonata }) => sonata.camera);
        await select("rename-rush");
        const preserved = await evaluate(({ sonata }) => sonata.camera);
        assert.equal(preserved.targetRadius, zoomed.targetRadius, "Demo selection discarded manual zoom");
        assert.deepEqual(preserved.targetFocus, zoomed.targetFocus, "Demo selection discarded manual focus");
        return {
            standaloneFile: true,
            lazySamples: true,
            deepLink: true,
            cache: true,
            recordedData: true,
            failureAndRetry: true,
            latestSelection: true,
            fileRace: true,
            cancel: true,
            loadingTransition: true,
            largeSampleFit: true
        };
    } finally {
        await restore();
    }
}
export = reviewDemoLoading;

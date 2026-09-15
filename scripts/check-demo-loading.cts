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
              fetch: typeof fetch;
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
            busy: sonata.fileImport.busy
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
    async function inject(key: string, mode: "delay" | "missing" | "invalid" | "mismatch") {
        await evaluate(
            (_page, key, mode) => {
                const original = globalThis.fetch.bind(globalThis);
                const control = (globalThis.demoReview = { fetch: original } as NonNullable<
                    typeof globalThis.demoReview
                >);
                const gate = new Promise<void>((resolve) => (control.release = resolve));
                globalThis.fetch = async (input, init) => {
                    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
                    if (url.pathname !== `/samples/${key}.json`) return original(input, init);
                    if (mode === "missing") return new Response("Not found", { status: 404 });
                    if (mode === "invalid") return new Response("{not JSON}");
                    const response = await original(input, init);
                    const body = await response.text();
                    if (mode === "mismatch")
                        return new Response(JSON.stringify({ ...JSON.parse(body), key: "unexpected" }));
                    // 既に受信済みの応答はAbortだけでは取り消せない。遅い完了を明示的に配送する。
                    control.started = true;
                    await gate;
                    return new Response(body, { status: response.status });
                };
            },
            key,
            mode
        );
    }
    async function restore() {
        await evaluate(async () => {
            const control = globalThis.demoReview;
            if (!control) return;
            globalThis.fetch = control.fetch;
            control.release?.();
            await control.pending;
            delete globalThis.demoReview;
        });
    }
    async function delayed(key: string) {
        await inject(key, "delay");
        await evaluate(({ sonata }, key) => {
            globalThis.demoReview!.pending = sonata.loadTrace(key);
        }, key);
        await waitFor(
            () => evaluate(() => Boolean(globalThis.demoReview?.started)),
            "The delayed sample request did not start"
        );
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
        assert.deepEqual(
            sampleRequests()
                .slice(beforeRoot)
                .map((url) => new URL(url).pathname),
            ["/samples/rename-rush.json"]
        );
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
            await restore();
        }
        await evaluate(() => document.getElementById("demo-retry")!.click());
        await until((s) => s.key === "wide-open", "Retry did not load the failed sample");

        await delayed("branch-storm");
        await openFile();
        await restore();
        assert.equal((await state()).key, "local-file", "An old demo response replaced the user's File");
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
        await delayed("x86-recovery");
        await evaluate(() => document.getElementById("demo-cancel")!.click());
        await restore();
        assert.equal((await state()).key, "memory-tide", "A canceled sample request replaced the current trace");
        return {
            standaloneFile: true,
            lazySamples: true,
            deepLink: true,
            cache: true,
            recordedData: true,
            failureAndRetry: true,
            latestSelection: true,
            fileRace: true,
            cancel: true
        };
    } finally {
        await restore();
    }
}
export = reviewDemoLoading;

"use strict";
// 有界な実Fileを使い、探索操作と非同期の区間境界をブラウザで検査する。
import assert = require("node:assert/strict");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor: waitUntil } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

async function reviewNavigation(window: BrowserWindow, contents: string) {
    const test = createBrowserTest(window);
    const { evaluate } = test;
    const waitFor = (condition: browserTest.PageCallback<[], unknown>, message: string) =>
        waitUntil(() => evaluate(condition), message, {
            diagnostics: () =>
                evaluate(({ sonata }) => ({
                    view: sonata.fileImport.view,
                    cycle: sonata.cycle,
                    status: document.getElementById("import-status")!.textContent,
                    search: document.getElementById("file-search-status")!.textContent
                }))
        });
    const ready = () => waitFor(({ sonata }) => !sonata.fileImport.busy, "Navigation did not settle");
    async function open() {
        await evaluate((_page, text) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([text], "navigation.kanata", { lastModified: 42 }));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
        }, contents);
        await waitFor(
            ({ sonata }) => sonata.trace.fileName === "navigation.kanata" && !sonata.fileImport.busy,
            "Navigation fixture did not open"
        );
    }
    async function click(id: string) {
        await evaluate((_page, id) => document.getElementById(id)!.click(), id);
        await ready();
    }
    async function jump(value: number) {
        await evaluate((_page, cycle) => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = String(cycle);
            document.getElementById("file-go")!.click();
        }, value);
        await ready();
    }
    async function search(kind: string, text: string) {
        await evaluate(
            (_page, kind, query) => {
                const select = document.getElementById("file-search-kind") as HTMLSelectElement;
                select.value = kind;
                select.dispatchEvent(new Event("change"));
                (document.getElementById("file-search-query") as HTMLInputElement).value = query;
                document.getElementById("file-search")!.click();
            },
            kind,
            text
        );
        await waitFor(({ sonata }) => !sonata.fileImport.searching, "Trace search did not finish");
    }
    await open();
    await evaluate(() => document.querySelector<HTMLElement>(".file-navigation-options summary")!.focus());
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await waitFor(
        () => (document.querySelector(".file-navigation-options") as HTMLDetailsElement).open,
        "Go to cycle did not open from the keyboard"
    );
    assert.equal(await evaluate(({ sonata }) => sonata.playing), false, "Opening Go to cycle also toggled playback");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor(
        () => !(document.querySelector(".file-navigation-options") as HTMLDetailsElement).open,
        "Escape did not close Go to cycle"
    );
    await evaluate(async () => {
        const detail = document.getElementById("detail-timeline")!;
        const rect = detail.getBoundingClientRect();
        detail.dispatchEvent(
            new WheelEvent("wheel", { deltaY: 50, clientX: rect.left + rect.width / 2, cancelable: true })
        );
        const timeline = document.getElementById("timeline") as HTMLInputElement;
        timeline.value = "10.5";
        timeline.dispatchEvent(new Event("input"));
        // 遅延していたホイール要求が発火する期間を越えても最後の手動操作を保つ。
        await new Promise((resolve) => setTimeout(resolve, 160));
    });
    assert.ok(
        await evaluate(
            ({ sonata }) =>
                sonata.cycle === 10.5 && sonata.fileImport.view!.span === 128 && !sonata.fileImport.selecting
        ),
        "A delayed wheel gesture overwrote a manual seek"
    );
    const overview = await evaluate(({ sonata }) => ({
        source: sonata.fileImport.source!,
        footer: Boolean(document.querySelector(".transport #file-window")),
        tools: Boolean(document.querySelector(".telemetry #file-tools"))
    }));
    assert.ok(overview.footer && overview.tools);
    assert.ok(overview.source.overview.bins.length <= 512);
    assert.equal(
        overview.source.overview.bins.reduce((n, bin) => n + bin.fetched, 0),
        321
    );
    assert.equal(
        overview.source.overview.bins.reduce((n, bin) => n + bin.committed, 0),
        320
    );
    const navigationLayout = await evaluate(() => {
        const detail = document.getElementById("detail-timeline")!;
        const controls = document.getElementById("file-detail-controls")!;
        const overview = document.getElementById("file-overview-wrap")!;
        return {
            detailBeforeControls: Boolean(detail.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING),
            controlsBeforeOverview: Boolean(
                controls.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
            localButtons: ["file-previous", "file-next", "file-zoom-out", "file-zoom-in"].every((id) =>
                controls.contains(document.getElementById(id))
            )
        };
    });
    assert.ok(
        navigationLayout.detailBeforeControls && navigationLayout.controlsBeforeOverview,
        "Detail timeline and its controls must precede the overall trace timeline"
    );
    assert.ok(navigationLayout.localButtons, "Local window buttons are outside the detail controls");
    await evaluate(({ sonata }) => {
        sonata.setPlaying(true);
        const range = document.getElementById("file-overview") as HTMLInputElement;
        range.value = "500";
        range.dispatchEvent(new Event("input"));
        range.dispatchEvent(new Event("change"));
    });
    await waitFor(
        ({ sonata }) => sonata.trace.firstCycle === 500 && sonata.playing && sonata.cycle > 500,
        "Moving the overall timeline did not continue playback in the new window"
    );
    await evaluate(() => {
        const timeline = document.getElementById("timeline") as HTMLInputElement;
        timeline.value = "505.5";
        timeline.dispatchEvent(new Event("input"));
    });
    assert.equal(await evaluate(({ sonata }) => sonata.playing), false, "Detail seeking did not pause playback");
    await evaluate(() => {
        const range = document.getElementById("file-overview") as HTMLInputElement;
        range.value = "200";
        range.dispatchEvent(new Event("input"));
        range.dispatchEvent(new Event("change"));
    });
    await ready();
    assert.equal(await evaluate(({ sonata }) => sonata.trace.firstCycle), 200);
    assert.equal(
        await evaluate(({ sonata }) => sonata.playing),
        false,
        "Moving the overall timeline resumed paused playback"
    );
    await click("file-last");
    assert.ok(
        await evaluate(({ sonata }) => {
            const source = sonata.fileImport.source!;
            return (
                sonata.trace.firstCycle ===
                Math.max(source.firstCycle, source.lastCycle - sonata.fileImport.view!.span + 1)
            );
        }),
        "Latest did not show the final cycle window"
    );
    assert.equal(await evaluate(({ sonata }) => sonata.playing), false, "Latest resumed paused playback");
    await click("file-first");
    assert.equal(await evaluate(({ sonata }) => sonata.trace.firstCycle), overview.source.firstCycle);
    assert.equal(await evaluate(({ sonata }) => sonata.playing), false, "Start resumed paused playback");
    await evaluate(({ sonata }) => {
        if (document.getElementById("auto-camera")!.getAttribute("aria-pressed") === "true")
            document.getElementById("auto-camera")!.click();
        sonata.captureAt(1.5);
    });
    const camera = await evaluate(({ sonata }) => sonata.camera);
    await search("id", "240");
    assert.equal(await evaluate(() => document.querySelectorAll("#file-search-results button").length), 1);
    await evaluate(({ sonata }) => {
        sonata.setPlaying(true);
        (document.querySelector("#file-search-results button") as HTMLButtonElement).click();
    });
    await ready();
    assert.equal(
        await evaluate(({ sonata }) => sonata.playing),
        false,
        "Selecting a search hit did not pause playback"
    );
    assert.equal(await evaluate(({ sonata }) => sonata.selectedID), 240);
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), 480);
    await click("file-back");
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), 1.5, "Back lost the original observation position");
    await click("file-forward");
    assert.equal(await evaluate(({ sonata }) => sonata.selectedID), 240);
    await click("file-back");
    await click("file-bookmark");
    await evaluate(() => {
        const name = document.querySelector("#file-bookmarks input") as HTMLInputElement;
        name.value = "Original observation";
        name.dispatchEvent(new Event("change"));
    });
    await jump(600);
    await evaluate(() => (document.querySelector("[data-bookmark-jump]") as HTMLButtonElement).click());
    await ready();
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), 1.5);
    await open();
    assert.equal(
        await evaluate(() => (document.querySelector("#file-bookmarks input") as HTMLInputElement).value),
        "Original observation",
        "Reopening the same file lost its bookmark"
    );
    await search("text", "0X1000");
    assert.equal(await evaluate(() => document.querySelectorAll("#file-search-results button").length), 40);
    const first = await evaluate(() => document.querySelector("#file-search-results button")!.textContent);
    await click("file-search-more");
    await waitFor(({ sonata }) => !sonata.fileImport.searching, "Search page did not finish");
    assert.notEqual(await evaluate(() => document.querySelector("#file-search-results button")!.textContent), first);
    await search("long", "2");
    assert.equal(await evaluate(() => document.querySelectorAll("#file-search-results button").length), 40);
    await search("flush", "");
    assert.equal(await evaluate(() => document.querySelectorAll("#file-search-results button").length), 0);
    await search("id", "999999");
    assert.equal(await evaluate(() => document.querySelectorAll("#file-search-results button").length), 0);
    await jump(100);
    await click("file-zoom-in");
    assert.equal(await evaluate(({ sonata }) => sonata.fileImport.view!.span), 64);
    const beforeWheel = await evaluate(({ sonata }) => sonata.fileImport.view!);
    await evaluate(() => {
        const timeline = document.getElementById("detail-timeline")!;
        const r = timeline.getBoundingClientRect();
        timeline.dispatchEvent(
            new WheelEvent("wheel", { deltaY: -50, clientX: r.left + r.width / 2, cancelable: true })
        );
    });
    await waitFor(
        ({ sonata }) => !sonata.fileImport.selecting && sonata.fileImport.view!.span === 51,
        "Wheel zoom did not change time scale"
    );
    const afterWheel = await evaluate(({ sonata }) => sonata.fileImport.view!);
    assert.ok(Math.abs(beforeWheel.start + 31.5 - (afterWheel.start + 25)) <= 1, "Wheel zoom lost the pointed cycle");
    await evaluate(() => {
        const timeline = document.getElementById("detail-timeline")!;
        for (let i = 0; i < 3; i++)
            timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, shiftKey: true, cancelable: true }));
    });
    await waitUntil(
        () =>
            evaluate(
                ({ sonata }, start) => !sonata.fileImport.selecting && sonata.fileImport.view!.start === start,
                afterWheel.start + 39
            ),
        "Shift-wheel did not accumulate panning"
    );
    const beforeDrag = await evaluate(({ sonata }) => sonata.fileImport.view!.start);
    const point = await evaluate(() => {
        const r = document.getElementById("detail-timeline")!.getBoundingClientRect();
        return {
            x: Math.round(r.left + r.width * 0.5),
            end: Math.round(r.left + r.width * 0.25),
            y: Math.round(r.top + r.height / 2)
        };
    });
    window.webContents.sendInputEvent({
        type: "mouseDown",
        x: point.x,
        y: point.y,
        button: "left",
        modifiers: ["shift"],
        clickCount: 1
    });
    window.webContents.sendInputEvent({
        type: "mouseMove",
        x: point.end,
        y: point.y,
        modifiers: ["shift", "leftbuttondown"]
    });
    window.webContents.sendInputEvent({
        type: "mouseUp",
        x: point.end,
        y: point.y,
        button: "left",
        modifiers: ["shift"],
        clickCount: 1
    });
    await waitUntil(
        () =>
            evaluate(
                ({ sonata }, before) => !sonata.fileImport.selecting && sonata.fileImport.view!.start > before,
                beforeDrag
            ),
        "Shift-drag did not pan the detail window"
    );
    assert.ok(await evaluate(({ sonata }, before) => sonata.fileImport.view!.start > before, beforeDrag));
    await jump(200);
    const end = await evaluate(({ sonata }) => {
        sonata.captureAt(sonata.trace.lastCycle - 0.02);
        sonata.setPlaying(true);
        return sonata.trace.lastCycle;
    });
    await waitFor(
        ({ sonata }) => sonata.trace.firstCycle > 200 && sonata.playing,
        "Playback looped instead of crossing the window boundary"
    );
    await evaluate(({ sonata }) => sonata.setPlaying(false));
    assert.ok(await evaluate(({ sonata }, boundary) => sonata.cycle >= boundary, end));
    const following = await evaluate(({ sonata }) => ({ start: sonata.trace.firstCycle, camera: sonata.camera }));
    assert.equal(following.camera.targetAzimuth, camera.targetAzimuth);
    assert.equal(following.camera.targetElevation, camera.targetElevation);
    assert.equal(following.camera.targetRadius, camera.targetRadius);
    await evaluate(({ sonata }) => {
        (document.getElementById("file-loop") as HTMLInputElement).checked = true;
        sonata.captureAt(sonata.trace.lastCycle - 0.01);
        sonata.setPlaying(true);
    });
    await waitFor(({ sonata }) => sonata.cycle < sonata.trace.firstCycle + 2, "Explicit window loop did not wrap");
    await evaluate(({ sonata }) => {
        sonata.setPlaying(false);
        (document.getElementById("file-loop") as HTMLInputElement).checked = false;
    });
    assert.equal(await evaluate(({ sonata }) => sonata.trace.firstCycle), following.start);
    await evaluate(({ sonata }) => sonata.captureAt(sonata.trace.lastCycle));
    const stepped = await evaluate(({ sonata }) => sonata.cycle + 1);
    await evaluate(({ sonata }) => {
        sonata.setPlaying(true);
        document.getElementById("next")!.click();
    });
    await ready();
    assert.equal(await evaluate(({ sonata }) => sonata.playing), false, "Cycle stepping did not pause playback");
    assert.equal(
        await evaluate(({ sonata }) => sonata.cycle),
        stepped,
        "Cycle step stopped at an internal window edge"
    );
    await jump(1640);
    await evaluate(({ sonata }) => {
        sonata.captureAt(sonata.trace.lastCycle);
        sonata.setPlaying(true);
    });
    await waitFor(({ sonata }) => !sonata.playing, "Playback did not stop at the actual file end");
    assert.equal(await evaluate(({ sonata }) => sonata.cycle), overview.source.lastCycle);
    // 新しい部分windowの応答を止め、手動操作の後に古い応答を配送する。
    const original = await evaluate(() => globalThis.sonataTraceWorkerSource);
    try {
        await evaluate((_page, source) => {
            globalThis.sonataTraceWorkerSource =
                source +
                `
                const nativeSend = globalThis.postMessage.bind(globalThis);
                let held;
                globalThis.postMessage = data => {
                    if (data.type === 'window' && [127, 600].includes(data.trace.firstCycle)) {
                        held = data; nativeSend({type: 'test-held'});
                    } else nativeSend(data);
                };
                const nativeReceive = globalThis.onmessage;
                globalThis.onmessage = event => {
                    if (event.data.type === 'test-release') {
                        if (held) nativeSend(held);
                        held = null;
                        nativeSend({type: 'test-released'});
                    }
                    else nativeReceive(event);
                };
            `;
            const context = globalThis as typeof globalThis & {
                navigationWorker?: Worker;
                navigationHeld?: boolean;
                navigationReleased?: boolean;
            };
            context.navigationHeld = false;
            context.navigationReleased = false;
            const Original = Worker;
            globalThis.Worker = new Proxy(Original, {
                construct(Target, args) {
                    const worker = new Target(...(args as [string | URL, WorkerOptions?]));
                    context.navigationWorker = worker;
                    worker.addEventListener("message", (event) => {
                        if (event.data.type === "test-held") context.navigationHeld = true;
                        if (event.data.type === "test-released") context.navigationReleased = true;
                    });
                    globalThis.Worker = Original;
                    return worker;
                }
            });
        }, original);
        await open();
        await evaluate(({ sonata }) => {
            sonata.captureAt(126.99);
            sonata.setPlaying(true);
        });
        await waitFor(
            ({ sonata }) =>
                sonata.fileImport.selecting &&
                Boolean((globalThis as typeof globalThis & { navigationHeld?: boolean }).navigationHeld),
            "Continuation response was not held"
        );
        await evaluate(() => {
            const timeline = document.getElementById("timeline") as HTMLInputElement;
            timeline.value = "10.5";
            timeline.dispatchEvent(new Event("input"));
            (globalThis as typeof globalThis & { navigationWorker: Worker }).navigationWorker.postMessage({
                type: "test-release"
            });
        });
        await waitFor(
            () => Boolean((globalThis as typeof globalThis & { navigationReleased?: boolean }).navigationReleased),
            "Held continuation response was not delivered"
        );
        await test.settle();
        assert.equal(
            await evaluate(({ sonata }) => sonata.cycle),
            10.5,
            "An old continuation response overwrote a manual seek"
        );
        assert.equal(await evaluate(({ sonata }) => sonata.trace.firstCycle), 0);
        const sceneHeight = await evaluate(() => document.getElementById("scene")!.clientHeight);
        await evaluate(({ sonata }) => {
            const context = globalThis as typeof globalThis & {
                navigationHeld?: boolean;
                navigationReleased?: boolean;
            };
            context.navigationHeld = context.navigationReleased = false;
            sonata.setPlaying(true);
            const range = document.getElementById("file-overview") as HTMLInputElement;
            range.value = "600";
            range.dispatchEvent(new Event("input"));
            range.dispatchEvent(new Event("change"));
        });
        await waitFor(
            ({ sonata }) =>
                sonata.fileImport.selecting &&
                Boolean((globalThis as typeof globalThis & { navigationHeld?: boolean }).navigationHeld),
            "Manual navigation response was not held"
        );
        assert.equal(await evaluate(({ sonata }) => sonata.playing), true, "Pending navigation lost playback intent");
        assert.equal(
            await evaluate(() => document.getElementById("scene")!.clientHeight),
            sceneHeight,
            "Loading status changed the scene height during navigation"
        );
        await evaluate(() => document.getElementById("play")!.click());
        assert.equal(await evaluate(({ sonata }) => sonata.playing), false, "Pause was ignored during navigation");
        await evaluate(() => {
            (globalThis as typeof globalThis & { navigationWorker: Worker }).navigationWorker.postMessage({
                type: "test-release"
            });
        });
        await waitFor(
            ({ sonata }) =>
                !sonata.fileImport.selecting &&
                sonata.trace.firstCycle === 600 &&
                Boolean((globalThis as typeof globalThis & { navigationReleased?: boolean }).navigationReleased),
            "Paused navigation did not apply the requested window"
        );
        await test.settle();
        assert.equal(
            await evaluate(({ sonata }) => sonata.playing),
            false,
            "A late navigation response resumed paused playback"
        );
    } finally {
        await evaluate((_page, source) => {
            globalThis.sonataTraceWorkerSource = source;
            document.getElementById("file-close")!.click();
            const context = globalThis as typeof globalThis & {
                navigationWorker?: Worker;
                navigationHeld?: boolean;
                navigationReleased?: boolean;
            };
            delete context.navigationWorker;
            delete context.navigationHeld;
            delete context.navigationReleased;
        }, original);
    }
    await open();
    await evaluate(() => {
        for (let i = 0; i < 3; i++) document.getElementById("file-next")!.click();
    });
    await ready();
    assert.equal(await evaluate(({ sonata }) => sonata.trace.firstCycle), 384, "Rapid window moves were lost");
    await evaluate(() => {
        for (let i = 0; i < 3; i++) document.getElementById("file-zoom-in")!.click();
    });
    await ready();
    assert.equal(await evaluate(({ sonata }) => sonata.fileImport.view!.span), 16, "Rapid zoom changes were lost");
    await evaluate(() => (document.activeElement as HTMLElement).blur());
    const keyStart = await evaluate(({ sonata }) => sonata.trace.firstCycle);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "PageDown" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "PageDown" });
    await waitUntil(
        () =>
            evaluate(
                ({ sonata }, start) => !sonata.fileImport.selecting && sonata.trace.firstCycle === start + 16,
                keyStart
            ),
        "PageDown did not move to the next window"
    );
    await evaluate(() => {
        document.getElementById("file-back")!.click();
        document.getElementById("file-back")!.click();
    });
    await ready();
    assert.equal(await evaluate(({ sonata }) => sonata.trace.firstCycle), 384, "Rapid history back lost a visit");
    assert.equal(await evaluate(({ sonata }) => sonata.fileImport.view!.span), 128, "Rapid history back lost the span");
    await evaluate(() => {
        document.getElementById("file-forward")!.click();
        document.getElementById("file-forward")!.click();
    });
    await ready();
    assert.equal(
        await evaluate(({ sonata }) => sonata.trace.firstCycle),
        keyStart + 16,
        "Rapid history forward lost a visit"
    );
    await open();
    return {
        overview: true,
        search: true,
        history: true,
        bookmarks: true,
        continuous: true,
        playbackIntent: true,
        rapidNavigation: true,
        staleResponse: true
    };
}
export = reviewNavigation;

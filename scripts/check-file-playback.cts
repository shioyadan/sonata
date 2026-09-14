"use strict";
// 同じ命令を区間境界の両側で観察し、配置と固定描画の連続性を確認する。
import assert = require("node:assert/strict");
import electron = require("electron");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest, waitFor } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

function fixture() {
    const events: { cycle: number; id: number; text: string }[] = [];
    for (let id = 0; id < 160; id++) {
        const fetch = id * 2;
        const issue = fetch + (id % 7 === 0 ? 8 : 5);
        const memory = id % 50 === 0;
        const latency = memory ? (id === 50 ? 12 : 3) : 1;
        const label = memory ? "lw x1, 0(x2)" : id % 53 === 0 ? "sw x1, 0(x2)" : "add x1, x2, x3";
        events.push({ cycle: fetch, id, text: `I\t${id}\t${id}\t0\nL\t${id}\t0\t${label}` });
        const stages = [
            ["F", fetch, fetch + 1],
            ["Rn", fetch + 1, fetch + 3],
            ["Sc", fetch + 3, issue],
            ["X", issue, issue + latency],
            ["Rw", issue + latency, fetch + 21],
            ["Cm", fetch + 21, fetch + 22]
        ] as const;
        for (const [name, start, end] of stages) {
            events.push({ cycle: start, id, text: `S\t${id}\t0\t${name}` });
            events.push({ cycle: end, id, text: `E\t${id}\t0\t${name}` });
        }
        events.push({ cycle: fetch + 22, id, text: `R\t${id}\t${id}\t0` });
    }
    events.sort((a, b) => a.cycle - b.cycle || a.id - b.id);
    const lines = ["Kanata\t0004", "C=\t0"];
    let previous = 0;
    for (const event of events) {
        if (event.cycle !== previous) lines.push(`C\t${event.cycle - previous}`);
        previous = event.cycle;
        lines.push(event.text);
    }
    return lines.join("\n") + "\n";
}

async function reviewFilePlayback(window: BrowserWindow) {
    const test = createBrowserTest(window);
    const { evaluate } = test;
    const ready = () =>
        waitFor(() => evaluate(({ sonata }) => !sonata.fileImport.busy), "File playback window did not settle", {
            diagnostics: () => evaluate(() => document.getElementById("import-status")!.textContent)
        });
    const rows = [];
    for (const style of ["neon", "aluminum", "paper"]) {
        await evaluate(
            (_page, text, style) => {
                document.getElementById(`style-${style}`)!.click();
                const data = new DataTransfer();
                data.items.add(new File([text], "continuous.kanata"));
                document.dispatchEvent(new DragEvent("drop", { dataTransfer: data }));
            },
            fixture(),
            style
        );
        await ready();
        assert.equal(await evaluate(({ sonata }) => sonata.trace.fileName), "continuous.kanata");
        await evaluate(({ sonata }) => {
            if (document.getElementById("auto-camera")!.getAttribute("aria-pressed") === "true")
                document.getElementById("auto-camera")!.click();
            if (document.getElementById("motion-effects")!.getAttribute("aria-pressed") === "true")
                document.getElementById("motion-effects")!.click();
            sonata.captureAt(127);
            document.querySelector("#labels > *")!.setAttribute("data-continuity-test", "true");
        });
        const before = await evaluate(({ sonata }) => ({
            positions: sonata.particles.map((p) => ({ id: p.id, position: p.pathPosition })),
            builds: sonata.sceneBuilds,
            camera: sonata.camera,
            minimum: sonata.memoryTiming.minimum
        }));
        assert.ok(before.positions.length >= 5, "The boundary fixture needs overlapping live instructions");
        const beforePixels = electron.nativeImage
            .createFromDataURL(
                await evaluate(({ sonata, $ }) => {
                    sonata.captureAt(127);
                    return $("scene").toDataURL("image/png");
                })
            )
            .toBitmap();
        await evaluate(() => {
            (document.getElementById("file-cycle") as HTMLInputElement).value = "127";
            document.getElementById("file-go")!.click();
        });
        await ready();
        await evaluate(({ sonata }) => sonata.captureAt(127));
        const after = await evaluate(({ sonata }) => ({
            positions: sonata.particles.map((p) => ({ id: p.id, position: p.pathPosition })),
            builds: sonata.sceneBuilds,
            camera: sonata.camera,
            labelsRetained: Boolean(document.querySelector("#labels [data-continuity-test]")),
            minimum: sonata.memoryTiming.minimum
        }));
        for (const old of before.positions) {
            const current = after.positions.find((p) => p.id === old.id);
            assert.ok(current, `${style}: instruction ${old.id} disappeared at the window boundary`);
            const displacement = Math.hypot(...current.position.map((value, axis) => value - old.position[axis]));
            assert.ok(displacement < 1e-6, `${style}: instruction ${old.id} moved ${displacement} at the same cycle`);
        }
        const afterPixels = electron.nativeImage
            .createFromDataURL(
                await evaluate(({ sonata, $ }) => {
                    sonata.captureAt(127);
                    return $("scene").toDataURL("image/png");
                })
            )
            .toBitmap();
        assert.ok(
            beforePixels.equals(afterPixels),
            `${style}: the same cycle rendered differently after a window switch`
        );
        assert.equal(after.builds, before.builds, `${style}: identical fixed geometry was rebuilt`);
        assert.ok(after.labelsRetained, `${style}: identical stage labels were replaced`);
        // 過去のpanからゼロへ近づく補間は微小値が残る。目標と操作状態は厳密に比較する。
        const target = ({ focus, radius, azimuth, elevation, ...rest }: typeof before.camera) => rest;
        assert.deepEqual(target(after.camera), target(before.camera), "A window switch changed the camera target");
        for (const key of ["radius", "azimuth", "elevation"] as const)
            assert.ok(Math.abs(after.camera[key] - before.camera[key]) < 1e-8, `A window switch changed camera ${key}`);
        assert.ok(
            Math.hypot(...after.camera.focus.map((value, axis) => value - before.camera.focus[axis])) < 1e-8,
            "A window switch moved the camera focus"
        );
        assert.deepEqual(after.minimum, before.minimum, "Memory pipe length changed with the window");
        await evaluate(({ sonata }) => {
            document.getElementById("motion-effects")!.click();
            sonata.captureAt(sonata.trace.lastCycle - 0.1);
            const speed = document.getElementById("speed") as HTMLSelectElement;
            speed.value = "128";
            speed.dispatchEvent(new Event("change"));
            sonata.setPlaying(true);
        });
        await waitFor(
            () => evaluate(({ sonata }) => sonata.trace.firstCycle >= 254 && sonata.cycle > 254 && sonata.playing),
            "Fast playback did not continue across the window boundary"
        );
        await evaluate(({ sonata }) => {
            sonata.setPlaying(false);
            const speed = document.getElementById("speed") as HTMLSelectElement;
            speed.value = "4";
            speed.dispatchEvent(new Event("change"));
        });
        rows.push({ style, instructions: before.positions.length, fixedGeometryReused: true });
    }
    await evaluate(() => {
        const text =
            [
                "Kanata\t0004",
                "C=\t0",
                "I\t0\t0\t0",
                "S\t0\t0\tF",
                "C\t124",
                "E\t0\t0\tF",
                "R\t0\t0\t1",
                "C\t2",
                "I\t1\t1\t0",
                "S\t1\t0\tF",
                "C\t14",
                "E\t1\t0\tF",
                "R\t1\t1\t0"
            ].join("\n") + "\n";
        const data = new DataTransfer();
        data.items.add(new File([text], "flush-context.kanata"));
        document.dispatchEvent(new DragEvent("drop", { dataTransfer: data }));
    });
    await ready();
    await evaluate(() => {
        (document.getElementById("file-cycle") as HTMLInputElement).value = "127";
        document.getElementById("file-go")!.click();
    });
    await ready();
    const flush = await evaluate(({ sonata }) => ({
        events: sonata.flushEvents,
        disabled: (document.getElementById("next-flush") as HTMLButtonElement).disabled,
        markers: document.querySelectorAll("#event-markers .event-marker").length
    }));
    assert.ok(flush.events.includes(124), "A preceding squash was lost from animation context");
    assert.ok(flush.disabled, "A preceding squash incorrectly enabled the next-event button");
    assert.equal(flush.markers, 0, "A context event created a marker outside the selected timeline");
    await evaluate(() => document.getElementById("file-close")!.click());
    return rows;
}
export = reviewFilePlayback;

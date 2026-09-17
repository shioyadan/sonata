"use strict";
// 実File入力から、Fetchの束・段をまたぐlane・退出後の前詰めを描画まで確認する。
import assert = require("node:assert/strict");
import fs = require("node:fs");
import path = require("node:path");
import type { BrowserWindow } from "electron";
import type browserTest = require("./browser-test.cts");
const { createBrowserTest } = require("./load-test.cjs")("browser-test.cts") as typeof browserTest;

async function reviewFrontGroups(
    window: BrowserWindow,
    screenshots: string,
    importFile: (name: string, bytes: string | Uint8Array) => Promise<void>
) {
    const test = createBrowserTest(window);
    const { evaluate } = test;
    const timings = [
        [1, 5, 8, 11],
        [1, 6, 9, 12],
        [2, 10, 12, 14],
        [2, 10, 12, 14],
        [3, 12, 14, 16],
        [3, 12, 14, 16]
    ];
    const text = timings
        .map(([fetch, decode, rename, dispatch], id) =>
            [
                `O3PipeView:fetch:${fetch * 1000}:0x${(4096 + id * 4).toString(16)}:0:${id + 1}: add x0, x1, x2`,
                `O3PipeView:decode:${decode * 1000}`,
                `O3PipeView:rename:${rename * 1000}`,
                `O3PipeView:dispatch:${dispatch * 1000}`,
                `O3PipeView:issue:${(dispatch + 1) * 1000}`,
                `O3PipeView:complete:${(dispatch + 2) * 1000}`,
                `O3PipeView:retire:${(20 + id) * 1000}`,
                ""
            ].join("\n")
        )
        .join("");
    await importFile("fetch-groups.o3", text);
    const records = await evaluate(({ sonata }) => sonata.trace.ops);
    const origin = timings[0][0] - records[0][2];
    assert.deepEqual(
        records.map((op) => op[2]),
        timings.map((row) => row[0] - origin)
    );
    const ids = records.map((op) => op[0]);
    assert.equal(await evaluate(({ sonata }) => sonata.frontend.lanes), 2);
    assert.deepEqual(await evaluate(({ sonata }) => sonata.frontend.groups.map((group) => group.ids)), [
        ids.slice(0, 2),
        ids.slice(2, 4),
        ids.slice(4, 6)
    ]);
    const sample = async (time: number) => {
        await test.sampleFrame(() => evaluate(({ sonata }, cycle) => sonata.captureAt(cycle), time - origin));
        return evaluate(({ sonata }) => ({
            cycle: sonata.cycle,
            entries: sonata.frontend.entries,
            particles: sonata.particles,
            radius: sonata.instructionLayout.radius
        }));
    };
    for (const style of ["neon", "aluminum", "paper"]) {
        await evaluate((_page, style) => document.getElementById(`style-${style}`)!.click(), style);
        const waiting = await sample(3.9);
        assert.equal(waiting.cycle, 3.9 - origin);
        assert.equal(waiting.radius, 0.12);
        assert.equal(waiting.entries.length, 6);
        const positions = ids.map((id) => waiting.particles.find((particle) => particle.id === id)!.pathPosition);
        for (let group = 0; group < 3; group++) {
            const [first, second] = positions.slice(group * 2, group * 2 + 2);
            assert.equal(first[0], second[0], `Fetch group split into different rows in ${style}`);
            assert.ok(second[2] - first[2] >= 0.24, `Program order reversed within a fetch group in ${style}`);
            if (group) assert.ok(positions[(group - 1) * 2][0] > first[0], "A younger group overtook an older group");
        }
        const split = await sample(5.9);
        const first = split.entries.find((entry) => entry.id === ids[0])!;
        const second = split.entries.find((entry) => entry.id === ids[1])!;
        assert.notEqual(first.node, second.node, "A fetch group forced simultaneous stage transitions");
        assert.equal(first.lane, 0);
        assert.equal(second.lane, 1, "A remaining group member was moved into the vacated lane");
        assert.equal(split.particles.find((p) => p.id === ids[1])!.pathPosition[2], positions[1][2]);
        const moving = await sample(6.2);
        const moved = await sample(6.5);
        const rowDuring = moving.entries.find((entry) => entry.id === ids[2])!.row;
        const rowAfter = moved.entries.find((entry) => entry.id === ids[2])!.row;
        assert.ok(rowDuring > 0 && rowDuring < 1, "Front-end compaction did not interpolate");
        assert.equal(rowAfter, 0, "The oldest remaining group did not advance to the exit");
        for (const time of [3.9, 5.9, 6.8, 6.9, 7, 7.2, 7.5, 9.8, 12.9]) {
            const state = await sample(time);
            assert.ok(state.particles.every((particle) => particle.pathPosition.every(Number.isFinite)));
        }
        const reverse = await sample(3.9);
        assert.deepEqual(reverse.entries, waiting.entries, "Seeking backward changed the group layout");
        assert.deepEqual(
            reverse.particles.map((particle) => particle.pathPosition),
            waiting.particles.map((particle) => particle.pathPosition)
        );
        await test.settle({ finish: true });
        fs.writeFileSync(
            path.join(screenshots, `frontend-groups-${style}.png`),
            (await window.webContents.capturePage()).toPNG()
        );
    }
    assert.deepEqual(
        await evaluate(({ sonata }) => sonata.trace.ops),
        records,
        "Front-end grouping changed trace observations"
    );

    // Dで詰まった10束を使い、4束の固定枠と入力側の表示待ちを確認する。
    const saturated = Array.from({ length: 20 }, (_, id) => {
        const group = Math.floor(id / 2),
            fetch = 1 + group,
            decode = 20 + group;
        return [
            `O3PipeView:fetch:${fetch * 1000}:0x${(4096 + id * 4).toString(16)}:0:${id + 1}: add x0, x1, x2`,
            `O3PipeView:decode:${decode * 1000}`,
            `O3PipeView:rename:${(decode + 1) * 1000}`,
            `O3PipeView:dispatch:${(decode + 2) * 1000}`,
            `O3PipeView:issue:${(decode + 3) * 1000}`,
            `O3PipeView:complete:${(decode + 4) * 1000}`,
            `O3PipeView:retire:${(40 + id) * 1000}`,
            ""
        ].join("\n");
    }).join("");
    await importFile("fetch-backpressure.o3", saturated);
    const original = await evaluate(({ sonata }) => sonata.trace.ops);
    const shift = 1 - original[0][2],
        saturatedIDs = original.map((op) => op[0]);
    const capture = async (time: number) => {
        await test.sampleFrame(() => evaluate(({ sonata }, t) => sonata.captureAt(t), time - shift));
        return evaluate(({ sonata }) => ({
            frontend: sonata.frontend,
            particles: sonata.particles,
            feed: sonata.instructionFeed,
            active: sonata.stats.active,
            camera: sonata.camera,
            detail: document.querySelector("#instruction-stream-label small")!.textContent
        }));
    };
    for (const style of ["neon", "aluminum", "paper"]) {
        await evaluate((_page, name) => document.getElementById(`style-${name}`)!.click(), style);
        const approaching = await capture(9.9);
        assert.ok(approaching.frontend.pending.length > 0);
        assert.ok(approaching.feed.some((row) => !approaching.frontend.pending.includes(row.id)));
        for (let i = 1; i < approaching.feed.length; i++)
            assert.ok(
                approaching.feed[i - 1].progress - approaching.feed[i].progress >= 1 / 24 - 1e-8,
                "An approaching input row overlapped the pending Fetch rows"
            );
        const full = await capture(16);
        const fetch = full.frontend.stages.find((stage) => stage.id === full.frontend.fetchNode)!;
        assert.equal(fetch.capacity, 4);
        assert.deepEqual(full.frontend.pending, saturatedIDs.slice(8), "Overflow did not wait in program order");
        assert.deepEqual(
            full.particles.map((p) => p.id),
            saturatedIDs.slice(0, 8)
        );
        assert.equal(full.active, 20, "Display capacity changed the recorded in-flight count");
        assert.match(full.detail!, /12 WAITING FOR DISPLAY/);
        assert.ok(full.frontend.pending.every((id) => full.feed.some((row) => row.id === id)));
        assert.equal(new Set(full.feed.map((row) => row.id)).size, full.feed.length, "Input ribbon duplicated IDs");
        assert.ok(full.feed.length <= 24, "Overflow grew the input ribbon");
        const entered = await capture(20.001);
        assert.deepEqual(entered.frontend.pending, saturatedIDs.slice(10), "D entry did not free a Fetch slot");
        assert.equal(entered.frontend.entries.find((entry) => entry.id === saturatedIDs[8])!.entry, 20 - shift);
        const settled = await capture(20.9);
        const p = settled.particles.find((particle) => particle.id === saturatedIDs[8])!.pathPosition;
        assert.ok(Math.abs(p[0] - fetch.bounds.x) + 0.12 <= fetch.bounds.w / 2 + 1e-8);
        assert.ok(Math.abs(p[2] - fetch.bounds.z) + 0.12 <= fetch.bounds.d / 2 + 1e-8);
        assert.deepEqual(settled.frontend.stages, full.frontend.stages, "Fetch resized after admitting a bundle");
        assert.equal(settled.camera.targetRadius, full.camera.targetRadius, "Fetch admission changed the zoom");
        const reverse = await capture(16);
        assert.deepEqual(reverse.frontend, full.frontend, "Backward seek changed Fetch admission");
        assert.deepEqual(
            reverse.particles.map(({ id, pathPosition }) => ({ id, pathPosition })),
            full.particles.map(({ id, pathPosition }) => ({ id, pathPosition })),
            "Backward seek changed visible Fetch instructions"
        );
        await test.settle({ finish: true });
        fs.writeFileSync(
            path.join(screenshots, `fetch-admission-${style}.png`),
            (await window.webContents.capturePage()).toPNG()
        );
    }
    assert.deepEqual(await evaluate(({ sonata }) => sonata.trace.ops), original, "Admission rewrote trace times");

    // 4束を超えて同サイクルにDへ進む場合も、Fを通る途中の位置を束ごとに分ける。
    const simultaneous = saturated.replace(/O3PipeView:decode:\d+/g, "O3PipeView:decode:20000");
    await importFile("fetch-same-cycle.o3", simultaneous);
    const simultaneousRecords = await evaluate(({ sonata }) => sonata.trace.ops);
    for (const style of ["neon", "aluminum", "paper"]) {
        await evaluate((_page, name) => document.getElementById(`style-${name}`)!.click(), style);
        const before = await capture(19.9);
        assert.equal(before.frontend.pending.length, 12);
        // 先行4束の退出も含めた3回の移動のうち、最後の束がFを通る瞬間。
        const passing = await capture(20 + (0.82 * 2.5) / 3);
        const ids = simultaneousRecords.slice(-4).map((op) => op[0]);
        const positions = ids.map((id) => passing.particles.find((p) => p.id === id)!.pathPosition);
        assert.equal(passing.frontend.pending.length, 0);
        const fetch = passing.frontend.stages.find((stage) => stage.id === passing.frontend.fetchNode)!;
        for (const p of positions)
            assert.ok(
                Math.abs(p[0] - fetch.bounds.x) + 0.12 <= fetch.bounds.w / 2 + 1e-7 &&
                    Math.abs(p[2] - fetch.bounds.z) + 0.12 <= fetch.bounds.d / 2 + 1e-7,
                `Same-cycle admission skipped the Fetch body in ${style}`
            );
        for (const offset of [0.1, 0.3, 0.381, 0.5, 0.6, 0.7, 0.82]) {
            const state = await capture(20 + offset);
            const allPositions = state.particles.map((particle) => particle.pathPosition);
            for (let i = 0; i < allPositions.length; i++)
                for (let j = i + 1; j < allPositions.length; j++)
                    assert.ok(
                        Math.hypot(...allPositions[i].map((value, axis) => value - allPositions[j][axis])) >=
                            0.24 - 1e-7,
                        `Same-cycle Fetch passages overlapped in ${style} at ${offset}`
                    );
        }
    }
    assert.deepEqual(await evaluate(({ sonata }) => sonata.trace.ops), simultaneousRecords);
}
export = reviewFrontGroups;

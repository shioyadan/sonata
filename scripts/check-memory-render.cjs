"use strict";
// 実描画で書込みの輪を観測時刻に合わせ、前後へのシークでも同じ状態を得る。
const assert = require("node:assert/strict");
const fs = require("node:fs"),
    path = require("node:path");
const { createBrowserTest } = require("./load-test.cjs")("browser-test.cts");
module.exports = async function reviewMemory(window, screenshots) {
    const { evaluate, sampleFrame } = createBrowserTest(window);
    const results = [];
    for (const key of ["branch-storm", "rename-rush", "x86-recovery"]) {
        const selected = await sampleFrame(() =>
            evaluate(({ sonata, $ }, key) => {
                sonata.loadTrace(key);
                $("style-blocks").click();
                const record = sonata.trace.storeCompletions.find(([id, end]) => {
                    const op = sonata.ops.find((op) => op.id === id);
                    return op && op.end >= sonata.trace.firstCycle && end > op.end + 2 && end < sonata.trace.lastCycle;
                });
                if (!record) throw new Error("No recorded pending store in " + key);
                const op = sonata.ops.find((op) => op.id === record[0]);
                return { id: op.id, start: op.end, end: record[1], minimum: sonata.memoryTiming.minimum };
            }, key)
        );
        const times = [
            selected.start - 0.001,
            selected.start,
            selected.start + 2.1,
            selected.end,
            selected.start + 2.1
        ];
        const states = [];
        for (const cycle of times) {
            states.push(
                await sampleFrame(() =>
                    evaluate(
                        ({ sonata, gl }, cycle, id) => {
                            sonata.captureAt(cycle);
                            return {
                                pending: sonata.pendingStores.find((s) => s.id === id) ?? null,
                                inRob: sonata.rob.entries.some((e) => e.id === id),
                                error: gl.getError()
                            };
                        },
                        cycle,
                        selected.id
                    )
                )
            );
        }
        assert.equal(states[0].pending, null, "Store marker anticipated commit");
        assert.equal(states[0].inRob, true);
        assert.ok(states[1].pending, "Recorded pending write disappeared at commit");
        assert.equal(states[1].inRob, false, "Pending write retained a retired ROB entry");
        assert.ok(states[2].pending, "Instruction departure removed an outstanding write");
        assert.equal(states[3].pending, null, "Completed write remained pending");
        assert.deepEqual(states[4], states[2], "Seeking changed pending write state");
        assert.ok(states.every((s) => s.error === 0));
        fs.writeFileSync(path.join(screenshots, `memory-${key}.png`), (await window.webContents.capturePage()).toPNG());
        results.push({ key, ...selected });
    }
    await sampleFrame(() =>
        evaluate(({ sonata }) => {
            sonata.loadTrace("memory-tide");
            sonata.captureAt(4000);
            if (sonata.pendingStores.length) throw new Error("Unrecorded RSD store writes were invented");
        })
    );
    fs.writeFileSync(path.join(screenshots, "memory-tide-split.png"), (await window.webContents.capturePage()).toPNG());
    return results;
};

"use strict";
// 抽出器と同じ TypeScript ローダーを使い、元ログなしで Store Tick の校正と除外を検査する。
// node --import tsx scripts/check-store-evidence.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseTrace, getOps, getGem5StoreCompletions, buildSample } = require("./import-trace.ts");

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-store-evidence-"));
    let trace;
    try {
        const records = [
            ["strh w1, [x2]", 11025],
            ["MOV_M_R : st rax, DS:[t0 + r12]", 11200],
            ["str w1, [x2]", 0],
            ["str w1, [x2]", null],
            ["ldr w1, [x2]", 11400],
            ["str w1, [x2]", 11500, true],
            ["stxr w0, w1, [x2]", 11600],
            ["sbfm w0, w0, #0, #15", 11700]
        ];
        const lines = records.flatMap(([instruction, store, flush], index) => {
            const fetch = 10000 + index * 100;
            return [
                `O3PipeView:fetch:${fetch}:0x1000:0:${20 + index}: ${instruction}`,
                ...["decode", "rename", "dispatch", "issue", "complete"].map(
                    (stage, offset) =>
                        `O3PipeView:${stage}:${fetch + (offset + 1 + (index === 0 && offset >= 3 ? 2 : 0)) * 100}`
                ),
                `O3PipeView:retire:${flush ? 0 : fetch + 900}${store === null ? "" : ":store:" + store}`
            ];
        });
        const source = {
            key: "fixture",
            label: "Store evidence fixture",
            displayName: "fixture.log",
            fileName: path.join(root, "fixture.log"),
            parser: "gem5",
            machineOrder: "out-of-order"
        };
        fs.writeFileSync(source.fileName, lines.join("\n") + "\n");
        trace = await parseTrace(source);
        const ops = getOps(trace);
        const original = JSON.stringify(ops);
        assert.deepEqual(getGem5StoreCompletions(source, ops), [
            [0, 10.25],
            [1, 12]
        ]);
        const sample = await buildSample({ ...source, window: [0, 0], initialCycle: 0 });
        assert.deepEqual(sample.storeCompletions, [[0, 10.25]], "Sampling lost or clipped recorded store completion");
        const absent = await buildSample({ ...source, window: [12, 12], initialCycle: 12 });
        assert.equal(Object.hasOwn(absent, "storeCompletions"), false, "Absent evidence became an observed empty list");
        assert.equal(JSON.stringify(ops), original, "Store evidence changed parsed stages or instruction timing");
        assert.equal(ops[0].retiredCycle, 10, "Store completion extended the retirement stage");
        assert.deepEqual(getGem5StoreCompletions({ parser: "onikiri" }, ops), []);
        assert.deepEqual(getGem5StoreCompletions(source, []), []);
        assert.deepEqual(getGem5StoreCompletions(source, [ops[0]]), [], "Missing calibration was guessed");

        // 既存の cycle 起点が0とは限らない。一定のoffsetだけを保ち、端数も丸めない。
        const shifted = ops.map((op) => ({ ...op, fetchedCycle: op.fetchedCycle + 123.5 }));
        assert.deepEqual(getGem5StoreCompletions(source, shifted), [
            [0, 133.75],
            [1, 135.5]
        ]);
        assert.deepEqual(
            getGem5StoreCompletions(
                source,
                ops.map((op) => ({ ...op, fetchedCycle: 0 }))
            ),
            [],
            "Equal fetch cycles supplied no tick scale"
        );
        assert.deepEqual(
            getGem5StoreCompletions(
                source,
                ops.map((op, index) => ({ ...op, fetchedCycle: -index }))
            ),
            [],
            "Negative tick scale was accepted"
        );
        assert.deepEqual(
            getGem5StoreCompletions(
                source,
                ops.map((op, index) => ({ ...op, fetchedCycle: op.fetchedCycle + (index === 3 ? 1 : 0) }))
            ),
            [],
            "Inconsistent calibration was accepted"
        );
        for (const detail of ["", "Store Tick: -1", "Store Tick: NaN", "Store Tick: 9007199254740992", "Store Tick: 1"])
            assert.deepEqual(
                getGem5StoreCompletions(
                    source,
                    ops.map((op) => ({
                        ...op,
                        labelDetail: op.labelDetail.replace(/^Store Tick: .*$/m, detail)
                    }))
                ),
                [],
                `Invalid store completion was accepted: ${detail}`
            );
        assert.deepEqual(
            getGem5StoreCompletions(
                source,
                ops.map((op) => ({ ...op, retired: false }))
            ),
            [],
            "An unretired store acquired completion evidence"
        );
        console.log("Store evidence: raw parser ticks, cycle calibration, missing values and ordinary stores passed");
    } finally {
        trace?.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

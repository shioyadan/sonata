"use strict";
// 配布生ログをCoreへ通し、旧デモに含まれた命令のID・原時刻・終了状態を照合する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { File } = require("node:buffer");
const files = require("../src/trace-file.cts");
const replay = require("../src/replay-model.cts");
const root = path.resolve(__dirname, "..");
const readJSON = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const catalog = readJSON("data/sample-catalog.json");
const sources = readJSON("data/sample-sources.json").sources;
const legacy = JSON.parse(
    fs
        .readFileSync(path.join(root, "data/traces.js"), "utf8")
        .split("globalThis.embeddedFlowTraces=")[1]
        .trim()
        .replace(/;$/, "")
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function check() {
    let compared = 0;
    for (const source of sources) {
        const compressed = fs.readFileSync(path.join(root, "data/samples", source.file));
        const bytes = gunzipSync(compressed);
        assert.equal(compressed.length, source.bytes);
        assert.equal(digest(compressed), source.sha256);
        assert.equal(bytes.length, source.prefixBytes);
        assert.equal(digest(bytes), source.rawSha256);
        assert.equal(bytes.at(-1), 10, "Sample truncated a source line");
        const entries = catalog.filter((entry) => entry.url === `samples/${source.file}`);
        assert.ok(entries.length, `Unreferenced raw sample: ${source.file}`);
        let window;
        const session = files.createFileSession((response) => {
            if (response.type === "window") window = response.trace;
        });
        try {
            await session.open(new File([compressed], entries[0].name), entries[0].config);
            for (const entry of entries) {
                await session.window({
                    type: "window",
                    request: 1,
                    cycle: entry.firstCycle,
                    span: entry.lastCycle - entry.firstCycle + 1,
                    thread: 0
                });
                assert.deepEqual([window.firstCycle, window.lastCycle], [entry.firstCycle, entry.lastCycle]);
                assert.ok(window.topDown?.slots.length, `${entry.key}: missing window analysis`);
                assert.equal(window.structure.robCapacity, entry.config.robEntries ?? window.structure.robCapacity);
                const model = replay.createReplay({ samples: [] });
                model.loadData(window);
                const ops = new Map(window.ops.map((op) => [op[0], op]));
                const expected = legacy.find((demo) => demo.key === entry.key);
                assert.ok(expected, `Missing migration fixture: ${entry.key}`);
                assert.deepEqual([entry.firstCycle, entry.lastCycle], [expected.firstCycle, expected.lastCycle]);
                assert.deepEqual(entry.provenance, expected.demo.provenance);
                assert.equal(
                    entry.config.isa,
                    source.source.startsWith("rsd/") ? "riscv" : source.source.includes("/x86/") ? "x86" : "aarch64"
                );
                if (entry.provenance.robEntries !== undefined)
                    assert.equal(entry.config.robEntries, entry.provenance.robEntries);
                assert.deepEqual(entry.bookmarks, expected.demo.bookmarks);
                for (const recorded of expected.ops) {
                    const op = ops.get(recorded[0]);
                    assert.ok(op && !op[12], `${entry.key}: missing complete instruction ${recorded[0]}`);
                    assert.deepEqual(
                        op.slice(0, 6),
                        recorded.slice(0, 6),
                        `${entry.key}: recorded instruction changed: ${recorded[0]}`
                    );
                    compared++;
                }
                assert.equal(window.evidence?.registers?.rows.length, 32, `${entry.key}: logical register layout`);
                const expectedRegisters = expected.evidence.registers;
                if (expectedRegisters.kind === "configuration") {
                    assert.deepEqual(window.evidence.registers.initial.mapping, []);
                    assert.deepEqual(window.evidence.registers.initial.values, []);
                } else {
                    assert.equal(window.evidence.registers.events.length, expectedRegisters.events.length);
                    assert.deepEqual(window.evidence.registers.reads ?? [], expectedRegisters.reads ?? []);
                }
                for (const event of expected.demo.events ?? []) {
                    const actual = window.demo.events.find(
                        (e) => e.kind === event.kind && e.id === event.id && e.cycle === event.cycle
                    );
                    assert.ok(actual, `${entry.key}: lost recorded notice ${event.id}`);
                    assert.equal(actual.line, event.line);
                    assert.equal(actual.endCycle, event.endCycle);
                }
                console.log(`Raw sample: ${entry.key} · ${expected.ops.length} recorded instructions unchanged`);
            }
        } finally {
            session.close();
        }
    }
    console.log(
        `Raw samples: ${sources.length} gzip files / ${catalog.length} demos / ${compared} recorded instructions verified`
    );
}
check().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

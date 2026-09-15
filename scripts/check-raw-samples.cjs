"use strict";
// 配布生ログをCoreへ通し、旧デモに含まれた命令のID・原時刻・終了状態を照合する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { File } = require("node:buffer");
const core = require("../vendor/konata-core/browser.cjs");
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
        const Parser = source.file.startsWith("gem5-") ? core.Gem5O3PipeViewParser : core.OnikiriParser;
        const trace = await new Parser().parse(new core.FileLineReader(new File([compressed], source.file)));
        try {
            for (const entry of entries) {
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
                    const op = trace.getOpForScan(recorded[0]);
                    assert.ok(op && !op.eof, `${entry.key}: missing complete instruction ${recorded[0]}`);
                    assert.deepEqual(
                        [
                            op.id,
                            op.rid,
                            op.fetchedCycle,
                            op.retiredCycle,
                            op.flush ? 1 : 0,
                            op.labelName || `(g:${op.gid})`
                        ],
                        recorded.slice(0, 6),
                        `${entry.key}: recorded instruction changed: ${recorded[0]}`
                    );
                    compared++;
                }
                console.log(`Raw sample: ${entry.key} · ${expected.ops.length} recorded instructions unchanged`);
            }
        } finally {
            trace.close();
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

"use strict";
// 別の場所へ移したソースだけで、Konata・node_modules・元ログなしにビルドできることを確認する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { build, formatTraceScript } = require("./build.cjs");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readTrace = (source) => {
    const context = {};
    vm.runInNewContext(source, context, { timeout: 10000 });
    return JSON.parse(JSON.stringify(context.embeddedFlowTraces));
};
const original = read("data/traces.js");
const expected = readTrace(original);
const definitions = JSON.parse(read("data/sample-catalog.json"));
const sources = JSON.parse(read("data/sample-sources.json")).sources;
assert.deepEqual(readTrace(formatTraceScript(original)), expected);
assert.equal(
    formatTraceScript(formatTraceScript(original)),
    formatTraceScript(original),
    "Trace formatting is not idempotent"
);
const strings =
    "globalThis.embeddedFlowTraces=" +
    JSON.stringify([
        { text: 'quotes " , backslash \\ and </script>', items: Array(300).fill('a,b\n"\\') },
        [0, -1, 0.25, null, true, false]
    ]) +
    ";";
assert.deepEqual(readTrace(formatTraceScript(strings)), readTrace(strings));
const output = build(),
    bytes = fs.readFileSync(output);
const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
assert.ok(!bytes.some((c) => c < 32 && ![9, 10, 13].includes(c)), "Binary control character in HTML");
assert.ok(!/<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel="stylesheet"/i.test(html));
assert.ok(html.includes(read("LICENSE.md").trim()), "Standalone HTML lost its license notice");
const noticeBlock = /<pre id="license-text">([\s\S]*?)<\/pre>/.exec(html);
assert.ok(noticeBlock, "Standalone HTML lost its readable license panel");
const notices = noticeBlock[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
for (const file of [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "licenses/COREMARK-LICENSE.md",
    "licenses/RSD-LICENSE.txt",
    "licenses/RSD-CREDITS.md",
    "vendor/konata-core/LICENSE.md",
    "vendor/wasm-zstd/LICENSE",
    "vendor/wasm-zstd/FZSTD-LICENSE.txt",
    "vendor/wasm-zstd/ZSTD-LICENSE.txt"
]) {
    assert.ok(notices.includes(read(file).trim()), `Standalone HTML lost third-party notice: ${file}`);
}
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 2);
assert.ok(!html.includes("globalThis.embeddedFlowTraces="), "HTML still embeds the demo data");
assert.equal(new Set(expected.map((t) => t.key)).size, 5);
for (const script of scripts) new vm.Script(script);
const workerContext = {};
vm.runInNewContext(scripts[0], workerContext);
assert.equal(workerContext.embeddedFlowTraces, undefined, "HTML still initializes embedded demos");
const catalog = JSON.parse(JSON.stringify(workerContext.sonataDemoCatalog));
assert.deepEqual(
    catalog,
    definitions.map((entry) => ({
        ...entry,
        size: sources.find((source) => entry.url === `samples/${source.file}`).bytes
    })),
    "Demo catalog changed the labels, metadata or portable sample URLs"
);
assert.deepEqual(
    catalog.map(({ key, label }) => ({ key, label })),
    expected.map(({ key, label }) => ({ key, label }))
);
assert.ok(JSON.stringify(catalog).length < 32768, "Sample metadata is no longer a small catalog");
const sampleFiles = sources.map(({ file }) => file).sort();
assert.deepEqual(fs.readdirSync(path.join(root, "dist/samples")).sort(), sampleFiles);
for (const source of sources) {
    const sample = fs.readFileSync(path.join(root, "dist/samples", source.file));
    assert.deepEqual(sample, fs.readFileSync(path.join(root, "data/samples", source.file)));
    assert.equal(createHash("sha256").update(sample).digest("hex"), source.sha256);
    assert.deepEqual([...sample.subarray(0, 3)], [31, 139, 8], "Sample is not a raw gzip stream");
}
for (const demo of expected) {
    assert.ok(!html.includes(JSON.stringify(demo.ops)), `HTML still includes instructions: ${demo.key}`);
}
assert.ok(workerContext.sonataTraceWorkerSource.includes("PagedOpStore"), "Offline trace reader missing");
new vm.Script(workerContext.sonataTraceWorkerSource);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-build-"));
try {
    for (const entry of ["src", "data", "vendor", "LICENSE.md", "THIRD_PARTY_NOTICES.md", "licenses"]) {
        fs.cpSync(path.join(root, entry), path.join(temp, entry), { recursive: true });
    }
    // 旧デモJSONは移行比較用だけで、ビルドには不要。
    fs.unlinkSync(path.join(temp, "data/traces.js"));
    fs.unlinkSync(path.join(temp, "data/demo-manifest.json"));
    fs.mkdirSync(path.join(temp, "scripts"));
    for (const file of ["build.cjs", "bundle.cjs"])
        fs.copyFileSync(path.join(root, "scripts", file), path.join(temp, "scripts", file));
    const isolatedBuild = () =>
        spawnSync(process.execPath, [path.join(temp, "scripts/build.cjs")], {
            cwd: os.tmpdir(),
            encoding: "utf8"
        });
    const result = isolatedBuild();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
        fs.readFileSync(path.join(temp, "dist/sonata.html")),
        bytes,
        "Build depends on checkout location or installed packages"
    );
    const isolatedSamples = path.join(temp, "dist/samples");
    assert.deepEqual(fs.readdirSync(isolatedSamples).sort(), sampleFiles);
    for (const file of sampleFiles)
        assert.deepEqual(
            fs.readFileSync(path.join(isolatedSamples, file)),
            fs.readFileSync(path.join(root, "dist/samples", file)),
            `Sample build depends on checkout location: ${file}`
        );
    // 削除したデモを再ビルド後の配布へ混ぜない。
    fs.writeFileSync(path.join(isolatedSamples, "obsolete-demo.json"), "{}");
    assert.equal(isolatedBuild().status, 0);
    assert.deepEqual(fs.readdirSync(isolatedSamples).sort(), sampleFiles);
    // ファイル名はデータから組み立てるため、ディレクトリ移動や重複を生成前に拒否する。
    for (const key of ["../escape", "a/b", "a\\b", "%2e%2e", "demo.json", expected[1].key]) {
        const invalid = structuredClone(definitions);
        invalid[0].key = key;
        fs.writeFileSync(path.join(temp, "data/sample-catalog.json"), JSON.stringify(invalid));
        const rejected = isolatedBuild();
        assert.notEqual(rejected.status, 0, `Unsafe demo key accepted: ${key}`);
        assert.match(rejected.stderr, /Invalid or duplicate demo key/);
    }
    assert.ok(!fs.existsSync(path.join(temp, "dist/escape.log.gz")), "Demo key escaped its output directory");
    for (const url of [
        "../escape.log.gz",
        "samples/../escape.log.gz",
        "https://example.test/trace.log.gz",
        "samples/missing.log.gz",
        "samples/rename-rush.json"
    ]) {
        const invalid = structuredClone(definitions);
        invalid[0].url = url;
        fs.writeFileSync(path.join(temp, "data/sample-catalog.json"), JSON.stringify(invalid));
        const rejected = isolatedBuild();
        assert.notEqual(rejected.status, 0, `Unsafe sample URL accepted: ${url}`);
        assert.match(rejected.stderr, /Invalid or missing sample URL/);
    }
    fs.writeFileSync(path.join(temp, "data/sample-catalog.json"), JSON.stringify(definitions));
    const samplePath = path.join(temp, "data/samples", sampleFiles[0]);
    const changed = fs.readFileSync(samplePath);
    changed[changed.length - 1] ^= 1;
    fs.writeFileSync(samplePath, changed);
    const rejected = isolatedBuild();
    assert.notEqual(rejected.status, 0, "Build accepted changed raw sample bytes");
    assert.match(rejected.stderr, /Sample bytes changed/);
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
const upstream = JSON.parse(read("vendor/konata-core/UPSTREAM.json"));
for (const [file, hash] of Object.entries(upstream.files)) {
    const actual = createHash("sha256")
        .update(fs.readFileSync(path.join(root, "vendor/konata-core", file)))
        .digest("hex");
    assert.equal(actual, hash, `Vendored ${file} changed; document the change in UPSTREAM.json`);
}
console.log(
    `Build: ${expected.length} demos / ${sampleFiles.length} raw gzip samples unchanged; catalog only in HTML; UTF-8; offline reader; reproducible outside checkout; ${Object.keys(upstream.files).length} upstream files verified`
);

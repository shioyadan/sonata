"use strict";
// Node の標準機能だけで、本体 HTML と必要時に読み込む生トレースの圧縮ファイルを生成する。
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const { bundle } = require("./bundle.cjs");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function traceJson(source) {
    const marker = "globalThis.embeddedFlowTraces=",
        start = source.indexOf(marker);
    if (start < 0) throw new Error("Missing embedded trace assignment");
    return {
        marker,
        start,
        json: source
            .slice(start + marker.length)
            .trim()
            .replace(/;$/, "")
    };
}

function formatTraceScript(source) {
    const { marker, start, json } = traceJson(source);
    JSON.parse(json); // 整形対象を JSON に限定し、任意の JavaScript は整形しない。
    let quoted = false,
        escaped = false,
        column = 0,
        formatted = "";
    for (let index = 0; index < json.length; index++) {
        const char = json[index];
        formatted += char;
        column++;
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "," && column >= 120 && json[index + 1] !== "\n" && json[index + 1] !== "\r") {
            formatted += "\n";
            column = 0;
        }
        if (char === "\n") column = 0;
    }
    return source.slice(0, start) + marker + formatted + ";\n";
}

function build() {
    const definitions = JSON.parse(read("data/sample-catalog.json"));
    const sources = JSON.parse(read("data/sample-sources.json"));
    if (!Array.isArray(definitions) || !definitions.length || sources.version !== 1 || !Array.isArray(sources.sources))
        throw new Error("Missing demo catalog or sample sources");
    const files = new Map();
    for (const source of sources.sources) {
        if (
            typeof source.file !== "string" ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*\.log\.gz$/.test(source.file) ||
            files.has(source.file)
        )
            throw new Error(`Invalid or duplicate sample file: ${source.file}`);
        const bytes = fs.readFileSync(path.join(root, "data/samples", source.file));
        if (bytes.length !== source.bytes || createHash("sha256").update(bytes).digest("hex") !== source.sha256)
            throw new Error(`Sample bytes changed: ${source.file}`);
        files.set(source.file, bytes);
    }
    const keys = new Set();
    const used = new Set();
    const catalog = definitions.map((entry) => {
        const { key, label, url, firstCycle, lastCycle, initialCycle } = entry;
        if (typeof key !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || keys.has(key))
            throw new Error(`Invalid or duplicate demo key: ${key}`);
        if (typeof label !== "string" || !label) throw new Error(`Missing demo label: ${key}`);
        const filename = typeof url === "string" && /^samples\/([a-z0-9]+(?:-[a-z0-9]+)*\.log\.gz)$/.exec(url)?.[1];
        const bytes = filename && files.get(filename);
        if (!bytes) throw new Error(`Invalid or missing sample URL: ${url}`);
        if (
            ![firstCycle, lastCycle, initialCycle].every(Number.isFinite) ||
            firstCycle < 0 ||
            lastCycle < firstCycle ||
            initialCycle < firstCycle ||
            initialCycle > lastCycle
        )
            throw new Error(`Invalid demo window: ${key}`);
        if (["ops", "evidence", "topDown", "events"].some((field) => field in entry))
            throw new Error(`Demo catalog contains parsed records: ${key}`);
        keys.add(key);
        used.add(filename);
        return { ...entry, size: bytes.length };
    });
    if (used.size !== files.size) throw new Error("Unreferenced sample source");
    let html = read("src/index.html");
    const license = read("LICENSE.md").replace(/--/g, "—");
    html = html.replace("<!doctype html>", () => `<!doctype html>\n<!-- Sonata · BSD-3-Clause\n${license}\n-->`);
    // 単一 HTML をコピーして配布する場合も、第三者の権利表示と全文を持ち運ぶ。
    const noticeFiles = [
        "LICENSE.md",
        "THIRD_PARTY_NOTICES.md",
        "licenses/COREMARK-LICENSE.md",
        "licenses/RSD-LICENSE.txt",
        "licenses/RSD-CREDITS.md",
        "vendor/konata-core/LICENSE.md",
        "vendor/wasm-zstd/LICENSE",
        "vendor/wasm-zstd/FZSTD-LICENSE.txt",
        "vendor/wasm-zstd/ZSTD-LICENSE.txt"
    ];
    const notices = noticeFiles.map((file) => `${file}\n${"=".repeat(file.length)}\n${read(file).trim()}`).join("\n\n");
    const noticeMarker = "<!-- SONATA_LICENSE_NOTICES -->";
    if (!html.includes(noticeMarker)) throw new Error("Missing license notice placeholder");
    html = html.replace(noticeMarker, () => notices.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    html = html.replace(/<link rel="stylesheet" href="([^"\n]+)"\s*\/?>/g, (_tag, url) => {
        const css = read(`src/${url}`).replace(/<\/style/gi, "<\\/style");
        return `<style>\n${css}\n</style>`;
    });
    const workerOnly = ["trace-worker.cts", "trace-file.cts", "trace-window.cts", "trace-structure.cts"];
    const workerFiles = [...workerOnly, "memory.cts", "replay-model.cts", "geometry.cts"];
    const worker = bundle(root, "src/trace-worker.cts", [
        ...workerFiles.map((file) => path.join(root, "src", file)),
        path.join(root, "vendor/konata-core/browser.cjs")
    ]);
    const uiFiles = fs
        .readdirSync(path.join(root, "src"))
        .filter((file) => file.endsWith(".cts") && !workerOnly.includes(file))
        .sort()
        .map((file) => path.join(root, "src", file));
    const scripts = [
        [
            '<script id="demo-catalog"></script>',
            `globalThis.sonataDemoCatalog=${JSON.stringify(catalog)};\n` +
                `globalThis.sonataTraceWorkerSource=${JSON.stringify(worker)};\n`
        ],
        ['<script src="sonata.cts"></script>', bundle(root, "src/sonata.cts", uiFiles)]
    ];
    for (const [tag, source] of scripts) {
        if (!html.includes(tag)) throw new Error(`Missing source script: ${tag}`);
        html = html.replace(tag, () => `<script>\n${source.replace(/<\/script/gi, "<\\/script")}\n</script>`);
    }
    if (/<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel="stylesheet"|(?:src|href)="(?:\.\.\/|sonata-)/i.test(html))
        throw new Error("The application still depends on an external script or stylesheet.");
    const output = path.join(root, "dist/sonata.html");
    const samples = path.join(path.dirname(output), "samples");
    // 再ビルドで削除済みのデモを配布しない。生成物以外には触れない。
    fs.rmSync(samples, { recursive: true, force: true });
    fs.mkdirSync(samples, { recursive: true });
    for (const [filename, bytes] of files) fs.writeFileSync(path.join(samples, filename), bytes);
    fs.writeFileSync(output, html);
    console.log(
        `${path.relative(process.cwd(), output)} · ${Math.round(Buffer.byteLength(html) / 1024)} KiB · ${catalog.length} demos / ${files.size} raw trace files`
    );
    return output;
}
if (require.main === module) build();
module.exports = { build, formatTraceScript };

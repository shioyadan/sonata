"use strict";
// 元ログの連続した先頭部分をそのまま圧縮する。命令・時刻・行番号は書き換えない。
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const root = path.resolve(__dirname, "..");
const inputs = process.env.SONATA_TRACE_ROOT ?? path.join(root, "inputs");
const manifestPath = path.join(root, "data/sample-sources.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const source of manifest.sources) {
    const input = path.resolve(inputs, source.source);
    if (!input.startsWith(path.resolve(inputs) + path.sep)) throw new Error("Source escaped its input directory");
    const descriptor = fs.openSync(input, "r");
    let bytes;
    try {
        if (fs.fstatSync(descriptor).size !== source.sourceBytes)
            throw new Error(`Source size changed: ${source.source}`);
        bytes = Buffer.alloc(source.prefixBytes);
        if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length)
            throw new Error(`Incomplete source prefix: ${source.source}`);
    } finally {
        fs.closeSync(descriptor);
    }
    if (bytes.at(-1) !== 10 || digest(bytes) !== source.rawSha256)
        throw new Error(`Source prefix changed: ${source.source}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.log\.gz$/.test(source.file))
        throw new Error(`Invalid sample filename: ${source.file}`);
    const compressed = gzipSync(bytes, { level: 9 });
    source.bytes = compressed.length;
    source.sha256 = digest(compressed);
    fs.mkdirSync(path.join(root, "data/samples"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/samples", source.file), compressed);
    console.log(`${source.file}: ${bytes.length} source bytes → ${compressed.length} gzip bytes`);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

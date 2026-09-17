"use strict";
// 元ログの連続した先頭部分をそのまま圧縮する。命令・時刻・行番号は書き換えない。
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createGunzip, gzipSync } = require("node:zlib");
const root = path.resolve(__dirname, "..");
const inputs = process.env.SONATA_TRACE_ROOT ?? path.join(root, "inputs");
const manifestPath = path.join(root, "data/sample-sources.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readPrefix(source) {
    const input = path.resolve(inputs, source.source);
    if (!input.startsWith(path.resolve(inputs) + path.sep)) throw new Error("Source escaped its input directory");
    // sourceBytes / sourceSha256は原本、prefixBytes / rawSha256は展開後の連続prefixを指す。
    if (fs.statSync(input).size !== source.sourceBytes) throw new Error(`Source size changed: ${source.source}`);
    if (source.sourceEncoding !== undefined && source.sourceEncoding !== "gzip")
        throw new Error(`Unknown source encoding: ${source.sourceEncoding}`);
    const file = fs.createReadStream(input);
    const stream = source.sourceEncoding === "gzip" ? file.pipe(createGunzip()) : file;
    if (stream !== file) file.on("error", (error) => stream.destroy(error));
    const bytes = Buffer.alloc(source.prefixBytes);
    let length = 0;
    try {
        for await (const chunk of stream) {
            length += chunk.copy(bytes, length, 0, Math.min(chunk.length, bytes.length - length));
            if (length === bytes.length) break;
        }
    } finally {
        stream.destroy();
        file.destroy();
    }
    if (length !== bytes.length) throw new Error(`Incomplete source prefix: ${source.source}`);
    if (bytes.at(-1) !== 10 || digest(bytes) !== source.rawSha256)
        throw new Error(`Source prefix changed: ${source.source}`);
    return bytes;
}

async function generate() {
    // ファイル名を指定すれば、そのサンプルだけを再抽出できる。
    const requested = process.argv.slice(2);
    const unknown = requested.filter((name) => !manifest.sources.some((source) => source.file === name));
    if (unknown.length) throw new Error(`Unknown sample: ${unknown.join(", ")}`);
    for (const source of manifest.sources) {
        if (requested.length && !requested.includes(source.file)) continue;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.log\.gz$/.test(source.file))
            throw new Error(`Invalid sample filename: ${source.file}`);
        const bytes = await readPrefix(source);
        const compressed = gzipSync(bytes, { level: 9 });
        source.bytes = compressed.length;
        source.sha256 = digest(compressed);
        fs.mkdirSync(path.join(root, "data/samples"), { recursive: true });
        fs.writeFileSync(path.join(root, "data/samples", source.file), compressed);
        console.log(`${source.file}: ${bytes.length} source bytes → ${compressed.length} gzip bytes`);
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
generate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

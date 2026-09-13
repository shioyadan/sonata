"use strict";
// 固定ソース・生成物と、ブラウザへ同梱する実際のCoreをNodeから検査する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { gzipSync } = require("node:zlib");
const { generate } = require("./generate-core.cjs");
const core = require("../vendor/konata-core/browser.cjs");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// Blob Workerだけをworker_threadsへ接続し、生成したWorker本文とWASMをそのまま動かす。
// この関数を子にも渡すことで、Parser Worker内からの副Worker生成を実際に通す。
function installWorkers() {
    const { Worker: Thread, parentPort } = require("node:worker_threads");
    const { resolveObjectURL } = require("node:buffer");
    const live = new Set(),
        urls = new Set(),
        stops = [];
    let created = 0;
    const createURL = URL.createObjectURL.bind(URL),
        revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
        const url = createURL(blob);
        urls.add(url);
        return url;
    };
    URL.revokeObjectURL = (url) => {
        urls.delete(url);
        revokeURL(url);
    };
    globalThis.Worker = class BrowserWorker {
        constructor(url) {
            const blob = resolveObjectURL(url);
            if (!blob) throw new Error("Worker Blob was revoked before construction");
            created++;
            live.add(this);
            this.ready = blob.text().then((source) => {
                if (this.closed) return null;
                const worker = new Thread(`(${installWorkers.toString()})();\n${source}`, { eval: true });
                worker.on("message", (data) => this.onmessage?.({ data }));
                worker.on("error", (error) => this.onerror?.({ message: error.message }));
                worker.on("exit", () => live.delete(this));
                return worker;
            });
        }
        postMessage(value, transfer = []) {
            void this.ready.then((worker) => {
                if (!this.closed) worker?.postMessage(value, transfer);
            });
        }
        terminate() {
            this.closed = true;
            live.delete(this);
            stops.push(this.ready.then((worker) => worker?.terminate()));
        }
    };
    globalThis.workerStats = async () => {
        await Promise.all(stops);
        return { created, live: live.size, urls: urls.size };
    };
    // WASMが外部ファイルを要求した場合は、隠れたネットワーク依存として失敗させる。
    globalThis.fetch = () => {
        throw new Error("The Core tried to fetch an external resource");
    };
    if (parentPort) {
        globalThis.postMessage = (value, transfer = []) => parentPort.postMessage(value, transfer);
        globalThis.close = () => parentPort.close();
        parentPort.on("message", (data) => {
            Promise.resolve(globalThis.onmessage?.({ data })).catch((error) => {
                parentPort.postMessage({ error: error.stack });
            });
        });
    }
}

function kanata(count) {
    const lines = ["Kanata\t0004"];
    for (let id = 0; id < count; id++) {
        lines.push(
            `I\t${id}\t${id + 100}\t0`,
            `L\t${id}\t0\t0x1000: add あ${id}`,
            `S\t${id}\t0\tF`,
            "C\t1",
            `E\t${id}\t0\tF`,
            `S\t${id}\t0\tX`,
            "C\t1",
            `E\t${id}\t0\tX`,
            `R\t${id}\t${id}\t0`,
            "C\t1"
        );
    }
    return lines.join("\n") + "\n";
}

function checkHashes() {
    for (const directory of ["vendor/konata-core", "vendor/wasm-zstd"]) {
        const manifest = JSON.parse(read(`${directory}/UPSTREAM.json`));
        for (const [name, expected] of Object.entries(manifest.files)) {
            const actual = createHash("sha256")
                .update(fs.readFileSync(path.join(root, directory, name)))
                .digest("hex");
            assert.equal(actual, expected, `Snapshot changed: ${directory}/${name}`);
        }
    }
    return generate({ check: true });
}

function checkTypes() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-core-types-"));
    const declaration = path.join(root, "vendor/konata-core/browser.cjs").replaceAll(path.sep, "/");
    const importSource = (name) => path.join(root, `vendor/konata-core/${name}.ts`).replaceAll(path.sep, "/");
    const fixtures = {
        "dom.cts": `import core = require(${JSON.stringify(declaration)});
            const result = core.parseTraceFile(new File(['Kanata\\t0004'], 'trace.log'), {onProgress(value){const number:number=value;},onTrace(trace){trace.getOp(0);}});
            const store = core.PagedOpStore.createZstd({maxDecodedPages:2});
            // @ts-expect-error File相当のstream入力が必要。
            core.parseTraceFile('trace.log');
            // @ts-expect-error 進捗はnumber。
            core.parseTraceFile(new File([], 'trace.log'), {onProgress(value:string){}});
            // @ts-expect-error storeの上限はnumber。
            core.PagedOpStore.createZstd({maxCachedOps:'all'});`,
        "source.cts": `import core = require(${JSON.stringify(declaration)});
            import {parseTraceFile} from ${JSON.stringify(importSource("trace_parser"))};
            import {StageStructureDetector} from ${JSON.stringify(importSource("stage_structure_detector"))};
            import {PagedOpStore} from ${JSON.stringify(importSource("paged_op_store"))};
            import {OnikiriParser} from ${JSON.stringify(importSource("onikiri_parser"))};
            import {Gem5O3PipeViewParser} from ${JSON.stringify(importSource("gem5_o3_pipe_view_parser"))};
            import {FileLineReader} from ${JSON.stringify(importSource("file_line_reader"))};
            const checked:typeof core={parseTraceFile,StageStructureDetector,PagedOpStore,OnikiriParser,Gem5O3PipeViewParser,FileLineReader};`
    };
    try {
        for (const [name, source] of Object.entries(fixtures)) {
            const file = path.join(temp, name);
            fs.writeFileSync(file, source);
            const result = spawnSync(
                process.execPath,
                [
                    path.join(root, "node_modules/typescript/bin/tsc"),
                    "--noEmit",
                    "--strict",
                    "--module",
                    "NodeNext",
                    "--target",
                    "ES2022",
                    "--lib",
                    name === "dom.cts" ? "ES2023,DOM,DOM.Iterable" : "ES2023,WebWorker",
                    "--allowImportingTsExtensions",
                    file
                ],
                { cwd: root, encoding: "utf8" }
            );
            assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
        }
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

async function checkParsers(zstd) {
    const text = kanata(3),
        expected = [];
    const encoded = new TextEncoder().encode(text);
    for (const [name, bytes] of [
        ["trace.log", encoded],
        ["trace.gz", gzipSync(encoded)],
        ["trace.zst", zstd.compress(encoded)]
    ]) {
        const progress = [];
        const result = await core.parseTraceFile(new File([bytes], name), {
            onProgress: (value) => progress.push(value)
        });
        assert.equal(result.parserName, "OnikiriParser");
        assert.equal(result.trace.opCount, 3);
        const ops = Array.from({ length: 3 }, (_, id) => result.trace.getOp(id));
        assert.equal(ops[0].labelName, "0x1000: add あ0");
        if (expected.length) assert.deepEqual(ops, expected);
        else expected.push(...ops);
        assert.ok(
            progress.every((value, index) => value >= 0 && value <= 1 && (index === 0 || value >= progress[index - 1]))
        );
        result.trace.close();
        assert.equal(result.trace.opCount, 0);
    }
    const gem5 =
        "O3PipeView:fetch:1000:0x10:0:10: add r1, r2\nO3PipeView:decode:2000\nO3PipeView:rename:3000\nO3PipeView:dispatch:4000\nO3PipeView:issue:5000\nO3PipeView:complete:6000\nO3PipeView:retire:7000\n";
    let streams = 0;
    const input = {
        name: "gem5.zst",
        size: 0,
        type: "",
        stream() {
            streams++;
            return new Blob([zstd.compress(new TextEncoder().encode(gem5))]).stream();
        }
    };
    const result = await core.parseTraceFile(input);
    assert.equal(streams, 2, "Format fallback did not reopen the stream");
    assert.equal(result.parserName, "Gem5O3PipeViewParser");
    assert.equal(result.trace.getOp(0).retiredCycle, 7);
    result.trace.close();
    await assert.rejects(core.parseTraceFile(new File(["unrecognized\n"], "unknown.log")), /not a gem5/);
    await assert.rejects(core.parseTraceFile(new File([], "empty.log")), /empty/);
    const compressed = zstd.compress(encoded);
    await assert.rejects(
        core.parseTraceFile(new File([compressed.slice(0, -3)], "truncated.zst")),
        /Zstandard|zstd|decompress/i
    );

    const controller = new AbortController();
    let partial;
    await assert.rejects(
        core.parseTraceFile(
            new File([kanata(3000)], "cancel.log"),
            {
                onTrace: (trace) => {
                    partial = trace;
                },
                onProgress: () => controller.abort()
            },
            controller.signal
        ),
        /canceled/
    );
    assert.ok(partial);
    assert.equal(partial.opCount, 0, "Cancellation retained parsed operations");
    const lines = [];
    const long = "a".repeat(8191) + "あ";
    await new core.FileLineReader(new File([long + "\r\ntail"], "utf8.log")).readLines((line) => lines.push(line));
    assert.deepEqual(lines, [long, "tail"]);
    return expected[0];
}

async function checkPages(op) {
    const store = await core.PagedOpStore.createZstd({
        pageSizeBits: 0,
        maxDecodedPages: 1,
        maxCachedOps: 2,
        levelSpans: [1]
    });
    for (let id = 0; id < 32; id++) store.setOp(id, { ...op, id });
    await store.waitForPendingCompression();
    assert.ok(store.serializedPageCount >= 31 && store.storedSize > 0);
    assert.equal(store.decodedPageCount, 1, "Page compression retained every decoded operation");
    // ページ復元後はクラスのprototypeを持たないが、記録値はすべて保存される。
    assert.deepEqual(store.getOp(0), structuredClone(op));
    const accesses = store.opCacheAccessCount;
    assert.equal(store.getOpForScan(17).id, 17);
    assert.equal(store.opCacheAccessCount, accesses, "Scanning filled the interactive Op cache");
    store.close();
    assert.equal(store.storedSize, 0);
    assert.equal(store.opCount, 0);
}

async function checkNestedWorkers(compressed) {
    installWorkers();
    const code = read("vendor/konata-core/browser.cjs");
    const source = `const sentinel=()=>{};globalThis.onmessage=sentinel;
        const exported={exports:{}};(function(module){${code}\n})(exported);
        if(globalThis.onmessage!==sentinel)throw new Error('Core overwrote the outer Worker handler');
        onmessage=async({data})=>{
            const result=await exported.exports.parseTraceFile(new File([data],'nested.zst'));
            const count=result.trace.opCount,first=result.trace.getOp(0).labelName;
            result.trace.close();
            postMessage({count,first,stats:await workerStats()});
        };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    try {
        const result = await new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
            worker.onerror = (error) => reject(new Error(error.message));
            worker.postMessage(compressed);
        });
        assert.equal(result.count, 3000);
        assert.equal(result.first, "0x1000: add あ0");
        assert.ok(result.stats.created >= 2, "Zstd decompression and page compression did not use Workers");
        assert.equal(result.stats.live, 0, "Closing the trace left a Zstd Worker running");
        assert.equal(result.stats.urls, 0, "Zstd Worker Blob URLs were retained");
    } finally {
        worker.terminate();
    }
    const stats = await workerStats();
    assert.equal(stats.live, 0);
    assert.equal(stats.urls, 0);
}

async function main() {
    const generated = checkHashes();
    checkTypes();
    const { Zstd } = await import("@hpcc-js/wasm-zstd");
    const zstd = await Zstd.load();
    const op = await checkParsers(zstd);
    await checkPages(op);
    await checkNestedWorkers(zstd.compress(new TextEncoder().encode(kanata(3000))));
    console.log(
        `Konata core: ${generated.bytes} bytes; snapshot/regeneration/types; plain/gzip/zstd; format fallback; cancel; pages; nested Workers and cleanup passed`
    );
}

// Worker境界の不具合でも通常CIを無期限に占有しない。
const watchdog = setTimeout(() => {
    console.error("Core checks exceeded 60 seconds");
    process.exit(1);
}, 60000);
main().then(
    () => clearTimeout(watchdog),
    (error) => {
        clearTimeout(watchdog);
        console.error(error);
        process.exit(1);
    }
);

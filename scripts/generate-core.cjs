"use strict";
// Konataの固定ソースを開発時にだけ変換する。通常ビルドは生成済みbrowser.cjsを使う。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const coreDirectory = path.join(root, "vendor/konata-core");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exportsFrom = {
    parseTraceFile: "trace_parser",
    StageStructureDetector: "stage_structure_detector",
    PagedOpStore: "paged_op_store",
    OnikiriParser: "onikiri_parser",
    Gem5O3PipeViewParser: "gem5_o3_pipe_view_parser",
    FileLineReader: "file_line_reader"
};

// このローダーはブラウザとZstd Worker内の両方で動き、Node APIを参照しない。
function run(modules, entry) {
    const cache = Object.create(null);
    function load(name) {
        if (cache[name]) return cache[name].exports;
        if (!Object.hasOwn(modules, name)) throw new Error(`Unknown Konata module: ${name}`);
        const module = { exports: {} };
        cache[name] = module;
        modules[name]((specifier) => load(specifier.replace(/^\.\//, "")), module, module.exports);
        return module.exports;
    }
    return load(entry);
}

// 元Workerの本文は内側でだけ評価する。Parser Workerのonmessageを上書きしない。
// run/wasmModule/zstdWorkerModuleは生成済みモジュールの関数を参照する。
function workerAdapter(_require, module) {
    module.exports.default = function createZstdWorker() {
        const source = `(${run.toString()})({"@hpcc-js/wasm-zstd":${wasmModule.toString()},"zstd_stream_worker":${zstdWorkerModule.toString()}},"zstd_stream_worker");`;
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        try {
            return new Worker(url, { name: "sonata-zstd" });
        } finally {
            // Workerは生成時にBlobを取得する。終了はKonataのclose/cancelがterminateへ渡す。
            URL.revokeObjectURL(url);
        }
    };
}

function generate({ check = false } = {}) {
    const dependencies = {};
    function read(file) {
        const bytes = fs.readFileSync(path.join(root, file));
        dependencies[file] = hash(bytes);
        return bytes.toString("utf8");
    }
    function compile(file) {
        const output = ts.transpileModule(read(file), {
            fileName: file,
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                newLine: ts.NewLineKind.LineFeed,
                removeComments: true,
                allowJs: true
            },
            reportDiagnostics: true
        });
        const errors = (output.diagnostics ?? []).filter(
            (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
        );
        assert.equal(
            errors.length,
            0,
            errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n")
        );
        return `function(require,module,exports){\n${output.outputText}}`;
    }
    const sourceModules = [
        "file_line_reader",
        "gem5_o3_pipe_view_parser",
        "model",
        "onikiri_parser",
        "op_store",
        "paged_op_store",
        "stage_structure_detector",
        "trace_parser",
        "zstd_stream"
    ];
    const modules = sourceModules.map((name) => `${JSON.stringify(name)}:${compile(`vendor/konata-core/${name}.ts`)}`);
    const wasm = compile("vendor/wasm-zstd/index.js");
    const worker = compile("vendor/konata-core/zstd_stream_worker.ts");
    modules.push('"@hpcc-js/wasm-zstd":wasmModule', '"zstd_stream_worker":workerAdapter');
    const entry = Object.entries(exportsFrom)
        .map(([name, source]) => `exports.${name}=require("./${source}").${name};`)
        .join("\n");
    modules.push(`"browser-entry":function(require,module,exports){\n${entry}\n}`);
    const code = [
        '"use strict";',
        "// scripts/generate-core.cjsによる生成物。直接編集しない。",
        "// Konata: BSD-3-Clause; wasm-zstd: Apache-2.0; fzstd: MIT; Zstandard: BSD-3-Clause.",
        `const wasmModule=${wasm};`,
        `const zstdWorkerModule=${worker};`,
        run.toString(),
        workerAdapter.toString(),
        `module.exports=run({\n${modules.join(",\n")}\n},"browser-entry");`,
        ""
    ].join("\n");
    read("vendor/konata-core/browser.d.cts");
    read("scripts/generate-core.cjs");
    const manifestPath = path.join(coreDirectory, "UPSTREAM.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const generated = {
        generator: "scripts/generate-core.cjs",
        typescript: ts.version,
        typescriptSha256: hash(fs.readFileSync(require.resolve("typescript"))),
        dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b, "en"))),
        files: { "browser.cjs": hash(code) }
    };
    if (check) {
        assert.equal(
            fs.readFileSync(path.join(coreDirectory, "browser.cjs"), "utf8"),
            code,
            "Regenerate the vendored Konata browser bundle"
        );
        assert.deepEqual(manifest.generated, generated, "Konata generation inputs or output hashes changed");
    } else {
        fs.writeFileSync(path.join(coreDirectory, "browser.cjs"), code);
        manifest.generated = generated;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    return { bytes: Buffer.byteLength(code), modules: sourceModules.length + 3, typescript: ts.version };
}

if (require.main === module)
    console.log("Konata browser bundle:", generate({ check: process.argv.includes("--check") }));
module.exports = { generate };

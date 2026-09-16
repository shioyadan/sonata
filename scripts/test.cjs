"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// 並列実行で計測を競合させず、各検査の独立したプロセスと終了コードを保つ。
const suites = {
    memory: "types",
    "store-evidence": "tsx",
    model: "types",
    playback: "types",
    "sample-model": "types",
    continuity: "types",
    schedulers: "types",
    "piece-grounding": "types",
    scene: "types",
    bundle: "node",
    "browser-test": "node",
    "render-plan": "node",
    build: "node",
    core: "node",
    "trace-index": "types",
    "trace-file": "types",
    "trace-worker": "types",
    "trace-window": "types",
    "raw-samples": "tsx",
    "top-down": "tsx",
    "trace-evidence": "types"
};
const runtimes = { node: [], types: ["--experimental-transform-types"], tsx: ["--import", "tsx"] };

function run(requested) {
    if (requested.length === 1 && requested[0] === "--list") {
        console.log(Object.keys(suites).join("\n"));
        return 0;
    }
    const unknown = requested.filter((name) => !Object.hasOwn(suites, name));
    if (unknown.length) {
        console.error(`Unknown CPU test suite: ${unknown.join(", ")}. Use npm test -- --list.`);
        return 1;
    }
    const selected = requested.length ? [...new Set(requested)] : Object.keys(suites);
    const started = performance.now();
    for (const [index, name] of selected.entries()) {
        console.log(`[test] ${name} started (${index + 1}/${selected.length})`);
        const start = performance.now();
        const result = spawnSync(process.execPath, [...runtimes[suites[name]], `scripts/check-${name}.cjs`], {
            cwd: path.resolve(__dirname, ".."),
            stdio: "inherit"
        });
        const seconds = ((performance.now() - start) / 1000).toFixed(2);
        if (result.error || result.status !== 0) {
            console.error(`[test] ${name} failed after ${seconds}s`);
            if (result.error) console.error(result.error.message);
            if (result.signal) console.error(`Terminated by ${result.signal}`);
            return result.status || 1;
        }
        console.log(`[test] ${name} passed in ${seconds}s`);
    }
    console.log(`[test] ${selected.length} suites passed in ${((performance.now() - started) / 1000).toFixed(2)}s`);
    return 0;
}

process.exitCode = run(process.argv.slice(2));

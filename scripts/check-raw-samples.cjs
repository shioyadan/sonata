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

function checkNamd(entry, bytes, window, model) {
    assert.deepEqual([entry.firstCycle, entry.lastCycle, entry.initialCycle], [19691, 19818, 19691]);
    assert.equal(entry.provenance.simulator, "Onikiri2");
    assert.equal(entry.provenance.workload, "SPEC CPU · NAMD");
    assert.match(entry.provenance.processor, /STRAIGHT/);
    assert.deepEqual(entry.config, { machineOrder: "out-of-order" });
    assert.equal(window.evidence?.registers, null, "Unknown ISA acquired another demo's register layout");

    // Coreとは独立に原文のI/L/S/Rを読み、表示窓のID・時刻・終了と見どころを照合する。
    // C=1が表示cycle 0になる規則を保ち、抜粋時に先頭や行番号を詰めない。
    const lines = bytes.toString("utf8").split("\n");
    assert.deepEqual(lines.slice(0, 2), ["Kanata\t0004", "C=\t1"]);
    const recorded = new Map();
    let cycle = 0;
    for (const [index, line] of lines.entries()) {
        const [command, id, lane, value] = line.split("\t");
        if (command === "C=") cycle = Number(id) - 1;
        else if (command === "C") cycle += Number(id);
        else if (command === "I") recorded.set(Number(id), { fetch: cycle, stages: [] });
        else if (command === "L" && lane === "0") recorded.get(Number(id)).label = value;
        else if (command === "S" && lane === "0")
            recorded.get(Number(id)).stages.push({ name: value, cycle, line: index + 1 });
        else if (command === "R")
            Object.assign(recorded.get(Number(id)), { end: cycle, rid: Number(lane), flush: Number(value) });
    }
    for (const op of window.ops) {
        const raw = recorded.get(op[0]);
        assert.ok(raw && raw.end !== undefined && !op[12], `NAMD instruction #${op[0]} is incomplete`);
        assert.deepEqual(op.slice(0, 6), [op[0], raw.rid, raw.fetch, raw.end, raw.flush, raw.label]);
        for (const stage of op[6]) {
            assert.ok(
                raw.stages.some((event) => event.name === stage[0] && event.cycle === stage[2]),
                `NAMD instruction #${op[0]} changed a stage entry`
            );
        }
    }
    const operations = [...recorded.values()];
    const dispatches = new Map();
    const predictionMisses = [];
    let fpDispatches = 0;
    for (const op of operations) {
        for (const stage of op.stages) {
            if (stage.cycle < entry.firstCycle || stage.cycle > entry.lastCycle) continue;
            if (stage.name === "D") {
                dispatches.set(stage.cycle, (dispatches.get(stage.cycle) ?? 0) + 1);
                if (/\bF[A-Z]+\./.test(op.label)) fpDispatches++;
            } else if (stage.name === "Xbm") predictionMisses.push(stage);
        }
    }
    let gap = 0;
    let longestGap = 0;
    for (let cycle = entry.firstCycle; cycle <= entry.lastCycle; cycle++) {
        gap = dispatches.has(cycle) ? 0 : gap + 1;
        longestGap = Math.max(longestGap, gap);
    }
    // 件数だけでは長い空白を見落とすため、Dが始まるサイクル数と最長の途切れも固定する。
    assert.deepEqual(
        [dispatches.size, [...dispatches.values()].reduce((sum, count) => sum + count, 0), longestGap, fpDispatches],
        [108, 1496, 5, 423]
    );
    assert.equal(predictionMisses.length, 1, "The continuous NAMD sample gained another prediction miss");
    assert.deepEqual(
        recorded.get(62019).stages.find((s) => s.name === "Xbm"),
        {
            name: "Xbm",
            cycle: 19782,
            line: 1760981
        }
    );
    assert.equal(window.ops.filter((op) => op[4] && op[3] === 19782).length, 524);
    assert.equal(operations.filter((op) => op.fetch === 19783).length, 16);
    assert.equal(dispatches.get(19788), 12);
    const multiply = model.ops.find((op) => op.id === 61265);
    assert.deepEqual(
        [multiply.kind, multiply.execution, multiply.fetch, multiply.completion, multiply.end, multiply.flush],
        ["fp", "exec-fp", 19691, 19718, 19731, false]
    );
    assert.ok(multiply.stages.some((stage) => stage.node === "commit" && stage.start === 19729));
    for (const node of ["exec-fp", "front-2"])
        assert.ok(
            model.ops.some((op) =>
                op.stages.some(
                    (stage) =>
                        stage.node === node && stage.start <= entry.screenshotCycle && stage.end > entry.screenshotCycle
                )
            ),
            `NAMD screenshot lost active ${node}`
        );
    console.log(`Raw sample: ${entry.key} · ${window.ops.length} instructions / dispatch, FP and recovery verified`);
    return window.ops.length;
}

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
                const model = replay.createReplay({ samples: [] }).loadData(window);
                const ops = new Map(window.ops.map((op) => [op[0], op]));
                if (entry.key === "namd-flow") {
                    compared += checkNamd(entry, bytes, window, model);
                    continue;
                }
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

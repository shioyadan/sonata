"use strict";
// 旧デモを比較fixtureにし、実raw入力から記録値と注釈時刻を再現する。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../vendor/konata-core/browser.cjs");
const { createEvidenceIndex } = require("../src/trace-evidence.cts");
const replay = require("../src/replay-model.cts");

function op(id, gid, tick, cycle, tid = 0) {
    return {
        id,
        gid,
        tid,
        fetchedCycle: cycle,
        retiredCycle: cycle + 2,
        lanes: [],
        prods: [],
        labelName: "add x0, x1, #1",
        labelDetail: `Fetched Tick: ${tick}`
    };
}
function feed(index, lines) {
    for (const line of lines) index.observeLine(line);
}
function synthetic() {
    const none = createEvidenceIndex();
    const operations = [op(0, 0, 1000, 0), op(1, 1, 1100, 1)];
    operations.forEach((o) => none.observeOp(o, "gem5"));
    assert.equal(none.windowEvidence(0, 10, operations).registers, null);
    assert.equal(none.windowEvidence(0, 10, operations).scheduling, null);
    const configured = createEvidenceIndex({ isa: "aarch64", wordBits: 64 }).windowEvidence(0, 10).registers;
    assert.equal(configured.kind, "configuration");
    assert.equal(configured.rows.length, 32);
    assert.equal(configured.capacity, undefined);
    assert.deepEqual(configured.initial, { mapping: [], values: [], owners: [] });
    assert.throws(() => createEvidenceIndex({ integerRegisters: Infinity }), /capacity/);

    const unknown = createEvidenceIndex();
    feed(unknown, [
        "10010: cpu.rename: Processing instruction [sn:7]",
        "10010: cpu.rename: Renamed reg 0 to physical reg 300 (300) old mapping was 22",
        "10010: cpu.rename: Renaming arch reg 4 (integer) to physical reg 300",
        "10020: cpu: RegFile: Setting int register 300 to 0xabc",
        "10025: cpu: Execute: Processing PC 0x1000 [sn:7]",
        "10025: cpu: RegFile: Access to int register 300, has data 0xabc",
        "10030: cpu.rename: Removing history entry with sequence number 7 (archReg: 4, newPhysReg: 300, prevPhysReg: 22)",
        "10035: cpu.rename: Freeing phys regs of misspeculated instructions"
    ]);
    unknown.observeOp(op(2, 7, 10000, 10), "gem5");
    assert.equal(
        unknown.windowEvidence(10, 11).registers,
        null,
        "A single tick/cycle point does not establish a clock"
    );
    unknown.observeOp(op(3, 8, 10100, 11), "gem5");
    const regs = unknown.windowEvidence(10, 11).registers;
    assert.deepEqual(regs.rows, [4]);
    assert.deepEqual(regs.logicalNames, { 4: "i4" });
    assert.equal(regs.capacity, undefined);
    assert.equal(regs.wordBits, undefined);
    assert.deepEqual(regs.initial.owners, []);
    assert.equal(regs.events.find((e) => e.type === "write").cycle, 10.2);
    assert.equal(regs.reads[0].id, 2);
    assert.equal(regs.events.find((e) => e.type === "restore").cycle, 10.3);
    assert.equal(regs.allocation.events.at(-1).cycle, 10.35);
    assert.equal(regs.allocation.events.at(-1).physical, 300, "Register numbers above 255 were discarded");
    const before = JSON.stringify(regs);
    unknown.observeOp(op(4, 9, 10200, 12, 1), "gem5");
    assert.equal(unknown.windowEvidence(10, 11).registers, null, "SMT register maps were mixed");
    assert.equal(JSON.stringify(regs), before, "A later observation mutated a published window");
    unknown.clear();
    assert.equal(unknown.stats().lineCount, 0);
    assert.equal(unknown.stats().pages, 0);
    assert.equal(unknown.windowEvidence(0, 10).registers, null);

    const rsd = createEvidenceIndex();
    feed(rsd, [
        "Kanata\t0004",
        "I\t0\t0\t0",
        "L\t0\t0\t0000: add a1, a2, a3",
        "C\t1",
        "L\t0\t1\tmap: r1(p10), = r2(p2), prev: r1(p1), IQ alloc: 1",
        "C\t1",
        "L\t0\t1\td:0x1234 = fu(a:0x1, b:0x2)",
        "C\t2",
        "S\t0\t0\tRw"
    ]);
    for (let id = 1; id <= 2000; id++)
        feed(rsd, [
            "C\t1",
            `I\t${id}\t${id}\t0`,
            `L\t${id}\t0\t0000: add a2, a3, a4`,
            `L\t${id}\t1\tmap: r2(p20), = r3(p3), prev: r2(p2), IQ alloc: 0`,
            `R\t${id}\t${id}\t0`
        ]);
    const pending = rsd.windowEvidence(4, 5).registers;
    assert.equal(
        pending.events.some((e) => e.type === "write"),
        false,
        "Unconfirmed final writeback was invented"
    );
    feed(rsd, ["C\t1", "R\t0\t2001\t0"]);
    const resolved = rsd.windowEvidence(4, 5).registers;
    assert.equal(resolved.events.find((e) => e.type === "write").hex, "0x1234");
    assert.equal(resolved.events.find((e) => e.type === "write").observedCycle, 2);
    assert.equal(
        new Map(rsd.windowEvidence(2000, 2001).registers.initial.values).get(10),
        "0x1234",
        "A late RSD writeback did not update later checkpoints"
    );
    assert.equal(
        rsd.windowEvidence(0, 3).registers.events.some((e) => e.type === "write"),
        false,
        "A result annotation was exposed before its writeback"
    );
    assert.ok(rsd.stats().pages > 1);
    assert.ok(rsd.stats().decodedPages <= 2);
    assert.ok(rsd.stats().bufferedEvents < 2100);
    assert.equal(rsd.stats().activeRecords, 0);
    for (let id = 0; id < 70000; id++) rsd.observeLine(`L\t${id}\t0\tlate label`);
    assert.equal(rsd.stats().activeRecords, 0, "Post-retire labels accumulated indefinitely");
}

async function samples() {
    const context = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../data/traces.js"), "utf8"), context);
    const legacy = JSON.parse(JSON.stringify(context.embeddedFlowTraces));
    const directory = process.env.SONATA_SAMPLE_ROOT ?? path.join(__dirname, "../data/samples");
    const fixtures = [
        ["rename-rush", "gem5-arm-registers.log.gz", "aarch64"],
        ["x86-recovery", "gem5-x86-registers.log.gz", "x86"],
        ["memory-tide", "rsd-memory.log.gz", "riscv"]
    ];
    const reports = [];
    for (const [key, name, isa] of fixtures) {
        const expected = legacy.find((trace) => trace.key === key);
        const index = createEvidenceIndex({ isa, ...(isa === "riscv" ? {} : { integerRegisters: 256, wordBits: 64 }) });
        const file = new File([fs.readFileSync(path.join(directory, name))], name);
        // FileLineReader自身にgzipを展開させ、ブラウザと同じ行文字列を共有抽出器へ渡す。
        await new core.FileLineReader(file).readLines(index.observeLine);
        const parsed = await core.parseTraceFile(file, {
            onTrace(trace) {
                const write = trace.opStore.setOp.bind(trace.opStore);
                trace.opStore.setOp = (id, op) => {
                    write(id, op);
                    index.observeOp(op, isa === "riscv" ? "onikiri" : "gem5");
                };
            }
        });
        const source = parsed.trace;
        try {
            const ops = expected.ops.map(([id]) => source.getOpForScan(id));
            assert.ok(ops.every(Boolean), `${key}: an original demo instruction is missing`);
            const actual = index.windowEvidence(expected.firstCycle, expected.lastCycle, ops, (id) =>
                source.getOpForScan(id)
            );
            for (const part of ["events", "initial", "allocation", "rows"])
                assert.deepEqual(actual.registers[part], expected.evidence.registers[part], `${key}: ${part}`);
            assert.deepEqual(actual.registers.reads ?? [], expected.evidence.registers.reads ?? [], `${key}: reads`);
            assert.deepEqual(actual.scheduling, expected.evidence.scheduling, `${key}: scheduling`);
            const notices = expected.demo.events.map(({ endCycle, instruction, ...event }) => event);
            assert.deepEqual(actual.events, notices, `${key}: recorded miss annotations`);
            const model = replay.createRegisterReplay(expected.evidence.registers);
            for (const first of [expected.firstCycle + 32, expected.lastCycle + 0.5, expected.firstCycle]) {
                const data = index.windowEvidence(first, Math.min(first + 12, expected.lastCycle + 1)).registers;
                if (first <= expected.lastCycle) {
                    const at = replay.createRegisterReplay(data).stateAt(first);
                    const reference = model.stateAt(first);
                    assert.deepEqual(
                        at.rows.map(({ logical, physical, value, writer }) => ({ logical, physical, value, writer })),
                        reference.rows.map(({ logical, physical, value, writer }) => ({
                            logical,
                            physical,
                            value,
                            writer
                        })),
                        `${key}: checkpoint changed register state after seeking`
                    );
                }
            }
            assert.ok(index.stats().decodedPages <= 2);
            assert.ok(index.stats().activeRecords < 100, `${key}: retired records accumulated`);
            reports.push({
                key,
                events: actual.registers.events.length,
                reads: actual.registers.reads.length,
                pages: index.stats().pages,
                decodedPages: index.stats().decodedPages
            });
        } finally {
            source.close();
        }
    }
    return reports;
}
async function main() {
    synthetic();
    console.log(JSON.stringify({ traceEvidence: "ok", samples: await samples() }));
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

import type { Op } from "../vendor/konata-core/model";
import evidence = require("../src/trace-evidence.cts");
import { evidenceLines } from "./evidence-input";

type Timing = {
    allocation: (op: Readonly<Op>) => number | null;
    ready: (op: Readonly<Op>) => number | null;
    end: (op: Readonly<Op>) => number;
};
type Dependency = { id: number; ready: number | null; register?: string };
type EvidenceOp = { id: number; dependencies: Dependency[]; slot?: number };

// 呼出し元がARM64と明示したデモのスカラ命令に限定する。
// レジスタ RAW 依存だけを推定し、メモリの alias や物理レジスタ名は推測しない。
function armOperands(label: string) {
    const text = label
        .replace(/^(?:0x)?[0-9a-f]+:\s*/i, "")
        .trim()
        .toLowerCase();
    const mnemonic = text.split(/\s+/)[0],
        args = text.slice(mnemonic.length);
    const registers = (s: string) =>
        [...s.matchAll(/\b(?:[wx](?:[12]?\d|30)|sp|[wx]zr)\b/g)]
            .map((m) => m[0].replace(/^w/, "x"))
            .filter((r) => r !== "xzr");
    const regs = registers(args),
        dest: string[] = [],
        source: string[] = [];
    if (/^b\./.test(mnemonic)) source.push("nzcv");
    else if (mnemonic === "b" || mnemonic === "nop") {
    } else if (mnemonic === "bl") {
        dest.push("x30");
    } else if (mnemonic === "ret") {
        source.push(...(regs.length ? regs : ["x30"]));
    } else if (/^(?:str|stp|cmp|cmn|tst|cbz|cbnz|tbz|tbnz|br|blr)$/.test(mnemonic)) {
        source.push(...regs);
        if (/^(?:cmp|cmn|tst)$/.test(mnemonic)) dest.push("nzcv");
        if (mnemonic === "blr") dest.push("x30");
    } else if (
        /^(?:add|addxi_uop|adds|sub|subs|madd|and|ands|orr|movz|movk|sbfm|csinc|ldr|ldrsh|ldrb|ldrh)$/.test(mnemonic)
    ) {
        const first = registers(args.split(",")[0])[0];
        if (first) dest.push(first);
        source.push(...registers(args.slice(args.indexOf(",") + 1)));
        if (mnemonic === "movk" && first) source.push(first);
        if (mnemonic === "csinc") source.push("nzcv");
        if (/^(?:adds|subs|ands)$/.test(mnemonic)) dest.push("nzcv");
    } else return null;
    return { source: [...new Set(source)], dest: [...new Set(dest)] };
}

export function buildSchedulingEvidence(
    allOps: Readonly<Op>[],
    sampleOps: Readonly<Op>[],
    timing: Timing,
    allowArmInference = false
) {
    const byID = new Map(allOps.map((o) => [o.id, o])),
        wanted = new Set(sampleOps.map((o) => o.id));
    const native = sampleOps.some((op) => op.prods.length > 0);
    if (native)
        return {
            kind: "recorded",
            label: "Recorded dependency edges",
            ops: sampleOps.map((op) => ({
                id: op.id,
                dependencies: op.prods.map((d) => ({
                    id: d.opID,
                    ready: byID.has(d.opID) ? timing.ready(byID.get(d.opID)!) : null
                }))
            }))
        };
    if (!allowArmInference) return null;
    const writers = new Map<string, number>(),
        previous = new Map<number, Array<[string, number | undefined]>>(),
        result: EvidenceOp[] = [];
    const events = allOps
        .flatMap((op) => {
            const at = timing.allocation(op);
            return at === null
                ? []
                : [{ time: at, op, flush: false }, ...(op.flush ? [{ time: timing.end(op), op, flush: true }] : [])];
        })
        .sort(
            (a, b) =>
                a.time - b.time ||
                Number(b.flush) - Number(a.flush) ||
                (a.flush ? b.op.id - a.op.id : a.op.id - b.op.id)
        );
    for (const event of events) {
        const { op } = event;
        if (event.flush) {
            for (const [reg, id] of previous.get(op.id) ?? [])
                if (writers.get(reg) === op.id) {
                    if (id === undefined) writers.delete(reg);
                    else writers.set(reg, id);
                }
            continue;
        }
        const operands = armOperands(op.labelName);
        if (!operands) continue;
        const dependencies = operands.source.flatMap((register) => {
            const id = writers.get(register);
            return id === undefined ? [] : [{ id, register, ready: timing.ready(byID.get(id)!) }];
        });
        if (wanted.has(op.id)) result.push({ id: op.id, dependencies });
        previous.set(
            op.id,
            operands.dest.map((reg) => [reg, writers.get(reg)])
        );
        operands.dest.forEach((reg) => writers.set(reg, op.id));
    }
    return { kind: "inferred", label: "Register RAW · disassembly estimate", ops: result };
}

export function readRsdRegisterEvidence(
    fileName: string,
    firstCycle: number,
    lastCycle: number,
    wanted: Set<number>,
    allOps: Readonly<Op>[] = []
) {
    const index = evidence.createEvidenceIndex();
    for (const line of evidenceLines(fileName)) index.observeLine(line);
    const byID = new Map(allOps.map((op) => [op.id, op]));
    const { registers, scheduling } = index.windowEvidence(
        firstCycle,
        lastCycle,
        allOps.filter((op) => wanted.has(op.id)),
        (id) => byID.get(id)
    );
    return { registers, scheduling };
}

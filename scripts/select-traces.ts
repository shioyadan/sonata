/** 実トレースの先頭を上限付きで読み、イベントの多い短い区間を順位付けする。
 * node --import tsx scripts/select-traces.ts
 */
import fs from "node:fs";
import path from "node:path";
import { parseTrace, getOps, getGem5FlushCycles, instructionKind, type TraceSource } from "./import-trace";

const base = process.env.SONATA_TRACE_ROOT ?? path.resolve(__dirname, "../inputs");
const prefixBytes = 24 * 1024 * 1024;
export const candidates: TraceSource[] = [
    {
        key: "rsd-coremark",
        label: "RSD CoreMark",
        displayName: "rsd/kanata-coremark-correct.log",
        fileName: `${base}/rsd/kanata-coremark-correct.log`,
        parser: "onikiri",
        machineOrder: "out-of-order",
        prefixBytes
    },
    {
        key: "rsd-mshr",
        label: "RSD memory",
        displayName: "rsd/mshr.log",
        fileName: `${base}/rsd/mshr.log`,
        parser: "onikiri",
        machineOrder: "out-of-order"
    },
    {
        key: "axpy",
        label: "AXPY",
        displayName: "kimura/kon_axpy_m2_dino.kanata",
        fileName: `${base}/kimura/kon_axpy_m2_dino.kanata`,
        parser: "onikiri",
        machineOrder: "out-of-order",
        prefixBytes
    },
    {
        key: "gem5-arm-coremark",
        label: "gem5 ARM64 CoreMark",
        displayName: "gem5-traces/full-2iter/arm64/trace.log",
        fileName: `${base}/gem5-traces/full-2iter/arm64/trace.log`,
        parser: "gem5",
        machineOrder: "out-of-order",
        prefixBytes
    },
    {
        key: "gem5-x86-coremark",
        label: "gem5 x86 CoreMark",
        displayName: "gem5-traces/full-2iter/x86/trace.log",
        fileName: `${base}/gem5-traces/full-2iter/x86/trace.log`,
        parser: "gem5",
        machineOrder: "out-of-order",
        prefixBytes
    },
    {
        key: "gem5-arm-detailed",
        label: "gem5 ARM64 · register trace",
        displayName: "gem5-traces/detailed/arm64/trace.log",
        fileName: `${base}/gem5-traces/detailed/arm64/trace.log`,
        parser: "gem5",
        machineOrder: "out-of-order",
        prefixBytes
    },
    {
        key: "gem5-x86-detailed",
        label: "gem5 x86 · register trace",
        displayName: "gem5-traces/detailed/x86/trace.log",
        fileName: `${base}/gem5-traces/detailed/x86/trace.log`,
        parser: "gem5",
        machineOrder: "out-of-order",
        prefixBytes
    },
    {
        key: "nada-tuned",
        label: "NaDa tuned",
        displayName: "nada/inorder-tuned.out.zst",
        fileName: `${base}/nada/inorder-tuned.out.zst`,
        parser: "onikiri",
        machineOrder: "in-order",
        prefixBytes,
        zstdPrefix: true
    }
];

async function main() {
    const report = [];
    const log = console.log,
        warn = console.warn;
    for (const source of candidates) {
        console.log = () => undefined;
        console.warn = () => undefined;
        let trace;
        try {
            trace = await parseTrace(source);
            const ops = getOps(trace),
                flushes = getGem5FlushCycles(source, ops);
            const n = trace.lastCycle + 2;
            const fetch = new Int32Array(n),
                retire = new Int32Array(n),
                flush = new Int32Array(n),
                moves = new Int32Array(n),
                activeDelta = new Int32Array(n),
                memoryDelta = new Int32Array(n);
            const end = (op) => (op.flush ? (flushes.get(op.id) ?? op.retiredCycle) : op.retiredCycle);
            for (const op of ops) {
                fetch[op.fetchedCycle]++;
                (op.flush ? flush : retire)[end(op)]++;
                activeDelta[op.fetchedCycle]++;
                activeDelta[end(op)]--;
                const kind = instructionKind(op.labelName);
                for (const lane of op.lanes) for (const stage of lane?.stages ?? []) moves[stage.startCycle]++;
                if (kind === "memory") {
                    memoryDelta[op.fetchedCycle]++;
                    memoryDelta[end(op)]--;
                }
            }
            const active = new Int32Array(n),
                memory = new Int32Array(n);
            for (let i = 0; i < n; i++) {
                active[i] = (active[i - 1] ?? 0) + activeDelta[i];
                memory[i] = (memory[i - 1] ?? 0) + memoryDelta[i];
            }
            const span = 128;
            const ranked = [];
            for (let first = 20; first + span + 40 < n; first += 8) {
                let retired = 0,
                    squashed = 0,
                    transitions = 0,
                    longestIdle = 0,
                    idle = 0,
                    peak = 0,
                    peakMemory = 0,
                    events = 0;
                for (let t = first; t < first + span; t++) {
                    retired += retire[t];
                    squashed += flush[t];
                    transitions += moves[t];
                    peak = Math.max(peak, active[t]);
                    peakMemory = Math.max(peakMemory, memory[t]);
                    idle = moves[t] === 0 && fetch[t] === 0 && retire[t] === 0 && flush[t] === 0 ? idle + 1 : 0;
                    longestIdle = Math.max(longestIdle, idle);
                    if (flush[t]) events++;
                }
                if (retired < 45 || peak > 240) continue;
                const score =
                    retired * 1.5 +
                    Math.min(squashed, 100) * 3 +
                    Math.min(events, 6) * 18 +
                    transitions * 0.12 -
                    longestIdle * 8;
                ranked.push({
                    first,
                    last: first + span - 1,
                    retired,
                    squashed,
                    events,
                    peak,
                    peakMemory,
                    longestIdle,
                    transitions,
                    score
                });
            }
            const choose = (sort) => {
                const selected = [];
                for (const window of [...ranked].sort(sort)) {
                    if (selected.every((s) => Math.abs(s.first - window.first) >= span)) selected.push(window);
                    if (selected.length === 4) break;
                }
                return selected;
            };
            const result = {
                key: source.key,
                sourceOps: ops.length,
                lastCycle: trace.lastCycle,
                action: choose((a, b) => b.score - a.score),
                throughput: choose((a, b) => b.retired - a.retired),
                memory: choose((a, b) => b.peakMemory - a.peakMemory || b.score - a.score)
            };
            report.push(result);
            log(JSON.stringify(result));
        } catch (error) {
            log(JSON.stringify({ key: source.key, error: String(error) }));
        } finally {
            trace?.close();
            console.log = log;
            console.warn = warn;
        }
    }
    const output = path.resolve(__dirname, "../artifacts");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "trace-selection.json"), JSON.stringify(report, null, 2) + "\n");
}
if (process.argv[1]?.endsWith("select-traces.ts")) void main();

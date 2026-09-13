"use strict";
// 圧縮済みの全トレースはWorkerに保持し、画面へ渡す命令を表示区間に限定する。
import type { Op, ParsedTrace } from "../vendor/konata-core/model";
import type { MutableOpStore } from "../vendor/konata-core/op_store";
import core = require("../vendor/konata-core/browser.cjs");
import windows = require("./trace-window.cts");
import type replay = require("./replay-model.cts");

interface Source {
    name: string;
    parser: "onikiri" | "gem5";
    opCount: number;
    firstCycle: number;
    lastCycle: number;
    threads: number[];
    laneNames: string[];
    warnings: number;
    storedBytes: number;
    indexBlocks: number;
}
interface Block {
    firstID: number;
    lastID: number;
    firstCycle: number;
    lastCycle: number;
    ids: Uint32Array;
}
interface Progress {
    phase: "reading" | "indexing";
    value: number;
}
type Request =
    | { type: "open"; file: File }
    | { type: "window"; request: number; cycle: number; span: number; thread: number }
    | { type: "close" };
type Response =
    | { type: "progress"; progress: Progress }
    | { type: "loaded"; source: Source }
    | { type: "window"; request: number; trace: replay.Trace }
    | { type: "error"; request?: number; message: string }
    | { type: "closed" };

const blockSize = 1024;
const maxWindowOps = 16384;
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function checkAbort(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("Trace loading canceled", "AbortError");
}

// Parserの最初のonTraceは命令の格納前に届く。公開storeの書込みを観測し、
// 疎なIDでも0..lastIDを走査せず、実在するIDだけをビット集合へ記録する。
function createTraceIndex() {
    const blocks = new Map<number, Block>();
    const threads = new Set<number>();
    let firstCycle = Infinity;
    let observedLastCycle = 0;
    function observe(op: Readonly<Op>) {
        if (!Number.isSafeInteger(op.id) || op.id < 0 || !Number.isFinite(op.fetchedCycle))
            throw new Error("The trace contains an unsupported instruction ID or cycle.");
        const firstID = Math.floor(op.id / blockSize) * blockSize;
        let block = blocks.get(firstID);
        if (!block) {
            block = {
                firstID,
                lastID: op.id,
                firstCycle: Infinity,
                lastCycle: -Infinity,
                ids: new Uint32Array(blockSize / 32)
            };
            blocks.set(firstID, block);
        }
        const offset = op.id - firstID;
        block.ids[offset >>> 5] |= 1 << (offset & 31);
        block.lastID = Math.max(block.lastID, op.id);
        block.firstCycle = Math.min(block.firstCycle, op.fetchedCycle);
        block.lastCycle = Math.max(block.lastCycle, windows.isUnfinished(op) ? Infinity : op.retiredCycle);
        firstCycle = Math.min(firstCycle, op.fetchedCycle);
        observedLastCycle = Math.max(observedLastCycle, op.fetchedCycle);
        for (const lane of op.lanes) {
            for (const stage of lane?.stages ?? [])
                observedLastCycle = Math.max(observedLastCycle, stage.startCycle, stage.endCycle);
        }
        threads.add(op.tid);
    }
    function attach(trace: ParsedTrace) {
        if (trace.opCount !== 0) throw new Error("The parser published its store after instructions were written.");
        const store = trace.opStore as MutableOpStore;
        const write = store.setOp.bind(store);
        store.setOp = (id, op) => {
            write(id, op);
            observe(op);
        };
    }
    function finish(lastCycle: number) {
        lastCycle = Math.max(lastCycle, observedLastCycle);
        if (!blocks.size) throw new Error("No instructions were found in this trace.");
        if (!Number.isFinite(lastCycle)) throw new Error("The trace end cycle is invalid.");
        const entries = [...blocks.values()].sort((a, b) => a.firstID - b.firstID);
        for (const block of entries) if (block.lastCycle === Infinity) block.lastCycle = lastCycle;
        return {
            blocks: entries,
            threads: [...threads].sort((a, b) => a - b),
            firstCycle: Math.floor(firstCycle),
            lastCycle
        };
    }
    function clear() {
        blocks.clear();
        threads.clear();
    }
    return { attach, observe, finish, clear };
}

// fetch順だけの検索では、左境界より前に始まった長いメモリアクセスを落としてしまう。
// ブロックの生存区間で絞り、該当ページだけを展開して実際の交差を確認する。
async function selectOps(
    trace: ParsedTrace,
    blocks: readonly Block[],
    firstCycle: number,
    lastCycle: number,
    thread: number,
    signal: AbortSignal
) {
    const ops: Readonly<Op>[] = [];
    let scanned = 0;
    for (const block of blocks) {
        checkAbort(signal);
        if (block.firstCycle > lastCycle || block.lastCycle < firstCycle) continue;
        for (let id = block.firstID; id <= block.lastID; id++) {
            const offset = id - block.firstID;
            if (!(block.ids[offset >>> 5] & (1 << (offset & 31)))) continue;
            const op = trace.getOpForScan(id);
            if (
                op &&
                op.tid === thread &&
                op.fetchedCycle <= lastCycle &&
                (windows.isUnfinished(op) ? Infinity : op.retiredCycle) >= firstCycle
            ) {
                ops.push(op);
                if (ops.length > maxWindowOps)
                    throw new Error("Too many instructions in this window. Select a shorter cycle range.");
            }
        }
        if (++scanned % 8 === 0) await yieldTask();
    }
    return ops;
}

function createFileSession(send: (response: Response) => void) {
    const abort = new AbortController();
    const indexer = createTraceIndex();
    let trace: ParsedTrace | null = null;
    let source: Source | null = null;
    let blocks: Block[] = [];
    async function open(file: File) {
        const result = await core.parseTraceFile(
            file,
            {
                onProgress: (value) => send({ type: "progress", progress: { phase: "reading", value } }),
                onTrace: (partial) => {
                    if (!trace) indexer.attach(partial);
                    trace = partial;
                }
            },
            abort.signal
        );
        checkAbort(abort.signal);
        if (!result) return;
        trace = result.trace;
        send({ type: "progress", progress: { phase: "indexing", value: 0 } });
        const index = indexer.finish(trace.lastCycle);
        blocks = index.blocks;
        source = {
            name: file.name,
            parser: result.parserName === "OnikiriParser" ? "onikiri" : "gem5",
            opCount: trace.opCount,
            firstCycle: index.firstCycle,
            lastCycle: Math.max(index.firstCycle, Math.ceil(index.lastCycle)),
            threads: index.threads,
            laneNames: [...trace.laneNames],
            warnings: trace.warningCount,
            storedBytes: (trace.opStore as core.PageStore).storedSize,
            indexBlocks: blocks.length
        };
        send({ type: "loaded", source });
    }
    async function window(request: Extract<Request, { type: "window" }>) {
        if (!trace || !source) throw new Error("No trace file is open.");
        if (
            !Number.isFinite(request.cycle) ||
            ![16, 32, 128, 512].includes(request.span) ||
            !source.threads.includes(request.thread)
        )
            throw new Error("Invalid trace window.");
        const firstCycle = Math.max(source.firstCycle, Math.min(source.lastCycle - 1, Math.floor(request.cycle)));
        const lastCycle = Math.min(source.lastCycle, firstCycle + request.span - 1);
        const ops = await selectOps(trace, blocks, firstCycle, lastCycle, request.thread, abort.signal);
        checkAbort(abort.signal);
        const converted = windows.toTraceWindow({ ops, firstCycle, lastCycle, source, laneNames: source.laneNames });
        checkAbort(abort.signal);
        send({ type: "window", request: request.request, trace: converted });
    }
    function close() {
        abort.abort();
        trace?.close();
        trace = null;
        blocks = [];
        indexer.clear();
        source = null;
    }
    return { open, window, close };
}
namespace traceFile {
    export type Metadata = Source;
    export type WorkerRequest = Request;
    export type WorkerResponse = Response;
}
const traceFile = { createFileSession, createTraceIndex, selectOps, maxWindowOps };
export = traceFile;

"use strict";
// 圧縮済みの全トレースはWorkerに保持し、画面へ渡す命令を表示区間に限定する。
import type { Op, ParsedTrace } from "../vendor/konata-core/model";
import type { MutableOpStore } from "../vendor/konata-core/op_store";
import core = require("../vendor/konata-core/browser.cjs");
import windows = require("./trace-window.cts");
import structures = require("./trace-structure.cts");
import replay = require("./replay-model.cts");
import memory = require("./memory.cts");

interface OverviewBin {
    fetched: number;
    committed: number;
    flushed: number;
}
interface Overview {
    scope: "all-threads";
    firstCycle: number;
    binWidth: number;
    bins: OverviewBin[];
}
interface SearchHit {
    id: number;
    cycle: number;
    endCycle: number | null;
    label: string;
    tid: number;
    flush: boolean;
}
interface SearchRequest {
    type: "search";
    request: number;
    kind: "text" | "id" | "flush" | "long";
    query: string;
    thread: number;
    after?: number;
}
interface Source {
    name: string;
    parser: "onikiri" | "gem5";
    opCount: number;
    firstCycle: number;
    lastCycle: number;
    threads: number[];
    laneNames: string[];
    warnings: number;
    storedBytes: number | null;
    indexBlocks: number;
    complete: boolean;
    overview: Overview;
}
interface Block {
    firstID: number;
    lastID: number;
    firstCycle: number;
    lastCycle: number;
    maxFetchCycle: number;
    ids: Uint32Array;
    ended: Uint32Array;
    flushGroups?: readonly FlushGroup[];
    stores?: { firstCycle: number; lastTick: number; ids: Uint32Array };
}
interface FlushGroup {
    firstID: number;
    lastID: number;
    tid: number;
    end: number;
}
interface Progress {
    phase: "reading" | "indexing";
    value: number;
}
type Request =
    | { type: "open"; file: File }
    | { type: "window"; request: number; cycle: number; span: number; thread: number }
    | SearchRequest
    | { type: "cancel-search" }
    | { type: "cancel-window" }
    | { type: "close" };
type Response =
    | { type: "progress"; progress: Progress }
    | { type: "loaded"; source: Source }
    | { type: "window"; request: number; trace: replay.Trace }
    | { type: "search"; request: number; hits: SearchHit[]; more: boolean }
    | { type: "error"; request?: number; operation?: "window" | "search"; message: string }
    | { type: "closed" };

const blockSize = 1024;
const maxWindowOps = 16384;
const maxOverviewBins = 512;
const maxSearchHits = 40;
// 頻繁なscanの譲り渡しに、入れ子setTimeoutの最小待ち時間を積み重ねない。
const yieldTask = () =>
    new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(undefined);
    });
function checkAbort(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("Trace loading canceled", "AbortError");
}

// ページ復元の速さに依存せず、操作要求とParserへ短い間隔で制御を返す。
// 通常の命令ごとにはPromiseを作らず、実際にyieldする時だけ待つ。
function createScanYield(signal: AbortSignal) {
    let started = performance.now();
    return () => {
        if (performance.now() - started < 8) return;
        return yieldTask().then(() => {
            checkAbort(signal);
            started = performance.now();
        });
    };
}

// 描画用の延長やflush群の推定を活動集計・検索の時刻へ持ち込まない。
// gem5のretire:0はsquashの正確な時刻を持たず、最後のstage開始だけが観測される。
function recordedEnd(op: Readonly<Op>, parser: Source["parser"]): number | null {
    if (windows.isUnfinished(op)) return null;
    let end = op.retiredCycle;
    if (parser === "gem5") {
        if (op.flush) {
            end = op.fetchedCycle;
            for (const lane of op.lanes) for (const stage of lane?.stages ?? []) end = Math.max(end, stage.startCycle);
        } else {
            for (const lane of op.lanes) {
                const retire = lane?.stages.find((stage) => stage.name === "Rt");
                if (retire) {
                    end = retire.startCycle;
                    break;
                }
            }
        }
    }
    return Number.isFinite(end) && end >= op.fetchedCycle ? end : null;
}

// 全threadの観測イベントだけを有界な時間binへ集約する。範囲が倍になるたびに
// 隣のbinを併合し、全命令の時刻配列や疎なサイクルごとのMapは追加しない。
function createOverview() {
    let firstCycle = 0,
        binWidth = 1,
        bins: OverviewBin[] = [];
    const empty = (): OverviewBin => ({ fetched: 0, committed: 0, flushed: 0 });
    function cover(cycle: number) {
        if (!bins.length) {
            firstCycle = Math.floor(cycle);
            bins.push(empty());
            return;
        }
        const start = Math.min(cycle, firstCycle),
            end = Math.max(cycle, firstCycle + (bins.length - 1) * binWidth);
        let width = binWidth;
        while (Math.floor(end / width) - Math.floor(start / width) + 1 > maxOverviewBins) width *= 2;
        const first = Math.floor(start / width) * width;
        const length = Math.floor(end / width) - Math.floor(start / width) + 1;
        if (width !== binWidth || first !== firstCycle) {
            const merged = Array.from({ length }, empty);
            bins.forEach((bin, index) => {
                const target = merged[Math.floor((firstCycle + index * binWidth - first) / width)];
                target.fetched += bin.fetched;
                target.committed += bin.committed;
                target.flushed += bin.flushed;
            });
            bins = merged;
            firstCycle = first;
            binWidth = width;
        } else {
            while (bins.length < length) bins.push(empty());
        }
    }
    function add(cycle: number, kind: keyof OverviewBin) {
        cover(cycle);
        bins[Math.floor((cycle - firstCycle) / binWidth)][kind]++;
    }
    function snapshot(lastCycle: number): Overview {
        cover(lastCycle);
        return { scope: "all-threads", firstCycle, binWidth, bins: bins.map((bin) => ({ ...bin })) };
    }
    function clear() {
        firstCycle = 0;
        binWidth = 1;
        bins = [];
    }
    return { add, snapshot, clear };
}

// Parserの最初のonTraceは命令の格納前に届く。公開storeの書込みを観測し、
// 疎なIDでも0..lastIDを走査せず、実在するIDだけをビット集合へ記録する。
function createTraceIndex(
    onWrite: () => void = () => undefined,
    onOperation: (op: Readonly<Op>, parser: Source["parser"], firstWrite: boolean) => void = () => undefined
) {
    const blocks = new Map<number, Block>();
    const overview = createOverview();
    const storeClock = windows.createStoreClock();
    let lastStoreTick = 0;
    const threads = new Set<number>();
    const flushGroups: FlushGroup[] = [];
    let firstCycle = Infinity;
    let observedLastCycle = 0;
    function firstGroupAt(id: number) {
        let low = 0,
            high = flushGroups.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (flushGroups[middle].lastID < id) low = middle + 1;
            else high = middle;
        }
        return low;
    }
    // 同threadの連続flush ID群をintervalで保持する。命令ごとの全体Mapは作らない。
    function observeFlush(op: Readonly<Op>) {
        let index = firstGroupAt(op.id);
        const current = flushGroups[index];
        if (current && current.firstID <= op.id) {
            if (current.tid !== op.tid) throw new Error("An instruction changed its hardware thread.");
            current.end = Math.max(current.end, op.retiredCycle);
            return;
        }
        const previous = flushGroups[index - 1];
        let group: FlushGroup;
        if (previous && previous.lastID + 1 === op.id && previous.tid === op.tid) {
            group = previous;
            group.lastID = op.id;
            group.end = Math.max(group.end, op.retiredCycle);
            index--;
        } else {
            group = { firstID: op.id, lastID: op.id, tid: op.tid, end: op.retiredCycle };
            flushGroups.splice(index, 0, group);
        }
        const next = flushGroups[index + 1];
        if (next && group.lastID + 1 === next.firstID && group.tid === next.tid) {
            group.lastID = next.lastID;
            group.end = Math.max(group.end, next.end);
            flushGroups.splice(index + 1, 1);
        }
    }
    function observe(op: Readonly<Op>, parser: Source["parser"] = "onikiri") {
        if (
            !Number.isSafeInteger(op.id) ||
            op.id < 0 ||
            !Number.isFinite(op.fetchedCycle) ||
            op.fetchedCycle < 0 ||
            op.fetchedCycle > Number.MAX_SAFE_INTEGER
        )
            throw new Error("The trace contains an unsupported instruction ID or cycle.");
        const firstID = Math.floor(op.id / blockSize) * blockSize;
        let block = blocks.get(firstID);
        if (!block) {
            block = {
                firstID,
                lastID: op.id,
                firstCycle: Infinity,
                lastCycle: -Infinity,
                maxFetchCycle: -Infinity,
                ids: new Uint32Array(blockSize / 32),
                ended: new Uint32Array(blockSize / 32)
            };
            blocks.set(firstID, block);
        }
        if (parser === "gem5") {
            storeClock.observe(op);
            const tick = windows.storeTick(op);
            if (tick !== null) {
                const stores = (block.stores ??= {
                    firstCycle: Infinity,
                    lastTick: 0,
                    ids: new Uint32Array(blockSize / 32)
                });
                const offset = op.id - firstID;
                stores.ids[offset >>> 5] |= 1 << (offset & 31);
                stores.firstCycle = Math.min(stores.firstCycle, recordedEnd(op, parser)!);
                stores.lastTick = Math.max(stores.lastTick, tick);
                lastStoreTick = Math.max(lastStoreTick, tick);
            }
        }
        block.maxFetchCycle = Math.max(block.maxFetchCycle, op.fetchedCycle);
        const offset = op.id - firstID;
        const word = offset >>> 5,
            bit = 1 << (offset & 31);
        const firstWrite = !(block.ids[word] & bit);
        if (firstWrite) overview.add(op.fetchedCycle, "fetched");
        block.ids[word] |= bit;
        // Coreのgem5二重writeや、retire後のラベル追加で同じイベントを数え直さない。
        if (!(block.ended[word] & bit)) {
            const end = recordedEnd(op, parser);
            if (end !== null) {
                overview.add(end, op.flush ? "flushed" : "committed");
                block.ended[word] |= bit;
            }
        }
        block.lastID = Math.max(block.lastID, op.id);
        block.firstCycle = Math.min(block.firstCycle, op.fetchedCycle);
        block.lastCycle = Math.max(block.lastCycle, windows.isUnfinished(op) ? Infinity : op.retiredCycle);
        firstCycle = Math.min(firstCycle, op.fetchedCycle);
        observedLastCycle = Math.max(
            observedLastCycle,
            op.fetchedCycle,
            windows.isUnfinished(op) ? 0 : op.retiredCycle
        );
        for (const lane of op.lanes) {
            for (const stage of lane?.stages ?? [])
                observedLastCycle = Math.max(observedLastCycle, stage.startCycle, stage.endCycle);
        }
        threads.add(op.tid);
        if (parser === "gem5" && op.flush) observeFlush(op);
        onOperation(op, parser, firstWrite);
    }
    function attach(trace: ParsedTrace, parser: Source["parser"] = "onikiri") {
        if (trace.opCount !== 0) throw new Error("The parser published its store after instructions were written.");
        const store = trace.opStore as MutableOpStore;
        const write = store.setOp.bind(store);
        store.setOp = (id, op) => {
            write(id, op);
            observe(op, parser);
            onWrite();
        };
    }
    function metadata(lastCycle: number) {
        const clock = storeClock.snapshot();
        lastCycle = Math.max(
            lastCycle,
            observedLastCycle,
            clock && lastStoreTick ? windows.storeCycle(clock, lastStoreTick) : 0
        );
        if (!blocks.size) throw new Error("No instructions were found in this trace.");
        if (!Number.isFinite(lastCycle) || lastCycle > Number.MAX_SAFE_INTEGER)
            throw new Error("The trace end cycle is invalid.");
        return {
            indexBlocks: blocks.size,
            threads: [...threads].sort((a, b) => a - b),
            firstCycle: Math.floor(firstCycle),
            lastCycle,
            overview: overview.snapshot(lastCycle)
        };
    }
    function finish(lastCycle: number) {
        return { ...metadata(lastCycle), blocks: [...blocks.values()] };
    }
    // 解析が次のyieldで進んでも、区間要求の対象IDを後から追加しない。
    // 全体のコピー・並べ替えは進捗通知ごとには行わず、該当ブロックだけを固定する。
    function snapshot(firstCycle: number, lastCycle: number) {
        const selected: Block[] = [];
        for (const block of blocks.values()) {
            if (block.firstCycle > lastCycle) continue;
            const groups: FlushGroup[] = [];
            let end = block.lastCycle;
            for (let i = firstGroupAt(block.firstID); i < flushGroups.length; i++) {
                const group = flushGroups[i];
                if (group.firstID > block.lastID) break;
                end = Math.max(end, group.end);
                groups.push({ ...group });
            }
            if (end >= firstCycle)
                selected.push({ ...block, lastCycle: end, ids: block.ids.slice(), flushGroups: groups });
        }
        return selected;
    }
    // 命令本体が退役した後も、交差する書込み待機のIDだけを圧縮pageから取得する。
    // 1命令ごとの全ログ配列を作らず、storeのあるIDブロックにビットと範囲を追加する。
    function storeSnapshot(firstCycle: number, lastCycle: number) {
        const clock = storeClock.snapshot();
        const selected: Pick<Block, "firstID" | "lastID" | "ids">[] = [];
        if (clock)
            for (const block of blocks.values()) {
                const stores = block.stores;
                if (
                    stores &&
                    stores.firstCycle <= lastCycle &&
                    windows.storeCycle(clock, stores.lastTick) >= firstCycle
                )
                    selected.push({ firstID: block.firstID, lastID: block.lastID, ids: stores.ids.slice() });
            }
        return { blocks: selected, clock };
    }
    function previewSnapshot(after: number) {
        return [...blocks.values()]
            .filter((block) => block.maxFetchCycle > after)
            .sort((a, b) => a.firstCycle - b.firstCycle || a.firstID - b.firstID)
            .map(({ firstID, lastID, firstCycle, ids }) => ({ firstID, lastID, firstCycle, ids: ids.slice() }));
    }
    function searchSnapshot(after = -1) {
        return [...blocks.values()]
            .filter((block) => block.lastID > after)
            .sort((a, b) => a.firstID - b.firstID)
            .map(({ firstID, lastID, ids }) => ({ firstID, lastID, ids: ids.slice() }));
    }
    function clear() {
        blocks.clear();
        overview.clear();
        storeClock.clear();
        lastStoreTick = 0;
        firstCycle = Infinity;
        observedLastCycle = 0;
        threads.clear();
        flushGroups.length = 0;
    }
    return { attach, observe, metadata, snapshot, storeSnapshot, previewSnapshot, searchSnapshot, finish, clear };
}

// fetch順だけの検索では、左境界より前に始まった長いメモリアクセスを落としてしまう。
// ブロックの生存区間で絞り、該当ページだけを展開して実際の交差を確認する。
async function selectOps(
    trace: ParsedTrace,
    blocks: readonly Block[],
    firstCycle: number,
    lastCycle: number,
    thread: number,
    signal: AbortSignal,
    flushCycles = new Map<number, number>()
) {
    const ops: Readonly<Op>[] = [];
    const pause = createScanYield(signal);
    let stages = 0;
    for (const block of blocks) {
        checkAbort(signal);
        if (block.firstCycle > lastCycle || block.lastCycle < firstCycle) continue;
        const groups = block.flushGroups ?? [];
        let groupIndex = 0;
        for (let id = block.firstID; id <= block.lastID; id++) {
            const offset = id - block.firstID;
            if (!(block.ids[offset >>> 5] & (1 << (offset & 31)))) continue;
            const yielding = pause();
            if (yielding) await yielding;
            const op = trace.getOpForScan(id);
            while (groupIndex < groups.length && groups[groupIndex].lastID < id) groupIndex++;
            const candidate = groups[groupIndex];
            const group = op?.flush && candidate?.firstID <= id && candidate.tid === op.tid ? candidate : undefined;
            const end = op && (windows.isUnfinished(op) ? Infinity : group ? group.end : op.retiredCycle);
            if (op && op.tid === thread && op.fetchedCycle <= lastCycle && end! >= firstCycle) {
                if (ops.length >= maxWindowOps)
                    throw new Error("Too many instructions in this window. Select a shorter cycle range.");
                for (const lane of op.lanes) stages += lane?.stages.length ?? 0;
                if (stages > windows.limits.stages)
                    throw new Error(`Select at most ${windows.limits.stages} stage events`);
                // 圧縮storeの復元値やretire後の追加ラベルを、awaitを跨いで共有しない。
                ops.push(structuredClone(op));
                if (group) flushCycles.set(id, group.end);
            }
        }
    }
    return ops;
}

async function selectStoreWaits(
    trace: ParsedTrace,
    snapshot: ReturnType<ReturnType<typeof createTraceIndex>["storeSnapshot"]>,
    firstCycle: number,
    lastCycle: number,
    thread: number,
    signal: AbortSignal
) {
    const waits: windows.StoreWait[] = [];
    const pause = createScanYield(signal);
    checkAbort(signal);
    for (const block of snapshot.blocks) {
        for (let id = block.firstID; id <= block.lastID; id++) {
            const offset = id - block.firstID;
            if (!(block.ids[offset >>> 5] & (1 << (offset & 31)))) continue;
            const yielding = pause();
            if (yielding) await yielding;
            const op = trace.getOpForScan(id);
            if (!op || op.tid !== thread) continue;
            const wait = windows.storeWait(op, snapshot.clock);
            if (!wait || wait[2] > lastCycle || wait[3] < firstCycle) continue;
            if (waits.length >= maxWindowOps)
                throw new Error(`Select at most ${maxWindowOps} outstanding store writes`);
            // 時刻は直ちに値へ取り出し、Parserが追加するラベルやOpをawait後へ持ち越さない。
            waits.push(wait);
        }
    }
    checkAbort(signal);
    return waits;
}

// 流入文字列だけを先読みする。将来のステージ・終了結果を再生モデルへ追加しない。
// last+1より先は0.7cycleのfetch補間の対象外なので、同時fetchも表示行数まででよい。
async function selectPreview(
    trace: ParsedTrace,
    blocks: readonly Pick<Block, "firstID" | "lastID" | "firstCycle" | "ids">[],
    after: number,
    through: number,
    thread: number,
    signal: AbortSignal
) {
    let ops: NonNullable<replay.Trace["feedPreview"]> = [];
    let scanned = 0;
    const pause = createScanYield(signal);
    for (const block of blocks) {
        checkAbort(signal);
        if (ops.length === replay.feedRows && block.firstCycle > ops.at(-1)!.fetch) break;
        if (scanned >= 65536) {
            // 未確認ブロックより早いと確定した行だけを使う。疎・非単調なログで全Opを走査しない。
            return { ops: ops.filter((op) => op.fetch < block.firstCycle), limited: true };
        }
        for (let id = block.firstID; id <= block.lastID; id++) {
            const offset = id - block.firstID;
            if (!(block.ids[offset >>> 5] & (1 << (offset & 31)))) continue;
            if (scanned === 65536) return { ops: ops.filter((op) => op.fetch < block.firstCycle), limited: true };
            scanned++;
            const yielding = pause();
            if (yielding) await yielding;
            const op = trace.getOpForScan(id);
            if (!op || op.tid !== thread || op.fetchedCycle <= after || op.fetchedCycle > through) continue;
            const last = ops.at(-1);
            if (
                ops.length === replay.feedRows &&
                (op.fetchedCycle > last!.fetch || (op.fetchedCycle === last!.fetch && op.id > last!.id))
            )
                continue;
            const label = op.labelName || `(g:${op.gid})`;
            const kind = memory.instructionType(label);
            ops.push({
                id: op.id,
                fetch: op.fetchedCycle,
                label: label.trim().replace(/\s+/g, " ").slice(0, 42),
                kind: kind === "load" || kind === "store" || kind === "atomic" ? "memory" : kind
            });
            ops.sort((a, b) => a.fetch - b.fetch || a.id - b.id);
            if (ops.length > replay.feedRows) ops.pop();
        }
    }
    return { ops, limited: false };
}

// storeを短いCPU区間ずつ走査する。検索中もParserとwindow要求へ制御を返す。
async function searchOps(
    trace: ParsedTrace,
    blocks: readonly Pick<Block, "firstID" | "lastID" | "ids">[],
    request: SearchRequest,
    parser: Source["parser"],
    signal: AbortSignal
) {
    const query = request.query.trim();
    const threshold = Number(query);
    if (
        !["text", "id", "flush", "long"].includes(request.kind) ||
        query.length > 512 ||
        (request.kind === "text" && !query) ||
        (request.kind === "id" && (!/^\d+$/.test(query) || !Number.isSafeInteger(threshold))) ||
        (request.kind === "long" && (!query || !Number.isFinite(threshold) || threshold < 0)) ||
        (request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < -1))
    )
        throw new Error("Invalid trace search.");
    const needle = query.toLowerCase(),
        hits: SearchHit[] = [];
    const pause = createScanYield(signal);
    for (const block of blocks) {
        checkAbort(signal);
        if (request.kind === "id" && (threshold < block.firstID || threshold > block.lastID)) continue;
        const firstID = Math.max(block.firstID, (request.after ?? -1) + 1);
        for (let id = firstID; id <= block.lastID; id++) {
            const offset = id - block.firstID;
            if (!(block.ids[offset >>> 5] & (1 << (offset & 31)))) continue;
            const yielding = pause();
            if (yielding) await yielding;
            if (request.kind === "id" && id !== threshold) continue;
            const op = trace.getOpForScan(id);
            if (!op || op.tid !== request.thread) continue;
            if (
                request.kind === "text" &&
                !op.labelName.toLowerCase().includes(needle) &&
                !op.labelDetail.toLowerCase().includes(needle)
            )
                continue;
            if (request.kind === "flush" && !op.flush) continue;
            const end = recordedEnd(op, parser);
            if (request.kind === "long" && (end === null || end - op.fetchedCycle < threshold)) continue;
            if (hits.length === maxSearchHits) return { hits, more: true };
            hits.push({
                id: op.id,
                cycle: op.fetchedCycle,
                endCycle: end,
                label: op.labelName.slice(0, 2048),
                tid: op.tid,
                flush: op.flush
            });
        }
    }
    checkAbort(signal);
    return { hits, more: false };
}

function createFileSession(send: (response: Response) => void) {
    const abort = new AbortController();
    const profiles = structures.createProfiles();
    const indexer = createTraceIndex(scheduleUpdate, profiles.observe);
    let trace: ParsedTrace | null = null;
    let source: Source | null = null;
    let parser: Source["parser"] = "onikiri";
    let complete = false;
    let started = false;
    let publishedAt = -Infinity;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let searching: AbortController | null = null;
    let selecting: AbortController | null = null;
    function metadata(): Source {
        if (!trace) throw new Error("No trace file is open.");
        const index = indexer.metadata(trace.lastCycle);
        return {
            name: trace.fileName,
            parser,
            opCount: trace.opCount,
            firstCycle: index.firstCycle,
            lastCycle: Math.max(index.firstCycle, Math.ceil(index.lastCycle)),
            threads: index.threads,
            laneNames: [...trace.laneNames],
            warnings: trace.warningCount,
            // このgetterは全圧縮ページを集計するため、途中更新では呼ばない。
            storedBytes: complete ? (trace.opStore as core.PageStore).storedSize : null,
            indexBlocks: index.indexBlocks,
            complete,
            overview: index.overview
        };
    }
    function publish() {
        if (abort.signal.aborted || !trace?.opCount) return;
        source = metadata();
        publishedAt = performance.now();
        send({ type: "loaded", source });
    }
    function scheduleUpdate() {
        if (abort.signal.aborted || complete || updateTimer !== undefined || !trace?.opCount) return;
        updateTimer = setTimeout(
            () => {
                updateTimer = undefined;
                publish();
            },
            Math.max(0, 250 - (performance.now() - publishedAt))
        );
    }
    async function open(file: core.TraceInput) {
        checkAbort(abort.signal);
        if (started) throw new Error("A trace file is already open.");
        started = true;
        // 固定CoreはKanataの形式不一致だけで2回目のstreamを開いてgem5へ移る。
        // 圧縮を自前で判定し直さず、最初のonTraceにも同じparser名を渡す。
        let attempts = 0;
        const input: core.TraceInput = {
            name: file.name,
            size: file.size,
            type: file.type,
            stream(signal) {
                if (++attempts > 2) throw new Error("The parser reopened its input unexpectedly.");
                parser = attempts === 1 ? "onikiri" : "gem5";
                return file.stream(signal);
            }
        };
        const result = await core.parseTraceFile(
            input,
            {
                onProgress: (value) => {
                    if (!abort.signal.aborted) send({ type: "progress", progress: { phase: "reading", value } });
                },
                onTrace: (partial) => {
                    if (abort.signal.aborted) return;
                    if (!trace) indexer.attach(partial, parser);
                    trace = partial;
                    scheduleUpdate();
                }
            },
            abort.signal
        );
        checkAbort(abort.signal);
        if (!result) return;
        trace = result.trace;
        if (parser !== (result.parserName === "OnikiriParser" ? "onikiri" : "gem5"))
            throw new Error("The parser changed its format selection contract.");
        complete = true;
        clearTimeout(updateTimer);
        updateTimer = undefined;
        if (!trace.opCount) throw new Error("No instructions were found in this trace.");
        publish();
    }
    async function window(request: Extract<Request, { type: "window" }>) {
        checkAbort(abort.signal);
        cancelWindow();
        const controller = new AbortController();
        selecting = controller;
        try {
            if (!trace || !source) throw new Error("No trace file is open.");
            const selectedSource = complete ? source : metadata();
            if (
                !Number.isFinite(request.cycle) ||
                !Number.isInteger(request.span) ||
                request.span < 16 ||
                request.span > windows.limits.cycles ||
                !selectedSource.threads.includes(request.thread)
            )
                throw new Error("Invalid trace window.");
            const firstCycle = Math.max(
                selectedSource.firstCycle,
                Math.min(selectedSource.lastCycle - 1, Math.floor(request.cycle))
            );
            const lastCycle = Math.min(selectedSource.lastCycle, firstCycle + request.span - 1);
            // 表示窓の時刻は保ち、直前のcommit/squash演出と次fetchに必要な文脈を取得する。
            const contextFirst = Math.max(selectedSource.firstCycle, firstCycle - 6);
            const contextLast = Math.min(selectedSource.lastCycle, lastCycle + 1);
            const blocks = indexer.snapshot(contextFirst, contextLast);
            const previewBlocks = indexer.previewSnapshot(contextLast);
            const storeSnapshot = indexer.storeSnapshot(contextFirst, contextLast);
            const flushCycles = new Map<number, number>();
            const ops = await selectOps(
                trace,
                blocks,
                contextFirst,
                contextLast,
                request.thread,
                controller.signal,
                flushCycles
            );
            checkAbort(controller.signal);
            const storeWaits = await selectStoreWaits(
                trace,
                storeSnapshot,
                contextFirst,
                contextLast,
                request.thread,
                controller.signal
            );
            checkAbort(controller.signal);
            const selection = {
                ops,
                storeWaits,
                storeClock: storeSnapshot.clock,
                firstCycle,
                lastCycle,
                source: selectedSource,
                laneNames: selectedSource.laneNames,
                flushCycles,
                profile: profiles.get(request.thread, (id) => trace!.getOpForScan(id), selectedSource)
            };
            const converted = windows.toTraceWindow(selection);
            const preview = await selectPreview(
                trace!,
                previewBlocks,
                contextLast,
                selectedSource.lastCycle,
                request.thread,
                controller.signal
            );
            converted.feedPreview = preview.ops;
            // 集約histogramではなく、実際に確認した次fetchまでを空白判定へ渡す。
            converted.emptyTailUntil =
                preview.ops[0]?.fetch ?? (preview.limited ? lastCycle : selectedSource.lastCycle);
            if (preview.limited)
                converted.demo.provenance.note += " Instruction text preview is limited for this interval.";
            checkAbort(controller.signal);
            send({ type: "window", request: request.request, trace: converted });
        } finally {
            if (selecting === controller) selecting = null;
        }
    }
    function cancelWindow() {
        selecting?.abort();
        selecting = null;
    }
    function cancelSearch() {
        searching?.abort();
        searching = null;
    }
    async function search(request: SearchRequest) {
        cancelSearch();
        checkAbort(abort.signal);
        if (!trace || !source) throw new Error("No trace file is open.");
        const selectedSource = complete ? source : metadata();
        if (!selectedSource.threads.includes(request.thread)) throw new Error("Invalid trace search thread.");
        const controller = new AbortController();
        searching = controller;
        try {
            // 連続した検索要求を先に受け、旧検索のindex複製やpage展開を避ける。
            await yieldTask();
            checkAbort(controller.signal);
            const blocks = indexer.searchSnapshot(request.after);
            const result = await searchOps(trace, blocks, request, parser, controller.signal);
            checkAbort(controller.signal);
            send({ type: "search", request: request.request, ...result });
        } finally {
            if (searching === controller) searching = null;
        }
    }
    function close() {
        abort.abort();
        cancelWindow();
        cancelSearch();
        clearTimeout(updateTimer);
        updateTimer = undefined;
        trace?.close();
        trace = null;
        indexer.clear();
        profiles.clear();
        source = null;
    }
    return { open, window, cancelWindow, search, cancelSearch, close };
}
namespace traceFile {
    export type Metadata = Source;
    export type TraceOverview = Overview;
    export type TraceSearchHit = SearchHit;
    export type WorkerRequest = Request;
    export type WorkerResponse = Response;
}
const traceFile = {
    createFileSession,
    createTraceIndex,
    selectOps,
    selectStoreWaits,
    searchOps,
    selectPreview,
    maxWindowOps,
    maxOverviewBins,
    maxSearchHits
};
export = traceFile;

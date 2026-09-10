import { File as NodeFile } from "node:buffer";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { FileLineReader } from "../vendor/konata-core/file_line_reader";
import { Gem5O3PipeViewParser } from "../vendor/konata-core/gem5_o3_pipe_view_parser";
import type { Op, ParsedTrace } from "../vendor/konata-core/model";
import { OnikiriParser } from "../vendor/konata-core/onikiri_parser";
import { StageStructureDetector } from "../vendor/konata-core/stage_structure_detector";
import { buildCycleNavigatorData, getCycleNavigatorTopDown } from "../vendor/konata-core/trace_navigator_analysis";
import { readGem5Registers, configuredGem5Registers } from "./gem5-registers";
import { buildSchedulingEvidence, readRsdRegisterEvidence } from "./scheduling-evidence";
import { topDownObservationTimes } from "./top-down";

export interface TraceSource {
    readonly key: string;
    readonly label: string;
    readonly displayName: string;
    readonly fileName: string;
    readonly parser: "onikiri" | "gem5";
    readonly machineOrder: "in-order" | "out-of-order";
    readonly zstdPrefix?: boolean;
    readonly prefixBytes?: number;
    readonly window?: readonly [number, number];
    readonly initialCycle?: number;
    readonly includeTopDown?: boolean;
    readonly includeEvidence?: boolean;
}

interface StageRange {
    readonly name: string;
    readonly startCycle: number;
    readonly endCycle: number;
}

type InstructionKind = "integer" | "memory" | "branch";

const memoryMissWaitCycles = 6;

function readZstdPrefix(fileName: string, limit = 32 * 1024 * 1024): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const process = spawn("zstd", ["-dc", fileName]);
        const chunks: Buffer[] = [];
        let size = 0;
        let reachedLimit = false;
        process.stdout.on("data", (chunk: Buffer) => {
            if (size >= limit) return;
            const accepted = chunk.subarray(0, limit - size);
            chunks.push(accepted);
            size += accepted.length;
            if (size >= limit) {
                reachedLimit = true;
                process.kill();
            }
        });
        process.on("error", reject);
        process.on("close", (code) => {
            if (code !== 0 && !reachedLimit) {
                reject(new Error(`zstd exited with status ${code}.`));
                return;
            }
            const contents = Buffer.concat(chunks);
            const lastNewline = contents.lastIndexOf(0x0a);
            resolve(lastNewline < 0 ? contents : contents.subarray(0, lastNewline + 1));
        });
    });
}

function readSourceBytes(source: TraceSource): Buffer {
    if (source.prefixBytes === undefined) return fs.readFileSync(source.fileName);
    const fd = fs.openSync(source.fileName, "r");
    try {
        const bytes = Buffer.alloc(Math.min(source.prefixBytes, fs.fstatSync(fd).size));
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const complete = bytes.subarray(0, count);
        return complete.subarray(0, complete.lastIndexOf(0x0a) + 1);
    } finally {
        fs.closeSync(fd);
    }
}

async function makeFile(source: TraceSource): Promise<File> {
    const bytes = source.zstdPrefix
        ? await readZstdPrefix(source.fileName, source.prefixBytes)
        : readSourceBytes(source);
    const contents = source.fileName.endsWith(".gz") ? zlib.gunzipSync(bytes) : bytes;
    return new NodeFile([contents], path.basename(source.fileName).replace(/\.(gz|zst)$/, "")) as unknown as File;
}

export async function parseTrace(source: TraceSource): Promise<ParsedTrace> {
    const parser = source.parser === "gem5" ? new Gem5O3PipeViewParser() : new OnikiriParser();
    return parser.parse(new FileLineReader(await makeFile(source)));
}

export function getOps(trace: ParsedTrace): Readonly<Op>[] {
    const ops: Readonly<Op>[] = [];
    for (let id = 0; id <= trace.lastID; id++) {
        const op = trace.getOpForScan(id);
        if (op !== undefined && !op.eof) {
            ops.push(op);
        }
    }
    return ops;
}

// Store Tick は実行完了や retire と別の観測値。既存のステージ・終了時刻には混ぜない。
// parser が保持した fetch tick と cycle の組から校正し、未観測の書込みを補完しない。
export function getGem5StoreCompletions(
    source: Pick<TraceSource, "parser">,
    ops: readonly Readonly<Pick<Op, "id" | "labelName" | "labelDetail" | "fetchedCycle" | "retired" | "flush">>[]
): [number, number][] {
    if (source.parser !== "gem5") return [];
    const calibration = ops.flatMap((op) => {
        const fetch = /^Fetched Tick: (\d+)$/m.exec(op.labelDetail);
        return fetch ? [{ tick: Number(fetch[1]), cycle: op.fetchedCycle }] : [];
    });
    const first = calibration[0];
    const second = calibration.find((entry) => entry.cycle !== first?.cycle);
    if (!first || !second) return [];
    const ticksPerCycle = (second.tick - first.tick) / (second.cycle - first.cycle);
    const cycleAt = (tick: number) => first.cycle + (tick - first.tick) / ticksPerCycle;
    if (
        !Number.isFinite(ticksPerCycle) ||
        ticksPerCycle <= 0 ||
        calibration.some(({ tick, cycle }) => !Number.isSafeInteger(tick) || Math.abs(cycleAt(tick) - cycle) > 1e-6)
    )
        return [];
    return ops.flatMap((op) => {
        if (!op.retired || op.flush) return [];
        const mnemonic = op.labelName
            .replace(/^(?:0x)?[0-9a-f]+:\s*/i, "")
            .trim()
            .replace(/^[A-Z0-9_]+\s*:\s*/, "")
            .split(/\s+/)[0]
            .toLowerCase();
        // ARM の通常 store と x86 の store micro-op。排他的 store や RMW は含めない。
        if (!/^(?:st|str[bh]?|stur[bh]?|stp|stnp|stlr[bh]?)$/.test(mnemonic)) return [];
        const store = /^Store Tick: (\d+)$/m.exec(op.labelDetail);
        const tick = store ? Number(store[1]) : 0;
        if (!Number.isSafeInteger(tick) || tick <= 0) return [];
        const cycle = cycleAt(tick);
        return Number.isFinite(cycle) && cycle >= op.fetchedCycle ? [[op.id, cycle] as [number, number]] : [];
    });
}

// O3PipeViewのretire:0にはsquash時刻がない。詳細ログが併記されている場合は
// [sn:N]を持つsquash行から実時刻を回収し、なければ同じ連続列の最終観測時刻を使う。
export function getGem5FlushCycles(source: TraceSource, ops: readonly Readonly<Op>[]): ReadonlyMap<number, number> {
    if (source.parser !== "gem5") return new Map();

    const contents = readSourceBytes(source).toString("utf8");
    const rawFetchTicks = new Map<number, number>();
    const rawSquashTicks = new Map<number, number>();
    for (const line of contents.split("\n")) {
        const fetch = /^O3PipeView:fetch:(\d+):[^:]*:[^:]*:(\d+):/.exec(line);
        if (fetch !== null) rawFetchTicks.set(Number(fetch[2]), Number(fetch[1]));
        if (!/squash/i.test(line)) continue;
        const tick = /^\s*(\d+):/.exec(line);
        const sequence = /\[sn:(\d+)\]/.exec(line);
        if (tick === null || sequence === null) continue;
        const gid = Number(sequence[1]);
        const rawTick = Number(tick[1]);
        rawSquashTicks.set(gid, Math.min(rawSquashTicks.get(gid) ?? rawTick, rawTick));
    }

    const calibration = ops.flatMap((op) => {
        const rawTick = rawFetchTicks.get(op.gid);
        return rawTick === undefined ? [] : [{ rawTick, cycle: op.fetchedCycle }];
    });
    const first = calibration[0];
    const second = calibration.find((entry) => entry.cycle !== first?.cycle);
    const observed = new Map<number, number>();
    if (first !== undefined && second !== undefined) {
        const ticksPerCycle = (second.rawTick - first.rawTick) / (second.cycle - first.cycle);
        const cycleBegin = first.rawTick / ticksPerCycle - first.cycle;
        if (Number.isFinite(ticksPerCycle) && ticksPerCycle > 0) {
            for (const op of ops) {
                const rawTick = rawSquashTicks.get(op.gid);
                if (op.flush && rawTick !== undefined) {
                    observed.set(op.id, rawTick / ticksPerCycle - cycleBegin);
                }
            }
        }
    }

    const result = new Map<number, number>();
    const ordered = [...ops].sort((left, right) => left.id - right.id);
    for (let index = 0; index < ordered.length; ) {
        if (!ordered[index].flush) {
            index++;
            continue;
        }
        const group = [ordered[index++]];
        while (index < ordered.length && ordered[index].flush && ordered[index].id === group.at(-1)!.id + 1)
            group.push(ordered[index++]);
        const explicit = group.flatMap((op) => {
            const cycle = observed.get(op.id);
            return cycle === undefined ? [] : [cycle];
        });
        const flushCycle =
            explicit.length > 0 ? Math.max(...explicit) : Math.max(...group.map((op) => op.retiredCycle));
        group.forEach((op) => result.set(op.id, flushCycle));
    }
    return result;
}

function getStageRanges(op: Readonly<Op>, laneID: number): StageRange[] {
    const ranges: StageRange[] = [];
    for (const stage of op.lanes[laneID]?.stages ?? []) {
        const endCycle = stage.endCycle === 0 ? op.retiredCycle : stage.endCycle;
        const previous = ranges.at(-1);
        if (previous?.name === stage.name) {
            ranges[ranges.length - 1] = {
                name: previous.name,
                startCycle: Math.min(previous.startCycle, stage.startCycle),
                endCycle: Math.max(previous.endCycle, endCycle)
            };
        } else {
            ranges.push({ name: stage.name, startCycle: stage.startCycle, endCycle });
        }
    }
    return ranges;
}

export function instructionKind(label: string): InstructionKind {
    const mnemonic = label
        .replace(/^(?:0x)?[0-9a-f]+:\s*/i, "")
        .trim()
        .replace(/^[A-Z0-9_]+\s*:\s*/, "")
        .split(/\s+/)[0]
        .toLowerCase();
    if (/^(b|bl|br|bx|cbz|cbnz|tbz|tbnz|jal|jalr|jr|ret|wrip)/.test(mnemonic)) {
        return "branch";
    }
    if (/^(ld|ldr|ldp|lw|lh|lb|lbu|lhu|sd|st|sw|sh|sb|load|store)/.test(mnemonic)) {
        return "memory";
    }
    return "integer";
}

function selectWindow(
    ops: readonly Readonly<Op>[],
    lastCycle: number,
    endCycle: (op: Readonly<Op>) => number = (op) => op.retiredCycle
): readonly [number, number] {
    const span = Math.min(300, lastCycle + 1);
    const flushCycles = [...new Set(ops.filter((op) => op.flush).map(endCycle))];
    const candidateStarts = new Set<number>([0, Math.max(0, lastCycle - span + 1)]);
    for (const flushCycle of flushCycles) {
        candidateStarts.add(Math.max(0, Math.min(lastCycle - span + 1, flushCycle - Math.floor(span * 0.3))));
    }
    for (let start = 0; start <= lastCycle - span + 1; start += Math.max(1, Math.floor(span / 3))) {
        candidateStarts.add(start);
    }
    let bestStart = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const start of candidateStarts) {
        const end = start + span - 1;
        const overlapping = ops.filter((op) => op.fetchedCycle <= end && endCycle(op) >= start);
        const flushes = overlapping.filter((op) => op.flush && endCycle(op) >= start && endCycle(op) <= end).length;
        const fetchCounts = new Map<number, number>();
        for (const op of overlapping) {
            if (op.fetchedCycle >= start && op.fetchedCycle <= end) {
                fetchCounts.set(op.fetchedCycle, (fetchCounts.get(op.fetchedCycle) ?? 0) + 1);
            }
        }
        const superscalarCycles = [...fetchCounts.values()].filter((count) => count > 1).length;
        const score = overlapping.length + flushes * 4 + superscalarCycles * 2;
        if (score > bestScore) {
            bestScore = score;
            bestStart = start;
        }
    }
    return [bestStart, bestStart + span - 1];
}

function selectInitialCycle(
    ops: readonly Readonly<Op>[],
    firstCycle: number,
    lastCycle: number,
    endCycle: (op: Readonly<Op>) => number = (op) => op.retiredCycle
): number {
    let selected = firstCycle;
    let selectedScore = Number.NEGATIVE_INFINITY;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
        const active = ops.filter((op) => op.fetchedCycle <= cycle && endCycle(op) > cycle).length;
        const fetched = ops.filter((op) => op.fetchedCycle === cycle).length;
        const flushing = ops.filter((op) => op.flush && endCycle(op) === cycle).length;
        const score = fetched * 100 + active - flushing * 20;
        if (score > selectedScore) {
            selectedScore = score;
            selected = cycle;
        }
    }
    return selected;
}

function roundedCapacity(peak: number, minimum: number): number {
    return Math.max(minimum, Math.ceil(peak / 8) * 8);
}

function peakOccupancy(
    ops: readonly Readonly<Op>[],
    firstCycle: number,
    lastCycle: number,
    begin: (op: Readonly<Op>) => number | null,
    end: (op: Readonly<Op>) => number | null
): number {
    let peak = 0;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
        peak = Math.max(
            peak,
            ops.filter((op) => {
                const beginCycle = begin(op);
                const endCycle = end(op);
                return beginCycle !== null && endCycle !== null && beginCycle <= cycle && cycle < endCycle;
            }).length
        );
    }
    return peak;
}

interface FlowStageObservation {
    readonly allocationCycle: number | null;
    readonly issueCycle: number | null;
    readonly executionLatency: number | null;
    readonly completionCycle: number | null;
    readonly admissionStallStartCycle: number | null;
    readonly admissionStallEndCycle: number | null;
}

interface FlowStageStructure {
    readonly allocationStage: {
        readonly laneID: number;
        readonly stageNames: readonly string[];
        readonly width: number;
    };
    readonly executionStage: { readonly laneID: number; readonly stageNames: readonly string[] };
    readonly transitionCoverage: number;
    readonly admissionStages: readonly {
        readonly laneID: number;
        readonly stageName: string;
        readonly typicalLatency: number;
    }[];
    observe(op: Readonly<Op>): FlowStageObservation;
}

interface DetectorDraft {
    readonly allocationStage: { readonly laneID: number; readonly stageNames: readonly string[] };
}

function typicalValue(values: readonly number[]): number {
    const counts = new Map<number, number>();
    values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
    return [...counts].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? 0;
}

function buildSerialStageFallback(ops: readonly Readonly<Op>[], measurement: unknown): FlowStageStructure {
    const draft = (measurement as { readonly draft_: DetectorDraft }).draft_;
    const laneID = draft.allocationStage.laneID;
    const candidateStats = draft.allocationStage.stageNames.map((name) => {
        const durations = ops.flatMap((op) =>
            getStageRanges(op, laneID)
                .filter((range) => range.name === name)
                .map((range) => range.endCycle - range.startCycle)
        );
        return {
            name,
            average: durations.reduce((sum, duration) => sum + duration, 0) / Math.max(1, durations.length)
        };
    });
    // 直列候補を一つのfrontierにできないin-order Traceでは、平均滞在が最長の
    // 可変latency stageを待ち行列として選ぶ。stage名そのものには依存しない。
    const allocationName = candidateStats.sort((left, right) => right.average - left.average)[0]?.name;
    if (allocationName === undefined) {
        throw new Error("A serial stage fallback could not be inferred.");
    }

    const starts = new Map<number, number>();
    const admissionSamples = new Map<string, number[]>();
    const successorCounts = new Map<string, number>();
    let allocationCount = 0;
    for (const op of ops) {
        const ranges = getStageRanges(op, laneID);
        const allocationIndex = ranges.findIndex((range) => range.name === allocationName);
        if (allocationIndex < 0) continue;
        const allocation = ranges[allocationIndex];
        allocationCount++;
        starts.set(allocation.startCycle, (starts.get(allocation.startCycle) ?? 0) + 1);
        const previous = ranges[allocationIndex - 1];
        if (previous !== undefined) {
            const samples = admissionSamples.get(previous.name) ?? [];
            samples.push(allocation.startCycle - previous.startCycle);
            admissionSamples.set(previous.name, samples);
        }
        const successor = ranges[allocationIndex + 1];
        if (successor !== undefined) {
            successorCounts.set(successor.name, (successorCounts.get(successor.name) ?? 0) + 1);
        }
    }
    const executionNames = [...successorCounts]
        .filter(([name]) => name !== allocationName && !admissionSamples.has(name))
        .sort((left, right) => right[1] - left[1])
        .map(([name]) => name);
    if (executionNames.length === 0) {
        throw new Error("Execution stages were not found after the serial stage fallback.");
    }
    const admissionStages = [...admissionSamples]
        .sort((left, right) => right[1].length - left[1].length)
        .map(([stageName, latencies]) => ({ laneID, stageName, typicalLatency: typicalValue(latencies) }));

    return {
        allocationStage: {
            laneID,
            stageNames: [allocationName],
            width: Math.max(...starts.values())
        },
        executionStage: {
            laneID,
            stageNames: executionNames
        },
        transitionCoverage:
            executionNames.reduce((sum, name) => sum + (successorCounts.get(name) ?? 0), 0) /
            Math.max(1, allocationCount),
        admissionStages,
        observe(op): FlowStageObservation {
            const ranges = getStageRanges(op, laneID);
            const allocationIndex = ranges.findIndex((range) => range.name === allocationName);
            const allocation = ranges[allocationIndex];
            const executionIndex =
                allocationIndex < 0
                    ? -1
                    : ranges.findIndex(
                          (range, index) => index > allocationIndex && executionNames.includes(range.name)
                      );
            const execution = ranges[executionIndex];
            const completion = executionIndex < 0 ? undefined : ranges[executionIndex + 1];
            const previous = ranges[allocationIndex - 1];
            const admission =
                previous === undefined ? undefined : admissionStages.find((stage) => stage.stageName === previous.name);
            const stallStart =
                previous === undefined || admission === undefined
                    ? null
                    : previous.startCycle + admission.typicalLatency;
            return {
                allocationCycle: allocation?.startCycle ?? null,
                issueCycle: execution?.startCycle ?? null,
                executionLatency: execution === undefined ? null : execution.endCycle - execution.startCycle,
                completionCycle: completion?.startCycle ?? null,
                admissionStallStartCycle: stallStart,
                admissionStallEndCycle:
                    stallStart === null || allocation === undefined
                        ? null
                        : Math.min(previous.endCycle, allocation.startCycle)
            };
        }
    };
}

export async function buildSample(source: TraceSource) {
    const trace = await parseTrace(source);
    const allOps = getOps(trace);
    const flushCycles = getGem5FlushCycles(source, allOps);
    const effectiveEndCycle = (op: Readonly<Op>): number =>
        op.flush ? (flushCycles.get(op.id) ?? op.retiredCycle) : op.retiredCycle;
    const detector = new StageStructureDetector();
    allOps.forEach((op) => detector.observe(op));
    const measurement = detector.finish();
    if (measurement === null) {
        trace.close();
        throw new Error(`Stage structure was not detected for ${source.displayName}.`);
    }
    allOps.forEach((op) => measurement.observe(op));
    let detectionMethod = "out-of-order frontier";
    let detected: FlowStageStructure | null = measurement.finish();
    if (detected === null) {
        detected = buildSerialStageFallback(allOps, measurement);
        detectionMethod = "serial-stage fallback";
    }

    const laneID = detected.allocationStage.laneID;
    const allocationNames = new Set(detected.allocationStage.stageNames);
    const executionNames = new Set(detected.executionStage.stageNames);
    const pathCounts = new Map<string, { readonly names: readonly string[]; count: number }>();
    for (const op of allOps) {
        if (!op.retired || op.flush) {
            continue;
        }
        const names = getStageRanges(op, laneID).map((range) => range.name);
        if (!names.some((name) => allocationNames.has(name)) || !names.some((name) => executionNames.has(name))) {
            continue;
        }
        const key = names.join("\u0000");
        const current = pathCounts.get(key);
        if (current === undefined) {
            pathCounts.set(key, { names, count: 1 });
        } else {
            current.count++;
        }
    }
    const representativePath = [...pathCounts.values()].sort((left, right) => right.count - left.count)[0]?.names;
    if (representativePath === undefined) {
        trace.close();
        throw new Error(`A representative path was not found for ${source.displayName}.`);
    }
    const allocationIndex = representativePath.findIndex((name) => allocationNames.has(name));
    const executionIndex = representativePath.findIndex(
        (name, index) => index > allocationIndex && executionNames.has(name)
    );
    const frontNames = representativePath.slice(0, allocationIndex);
    const frontGroupCount = Math.min(6, Math.max(1, frontNames.length));
    const frontNodes = Array.from({ length: frontGroupCount }, (_, index) => ({
        id: `front-${index}`,
        names: [] as string[]
    }));
    frontNames.forEach((name, index) => {
        frontNodes[Math.min(frontGroupCount - 1, Math.floor((index * frontGroupCount) / frontNames.length))].names.push(
            name
        );
    });
    const frontNodeByName = new Map(frontNodes.flatMap((node) => node.names.map((name) => [name, node.id])));
    const completionNames = representativePath.slice(executionIndex + 1, -1);
    const retireNames = representativePath.slice(-1);
    const observations = new Map(allOps.map((op) => [op.id, detected.observe(op)]));
    const memoryCompletionStageNames = source.parser === "gem5" ? new Set(["Mc"]) : new Set<string>();
    const memoryWaitStageNames = new Set<string>();
    const memoryReadyCycles = new Map<number, number>();
    const memoryWaitStartCycles = new Map<number, number>();
    const memoryWaitOpIDs = new Set<number>();
    let inferredMemoryBaseLatency: number | null = null;
    if (source.parser === "gem5") {
        for (const op of allOps) {
            if (instructionKind(op.labelName) !== "memory") continue;
            const ranges = getStageRanges(op, laneID);
            const responseIndex = ranges.findIndex((range) => memoryCompletionStageNames.has(range.name));
            const completionCycle = observations.get(op.id)?.completionCycle;
            if (responseIndex < 0 || completionCycle === null || completionCycle === undefined) continue;
            const responseCycle = ranges[responseIndex].startCycle;
            memoryReadyCycles.set(op.id, responseCycle);
            if (responseCycle - completionCycle < memoryMissWaitCycles) continue;
            memoryWaitOpIDs.add(op.id);
            memoryWaitStartCycles.set(op.id, completionCycle);
            ranges
                .slice(0, responseIndex)
                .filter((range) => range.startCycle >= completionCycle)
                .forEach((range) => memoryWaitStageNames.add(range.name));
        }
    } else {
        const memoryTimings = allOps.flatMap((op) => {
            if (instructionKind(op.labelName) !== "memory" || !op.retired || op.flush) return [];
            const issueCycle = observations.get(op.id)?.issueCycle;
            if (issueCycle === null || issueCycle === undefined) return [];
            const ranges = getStageRanges(op, laneID);
            const readyRange = ranges.findLast((range) => completionNames.includes(range.name));
            const readyCycle = readyRange?.startCycle;
            if (readyCycle === undefined || readyCycle <= issueCycle) return [];
            return [{ op, ranges, issueCycle, readyCycle, readyName: readyRange.name }];
        });
        inferredMemoryBaseLatency =
            memoryTimings.length === 0
                ? null
                : Math.min(...memoryTimings.map(({ issueCycle, readyCycle }) => readyCycle - issueCycle));
        for (const timing of memoryTimings) {
            memoryReadyCycles.set(timing.op.id, timing.readyCycle);
            if (
                inferredMemoryBaseLatency === null ||
                timing.readyCycle - timing.issueCycle <= inferredMemoryBaseLatency + 0.001
            )
                continue;
            const waitStartCycle = timing.issueCycle + inferredMemoryBaseLatency;
            memoryWaitOpIDs.add(timing.op.id);
            memoryWaitStartCycles.set(timing.op.id, waitStartCycle);
            memoryCompletionStageNames.add(timing.readyName);
            timing.ranges
                .filter((range) => range.endCycle > waitStartCycle && range.startCycle < timing.readyCycle)
                .forEach((range) => memoryWaitStageNames.add(range.name));
        }
    }
    // gem5はMcの長い待ち、その他は観測した最短memory latencyの超過分を
    // memory waitとし、基準latencyの命令はmemory pipeからROBへ直接送る。
    // 同時にexecutionを開始した命令数を、種別ごとの最小パイプ数として扱う。
    const startsByKind = new Map<InstructionKind, Map<number, number>>();
    const executionNamesByKind = new Map<InstructionKind, Set<string>>();
    for (const op of allOps) {
        const issueCycle = observations.get(op.id)?.issueCycle;
        if (issueCycle === null || issueCycle === undefined) continue;
        const kind = instructionKind(op.labelName);
        let starts = startsByKind.get(kind);
        if (starts === undefined) {
            starts = new Map<number, number>();
            startsByKind.set(kind, starts);
        }
        starts.set(issueCycle, (starts.get(issueCycle) ?? 0) + 1);
        const observedName = getStageRanges(op, laneID).find(
            (range) => range.startCycle === issueCycle && executionNames.has(range.name)
        )?.name;
        if (observedName !== undefined) {
            const names = executionNamesByKind.get(kind) ?? new Set<string>();
            names.add(observedName);
            executionNamesByKind.set(kind, names);
        }
    }
    const executionNodes = (["integer", "memory", "branch"] as const)
        .filter((kind) => startsByKind.has(kind))
        .map((kind) => ({
            id: `exec-${kind}`,
            kind,
            names: [...(executionNamesByKind.get(kind) ?? detected.executionStage.stageNames)],
            pipeCount: Math.max(...(startsByKind.get(kind)?.values() ?? [1]))
        }));
    const [firstCycle, lastCycle] = source.window ?? selectWindow(allOps, trace.lastCycle, effectiveEndCycle);
    const sampleOps = allOps.filter((op) => op.fetchedCycle <= lastCycle && effectiveEndCycle(op) >= firstCycle);
    const initialCycle = source.initialCycle ?? selectInitialCycle(sampleOps, firstCycle, lastCycle, effectiveEndCycle);
    const sampledMemoryWaitOpCount = sampleOps.filter((op) => {
        const waitStartCycle = memoryWaitStartCycles.get(op.id);
        const readyCycle = memoryReadyCycles.get(op.id);
        return (
            waitStartCycle !== undefined &&
            readyCycle !== undefined &&
            waitStartCycle < lastCycle &&
            readyCycle > firstCycle
        );
    }).length;
    const memoryWait =
        sampledMemoryWaitOpCount === 0
            ? null
            : {
                  id: "memory-wait",
                  waitStageNames: [...memoryWaitStageNames],
                  completionStageNames: [...memoryCompletionStageNames],
                  observedOps: sampledMemoryWaitOpCount,
                  baseLatency: inferredMemoryBaseLatency
              };

    const explicitRsdStages = source.includeEvidence && source.fileName.endsWith("/rsd/mshr.log");
    const compactOps = sampleOps.map((op) => {
        const observation = observations.get(op.id);
        if (observation === undefined) {
            throw new Error(`Missing observation for op ${op.id}.`);
        }
        const ranges = getStageRanges(op, laneID);
        const kind = instructionKind(op.labelName);
        const executionNode = executionNodes.find((node) => node.kind === kind)?.id ?? executionNodes[0].id;
        const terminalRange = op.retired && !op.flush ? ranges.at(-1) : undefined;
        const allocationCycle = observation.allocationCycle;
        const issueCycle = observation.issueCycle;
        const completionCycle = explicitRsdStages
            ? (ranges.findLast((range) => range.name === "Rw")?.startCycle ?? null)
            : observation.completionCycle;
        const memoryReadyCycle = memoryReadyCycles.get(op.id) ?? completionCycle;
        const memoryWaitStartCycle = memoryWaitStartCycles.get(op.id);
        const mappedStages = ranges.flatMap((range, rangeIndex) => {
            const boundaries = [range.startCycle, range.endCycle];
            if (kind === "memory") {
                for (const boundary of [memoryWaitStartCycle, memoryReadyCycle]) {
                    if (
                        boundary !== null &&
                        boundary !== undefined &&
                        boundary > range.startCycle &&
                        boundary < range.endCycle
                    )
                        boundaries.push(boundary);
                }
            }
            boundaries.sort((left, right) => left - right);
            const segments =
                range.endCycle > range.startCycle
                    ? boundaries.slice(0, -1).map((startCycle, index) => ({
                          startCycle,
                          endCycle: boundaries[index + 1]
                      }))
                    : [{ startCycle: range.startCycle, endCycle: range.endCycle }];
            return segments.map((segment) => {
                let node: string;
                if (allocationCycle === null || segment.startCycle < allocationCycle) {
                    node =
                        frontNodeByName.get(range.name) ??
                        frontNodes[
                            Math.min(
                                frontNodes.length - 1,
                                Math.floor((rangeIndex * frontNodes.length) / Math.max(1, ranges.length))
                            )
                        ].id;
                } else if (issueCycle === null || segment.startCycle < issueCycle) {
                    node = "issue";
                } else if (kind === "memory" && memoryReadyCycle !== null) {
                    if (
                        memoryWaitStartCycle !== undefined &&
                        segment.startCycle >= memoryWaitStartCycle &&
                        segment.startCycle < memoryReadyCycle
                    ) {
                        node = memoryWait?.id ?? executionNode;
                    } else if (segment.startCycle < memoryReadyCycle) {
                        node = executionNode;
                    } else if (terminalRange === range) {
                        node = "commit";
                    } else {
                        node = "rob";
                    }
                } else if (completionCycle === null || segment.startCycle < completionCycle) {
                    node = executionNode;
                } else if (terminalRange === range) {
                    node = "commit";
                } else {
                    node = "rob";
                }
                // RSD は発行の受け渡し、レジスタ読み出し、実行、書き戻しを明示的に区別する。
                // メモリアクセスの再試行時も、そのステージ区分を維持する。
                if (explicitRsdStages) {
                    if (range.name === "Is" || range.name === "Rr") node = "register-read";
                    else if (["X", "Mt", "Ma"].includes(range.name)) node = executionNode;
                    else if (range.name === "Rw")
                        node =
                            memoryReadyCycle !== null && segment.startCycle < memoryReadyCycle ? "memory-wait" : "rob";
                }
                return [range.name, node, segment.startCycle, Math.max(segment.startCycle + 0.72, segment.endCycle)];
            });
        });
        return [
            op.id,
            op.rid,
            op.fetchedCycle,
            op.retiredCycle,
            op.flush ? 1 : 0,
            op.labelName || `(g:${op.gid})`,
            mappedStages,
            allocationCycle,
            issueCycle,
            memoryReadyCycle,
            executionNode,
            flushCycles.get(op.id) ?? null
        ];
    });

    const queuePeak = peakOccupancy(
        sampleOps,
        firstCycle,
        lastCycle,
        (op) => observations.get(op.id)?.allocationCycle ?? null,
        (op) => observations.get(op.id)?.issueCycle ?? effectiveEndCycle(op)
    );
    const robPeak = peakOccupancy(
        sampleOps,
        firstCycle,
        lastCycle,
        (op) => observations.get(op.id)?.allocationCycle ?? null,
        effectiveEndCycle
    );
    const fetchCounts = new Map<number, number>();
    const retireCounts = new Map<number, number>();
    for (const op of sampleOps) {
        const firstStage = getStageRanges(op, laneID)[0];
        if (firstStage !== undefined) {
            fetchCounts.set(firstStage.startCycle, (fetchCounts.get(firstStage.startCycle) ?? 0) + 1);
        }
        if (op.retired && !op.flush) {
            retireCounts.set(op.retiredCycle, (retireCounts.get(op.retiredCycle) ?? 0) + 1);
        }
    }
    let topDown = null;
    if (source.includeTopDown) {
        const data = await buildCycleNavigatorData(trace, { binCycleCount: 1 });
        if (data?.topDown) {
            const start = Math.max(0, firstCycle - 8),
                slots: number[][] = [];
            for (let cycle = start; cycle <= lastCycle; cycle++) {
                const s = getCycleNavigatorTopDown(data, cycle, cycle + 1);
                if (!s) throw new Error(`Top-down sample missing at ${cycle}.`);
                const row = [
                    s.retiringSlots,
                    s.squashedSlots,
                    s.recoveryBubbleSlots,
                    s.frontendBound,
                    s.backendBound,
                    s.unresolvedSlots
                ];
                if (
                    row.some((n) => !Number.isFinite(n) || n < 0) ||
                    row.reduce((sum, n) => sum + n, 0) !== s.totalSlots
                )
                    throw new Error(`Top-down slots do not sum at ${cycle}.`);
                slots.push(row);
            }
            topDown = {
                method: "Konata Top-down-like",
                firstCycle: start,
                windowCycles: 8,
                observationTimes: topDownObservationTimes(
                    data.topDown,
                    allOps,
                    start,
                    lastCycle,
                    slots,
                    effectiveEndCycle
                ),
                categories: ["retiring", "squashed", "recovery", "frontend", "backend", "unresolved"],
                slots,
                allocationWidth: data.topDown.allocationWidth,
                allocationStage: data.topDown.allocationStage.label,
                executionStage: data.topDown.executionStage.label,
                transitionCoverage: data.topDown.transitionCoverage
            };
            for (const cycle of [firstCycle, Math.floor((firstCycle + lastCycle) / 2), lastCycle]) {
                const s = getCycleNavigatorTopDown(data, cycle - 7, cycle + 1)!;
                const actual = slots
                    .slice(cycle - 7 - start, cycle - start + 1)
                    .reduce((sum, row) => sum.map((v, i) => v + row[i]), [0, 0, 0, 0, 0, 0]);
                const expected = [
                    s.retiringSlots,
                    s.squashedSlots,
                    s.recoveryBubbleSlots,
                    s.frontendBound,
                    s.backendBound,
                    s.unresolvedSlots
                ];
                if (actual.some((v, i) => v !== expected[i]))
                    throw new Error(`Embedded Top-down window differs from the analysis at ${cycle}.`);
            }
        }
    }
    let evidence = null;
    if (source.includeEvidence) {
        evidence = source.fileName.endsWith("/rsd/mshr.log")
            ? readRsdRegisterEvidence(source.fileName, firstCycle, lastCycle, new Set(sampleOps.map((o) => o.id)))
            : {
                  scheduling: buildSchedulingEvidence(allOps, sampleOps, {
                      allocation: (op) => observations.get(op.id)?.allocationCycle ?? null,
                      ready: (op) => memoryReadyCycles.get(op.id) ?? observations.get(op.id)?.completionCycle ?? null,
                      end: effectiveEndCycle
                  }),
                  registers: null
              };
    }
    if (source.includeEvidence && source.parser === "gem5") {
        evidence.registers = source.fileName.includes("/detailed/")
            ? readGem5Registers(source.fileName, allOps, firstCycle, lastCycle, source.prefixBytes)
            : configuredGem5Registers();
    }
    const sampledIDs = new Set(sampleOps.map((op) => op.id));
    const storeCompletions = getGem5StoreCompletions(source, allOps).filter(([id]) => sampledIDs.has(id));
    const sample = {
        key: source.key,
        label: source.label,
        fileName: source.displayName,
        parser: source.parser === "gem5" ? "gem5 O3PipeView" : "Kanata/Onikiri",
        machineOrder: source.machineOrder,
        sampledPrefix: source.zstdPrefix === true || source.prefixBytes !== undefined,
        sourceOps: trace.opCount,
        sourceCycles: trace.lastCycle + 1,
        firstCycle,
        lastCycle,
        initialCycle,
        ...(source.includeTopDown ? { topDown } : {}),
        ...(source.includeEvidence ? { evidence } : {}),
        ...(storeCompletions.length ? { storeCompletions } : {}),
        fetchWidth: Math.max(...fetchCounts.values()),
        retireWidth: Math.max(...retireCounts.values()),
        structure: {
            ...(explicitRsdStages
                ? {
                      registerRead: {
                          id: "register-read",
                          names: ["Is", "Rr"],
                          description: "Issue handoff, then recorded register read before X"
                      }
                  }
                : {}),
            detectionMethod,
            allocationLaneID: laneID,
            allocationStageNames: [...detected.allocationStage.stageNames],
            allocationWidth: detected.allocationStage.width,
            executionLaneID: detected.executionStage.laneID,
            executionStageNames: [...detected.executionStage.stageNames],
            transitionCoverage: detected.transitionCoverage,
            admissionStages: detected.admissionStages.map((stage) => ({ ...stage })),
            representativePath,
            frontNodes,
            executionNodes,
            memoryWait,
            completionNames,
            retireNames,
            queuePeak,
            queueCapacity: roundedCapacity(queuePeak, 16),
            robPeak,
            robCapacity: roundedCapacity(robPeak, 32)
        },
        ops: compactOps
    };
    trace.close();
    return sample;
}

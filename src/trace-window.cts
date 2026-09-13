"use strict";
// 解析済みの有界な命令集合を表示区間へ変換する。ファイル I/O と全体索引は呼出し側が所有する。
import type { Op } from "../vendor/konata-core/model";
import type { DetectedStageStructure } from "../vendor/konata-core/stage_structure_detector";
import replayModel = require("./replay-model.cts");
import memoryModel = require("./memory.cts");
const { StageStructureDetector } = require("../vendor/konata-core/browser.cjs") as Pick<
    typeof import("../vendor/konata-core/stage_structure_detector"),
    "StageStructureDetector"
>;
type Trace = replayModel.Trace;
type CompactOperation = Trace["ops"][number];
type Range = { name: string; start: number; end: number };
type Source = { name: string; parser: "onikiri" | "gem5"; opCount: number; lastCycle: number };
type Options = {
    ops: readonly Readonly<Op>[];
    firstCycle: number;
    lastCycle: number;
    source: Source;
    laneNames?: readonly string[];
};
const limits = { operations: 16384, stages: 131072, cycles: 512, active: 512, queue: 128, rob: 224, width: 32 };

function finiteCycle(value: number, label: string) {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || value < 0)
        throw new Error(`${label} is not a supported cycle: ${value}`);
}
function unfinished(op: Readonly<Op>) {
    return op.eof || (!op.retired && !op.flush);
}
function rangesOf(op: Readonly<Op>, lane: number, observedEnd: number, parser: Source["parser"]): Range[] {
    const ranges: Range[] = [];
    const stages = op.lanes[lane]?.stages ?? [];
    for (const stage of stages) {
        // gem5 Coreは未完了末尾のend=0もtick変換するため負値になる。
        // 終了の観測として扱わず、最後に記録された時刻まで開いたstageとして表示する。
        const openGem5 = parser === "gem5" && unfinished(op) && stage === stages.at(-1) && stage.endCycle < 0;
        const start = stage.startCycle,
            end = stage.endCycle === 0 || openGem5 ? Math.max(start, observedEnd) : stage.endCycle;
        finiteCycle(start, `Instruction #${op.id} stage start`);
        finiteCycle(end, `Instruction #${op.id} stage end`);
        if (end < start || start < (ranges.at(-1)?.start ?? op.fetchedCycle))
            throw new Error(`Instruction #${op.id} has unordered stage times`);
        if (!stage.name) throw new Error(`Instruction #${op.id} has an unnamed stage`);
        const previous = ranges.at(-1);
        if (previous?.name === stage.name && previous.end === start) previous.end = end;
        else ranges.push({ name: stage.name, start, end });
    }
    return ranges;
}
function peak(intervals: readonly (readonly [number, number])[]) {
    const events = intervals.flatMap(([start, end]) =>
        end > start
            ? [
                  [start, 1],
                  [end, -1]
              ]
            : []
    );
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0,
        maximum = 0;
    for (const [, change] of events) maximum = Math.max(maximum, (current += change));
    return maximum;
}
function width(times: readonly number[]) {
    const counts = new Map<number, number>();
    for (const time of times) counts.set(Math.floor(time), (counts.get(Math.floor(time)) ?? 0) + 1);
    return Math.max(1, ...counts.values());
}
function capacity(occupancy: number, minimum: number, maximum: number, label: string) {
    const result = Math.max(minimum, Math.ceil(occupancy / 8) * 8);
    if (result > maximum)
        throw new Error(
            `${label} requires ${result} entries; this view supports ${maximum}. Select a smaller interval.`
        );
    return result;
}

function detect(ops: readonly Readonly<Op>[]): DetectedStageStructure | null {
    const detector = new StageStructureDetector();
    for (const op of ops) detector.observe(op);
    const measurement = detector.finish();
    if (!measurement) return null;
    for (const op of ops) measurement.observe(op);
    return measurement.finish();
}
function primaryLane(ops: readonly Readonly<Op>[]) {
    const counts = new Map<number, number>();
    for (const op of ops)
        op.lanes.forEach((lane, index) => counts.set(index, (counts.get(index) ?? 0) + (lane?.stages.length ?? 0)));
    return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}

// ファイル名から ISA、周波数、物理レジスタ数を決めず、記録内の tick/cycle 対応だけを使う。
function storeCompletions(ops: readonly Readonly<Op>[], parser: Source["parser"]): [number, number][] {
    if (parser !== "gem5") return [];
    const calibration = ops.flatMap((op) => {
        const match = /^Fetched Tick: (\d+)$/m.exec(op.labelDetail);
        return match ? [{ tick: Number(match[1]), cycle: op.fetchedCycle }] : [];
    });
    const first = calibration[0],
        second = calibration.find((entry) => entry.cycle !== first?.cycle);
    if (!first || !second) return [];
    const period = (second.tick - first.tick) / (second.cycle - first.cycle),
        cycleAt = (tick: number) => first.cycle + (tick - first.tick) / period;
    if (
        !Number.isFinite(period) ||
        period <= 0 ||
        calibration.some(({ tick, cycle }) => !Number.isSafeInteger(tick) || Math.abs(cycleAt(tick) - cycle) > 1e-6)
    )
        return [];
    return ops.flatMap((op) => {
        if (!op.retired || op.flush || unfinished(op) || memoryModel.instructionType(op.labelName) !== "store")
            return [];
        const match = /^Store Tick: (\d+)$/m.exec(op.labelDetail),
            tick = match ? Number(match[1]) : 0,
            cycle = cycleAt(tick);
        return Number.isSafeInteger(tick) && tick > 0 && Number.isFinite(cycle) && cycle >= op.fetchedCycle
            ? [[op.id, cycle] as [number, number]]
            : [];
    });
}

function toTraceWindow({ ops: input, firstCycle, lastCycle, source, laneNames = [] }: Options): Trace {
    finiteCycle(firstCycle, "Window start");
    finiteCycle(lastCycle, "Window end");
    finiteCycle(source.lastCycle, "Trace end");
    if (
        !Number.isInteger(firstCycle) ||
        !Number.isInteger(lastCycle) ||
        lastCycle < firstCycle ||
        lastCycle > source.lastCycle
    )
        throw new Error("The selected interval is outside the observed trace");
    if (lastCycle - firstCycle + 1 > limits.cycles || input.length > limits.operations)
        throw new Error(`Select at most ${limits.cycles} cycles and ${limits.operations} instructions`);
    if (!Number.isSafeInteger(source.opCount) || source.opCount < 0)
        throw new Error("The source instruction count is invalid");
    let stageCount = 0;
    for (const op of input) {
        for (const lane of op.lanes) stageCount += lane?.stages.length ?? 0;
        if (stageCount > limits.stages) throw new Error(`Select at most ${limits.stages} stage events`);
    }
    const ops = Array.from(input).sort((a, b) => a.id - b.id),
        ids = new Set<number>(),
        threads = new Set<number>();
    for (const op of ops) {
        if (!Number.isSafeInteger(op.id) || op.id < 0 || ids.has(op.id))
            throw new Error("Instruction IDs are invalid or duplicated");
        ids.add(op.id);
        threads.add(op.tid);
        finiteCycle(op.fetchedCycle, `Instruction #${op.id} fetch`);
        if (!unfinished(op)) {
            finiteCycle(op.retiredCycle, `Instruction #${op.id} end`);
            if (op.retiredCycle < op.fetchedCycle) throw new Error(`Instruction #${op.id} ends before fetch`);
        }
    }
    if (threads.size > 1) throw new Error("Select one hardware thread before building the flow view");
    const detected = detect(ops),
        lane = detected?.allocationStage.laneID ?? primaryLane(ops),
        ranges = new Map(
            ops.map((op) => [
                op.id,
                rangesOf(op, lane, unfinished(op) ? source.lastCycle : op.retiredCycle, source.parser)
            ])
        );
    if (ops.some((op) => !ranges.get(op.id)!.length))
        throw new Error(`Some instructions have no recorded stages in lane ${laneNames[lane] ?? lane}`);
    const allocationNames = new Set(detected?.allocationStage.stageNames ?? []),
        executionNames = new Set(detected?.executionStage.stageNames ?? []),
        observations = new Map(ops.map((op) => [op.id, detected?.observe(op)]));
    const frontNames = new Set<string>();
    for (const op of ops) {
        const allocation = observations.get(op.id)?.allocationCycle;
        for (const range of ranges.get(op.id)!)
            if (allocation == null || range.start < allocation) frontNames.add(range.name);
    }
    const names = [...frontNames],
        frontNodes = Array.from({ length: Math.min(6, Math.max(1, names.length)) }, (_, index) => ({
            id: `front-${index}`,
            names: [] as string[]
        }));
    names.forEach((name, index) => frontNodes[Math.floor((index * frontNodes.length) / names.length)].names.push(name));
    if (!names.length) frontNodes[0].names.push("STAGES");
    const frontByName = new Map(frontNodes.flatMap((node) => node.names.map((name) => [name, node.id]))),
        completionNames = new Set<string>();
    for (const op of ops) {
        const completion = observations.get(op.id)?.completionCycle,
            range = ranges.get(op.id)!.find((range) => range.start === completion);
        if (range) completionNames.add(range.name);
    }
    const compactOps: CompactOperation[] = ops.map((op) => {
        const observed = observations.get(op.id),
            allocation = observed?.allocationCycle ?? null,
            issue = observed?.issueCycle ?? null,
            kind = memoryModel.instructionType(op.labelName),
            execution = `exec-${kind === "load" || kind === "store" || kind === "atomic" ? "memory" : kind}`,
            path = ranges.get(op.id)!;
        // 再登場する ready stage は最後の実行後だけを完了とする。EOF は結果を補完しない。
        const lastExecution = path.findLast((range) => executionNames.has(range.name)),
            completed =
                lastExecution &&
                path.findLast((range) => range.start >= lastExecution.end && completionNames.has(range.name));
        const response =
            source.parser === "gem5" && ["load", "store", "atomic"].includes(kind)
                ? path.findLast((range) => range.name === "Mc")
                : undefined;
        const completion = issue == null ? null : (response?.start ?? completed?.start ?? null);
        const stages: CompactOperation[6] = path.map((range, index) => {
            let node = frontByName.get(range.name) ?? frontNodes.at(-1)!.id;
            if (allocation != null && range.start >= allocation) {
                if (issue == null || range.start < issue) node = "issue";
                else if (completion == null || range.start < completion) node = execution;
                else node = !unfinished(op) && op.retired && !op.flush && index === path.length - 1 ? "commit" : "rob";
            }
            return [range.name, node, range.start, range.end];
        });
        return [
            op.id,
            op.rid,
            op.fetchedCycle,
            unfinished(op) ? source.lastCycle : op.retiredCycle,
            op.flush && !unfinished(op) ? 1 : 0,
            op.labelName || `(g:${op.gid})`,
            stages,
            allocation,
            issue,
            completion,
            execution,
            null,
            unfinished(op)
        ];
    });
    const endOf = (op: CompactOperation) => (op[12] ? Infinity : op[3]),
        activePeak = peak(compactOps.map((op) => [op[2], endOf(op)])),
        queuePeak = peak(
            compactOps.flatMap((op) =>
                op[7] == null ? [] : [[op[7], Math.min(op[8] ?? endOf(op), endOf(op))] as const]
            )
        ),
        robPeak = peak(compactOps.flatMap((op) => (op[7] == null ? [] : [[op[7], endOf(op)] as const])));
    if (activePeak > limits.active)
        throw new Error(
            `The interval contains ${activePeak} simultaneous instructions; this view supports ${limits.active}`
        );
    const queueCapacity = capacity(queuePeak, 16, limits.queue, "Scheduler"),
        robCapacity = capacity(robPeak, 32, limits.rob, "ROB"),
        fetchWidth = width(compactOps.map((op) => op[2])),
        retireWidth = width(compactOps.filter((op) => !op[4] && !op[12]).map((op) => op[3]));
    const byID = new Map(compactOps.map((op) => [op[0], op])),
        executionKinds = new Set(compactOps.map((op) => op[10].slice(5) as "integer" | "memory" | "branch"));
    if (!executionKinds.size) executionKinds.add("integer");
    const executionNodes = [...executionKinds].map((kind) => ({
        id: `exec-${kind}`,
        kind,
        names: [...executionNames],
        pipeCount: width(compactOps.filter((op) => op[10] === `exec-${kind}` && op[8] != null).map((op) => op[8]!))
    }));
    if (Math.max(fetchWidth, retireWidth, ...executionNodes.map((node) => node.pipeCount)) > limits.width)
        throw new Error(`The interval needs more than ${limits.width} simultaneous routes; choose a smaller interval`);
    // FIFO が成立しない入力は時間や命令を改変せず、表示できない理由を呼出し側へ返す。
    try {
        replayModel.createRobReplay(
            compactOps.map((op) => ({ id: op[0], allocation: op[7], end: endOf(op), flush: !!op[4] })),
            robCapacity
        );
    } catch (error) {
        throw new Error(
            `This interval cannot be represented by one FIFO: ${error instanceof Error ? error.message : error}`
        );
    }
    const dependencies = ops
        .filter((op) => op.prods.length > 0)
        .map((op) => ({
            id: op.id,
            dependencies: op.prods.map((producer) => ({
                id: producer.opID,
                ready: byID.get(producer.opID)?.[9] ?? null
            }))
        }));
    const inferred = detected
        ? "Stage roles inferred from the selected instructions"
        : "Generic serial stage view; allocation, execution and completion roles are unobserved";
    const incompleteCount = compactOps.filter((op) => op[12]).length;
    return {
        key: "local-file",
        label: source.name,
        fileName: source.name,
        parser: source.parser === "gem5" ? "gem5 O3PipeView" : "Kanata/Onikiri",
        machineOrder: detected ? "out-of-order" : "unknown",
        firstCycle,
        lastCycle,
        initialCycle: firstCycle,
        fetchWidth,
        retireWidth,
        ops: compactOps,
        storeCompletions: storeCompletions(ops, source.parser),
        structure: {
            queueCapacity,
            robCapacity,
            allocationWidth: detected?.allocationStage.width ?? 1,
            frontNodes,
            executionNodes,
            memoryWait: null
        },
        ...(dependencies.length
            ? {
                  evidence: {
                      scheduling: {
                          kind: "recorded",
                          label: "Recorded dependency edges; missing producers remain unknown",
                          ops: dependencies
                      },
                      registers: null
                  }
              }
            : {}),
        topDown: null,
        demo: {
            events: [],
            bookmarks: [],
            screenshotCycle: firstCycle,
            theme: ops.length ? "LOCAL TRACE" : "IDLE INTERVAL",
            provenance: {
                simulator: source.parser === "gem5" ? "gem5" : "Not recorded",
                workload: "Not recorded",
                processor: "Not recorded",
                configuration: "Not recorded",
                workloadKnown: false,
                note: `${inferred}. Display capacities and routes are inferred from observed concurrency, not hardware specifications. ${incompleteCount} instruction outcomes are unobserved. Source: ${source.opCount} instructions, through cycle ${source.lastCycle}.`
            }
        }
    };
}
const traceWindow = { toTraceWindow, limits, isUnfinished: unfinished };
export = traceWindow;

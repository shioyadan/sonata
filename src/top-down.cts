"use strict";
// Coreの構造観測を選択区間へ集計する。絶対cycleやファイル全体に比例する配列を作らない。
import type { Op } from "../vendor/konata-core/model";
import type { DetectedStageStructure } from "../vendor/konata-core/stage_structure_detector";
import type replay = require("./replay-model.cts");
type Structure = Pick<DetectedStageStructure, "allocationStage" | "executionStage" | "transitionCoverage" | "observe">;
type Recovery = { minimumCycles: number; sampleCount: number };
type Analysis = { structure: Structure; allocationWidth: number; minimumRecoveryCycles: number | null };
type RecoveryWindow = { start: number; end: number; notice: number };
type Options = {
    ops: readonly Readonly<Op>[];
    firstCycle: number;
    lastCycle: number;
    structure: Structure | null;
    endCycle?: (op: Readonly<Op>) => number;
    recovery?: Recovery | null;
    laneNames?: readonly string[];
};
const limits = { cycles: 512, history: 8, operations: 16384, stages: 131072, width: 32, recoverySamples: 10 };
function control(label: string) {
    const disassembly = label.slice(label.indexOf(":") + 1).trim();
    const mnemonic = (disassembly.split(/\s+/, 1)[0] ?? "").toLowerCase();
    if (/\bwrip\b/i.test(disassembly)) return /^(?:j|call|ret)/.test(mnemonic);
    return /^(?:j|jr|jal|jalr|call|ret|b|bl|blr|br|bx|bal|beq|bne|beqz|bnez|blt|bge|bltu|bgeu|bgez|bltz|blez|bgtz|cbz|cbnz|tbz|tbnz)(?:\..*)?$/.test(
        mnemonic.replace(/^c[._]/, "")
    );
}
function recoveryWindows(
    ops: readonly Readonly<Op>[],
    structure: Structure,
    endCycle: (op: Readonly<Op>) => number,
    contiguous: boolean
) {
    const previous = new Map<number, number>();
    const pending = new Map<number, { start: number; notice: number }>();
    const lastIds = new Map<number, number>();
    const windows: RecoveryWindow[] = [];
    for (const op of ops) {
        if (contiguous && op.id !== (lastIds.get(op.tid) ?? op.id - 1) + 1) {
            previous.delete(op.tid);
            pending.delete(op.tid);
        }
        lastIds.set(op.tid, op.id);
        const observation = structure.observe(op);
        const predecessor = previous.get(op.tid);
        if (op.flush && predecessor !== undefined) pending.set(op.tid, { start: predecessor, notice: endCycle(op) });
        if (!op.flush && pending.has(op.tid)) {
            const recovery = pending.get(op.tid)!;
            pending.delete(op.tid);
            if (
                op.retired &&
                !op.eof &&
                observation.allocationCycle !== null &&
                observation.allocationCycle >= recovery.start
            )
                windows.push({ ...recovery, end: observation.allocationCycle });
        }
        previous.delete(op.tid);
        if (
            !op.flush &&
            !op.eof &&
            op.retired &&
            observation.allocationCycle !== null &&
            observation.completionCycle !== null &&
            observation.completionCycle > observation.allocationCycle &&
            control(op.labelName)
        )
            previous.set(op.tid, observation.completionCycle);
    }
    return windows;
}
function boundedOps(ops: readonly Readonly<Op>[]) {
    if (ops.length > limits.operations) return false;
    let stages = 0;
    for (const op of ops) {
        for (const lane of op.lanes) stages += lane?.stages.length ?? 0;
        if (stages > limits.stages) return false;
    }
    return true;
}
// 不連続な標本の隙間を分岐回復とみなさない。10例未満の最短値は採用しない。
function recoveryModel(ops: readonly Readonly<Op>[], structure: Structure | null): Recovery | null {
    if (!structure || !boundedOps(ops)) return null;
    const histogram = new Map<number, number>();
    for (const window of recoveryWindows(
        [...ops].sort((a, b) => a.id - b.id),
        structure,
        (op) => op.retiredCycle,
        true
    )) {
        const latency = Math.floor(window.end - window.start);
        histogram.set(latency, (histogram.get(latency) ?? 0) + 1);
    }
    let result: Recovery | null = null;
    for (const [minimumCycles, sampleCount] of histogram)
        if (sampleCount >= limits.recoverySamples && (!result || minimumCycles < result.minimumCycles))
            result = { minimumCycles, sampleCount };
    return result;
}
// 抽出器の従来API。事後的な分類に、再生時に結果が判明する時刻を追加する。
function topDownObservationTimes(
    analysis: Analysis,
    ops: readonly Readonly<Op>[],
    first: number,
    last: number,
    slots: number[][],
    endCycle: (op: Readonly<Op>) => number,
    contiguous = false
): NonNullable<replay.TopDown["observationTimes"]> {
    const outcomes: [number, number, 0 | 1][] = [];
    const allocated = new Map<number, number>();
    const backend = new Set<number>();
    for (const op of ops) {
        const o = analysis.structure.observe(op);
        const cycle = o.allocationCycle === null ? null : Math.floor(o.allocationCycle);
        if (
            cycle !== null &&
            cycle >= first &&
            cycle <= last &&
            (allocated.get(cycle) ?? 0) < analysis.allocationWidth
        ) {
            allocated.set(cycle, (allocated.get(cycle) ?? 0) + 1);
            if (!op.eof && (op.retired || op.flush))
                outcomes.push([cycle, op.retired ? op.retiredCycle : endCycle(op), op.retired ? 0 : 1]);
        }
        if (o.admissionStallStartCycle !== null && o.admissionStallEndCycle !== null)
            for (
                let c = Math.max(first, Math.floor(o.admissionStallStartCycle));
                c < Math.min(last + 1, Math.ceil(o.admissionStallEndCycle));
                c++
            )
                backend.add(c);
    }
    const outcomeCounts = slots.map(() => [0, 0]);
    for (const [cycle, , category] of outcomes) outcomeCounts[cycle - first][category]++;
    for (let i = 0; i < slots.length; i++)
        for (const category of [0, 1])
            if (outcomeCounts[i][category] !== slots[i][category])
                throw new Error(`Top-down outcome evidence disagrees at ${first + i}, class ${category}`);
    const recoveries = recoveryWindows(ops, analysis.structure, endCycle, contiguous).map((window) => ({
        ...window,
        end: Math.min(window.end, window.start + (analysis.minimumRecoveryCycles ?? 0))
    }));
    const recoveryNotices = slots.map((row, i): [number, 3 | 4] | null => {
        if (!row[2]) return null;
        const cycle = first + i;
        const matching = recoveries.filter(
            (window) => cycle >= Math.floor(window.start) && cycle < Math.ceil(window.end)
        );
        if (!matching.length) throw new Error(`Top-down recovery has no observation time at ${cycle}`);
        return [Math.min(...matching.map((window) => window.notice)), backend.has(cycle) ? 4 : 3];
    });
    return { outcomes, recoveryNotices };
}
function buildTopDownWindow(options: Options) {
    const { firstCycle, lastCycle, structure, laneNames = [], endCycle = (op) => op.retiredCycle } = options;
    if (
        !Number.isSafeInteger(firstCycle) ||
        firstCycle < 0 ||
        !Number.isSafeInteger(lastCycle) ||
        lastCycle < firstCycle ||
        lastCycle - firstCycle + 1 > limits.cycles
    )
        throw new Error(`Top-down requires a window of at most ${limits.cycles} integer cycles`);
    if (!structure || !boundedOps(options.ops)) return null;
    const width = structure.allocationStage.width;
    if (!Number.isSafeInteger(width) || width < 1 || width > limits.width) return null;
    const first = Math.max(0, firstCycle - limits.history);
    const ops = [...options.ops].sort((a, b) => a.id - b.id);
    const classes = new Uint8Array((lastCycle - first + 1) * width);
    classes.fill(3);
    const allocated = (value: number) => value === 0 || value === 1 || value === 5;
    function mark(start: number, end: number, category: number) {
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        for (let cycle = Math.max(first, Math.floor(start)); cycle < Math.min(lastCycle + 1, Math.ceil(end)); cycle++)
            for (let index = (cycle - first) * width; index < (cycle - first + 1) * width; index++)
                if (!allocated(classes[index]) && (category !== 4 || classes[index] === 3)) classes[index] = category;
    }
    for (const op of ops) {
        const observation = structure.observe(op);
        if (observation.admissionStallStartCycle !== null && observation.admissionStallEndCycle !== null)
            mark(observation.admissionStallStartCycle, observation.admissionStallEndCycle, 4);
        if (observation.allocationCycle === null || !Number.isFinite(observation.allocationCycle)) continue;
        const index = (Math.floor(observation.allocationCycle) - first) * width;
        if (index < 0 || index + width > classes.length) continue;
        for (let slot = index; slot < index + width; slot++)
            if (!allocated(classes[slot])) {
                classes[slot] = op.eof ? 5 : op.retired ? 0 : op.flush ? 1 : 5;
                break;
            }
    }
    const recovery = options.recovery === undefined ? recoveryModel(ops, structure) : options.recovery;
    const minimumRecoveryCycles =
        recovery &&
        Number.isSafeInteger(recovery.minimumCycles) &&
        recovery.minimumCycles >= 0 &&
        recovery.sampleCount >= limits.recoverySamples
            ? recovery.minimumCycles
            : null;
    if (minimumRecoveryCycles !== null)
        for (const window of recoveryWindows(ops, structure, endCycle, true))
            mark(window.start, Math.min(window.end, window.start + minimumRecoveryCycles), 2);
    const slots = Array.from({ length: lastCycle - first + 1 }, (_, cycle) => {
        const row = [0, 0, 0, 0, 0, 0];
        for (let index = cycle * width; index < (cycle + 1) * width; index++) row[classes[index]]++;
        return row;
    });
    const stageLabel = (stage: Structure["executionStage"]) => {
        const label = stage.stageNames.join("/");
        return laneNames.length > 1 && laneNames[stage.laneID] ? `${laneNames[stage.laneID]}/${label}` : label;
    };
    return {
        method: "Konata Top-down-like (bounded window)",
        firstCycle: first,
        windowCycles: limits.history,
        slots,
        observationTimes: topDownObservationTimes(
            { structure, allocationWidth: width, minimumRecoveryCycles },
            ops,
            first,
            lastCycle,
            slots,
            endCycle,
            true
        ),
        categories: ["retiring", "squashed", "recovery", "frontend", "backend", "unresolved"],
        allocationWidth: width,
        allocationStage: stageLabel(structure.allocationStage),
        executionStage: stageLabel(structure.executionStage),
        transitionCoverage: structure.transitionCoverage,
        minimumRecoveryCycles,
        minimumRecoverySampleCount: minimumRecoveryCycles === null ? 0 : recovery!.sampleCount
    };
}
declare namespace topDown {
    export type WindowOptions = Options;
    export type RecoveryModel = Recovery;
}
const topDown = { buildTopDownWindow, recoveryModel, topDownObservationTimes, limits };
export = topDown;

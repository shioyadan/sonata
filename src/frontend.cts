"use strict";
// Fetchサイクルの束を各前段へ引き継ぎ、記録とは独立した表示行を準備する。
import geometry = require("./geometry.cts");
import type replayModel = require("./replay-model.cts");

const advanceCycles = 0.45;
type Interval = { start: number; end: number };
type Bundle = { fetchCycle: number; ids: number[]; ranges: Map<string, Interval> };
type MotionEvent = { time: number; slope: number; pending: number; settled: number };
type MotionPoint = { time: number; value: number; slope: number };

function upperBound<T>(values: T[], time: number, key: (value: T) => number) {
    let lo = 0,
        hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (key(values[mid]) <= time) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function ramp(events: MotionEvent[], start: number, end: number, amount: number) {
    if (!Number.isFinite(start)) return;
    const slope = amount / (end - start);
    events.push({ time: start, slope, pending: 1, settled: 0 });
    events.push({ time: end, slope: -slope, pending: -1, settled: amount });
}

function timeline(events: MotionEvent[]) {
    const points: MotionPoint[] = [];
    let value = 0,
        slope = 0,
        pending = 0,
        settled = 0,
        previous = events[0]?.time ?? 0;
    for (const event of events.sort((a, b) => a.time - b.time)) {
        value += slope * (event.time - previous);
        slope += event.slope;
        pending += event.pending;
        settled += event.settled;
        // 補間のない区間は整数へ戻し、長い無活動区間でも丸め誤差を蓄積しない。
        if (!pending) {
            value = settled;
            slope = 0;
        }
        const point = { time: event.time, value, slope };
        if (points.at(-1)?.time === event.time) points[points.length - 1] = point;
        else points.push(point);
        previous = event.time;
    }
    return points;
}

function valueAt(points: MotionPoint[], time: number) {
    const point = points[upperBound(points, time, (point) => point.time) - 1];
    return point ? point.value + point.slope * (time - point.time) : 0;
}

// 古い束の予約行数をFenwick木の時刻索引で合計する。描画中に全束を走査しない。
class QueueRows {
    readonly capacity: number;
    private readonly sums: MotionPoint[][];
    constructor(bundles: Bundle[], node: string) {
        const events: MotionEvent[][] = Array.from({ length: bundles.length + 1 }, () => []),
            all: MotionEvent[] = [];
        for (const [index, bundle] of bundles.entries()) {
            const range = bundle.ranges.get(node);
            if (!range || range.end <= range.start) continue;
            const motion: MotionEvent[] = [];
            // 古い束の到着が遅い記録でも、到着するまでに一行分を空けておく。
            ramp(motion, range.start - advanceCycles, range.start, 1);
            ramp(motion, range.end, range.end + advanceCycles, -1);
            all.push(...motion);
            for (let i = index + 1; i < events.length; i += i & -i) events[i].push(...motion);
        }
        this.sums = events.map(timeline);
        this.capacity = timeline(all).reduce((maximum, point) => Math.max(maximum, Math.ceil(point.value - 1e-9)), 1);
    }
    before(index: number, time: number) {
        let row = 0;
        for (let i = index; i > 0; i -= i & -i) row += valueAt(this.sums[i], time);
        return Math.max(0, row);
    }
}

class FrontendLayout {
    readonly lanes: number;
    readonly stages = new Map<string, { capacity: number }>();
    readonly groups: { fetchCycle: number; ids: number[] }[];
    private readonly bundles: Bundle[];
    private readonly locations = new Map<number, { group: number; lane: number }>();
    private readonly queues = new Map<string, QueueRows>();

    constructor(
        ops: readonly replayModel.Operation[],
        trace: Pick<replayModel.Trace, "fetchWidth" | "structure">,
        continuity?: { at: number; frontend: FrontendLayout }
    ) {
        const grouped = new Map<number, { ids: Set<number>; ranges: Map<string, Interval> }>();
        const ensure = (fetchCycle: number) => {
            if (!grouped.has(fetchCycle)) grouped.set(fetchCycle, { ids: new Set(), ranges: new Map() });
            return grouped.get(fetchCycle)!;
        };
        const reserve = (ranges: Map<string, Interval>, node: string, start: number, end: number) => {
            if (end <= start) return;
            const old = ranges.get(node);
            ranges.set(node, { start: Math.min(start, old?.start ?? start), end: Math.max(end, old?.end ?? end) });
        };
        for (const op of ops) {
            const group = ensure(Math.floor(op.fetch));
            group.ids.add(op.id);
            for (const [index, stage] of op.stages.entries()) {
                if (!stage.node.startsWith("front-")) continue;
                const next = op.stages[index + 1];
                reserve(
                    group.ranges,
                    stage.node,
                    stage.start,
                    Math.min(op.end, next ? next.start + geometry.stageTransition(next) : stage.end)
                );
            }
        }
        if (continuity) {
            for (const old of continuity.frontend.bundles) {
                const group = grouped.get(old.fetchCycle);
                if (group) {
                    // 窓外へ出た同じ束の先頭命令を忘れず、残る命令の横位置を維持する。
                    for (const id of old.ids) group.ids.add(id);
                    for (const [node, range] of old.ranges)
                        if (range.end <= continuity.at && range.end + advanceCycles > continuity.at)
                            reserve(group.ranges, node, range.start, range.end);
                } else {
                    // 退出直後の窓切替でも前詰めの途中を保つ。生存記録の補完には使わない。
                    const fading = [...old.ranges].filter(
                        ([, range]) => range.end <= continuity.at && range.end + advanceCycles > continuity.at
                    );
                    if (fading.length) {
                        const carried = ensure(old.fetchCycle);
                        for (const id of old.ids) carried.ids.add(id);
                        for (const [node, range] of fading) carried.ranges.set(node, range);
                    }
                }
            }
        }
        this.bundles = [...grouped]
            .sort(([a], [b]) => a - b)
            .map(([fetchCycle, group]) => ({
                fetchCycle,
                ids: [...group.ids].sort((a, b) => a - b),
                ranges: group.ranges
            }));
        this.groups = this.bundles.map(({ fetchCycle, ids }) => ({ fetchCycle, ids }));
        this.lanes = this.groups.reduce(
            (maximum, group) => Math.max(maximum, group.ids.length),
            Math.max(1, trace.fetchWidth, continuity?.frontend.lanes ?? 1)
        );
        for (const [group, bundle] of this.bundles.entries())
            for (const [lane, id] of bundle.ids.entries()) this.locations.set(id, { group, lane });
        const nodes = new Set([
            ...trace.structure.frontNodes.map((node) => node.id),
            ...this.bundles.flatMap((bundle) => [...bundle.ranges.keys()])
        ]);
        for (const node of nodes) {
            const queue = new QueueRows(this.bundles, node);
            this.queues.set(node, queue);
            this.stages.set(node, {
                capacity: Math.max(queue.capacity, continuity?.frontend.stages.get(node)?.capacity ?? 1)
            });
        }
    }

    position(id: number, node: string, time: number): { row: number; lane: number } | null {
        const place = this.locations.get(id),
            queue = this.queues.get(node);
        if (!place || !queue) return null;
        const range = this.bundles[place.group].ranges.get(node);
        if (!range) return null;
        // 次段への経路が退場元を参照するときも、最後に保持した位置を返す。
        const at = Math.max(range.start, Math.min(time, range.end));
        return { row: queue.before(place.group, at), lane: place.lane };
    }
}

function prepareFrontend(
    ops: readonly replayModel.Operation[],
    trace: Pick<replayModel.Trace, "fetchWidth" | "structure">,
    continuity?: { at: number; frontend: FrontendLayout }
) {
    return new FrontendLayout(ops, trace, continuity);
}

export = { prepareFrontend };

"use strict";
// Fetchサイクルの束を各前段へ引き継ぎ、記録とは独立した表示行を準備する。
import geometry = require("./geometry.cts");
import type replayModel = require("./replay-model.cts");

const advanceCycles = 0.45;
type Interval = { start: number; end: number };
type Bundle = { fetchCycle: number; ids: number[]; ranges: Map<string, Interval> };
type FetchReservation = Interval & { fetchCycle: number; exits: Map<number, number> };
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
    readonly fetchNode: string | null;
    readonly fetchCapacity = 4;
    readonly stages = new Map<string, { capacity: number }>();
    readonly groups: { fetchCycle: number; ids: number[] }[];
    private readonly bundles: Bundle[];
    private readonly locations = new Map<number, { group: number; lane: number }>();
    private readonly queues = new Map<string, QueueRows>();
    private readonly fetchReservations = new Map<number, FetchReservation>();
    private readonly admissions = new Map<number, Interval>();
    private readonly passages = new Map<number, { index: number; count: number }>();
    private readonly passageGroups = new Map<number, number[]>();
    private readonly waiting: { id: number; start: number; end: number }[] = [];
    private readonly waitingEnds: number[] = [];
    private readonly waitingStarts: number[] = [];

    constructor(
        ops: readonly replayModel.Operation[],
        trace: Pick<replayModel.Trace, "fetchWidth" | "structure">,
        continuity?: { at: number; frontend: FrontendLayout }
    ) {
        this.fetchNode = trace.structure.frontNodes.find((node) => node.names.includes("F"))?.id ?? null;
        const grouped = new Map<number, { ids: Set<number>; ranges: Map<string, Interval> }>();
        const ensure = (fetchCycle: number) => {
            if (!grouped.has(fetchCycle)) grouped.set(fetchCycle, { ids: new Set(), ranges: new Map() });
            return grouped.get(fetchCycle)!;
        };
        const reserve = (ranges: Map<string, Interval>, node: string, start: number, end: number) => {
            if (end < start || (end === start && node !== this.fetchNode)) return;
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
                    stage.node === this.fetchNode
                        ? Math.min(op.end, stage.end, next?.start ?? Infinity)
                        : Math.min(op.end, next ? next.start + geometry.stageTransition(next) : stage.end)
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
        this.prepareFetch(ops, continuity);
        for (const node of nodes) {
            if (node === this.fetchNode) {
                this.stages.set(node, { capacity: this.fetchCapacity });
                continue;
            }
            const queue = new QueueRows(this.bundles, node);
            this.queues.set(node, queue);
            this.stages.set(node, {
                capacity: Math.max(queue.capacity, continuity?.frontend.stages.get(node)?.capacity ?? 1)
            });
        }
    }

    private prepareFetch(ops: readonly replayModel.Operation[], continuity?: { at: number; frontend: FrontendLayout }) {
        if (!this.fetchNode) return;
        let active: FetchReservation[] = [],
            previousStart = -Infinity;
        for (const bundle of this.bundles) {
            const range = bundle.ranges.get(this.fetchNode);
            if (!range) continue;
            const old = continuity?.frontend.fetchReservations.get(bundle.fetchCycle);
            let start = Math.max(range.start, previousStart);
            // 同じ観測の窓交換では、入口からの移動を再開しない。
            if (old && Number.isFinite(old.start) && old.start >= start) start = old.start;
            let occupants = active.filter((row) => row.end > start);
            if (occupants.length >= this.fetchCapacity) {
                start = Math.max(start, Math.min(...occupants.map((row) => row.end)));
                occupants = active.filter((row) => row.end > start);
            }
            const exits = new Map(old?.start === start ? old.exits : []);
            for (const row of occupants) exits.set(row.fetchCycle, row.end);
            const reservation = {
                fetchCycle: bundle.fetchCycle,
                start,
                end: range.end,
                // 新しい束には退出済みの補間を予約しない。残る束だけ滑らかに前詰めする。
                exits
            };
            this.fetchReservations.set(bundle.fetchCycle, reservation);
            if (start <= range.end) {
                previousStart = start;
                active = occupants;
                if (start < range.end) active.push(reservation);
            }
        }
        for (const op of ops) {
            const index = op.stages.findIndex((stage) => stage.node === this.fetchNode);
            if (index < 0) continue;
            const stage = op.stages[index],
                end = Math.min(op.end, stage.end, op.stages[index + 1]?.start ?? Infinity),
                reservation = this.fetchReservations.get(Math.floor(op.fetch))!;
            const start = Math.max(stage.start, reservation.start);
            // F内で取消まで入口にいた命令は入れない。後段での将来の取消は参照しない。
            const canceledHere = op.flush && end === op.end && (op.stages[index + 1]?.start ?? Infinity) >= end;
            const admitted = canceledHere && start >= end ? Infinity : Math.min(start, end);
            this.admissions.set(op.id, { start: admitted, end });
            if (admitted > stage.start)
                this.waiting.push({ id: op.id, start: stage.start, end: Math.min(admitted, end) });
        }
        const handoffs = new Map<number, { ids: number[]; groups: Set<number>; instant: boolean }>();
        for (const op of ops) {
            const range = this.admissions.get(op.id),
                index = op.stages.findIndex((stage) => stage.node === this.fetchNode),
                next = op.stages[index + 1];
            // F内で終わった命令を混ぜず、その時刻に次段へ進む全束を順に渡す。
            if (!range || !Number.isFinite(range.start) || next?.start !== range.end || next.start >= op.end) continue;
            if (!handoffs.has(range.end)) handoffs.set(range.end, { ids: [], groups: new Set(), instant: false });
            const handoff = handoffs.get(range.end)!;
            handoff.ids.push(op.id);
            handoff.groups.add(Math.floor(op.fetch));
            handoff.instant ||= range.start === range.end;
        }
        for (const [time, handoff] of handoffs) {
            const old = continuity?.frontend.passageGroups.get(time);
            if (!handoff.instant && !old) continue;
            const groups = [...new Set([...(old ?? []), ...handoff.groups])].sort((a, b) => a - b);
            this.passageGroups.set(time, groups);
            const indices = new Map(groups.map((cycle, index) => [cycle, index]));
            for (const id of handoff.ids) {
                const cycle = this.bundles[this.locations.get(id)!.group].fetchCycle;
                this.passages.set(id, { index: indices.get(cycle)!, count: groups.length });
            }
        }
        this.waiting.sort((a, b) => a.id - b.id);
        let end = -Infinity,
            start = Infinity;
        for (const entry of this.waiting) {
            end = Math.max(end, entry.end);
            this.waitingEnds.push(end);
        }
        for (let index = this.waiting.length - 1; index >= 0; index--) {
            start = Math.min(start, this.waiting[index].start);
            this.waitingStarts[index] = start;
        }
    }

    admission(id: number): Interval | null {
        return this.admissions.get(id) ?? null;
    }

    // 0滞在通過が混ざる時刻では、既存F束の退出も含む順番で追い越しを防ぐ。
    passage(id: number): { index: number; count: number } | null {
        return this.passages.get(id) ?? null;
    }

    pending(time: number, limit = Infinity): number[] {
        const ids: number[] = [];
        // 解放済みの接頭部と、まだFetchされていない接尾部を時刻索引で飛ばす。
        for (let index = upperBound(this.waitingEnds, time, (end) => end); index < this.waiting.length; index++) {
            if (ids.length >= limit || this.waitingStarts[index] > time) break;
            const entry = this.waiting[index];
            if (entry.start <= time && time < entry.end) ids.push(entry.id);
        }
        return ids;
    }

    position(id: number, node: string, time: number): { row: number; lane: number } | null {
        const place = this.locations.get(id);
        if (!place) return null;
        if (node === this.fetchNode) {
            const passage = this.passages.get(id),
                admission = this.admissions.get(id);
            if (passage && admission?.start === admission?.end)
                return { row: passage.index % this.fetchCapacity, lane: place.lane };
            const reservation = this.fetchReservations.get(this.bundles[place.group].fetchCycle);
            if (!reservation) return null;
            const at = Math.min(
                reservation.end,
                Number.isFinite(reservation.start) ? Math.max(time, reservation.start) : time
            );
            let row = 0;
            for (const end of reservation.exits.values())
                row += at <= end ? 1 : at >= end + advanceCycles ? 0 : 1 - (at - end) / advanceCycles;
            return { row: Math.min(this.fetchCapacity - 1, row), lane: place.lane };
        }
        const queue = this.queues.get(node);
        if (!queue) return null;
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

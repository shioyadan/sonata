"use strict";
// 保存順に依存しない全体の観測と、Core検出用の有界なID標本を保持する。
import type { Op } from "../vendor/konata-core/model";
import windows = require("./trace-window.cts");
import memory = require("./memory.cts");
type Parser = "onikiri" | "gem5";
const limits = {
    threads: 64,
    stages: 128,
    stageNameChars: 256,
    transitions: 512,
    perThreadSamples: 256,
    totalSamples: 4096,
    sampleStages: 65536
};
interface ThreadState {
    names: Map<number, Set<string>>;
    edges: Map<number, Map<string, Set<string>>>;
    kinds: Set<"integer" | "fp" | "memory" | "branch">;
    memoryKinds: Set<"load" | "store" | "atomic">;
    minimum: { load: number | null; store: number | null };
    first: Set<number>;
    sampled: Map<number, number>;
    worst: number;
    count: number;
    stages: number;
    transitions: number;
    dirty: boolean;
    profile?: windows.StructureProfile;
}
function rank(id: number) {
    let value = (id >>> 0) ^ Math.imul(Math.floor(id / 0x100000000), 0x9e3779b9);
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
}
function createProfiles() {
    const threads = new Map<number, ThreadState>();
    let samples = 0;
    function observe(op: Readonly<Op>, parser: Parser, firstWrite: boolean) {
        let state = threads.get(op.tid);
        if (!state) {
            if (threads.size >= limits.threads)
                throw new Error(`Structure inference supports at most ${limits.threads} hardware threads`);
            state = {
                names: new Map(),
                edges: new Map(),
                kinds: new Set(),
                memoryKinds: new Set(),
                minimum: { load: null, store: null },
                first: new Set(),
                sampled: new Map(),
                worst: Infinity,
                count: 0,
                stages: 0,
                transitions: 0,
                dirty: true
            };
            threads.set(op.tid, state);
        }
        if (firstWrite) state.count++;
        for (let lane = 0; lane < op.lanes.length; lane++) {
            let previous: string | undefined;
            for (const stage of op.lanes[lane]?.stages ?? []) {
                let names = state.names.get(lane);
                if (!names) state.names.set(lane, (names = new Set()));
                if (!names.has(stage.name)) {
                    if (stage.name.length > limits.stageNameChars)
                        throw new Error(
                            `Structure inference supports stage names up to ${limits.stageNameChars} characters`
                        );
                    if (++state.stages > limits.stages)
                        throw new Error(`Structure inference supports at most ${limits.stages} stage names per thread`);
                    names.add(stage.name);
                    state.dirty = true;
                }
                if (previous && previous !== stage.name) {
                    let edges = state.edges.get(lane);
                    if (!edges) state.edges.set(lane, (edges = new Map()));
                    let after = edges.get(previous);
                    if (!after) edges.set(previous, (after = new Set()));
                    if (!after.has(stage.name)) {
                        if (++state.transitions > limits.transitions)
                            throw new Error(
                                `Structure inference supports at most ${limits.transitions} stage transitions per thread`
                            );
                        after.add(stage.name);
                        state.dirty = true;
                    }
                }
                previous = stage.name;
            }
        }
        {
            const kind = memory.instructionType(op.labelName ?? "");
            const execution = kind === "load" || kind === "store" || kind === "atomic" ? "memory" : kind;
            if (!state.kinds.has(execution)) {
                state.kinds.add(execution);
                state.dirty = true;
            }
            if (
                ["load", "store", "atomic"].includes(kind) &&
                !state.memoryKinds.has(kind as "load" | "store" | "atomic")
            ) {
                state.memoryKinds.add(kind as "load" | "store" | "atomic");
                state.dirty = true;
            }
            if ((kind === "load" || kind === "store") && op.retired && !op.flush && !windows.isUnfinished(op)) {
                for (const [laneID, lane] of op.lanes.entries()) {
                    const stages = lane?.stages ?? [];
                    if (
                        stages.some(
                            (stage, index) =>
                                !Number.isFinite(stage.startCycle) ||
                                !Number.isFinite(stage.endCycle) ||
                                stage.startCycle < (stages[index - 1]?.startCycle ?? op.fetchedCycle) ||
                                (stage.endCycle === 0 ? op.retiredCycle : stage.endCycle) < stage.startCycle
                        )
                    )
                        continue;
                    const onikiri = windows.stageProtocol([op], laneID, parser) === "onikiri";
                    const issue = stages.find((stage) => stage.name === (onikiri ? "I" : "Is"));
                    const executionNames =
                        parser === "gem5" ? ["Is"] : onikiri ? ["X", "Xbm", "Xlm", "Xam", "Xlu"] : ["X", "Mt", "Ma"];
                    const last = stages.findLastIndex((stage) => executionNames.includes(stage.name));
                    if (!issue || last < 0) continue;
                    const executionEnd = stages[last].endCycle;
                    const completion =
                        parser === "gem5"
                            ? (stages.findLast((stage) => stage.name === "Mc") ??
                              stages.findLast((stage) => stage.name === "Cm" && stage.startCycle >= executionEnd))
                            : stages.findLast(
                                  (stage) => stage.name === (onikiri ? "Wb" : "Rw") && stage.startCycle >= executionEnd
                              );
                    if (!completion) continue;
                    let first = last;
                    while (first > 0 && executionNames.includes(stages[first - 1].name)) first--;
                    const start = stages[first].startCycle,
                        end =
                            onikiri && kind === "load"
                                ? (stages.slice(first, last + 1).find((stage) => ["Xlm", "Xlu"].includes(stage.name))
                                      ?.startCycle ?? completion.startCycle)
                                : completion.startCycle,
                        duration = end - start;
                    if (
                        !Number.isFinite(duration) ||
                        duration <= 0 ||
                        start < issue.startCycle ||
                        end > op.retiredCycle
                    )
                        continue;
                    if (duration < (state.minimum[kind] ?? Infinity)) {
                        state.minimum[kind] = duration;
                        state.dirty = true;
                    }
                }
            }
        }
        if (state.first.has(op.id) || state.sampled.has(op.id)) state.dirty = true;
        if (!firstWrite) return;
        // 初期に保存された標本を残し、残りはIDのhashが小さい標本で全体を覆う。
        // 命令の保存順・巨大なIDの穴・再書込みによって全Op配列を作らない。
        const half = limits.perThreadSamples / 2;
        if (state.first.size < half && samples < limits.totalSamples) {
            state.first.add(op.id);
            samples++;
            state.dirty = true;
        } else if (state.sampled.size < half && samples < limits.totalSamples) {
            state.sampled.set(op.id, rank(op.id));
            state.worst = Math.max(...state.sampled.values());
            samples++;
            state.dirty = true;
        } else if (state.sampled.size && rank(op.id) < state.worst) {
            const worst = [...state.sampled].find(([, score]) => score === state.worst)!;
            state.sampled.delete(worst[0]);
            state.sampled.set(op.id, rank(op.id));
            state.worst = Math.max(...state.sampled.values());
            state.dirty = true;
        }
    }
    function get(thread: number, read: (id: number) => Readonly<Op> | null | undefined, source: windows.Source) {
        const state = threads.get(thread);
        if (!state) throw new Error("No structure observations exist for this hardware thread");
        if (!state.dirty && state.profile) {
            state.profile.observed = state.count;
            return state.profile;
        }
        // Coreの検出とMeasurementは同じID昇順の標本を2回読む必要がある。
        const ids = [...state.first, ...state.sampled.keys()].sort((a, b) => a - b);
        const ops: Readonly<Op>[] = [];
        let stages = 0;
        for (const id of ids) {
            const op = read(id);
            if (!op || op.tid !== thread) continue;
            const count = op.lanes.reduce((n, lane) => n + (lane?.stages.length ?? 0), 0);
            if (stages + count > limits.sampleStages) continue;
            stages += count;
            ops.push(op);
        }
        state.profile = windows.buildProfile(
            {
                ops,
                names: state.names,
                edges: state.edges,
                kinds: state.kinds,
                memoryKinds: state.memoryKinds,
                memoryMinimum: state.minimum,
                observed: state.count,
                sampleLimit: limits.perThreadSamples,
                source
            },
            state.profile
        );
        state.dirty = false;
        return state.profile;
    }
    function clear() {
        threads.clear();
        samples = 0;
    }
    return {
        observe,
        get,
        clear,
        get sampleCount() {
            return samples;
        }
    };
}
export = { createProfiles, limits };

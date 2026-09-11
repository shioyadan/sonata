"use strict";
// ロード／ストアの分類と、観測したアクセス時間を表示区間へ分ける。
import type replayModel = require("./replay-model.cts");
type Operation = replayModel.Operation;
type Stage = replayModel.Stage;
type AccessKind = "load" | "store";

function instructionType(label: string): "integer" | "branch" | AccessKind | "atomic" {
    const mnemonic = label
        .replace(/^(?:0x)?[0-9a-f]+:\s*/i, "")
        .trim()
        .replace(/^[A-Z0-9_]+\s*:\s*/, "")
        .split(/\s+/)[0]
        .toLowerCase();
    if (/^(?:amo|cas|swp|ldadd|ldclr|ldeor|ldset|ldsmax|ldsmin|ldumax|ldumin)/.test(mnemonic)) return "atomic";
    if (/^(?:stxr|stlxr|sc\.)/.test(mnemonic)) return "atomic";
    if (/^(?:ld|load)/.test(mnemonic) || /^(?:lb|lbu|lh|lhu|lw|lwu|flw|fld)$/.test(mnemonic)) return "load";
    if (/^(?:st|store)/.test(mnemonic) || /^(?:sb|sh|sw|sd|fsw|fsd)$/.test(mnemonic)) return "store";
    if (
        /^(?:b(?:\.[a-z]+|eqz?|nez?|gez?|ltz?|gtz?|lez?|ltu|geu)?|bl|blr|blx|br|bx|cbz|cbnz|tbz|tbnz|j|jal|jalr|jr|call|tail|ret|wripi?)$/.test(
            mnemonic
        )
    )
        return "branch";
    return "integer";
}

function prepareMemory(ops: Operation[], trace: replayModel.Trace) {
    const accesses = new Map<Operation, { start: number; end: number; stages: Stage[] }[]>();
    const minimum: Record<AccessKind, number | null> = { load: null, store: null };
    for (const op of ops) {
        if (!op.memoryKind || op.memoryKind === "atomic") continue;
        const kind = op.memoryKind;
        const groups: { start: number; end: number; stages: Stage[] }[] = [];
        for (let i = 0; i < op.stages.length; i++) {
            const first = op.stages[i];
            if (first.node !== `exec-${kind}`) continue;
            const stages = [first];
            while (i + 1 < op.stages.length && [first.node, "memory-wait"].includes(op.stages[i + 1].node)) {
                stages.push(op.stages[++i]);
            }
            const end = Math.min(stages.at(-1)!.end, op.completion ?? op.end, op.end);
            if (end > first.start) groups.push({ start: first.start, end, stages });
        }
        accesses.set(op, groups);
        // 後半だけの区間・squash・最終readyへ至らない再試行は最短値の根拠にしない。
        for (const group of groups) {
            if (op.flush || op.completion == null || group.end !== op.completion || op.completion > op.end) continue;
            if (
                op.issue == null ||
                group.start < op.issue ||
                !group.stages[0].names.some((n) => n === "Is" || n === "X")
            )
                continue;
            const duration = group.end - group.start;
            minimum[kind] = Math.min(minimum[kind] ?? Infinity, duration);
        }
    }
    for (const [op, groups] of accesses) {
        const base = minimum[op.memoryKind as AccessKind];
        if (op.memoryKind === "store")
            for (const stage of op.stages)
                if (stage.node === "memory-wait") {
                    stage.node = "exec-store";
                    stage.waiting = true;
                }
        if (base == null) continue;
        for (const group of groups) {
            const duration = Math.min(base, group.end - group.start);
            const first = group.stages[0];
            const replacement: Stage[] = [
                {
                    ...first,
                    end: group.start + duration,
                    entryCycles: Math.min(duration, base * 0.22),
                    names: [
                        ...new Set(
                            group.stages.filter((s) => s.node === first.node && !s.waiting).flatMap((s) => s.names)
                        )
                    ]
                }
            ];
            if (group.end > group.start + duration + 1e-9) {
                replacement.push({
                    node: op.memoryKind === "load" ? "memory-wait" : "exec-store",
                    ...(op.memoryKind === "store" ? { waiting: true } : {}),
                    start: group.start + duration,
                    end: group.end,
                    names: [...new Set(group.stages.flatMap((s) => s.names))]
                });
            }
            const index = op.stages.indexOf(first);
            op.stages.splice(index, group.stages.length, ...replacement);
        }
    }
    // 待機位置は物理SQの番号ではなく、同時に見せる命令へ割り当てる表示位置。
    const waits = ops.flatMap((op) =>
        op.stages.filter((s) => s.node === "memory-wait" || s.waiting).map((stage) => ({ op, stage }))
    );
    const ends: Record<string, number[]> = { "memory-wait": [], "exec-store": [] };
    for (const { op, stage } of waits.sort((a, b) => a.stage.start - b.stage.start || a.op.id - b.op.id)) {
        const slots = ends[stage.node];
        let slot = slots.findIndex((end) => end <= stage.start);
        if (slot < 0) slot = slots.length;
        stage.displaySlot = slot;
        slots[slot] = Math.min(op.end, stage.end + 0.82);
    }
    const sharedPipes = trace.structure.executionNodes.find((n) => n.kind === "memory")?.pipeCount ?? 0;
    const loadCount = ops.filter((op) => op.memoryKind === "load").length;
    const storeCount = ops.filter((op) => op.memoryKind === "store").length;
    const budget = Math.max(loadCount && storeCount ? 2 : 1, sharedPipes);
    const storePipes = storeCount
        ? loadCount
            ? Math.max(1, Math.min(budget - 1, Math.round((budget * storeCount) / (loadCount + storeCount))))
            : budget
        : 0;
    const loadPipes = loadCount ? budget - storePipes : 0;
    const executionNodes = trace.structure.executionNodes
        .filter((n) => n.kind !== "memory")
        .map((n) => ({ ...n, latency: 1, sharedPipes: 0 }));
    for (const kind of ["load", "store"] as const) {
        const pipeCount = kind === "load" ? loadPipes : storePipes;
        if (pipeCount)
            executionNodes.push({
                id: `exec-${kind}`,
                kind: "memory",
                names: [],
                pipeCount,
                latency: minimum[kind] ?? 1,
                sharedPipes
            });
    }
    if (ops.some((op) => op.memoryKind === "atomic"))
        executionNodes.push({ id: "exec-memory", kind: "memory", names: [], pipeCount: 1, latency: 1, sharedPipes });
    // 同時に発行されたアクセスは別の表示管路へ分ける。物理ポートIDの推定ではない。
    for (const node of executionNodes.filter((n) => n.kind === "memory")) {
        const routed = ops
            .filter((op) => op.execution === node.id)
            .sort(
                (a, b) =>
                    (a.stages.find((s) => s.node === node.id)?.start ?? Infinity) -
                        (b.stages.find((s) => s.node === node.id)?.start ?? Infinity) || a.id - b.id
            );
        routed.forEach((op, index) => {
            op.pipeLane = index % node.pipeCount;
        });
    }
    const storeTimes = new Map(trace.storeCompletions ?? []);
    const pendingStores = ops
        .flatMap((op) => {
            const complete = storeTimes.get(op.id);
            return op.memoryKind === "store" && !op.flush && complete != null && complete > op.end
                ? [{ op, id: op.id, start: op.end, end: complete }]
                : [];
        })
        .sort((a, b) => a.start - b.start || a.id - b.id);
    return {
        minimum,
        sharedPipes,
        executionNodes,
        pendingStores,
        waitSlots: {
            load: ends["memory-wait"].length,
            store: ends["exec-store"].length
        }
    };
}
const memory = { instructionType, prepareMemory };
export = memory;

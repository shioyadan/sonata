"use strict";
// 命令種別の分類と、観測したメモリアクセス時間を表示区間へ分ける。
import type replayModel = require("./replay-model.cts");
type Operation = replayModel.Operation;
type Stage = replayModel.Stage;
type AccessKind = "load" | "store";

function instructionType(label: string): "integer" | "fp" | "branch" | AccessKind | "atomic" {
    // OnikiriのPC・出力レジスタ付き表記だけを剥がし、任意の説明文を命令へ読み替えない。
    const onikiri = label
        .trim()
        .match(/^(?:0x)?[0-9a-f]+\s+(?:(?:r\d+|\(r\d+(?:,\s*r\d+)*\))\s*=\s*)?([a-z][a-z0-9_.]*)\([^()]*\)$/i);
    const assembly = label
        .replace(/^(?:0x)?[0-9a-f]+:\s*/i, "")
        .trim()
        .replace(/^[A-Z0-9_]+\s*:\s*/, "");
    const mnemonic = (onikiri?.[1] ?? assembly.split(/\s+/)[0]).toLowerCase();
    const operands = onikiri
        ? ""
        : assembly
              .slice(mnemonic.length)
              .replace(/;.*$|\/\/.*$/, "")
              .trim()
              .toLowerCase();
    if (/^(?:amo|cas|swp|ldadd|ldclr|ldeor|ldset|ldsmax|ldsmin|ldumax|ldumin)/.test(mnemonic)) return "atomic";
    if (/^(?:stxr|stlxr|sc\.)/.test(mnemonic)) return "atomic";
    if (
        /^(?:ld|load)/.test(mnemonic) ||
        /^(?:lb|lbu|lh|lhu|lw|lwu|flh|flw|fld|flq|fld[stl]|fild[slq]?|vldr|vld[1-4](?:\.[a-z0-9]+)?)$/.test(mnemonic) ||
        /^vl(?:e\d+|se\d+|[ou]xei\d+|seg\d+e\d+|sseg\d+e\d+|[ou]xseg\d+ei\d+)\.v$/.test(mnemonic)
    )
        return "load";
    if (
        /^(?:st|store)/.test(mnemonic) ||
        /^(?:sb|sh|sw|sd|fsh|fsw|fsd|fsq|fstp?[stl]?|fistp?[slq]?|vstr|vst[1-4](?:\.[a-z0-9]+)?)$/.test(mnemonic) ||
        /^vs(?:e\d+|se\d+|[ou]xei\d+|seg\d+e\d+|sseg\d+e\d+|[ou]xseg\d+ei\d+)\.v$/.test(mnemonic)
    )
        return "store";
    if (
        /^(?:b(?:\.[a-z]+|eqz?|nez?|gez?|ltz?|gtz?|lez?|ltu|geu)?|bl|blr|blx|br|bx|cbz|cbnz|tbz|tbnz|j|jal|jalr|jr|call|tail|ret|wripi?)$/.test(
            mnemonic
        )
    )
        return "branch";

    const vectorOperand =
        /(?:^|[\s,({])%?(?:[xyz]mm\d+|mm\d+|[vqd]\d+(?:\.[0-9]*[bhsd])?|z\d+(?:\.[bhsd])?)(?=$|[\s,.)}\[])/.test(
            operands
        );
    // FP/SIMDもメモリアクセスは同じ管路へ置く。x86のmoveは記載されたオペランド順を使う。
    const vectorMove =
        /^(?:v?mov(?:ap[sd]|up[sd]|[hl]p[sd]|s[sd]|dq[au](?:8|16|32|64)?|[dq])|v?lddqu)$/.test(mnemonic) &&
        (!/^(?:movsd|movq|movd)$/.test(mnemonic) || vectorOperand);
    if (vectorMove && /\[|\(%/.test(operands)) {
        const att = operands.includes("%");
        const firstIsRegister = /^%?(?:[xyz]mm\d+|mm\d+|[er]?[abcd]x|r\d+[dwb]?)(?:\s|,|$)/.test(operands);
        return firstIsRegister === att ? "store" : "load";
    }

    // 既知の命令名だけを判定する。fenceや未知のv接頭辞からISA・演算種別を推測しない。
    if (
        /^(?:f(?:add|sub|mul|mulx|div|sqrt|madd|msub|nmadd|nmsub|abs|neg|mov|mv|sgnj[nx]?|min(?:nm)?|max(?:nm)?|cmp[e]?|cm(?:eq|ge|gt|le|lt)|ccmp[e]?|csel|class|eq|lt|le|recpe|recps|rsqrte|rsqrts|cvt(?:[amnpz][su]|l2?|n2?)?|rint[ainpmxz]?|round(?:nx)?)|[su]cvtf)(?:\.[a-z0-9]+)*$/.test(
            mnemonic
        ) ||
        /^(?:f(?:addp|subp|subr|subrp|mulp|divp|divr|divrp|chs|ld1|ldz|ldpi|ldl2e|ldl2t|ldlg2|ldln2|com|comp|compp|comi|comip|ucom|ucomp|ucompp|ucomi|ucomip|xch|sin|cos|sincos|ptan|patan|yl2x|yl2xp1|2xm1|scale|prem|prem1|rndint)|(?:add|sub|mul|div|sqrt|cmp|cvt|mov)fp)$/.test(
            mnemonic
        ) ||
        /^(?:v?f(?:madd|msub|nmadd|nmsub|maddsub|msubadd)(?:132|213|231)?[ps][sd]|v?(?:add|sub|mul|div|min|max|sqrt|rsqrt|rcp|hadd|hsub|addsub|and|andn|or|xor|cmp|comi|ucomi|round)[ps][sd]|v?cvt(?:t)?(?:[ps][sd]|[su]?dq|[su]?qq|si)2(?:[ps][sd]|[su]?dq|[su]?qq|si))$/.test(
            mnemonic
        ) ||
        vectorMove ||
        /^v(?:f?(?:add|sub|rsub|mul|div|rdiv|sqrt|min|max|madd|msub|nmadd|nmsub|macc|msac|nmacc|nmsac|sgnj[nx]?)|mla|mls|neg|abs|mov|mvn|and|orr|or|eor|xor|not|dup|ext|zip|uzp|trn|rev|shl|shr|sra|sll|srl|cvt|fcvt|fwcvt|fncvt|merge|fmerge)(?:\.[a-z0-9]+)+$/.test(
            mnemonic
        )
    )
        return "fp";

    // 整数と共通のNEON/SVE演算名やx86 packed演算は、明示されたvectorレジスタで確認する。
    if (
        vectorOperand &&
        /^(?:add|sub|mul|mla|mls|madd|msub|neg|abs|and|orr|eor|bic|bif|bit|bsl|not|mov|movi|mvni|dup|ins|ext|tbl|tbx|rev(?:16|32|64)?|zip[12]?|uzp[12]?|trn[12]?|[su]?(?:shl|shr|sra|shll|shrn|qadd|qsub|qxtn|xtl|mull|mlal|mlsl|dot)[2]?|[su]?max[pv]?|[su]?min[pv]?|add[vp]|cm(?:eq|ge|gt|hi|hs|le|lt)|v?(?:p(?:add|sub|mul|madd|and|andn|or|xor|shuf|sll|srl|sra|cmp|unpck|ack|mov|blend|erm)[a-z0-9]*|blend[a-z0-9]*|broadcast[a-z0-9]*|perm[a-z0-9]*|shuf[ps][sd]))$/.test(
            mnemonic
        )
    )
        return "fp";
    return "integer";
}

type MemoryOperation = Pick<
    Operation,
    "memoryKind" | "stages" | "flush" | "unfinished" | "completion" | "issue" | "end"
>;
function recordedWaitStart(stages: Stage[]) {
    // Onikiriが明示した応答待ちだけを使い、Cmなどから推定した待機と区別する。
    return stages.find(
        (stage) =>
            stage.node === "memory-wait" &&
            stage.names.length > 0 &&
            stage.names.every((name) => name === "Xlm" || name === "Xlu")
    )?.start;
}
function observeAccesses<T extends MemoryOperation>(ops: T[]) {
    const accesses = new Map<T, { start: number; end: number; stages: Stage[] }[]>();
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
            if (
                op.flush ||
                op.unfinished ||
                op.completion == null ||
                group.end !== op.completion ||
                op.completion > op.end
            )
                continue;
            if (
                op.issue == null ||
                group.start < op.issue ||
                !group.stages[0].names.some((n) => n === "Is" || n === "X")
            )
                continue;
            const duration = (recordedWaitStart(group.stages) ?? group.end) - group.start;
            if (duration > 0) minimum[kind] = Math.min(minimum[kind] ?? Infinity, duration);
        }
    }
    return { accesses, minimum };
}

// Coreで役割を確認した有界標本にも、表示時と同じアクセスの成立条件を適用する。
function observedMinimum(ops: replayModel.Trace["ops"]) {
    return observeAccesses(
        ops.map((op) => {
            const kind = instructionType(op[5]);
            const stages: Stage[] = [];
            for (const [name, sourceNode, start, end] of op[6]) {
                const node = sourceNode === "exec-memory" ? `exec-${kind}` : sourceNode;
                const previous = stages.at(-1);
                if (previous?.node === node) {
                    previous.end = Math.max(previous.end, end);
                    previous.names.push(name);
                } else stages.push({ names: [name], node, start, end });
            }
            return {
                memoryKind: kind === "load" || kind === "store" || kind === "atomic" ? kind : undefined,
                flush: !!op[4],
                unfinished: op[12],
                issue: op[8],
                completion: op[9],
                end: op[3],
                stages
            };
        })
    ).minimum;
}

function prepareMemory(ops: Operation[], trace: replayModel.Trace) {
    const { accesses, minimum } = observeAccesses(ops);
    const profile = trace.displayProfile;
    // 任意Fileは全体で観測した基準を使い、未観測の種別だけ局所の根拠で補う。
    for (const kind of ["load", "store"] as const) {
        const globalMinimum = profile?.memoryMinimum[kind];
        if (globalMinimum != null) minimum[kind] = globalMinimum;
    }
    for (const [op, groups] of accesses) {
        const base = minimum[op.memoryKind as AccessKind];
        if (op.memoryKind === "store") {
            for (const stage of op.stages) {
                if (stage.node === "memory-wait") stage.node = "rob";
            }
        }
        if (base == null) continue;
        for (const group of groups) {
            // 記録の段から明示した待機を、別区間の最短値で管路へ戻さない。
            const untilWait = recordedWaitStart(group.stages) ?? group.end;
            const duration = Math.min(base, untilWait - group.start);
            const first = group.stages[0];
            const replacement: Stage[] = [
                {
                    ...first,
                    end: group.start + duration,
                    entryCycles: Math.min(duration, base * 0.22),
                    names: [...new Set(group.stages.filter((s) => s.node === first.node).flatMap((s) => s.names))]
                }
            ];
            if (group.end > group.start + duration + 1e-9) {
                replacement.push({
                    // STORE は未完了のまま既存の ROB セルへ置き、記録された再発行時刻に実行へ戻す。
                    node: op.memoryKind === "load" ? "memory-wait" : "rob",
                    start: group.start + duration,
                    end: group.end,
                    names: [...new Set(group.stages.flatMap((s) => s.names))]
                });
            }
            const index = op.stages.indexOf(first);
            op.stages.splice(index, group.stages.length, ...replacement);
        }
    }
    // LOAD WAIT は同時に見せる命令の表示位置。STORE は既存の ROB スロットを使う。
    const waits = ops.flatMap((op) =>
        op.stages.filter((s) => s.node === "memory-wait").map((stage) => ({ op, stage }))
    );
    const ends: number[] = [];
    for (const { op, stage } of waits.sort((a, b) => a.stage.start - b.stage.start || a.op.id - b.op.id)) {
        let slot = ends.findIndex((end) => end <= stage.start);
        if (slot < 0) slot = ends.length;
        stage.displaySlot = slot;
        ends[slot] = Math.min(op.end, stage.end + 0.82);
    }
    const sharedPipes = trace.structure.executionNodes.find((n) => n.kind === "memory")?.pipeCount ?? 0;
    const loadCount = profile
        ? Number(profile.memoryKinds.includes("load"))
        : ops.filter((op) => op.memoryKind === "load").length;
    const storeCount = profile
        ? Number(profile.memoryKinds.includes("store"))
        : ops.filter((op) => op.memoryKind === "store").length;
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
    if (profile?.memoryKinds.includes("atomic") || ops.some((op) => op.memoryKind === "atomic"))
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
            load: ends.length
        }
    };
}
const memory = { instructionType, observedMinimum, prepareMemory };
export = memory;

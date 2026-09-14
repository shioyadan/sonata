"use strict";
// 記録時刻から再生状態を復元し、同梱デモを配置で使う構造へ準備する。
import geometry = require("./geometry.cts");
import memoryModel = require("./memory.cts");
const { stageTransition } = geometry;
const feedRows = 24,
    feedLead = 0.7;

// 入力記録と表示準備後の命令を区別し、未観測の時刻・値は null のまま扱う。
interface StageRange {
    node: string;
    start: number;
    end: number;
    names: string[];
    displaySlot?: number;
    entryCycles?: number;
}
interface Instruction {
    id: number;
    rid: number;
    index: number;
    pipeLane?: number;
    fetch: number;
    end: number;
    flush: boolean;
    unfinished?: boolean;
    label: string;
    stages: StageRange[];
    allocation: number | null;
    issue: number | null;
    completion: number | null;
    execution: string;
    kind: "integer" | "memory" | "branch";
    memoryKind?: "load" | "store" | "atomic";
    reads: ReadInterval[];
    sourceRegisters: RegisterSource[];
    issueSlot?: number;
    robSlot?: number;
    commitSlot?: number;
    feedText?: string;
}
type FeedInstruction = Pick<Instruction, "id" | "fetch" | "label" | "kind" | "feedText"> &
    Partial<Pick<Instruction, "end" | "flush">>;
type ReadInterval = { start: number; end: number; sources?: { physical: number; hex: string }[] };
type RegisterSource = { logical: number; physical: number; previous?: number };
type CompactStage = [name: string, node: string, start: number, end: number];
type CompactOperation = [
    id: number,
    rid: number,
    fetch: number,
    retired: number,
    flush: number,
    label: string,
    stages: CompactStage[],
    allocation: number | null,
    issue: number | null,
    completion: number | null,
    execution: string,
    flushCycle?: number | null,
    unfinished?: boolean
];
type Dependency = { id: number; ready: number | null; register?: string };
interface SchedulingEvidence {
    kind: string;
    label?: string;
    ops: { id: number; dependencies: Dependency[]; sources?: RegisterSource[] }[];
}
type RegisterEventBase = { cycle: number; physical: number; previous?: number };
type RegisterEvent = RegisterEventBase &
    (
        | { type: "map"; logical: number }
        | { type: "observe"; hex: string }
        | { type: "rename"; logical: number; id: number }
        | { type: "restore"; logical: number; id: number; previous: number }
        | { type: "write"; id: number; hex: string; logical?: number }
    );
type AllocationState = "allocated" | "free" | "unknown";
type AllocationEvent = { cycle: number; physical: number; state: Exclude<AllocationState, "unknown">; reason: string };
interface RegisterEvidence {
    origin?: string;
    rows: number[];
    constantRows?: number[];
    kind?: string;
    label?: string;
    capacity?: number;
    logicalNames?: Record<number, string>;
    logicalPrefix?: string;
    wordBits?: number;
    initial: { mapping: [number, number][]; values: [number, string][]; owners: [number, number][] };
    allocation?: {
        initial: [number, Exclude<AllocationState, "unknown">][];
        events: AllocationEvent[];
        kind?: string;
        label?: string;
    };
    events: RegisterEvent[];
    reads?: { id: number; cycle: number; physical: number; hex: string }[];
}
interface TopDownData {
    firstCycle: number;
    windowCycles: number;
    slots: number[][];
    method?: string;
    observationTimes?: {
        outcomes: [allocated: number, observed: number, outcome: 0 | 1][];
        recoveryNotices: ([time: number, category: 3 | 4] | null)[];
    };
}
type DemoEvent = {
    kind: "branch-mispredict" | "dcache-miss" | "icache-miss";
    id: number;
    cycle: number;
    endCycle?: number;
};
interface TraceData {
    key: string;
    firstCycle: number;
    lastCycle: number;
    fetchWidth: number;
    parser: string;
    ops: CompactOperation[];
    storeCompletions?: [number, number][];
    feedPreview?: Pick<FeedInstruction, "id" | "fetch" | "label" | "kind">[];
    // 現在窓の後に追加 fetch がないと確認できた末端。省略時は窓外を推測しない。
    emptyTailUntil?: number;
    displayProfile?: {
        memoryMinimum: { load: number | null; store: number | null };
        memoryKinds: ("load" | "store" | "atomic")[];
    };
    label: string;
    fileName: string;
    initialCycle: number;
    retireWidth: number;
    machineOrder: string;
    structure: {
        registerRead?: { id: string; names: string[]; description: string };
        queueCapacity: number;
        robCapacity: number;
        allocationWidth: number;
        frontNodes: { id: string; names: string[] }[];
        executionNodes: { id: string; kind: Instruction["kind"]; names: string[]; pipeCount: number }[];
        memoryWait: {
            id: string;
            waitStageNames: string[];
            completionStageNames: string[];
            observedOps: number;
            baseLatency: number | null;
        } | null;
    };
    demo: {
        events?: DemoEvent[];
        bookmarks: { cycle: number; label: string; type: string }[];
        screenshotCycle: number;
        theme: string;
        provenance: {
            simulator: string;
            workload: string;
            processor: string;
            configuration: string;
            note: string;
            workloadKnown: boolean;
        };
    };
    evidence?: { scheduling: SchedulingEvidence; registers?: RegisterEvidence | null };
    topDown?: TopDownData | null;
}
type RobOperation = Pick<Instruction, "id" | "end" | "flush"> & { allocation?: number | null };
type QueueEntry<T> = { op: T; slot: number };
type RobSnapshot<T> = {
    time: number;
    head: number;
    tail: number;
    entries: QueueEntry<T>[];
    retired: number[];
    squashed: number[];
};
type FeedGroup = { time: number; start: number; count: number };
type FeedState = {
    phase: "flow" | "notice" | "rewind" | "discard" | "refill";
    time: number | null;
    count: number;
    age: number;
    cursor: number;
    normalCursor: number;
    cancelAlpha: number;
    flowAlpha: number;
    dissolve: number;
    recovery: number;
    ids: number[];
};
type PlaybackOptions = { duration?: number; reducedMotion?: boolean };
type BoundCategory = "active" | "badSpeculation" | "frontend" | "backend" | "unresolved";
type DependencyOperation = Pick<Instruction, "id" | "end" | "allocation" | "issue" | "issueSlot">;
type DependencyCell = {
    consumer: number;
    producer: number;
    row: number | undefined;
    column: number | null;
    waiting: boolean;
    unknown: boolean;
    alpha: number;
    register: string | null;
};
type Broadcast = { producer: number; column: number | null; rows: (number | undefined)[]; progress: number };

function createRobReplay<T extends RobOperation>(
    ops: readonly T[],
    capacity: number,
    continuity?: { time: number; state: RobSnapshot<T> }
) {
    const events = new Map<number, { allocate: T[] }>(),
        slots = new Map<number, number>();
    const at = (time: number) => {
        if (!events.has(time)) events.set(time, { allocate: [] });
        return events.get(time)!;
    };
    for (const op of ops) {
        if (op.allocation == null || op.allocation >= op.end) continue;
        at(op.allocation).allocate.push(op);
        // EOF の未完了命令は終了イベントを持たず、有限の再生時刻で占有を保つ。
        if (Number.isFinite(op.end)) at(op.end);
    }
    let head = 0,
        tail = 0;
    const queue: QueueEntry<T>[] = [],
        snapshots: RobSnapshot<T>[] = [];
    for (const time of [...events.keys()].sort((a, b) => a - b)) {
        const retired: number[] = [],
            squashed: number[] = [];
        // 誤経路の命令を取り消し、キュー末尾の若い命令から巻き戻す。
        while (queue.length && queue.at(-1)!.op.flush && queue.at(-1)!.op.end <= time) {
            const entry = queue.pop()!;
            tail = entry.slot;
            squashed.push(entry.op.id);
        }
        // 完了時は ready を立てるだけとし、先頭はコミット時にだけ進める。
        while (queue.length && queue[0].op.end <= time && !queue[0].op.flush) {
            const entry = queue.shift()!;
            head = (entry.slot + 1) % capacity;
            retired.push(entry.op.id);
        }
        if (queue.some((entry) => entry.op.end <= time)) throw new Error(`Trace is not FIFO at cycle ${time}.`);
        if (!queue.length) head = tail;
        for (const op of events.get(time)!.allocate.sort((a, b) => a.id - b.id)) {
            if (queue.length >= capacity) throw new Error(`ROB capacity exceeded at cycle ${time}.`);
            if (queue.length && queue.at(-1)!.op.id >= op.id)
                throw new Error(`ROB allocation order regressed at cycle ${time}.`);
            slots.set(op.id, tail);
            queue.push({ op, slot: tail });
            tail = (tail + 1) % capacity;
        }
        snapshots.push({ time, head, tail, entries: [...queue], retired, squashed });
    }
    const empty: RobSnapshot<T> = { time: -Infinity, head: 0, tail: 0, entries: [], retired: [], squashed: [] };
    function stateAt(time: number) {
        let lo = 0,
            hi = snapshots.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (snapshots[mid].time <= time) lo = mid + 1;
            else hi = mid;
        }
        return snapshots[lo - 1] ?? empty;
    }
    if (continuity) {
        const previous = continuity.state;
        const next = stateAt(continuity.time);
        const oldSlots = new Map(previous.entries.map(({ op, slot }) => [op.id, slot]));
        const offsets = new Set(
            next.entries.flatMap(({ op, slot }) => {
                const old = oldSlots.get(op.id);
                return old === undefined ? [] : [(old - slot + capacity) % capacity];
            })
        );
        // 共通の生存命令が示す循環位相だけを合わせ、FIFO・終了イベントは変更しない。
        const offset =
            offsets.size === 1
                ? offsets.values().next().value!
                : !previous.entries.length && !next.entries.length
                  ? (previous.tail - next.tail + capacity) % capacity
                  : 0;
        if (offset) {
            const shift = (slot: number) => (slot + offset) % capacity;
            for (const [id, slot] of slots) slots.set(id, shift(slot));
            const entries = new Set(snapshots.flatMap((snapshot) => snapshot.entries));
            for (const entry of entries) entry.slot = shift(entry.slot);
            for (const snapshot of [empty, ...snapshots]) {
                snapshot.head = shift(snapshot.head);
                snapshot.tail = shift(snapshot.tail);
            }
        }
    }
    return { capacity, slots, snapshots, stateAt };
}

function memoryCompletions<
    T extends Pick<Instruction, "id" | "flush" | "completion" | "end"> & { stages: { node: string; start: number }[] }
>(ops: readonly T[]) {
    return ops
        .flatMap((op) => {
            if (op.flush || op.completion == null || op.completion > op.end) return [];
            const wait = op.stages.find((stage) => stage.node === "memory-wait" && stage.start < op.completion!) as
                | T["stages"][number]
                | undefined;
            return wait ? [{ id: op.id, time: op.completion, op, wait }] : [];
        })
        .sort((a, b) => a.time - b.time || a.id - b.id);
}

const codeRewindDuration = 4;
const smooth = (x: number) => {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
};
function flushPlaybackRate(
    time: number,
    events: readonly number[],
    { duration = codeRewindDuration, reducedMotion = false }: PlaybackOptions = {}
) {
    if (reducedMotion) return 1;
    let rate = 1;
    for (const event of events) {
        const age = time - event;
        if (age < -0.8 || age >= duration + 1.4) continue;
        const recoveryStart = Math.min(2.8, duration);
        const eventRate =
            age < 0
                ? 1 - 0.73 * smooth((age + 0.8) / 0.8)
                : 0.27 + 0.73 * smooth((age - recoveryStart) / (duration + 1.4 - recoveryStart));
        rate = Math.min(rate, eventRate);
    }
    return rate;
}
function advancePlayback(
    time: number,
    seconds: number,
    speed: number,
    events: readonly number[],
    options?: PlaybackOptions
) {
    // 速度の連続的な変化を小刻みに積分し、フレームレートが低い場合も
    // スローモーションの終了時に再生時計が大きく飛ばないようにする。
    const steps = Math.max(1, Math.ceil(seconds * 120)),
        dt = seconds / steps;
    for (let i = 0; i < steps; i++) {
        const midpoint = time + (dt * speed * flushPlaybackRate(time, events, options)) / 2;
        time += dt * speed * flushPlaybackRate(midpoint, events, options);
    }
    return time;
}

function createPlaybackGaps(trace: TraceData, busy: [number, number][]): (cycle: number) => number | null {
    const minimumGap = 16,
        before = 2,
        after = 6,
        gaps: [number, number][] = [],
        nextFetch = trace.feedPreview?.reduce((first, op) => Math.min(first, op.fetch), Infinity) ?? Infinity,
        until = Math.max(
            trace.lastCycle,
            trace.emptyTailUntil ?? trace.lastCycle,
            Number.isFinite(nextFetch) ? nextFetch : trace.lastCycle
        );
    const protect = (time: number) => busy.push([time, time]);
    for (const [, time] of trace.storeCompletions ?? []) protect(time);
    const registers = trace.evidence?.registers;
    for (const event of registers?.events ?? []) protect(event.cycle);
    for (const event of registers?.allocation?.events ?? []) protect(event.cycle);
    for (const read of registers?.reads ?? []) protect(read.cycle);
    // preview は確定した先頭までしか証明しない。未知の生存期間には進まない。
    if (Number.isFinite(nextFetch)) busy.push([nextFetch, Infinity]);
    busy.sort((a, b) => a[0] - b[0]);
    let cursor = trace.firstCycle;
    for (const [start, end] of busy) {
        const next = Math.min(start - before, until);
        if (next - cursor >= minimumGap) gaps.push([cursor, next]);
        cursor = Math.max(cursor, end + after);
        if (cursor >= until) break;
    }
    if (until - cursor >= minimumGap) gaps.push([cursor, until]);
    // 統合済みの候補だけを二分探索し、毎フレーム命令配列を走査しない。
    return (cycle) => {
        if (!Number.isFinite(cycle)) return null;
        let low = 0,
            high = gaps.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (gaps[middle][1] <= cycle) low = middle + 1;
            else high = middle;
        }
        const gap = gaps[low];
        return gap && cycle >= gap[0] && gap[1] - cycle >= minimumGap ? gap[1] : null;
    };
}

function createEmptyPlayback(trace: TraceData): (cycle: number) => number | null {
    const busy: [number, number][] = [],
        storeTimes = new Map(trace.storeCompletions ?? []);
    // ステージ間の停止も生存中として扱い、未完了命令の終端を窓の末尾で切らない。
    for (const op of trace.ops) {
        const end = op[12] ? Infinity : op[4] ? (op[11] ?? op[3]) : op[3];
        busy.push([op[2], Math.max(end, storeTimes.get(op[0]) ?? end)]);
    }
    for (const event of trace.demo.events ?? []) busy.push([event.cycle, event.endCycle ?? event.cycle]);
    return createPlaybackGaps(trace, busy);
}

function createWaitPlayback(trace: TraceData): (cycle: number) => number | null {
    const busy: [number, number][] = [],
        waiting: [number, number][] = [];
    const protect = (time: number | null | undefined) => {
        if (time != null && Number.isFinite(time)) busy.push([time, time]);
    };
    for (const op of trace.ops) {
        const fetch = op[2],
            end = op[4] ? (op[11] ?? op[3]) : op[3];
        // 終了やステージが不明な命令を、静止しているという理由で待機にしない。
        if (op[12] || !Number.isFinite(end) || end < fetch) {
            busy.push([fetch, Infinity]);
            continue;
        }
        if (
            !op[6].length ||
            op[6].some(([, , start, stop]) => !Number.isFinite(start) || !Number.isFinite(stop) || stop < start)
        ) {
            busy.push([fetch, end]);
            continue;
        }
        protect(fetch);
        protect(end);
        for (const time of [op[7], op[8], op[9]]) protect(time);
        let covered = fetch;
        for (const [, node, rawStart, rawEnd] of [...op[6]].sort((a, b) => a[2] - b[2])) {
            const start = Math.max(fetch, rawStart),
                stop = Math.min(end, rawEnd);
            if (stop < start) continue;
            if (start > covered) busy.push([covered, start]);
            protect(start);
            protect(stop);
            if (node.startsWith("front-") || node === "issue" || node === "rob" || node === "memory-wait") {
                waiting.push([start, stop]);
            } else {
                // 実行・レジスタ読出し・未知のノードは区間全体の移動を保つ。
                busy.push([start, stop]);
            }
            covered = Math.max(covered, stop);
        }
        if (covered < end) busy.push([covered, end]);
    }
    for (const op of trace.evidence?.scheduling?.ops ?? []) {
        for (const dependency of op.dependencies) protect(dependency.ready);
    }
    for (const event of trace.demo.events ?? []) {
        protect(event.cycle);
        protect(event.endCycle);
    }
    // 空白のスキップとは独立した設定なので、実在する待機区間の外は候補にしない。
    waiting.sort((a, b) => a[0] - b[0]);
    let cursor = -Infinity;
    for (const [start, end] of waiting) {
        if (start > cursor) busy.push([cursor, start]);
        cursor = Math.max(cursor, end);
    }
    busy.push([cursor, Infinity]);
    return createPlaybackGaps(trace, busy);
}

function measureTransfers(
    ops: readonly (Pick<Instruction, "id" | "fetch" | "allocation" | "end" | "flush"> & {
        stages: { node: string; start: number }[];
    })[],
    {
        firstCycle = -Infinity,
        lastCycle = Infinity,
        frontNodes = []
    }: { firstCycle?: number; lastCycle?: number; frontNodes?: { id: string }[] } = {}
) {
    const edges = new Map<string, { from: string; to: string; cycles: Map<number, Set<number>> }>(),
        lastFront = frontNodes.at(-1)?.id;
    function record(from: string, to: string, time: number, id: number) {
        if (!Number.isFinite(time) || time < firstCycle || time >= lastCycle + 1) return;
        const key = `${from}>${to}`,
            cycle = Math.floor(time);
        if (!edges.has(key)) edges.set(key, { from, to, cycles: new Map() });
        const edge = edges.get(key)!;
        if (!edge.cycles.has(cycle)) edge.cycles.set(cycle, new Set());
        edge.cycles.get(cycle)!.add(id);
    }
    for (const op of ops) {
        if (frontNodes.length) record("input", frontNodes[0].id, op.fetch, op.id);
        // スケジューラ滞在が 0 サイクルだとステージ区間に現れない場合がある。
        // その場合も allocation と実行開始から入口・出口の通過を数える。
        if (lastFront && op.allocation != null && op.allocation < op.end)
            record(lastFront, "issue", op.allocation, op.id);
        const admission = op.stages.find((stage) => stage.node === "register-read" || stage.node.startsWith("exec"));
        if (admission && op.allocation != null && op.allocation <= admission.start && admission.start < op.end)
            record("issue", admission.node, admission.start, op.id);
        let previous;
        for (const stage of op.stages) {
            if (stage.start < op.end) {
                if (previous && previous.node !== stage.node && stage.node !== "commit")
                    record(previous.node, stage.node, stage.start, op.id);
            }
            previous = stage;
        }
        if (!op.flush) {
            record("rob", "commit", op.end, op.id);
            record("commit", "output", op.end, op.id);
        }
    }
    return new Map(
        [...edges].map(([key, e]) => {
            const counts = [...e.cycles]
                .sort((a, b) => a[0] - b[0])
                .map(([cycle, ids]) => ({ cycle, count: ids.size }));
            return [
                key,
                {
                    from: e.from,
                    to: e.to,
                    peak: Math.max(...counts.map((c) => c.count)),
                    total: counts.reduce((sum, c) => sum + c.count, 0),
                    counts
                }
            ];
        })
    );
}
// このカーソルは流入する命令列の表示だけを制御し、プロセッサの時刻は巻き戻さない。
function createFeedReplay(
    orderedOps: readonly Pick<FeedInstruction, "id" | "fetch" | "flush" | "end">[],
    {
        firstCycle = -Infinity,
        lastCycle = Infinity,
        rows = 24,
        lead = 0.7
    }: { firstCycle?: number; lastCycle?: number; rows?: number; lead?: number } = {}
) {
    const groups: FeedGroup[] = [],
        squashes = new Map<number, { id: number; index: number }[]>();
    orderedOps.forEach((op, index) => {
        if (groups.at(-1)?.time === op.fetch) groups.at(-1)!.count++;
        else groups.push({ time: op.fetch, start: index, count: 1 });
        if (op.flush && op.end != null && op.end >= firstCycle && op.end <= lastCycle) {
            if (!squashes.has(op.end)) squashes.set(op.end, []);
            squashes.get(op.end)!.push({ id: op.id, index });
        }
    });
    function cursorAt(time: number) {
        const group = groups.find((g) => g.time > time);
        return group ? group.start + group.count * smooth((time - group.time + lead) / lead) : orderedOps.length;
    }
    const events = [...squashes]
        .sort((a, b) => a[0] - b[0])
        .map(([time, entries]) => {
            const start = cursorAt(time),
                turn = Math.max(0, entries[0].index, start - rows * 1.25);
            return { time, start, turn, ids: entries.map((e) => e.id) };
        });
    function stateAt(time: number, reducedMotion = false): FeedState {
        const normalCursor = cursorAt(time),
            event = events.findLast((e) => e.time <= time && time < e.time + codeRewindDuration);
        const flow: FeedState = {
            phase: "flow",
            time: null,
            count: 0,
            age: 0,
            cursor: normalCursor,
            normalCursor,
            cancelAlpha: 0,
            flowAlpha: 1,
            dissolve: 0,
            recovery: 1,
            ids: []
        };
        if (!event) return flow;
        const age = time - event.time,
            base = { ...flow, time: event.time, count: event.ids.length, age, ids: [...event.ids] };
        if (reducedMotion) return { ...base, phase: "notice" };
        const cursor = event.start + (event.turn - event.start) * smooth(age / 0.9);
        // 文字は漂いながら薄くなり、命令列が再流入する直前まで短い余韻を残す。
        const dissolve = smooth((age - 0.9) / 1.65),
            recovery = smooth((age - 2.8) / 1.2);
        return {
            ...base,
            phase: age < 0.9 ? "rewind" : age < 2.8 ? "discard" : "refill",
            cursor,
            cancelAlpha: 1 - smooth((age - 0.9) / 2.1),
            flowAlpha: recovery,
            dissolve,
            recovery
        };
    }
    return { cursorAt, stateAt, events };
}

function sampleTopDown(data: TopDownData | null | undefined, time: number) {
    if (!data || !Number.isFinite(time)) return { available: false as const };
    const end = Math.min(data.slots.length, time - data.firstCycle);
    const first = Math.max(0, end - data.windowCycles);
    if (end <= first) return { available: false as const };
    const counts = [0, 0, 0, 0, 0, 0, 0];
    const observations = data.observationTimes;
    for (let i = Math.floor(first); i < Math.ceil(end); i++) {
        const weight = Math.min(end, i + 1) - Math.max(first, i),
            row = [...data.slots[i], 0];
        if (observations) {
            // 結果が未確定でも割り当て自体は判明している。処理中の仕事と、
            // 判断に必要な記録が欠けているスロットを分けて扱う。
            row[6] = row[0] + row[1];
            row[0] = row[1] = 0;
            const recovery = observations.recoveryNotices[i];
            if (recovery && time < recovery[0]) {
                row[recovery[1]] += row[2];
                row[2] = 0;
            }
        }
        row.forEach((n, j) => (counts[j] += n * weight));
    }
    for (const [allocated, observed, outcome] of observations?.outcomes ?? []) {
        if (observed > time) continue;
        const index = allocated - data.firstCycle,
            weight = Math.max(0, Math.min(end, index + 1) - Math.max(first, index));
        counts[6] -= weight;
        counts[outcome] += weight;
    }
    for (let i = 0; i < counts.length; i++) if (Math.abs(counts[i]) < 1e-9) counts[i] = 0;
    const total = counts.reduce((sum, n) => sum + n, 0);
    if (total <= 0) return { available: false as const };
    const shares = {
        retiring: counts[0] / total,
        badSpeculation: (counts[1] + counts[2]) / total,
        frontend: counts[3] / total,
        backend: counts[4] / total,
        unresolved: counts[5] / total,
        inFlight: counts[6] / total
    };
    // 主表示では有効な割り当てと失われた処理能力を比較する。
    // コミットは有効な割り当ての内訳を確定するため、レイテンシが長いだけで
    // 主表示が未確定・不明のままにならないようにする。
    const ranked = Object.entries({
        active: shares.retiring + shares.inFlight,
        badSpeculation: shares.badSpeculation,
        frontend: shares.frontend,
        backend: shares.backend,
        unresolved: shares.unresolved
    }).sort((a, b) => b[1] - a[1]);
    const dominant: BoundCategory | "mixed" =
        Math.abs(ranked[0][1] - ranked[1][1]) < 1e-9 ? "mixed" : (ranked[0][0] as BoundCategory);
    return {
        available: true as const,
        firstCycle: data.firstCycle + first,
        lastCycle: data.firstCycle + end,
        cycles: end - first,
        totalSlots: total,
        counts,
        shares,
        dominant,
        dominantShare: ranked[0][1]
    };
}
function findRecoveryBranches<T extends Pick<Instruction, "id" | "flush" | "end" | "execution" | "completion">>(
    ops: readonly T[],
    events: readonly DemoEvent[] | undefined,
    flushes: readonly number[],
    infer = false
) {
    const result = [];
    for (const event of events ?? []) {
        if (event.kind !== "branch-mispredict") continue;
        const op = ops.find((o) => o.id === event.id);
        if (!op || op.flush) continue;
        const flush = flushes.find((t) => t >= event.cycle && t <= event.cycle + 4);
        result.push({
            id: op.id,
            op,
            cycle: event.cycle,
            until: Math.min(op.end + 1.6, (flush ?? event.cycle) + 5.4),
            inferred: false
        });
    }
    if (infer)
        for (const time of flushes) {
            const first = Math.min(...ops.filter((o) => o.flush && o.end === time).map((o) => o.id));
            // O3PipeView には原因の注釈がない。直前の命令が生存する分岐の場合だけ、
            // 推定候補であることを明示して表示する。
            const op = ops.find(
                (o) =>
                    o.id === first - 1 &&
                    !o.flush &&
                    o.execution === "exec-branch" &&
                    o.completion !== null &&
                    o.completion <= time &&
                    o.completion >= time - 8 &&
                    o.end > time
            );
            if (op)
                result.push({ id: op.id, op, cycle: time, until: Math.min(op.end + 1.6, time + 5.4), inferred: true });
        }
    return result.sort((a, b) => a.cycle - b.cycle);
}
function createDependencyReplay(
    ops: readonly DependencyOperation[],
    evidence: SchedulingEvidence | null | undefined,
    capacity?: number
) {
    const byID = new Map((evidence?.ops ?? []).map((o) => [o.id, o]));
    const count = capacity ?? Math.max(1, ...ops.map((o) => (o.issueSlot ?? -1) + 1));
    const resident = (op: DependencyOperation, time: number) =>
        op.allocation != null && op.allocation <= time && time < Math.min(op.issue ?? op.end, op.end);
    function columnAt(id: number, time: number) {
        const op = ops.find((o) => o.id === id);
        return op && resident(op, time) ? op.issueSlot : null;
    }
    function stateAt(time: number) {
        const active = ops.filter((op) => resident(op, time)),
            slots = new Map(active.map((op) => [op.id, op.issueSlot]));
        const rows: { id: number; slot: number | undefined; known: boolean; ready: boolean }[] = [],
            cells: DependencyCell[] = [],
            external: DependencyCell[] = [],
            broadcasts = new Map<number, Broadcast>();
        for (const op of active) {
            const evidenceOp = byID.get(op.id),
                deps = evidenceOp?.dependencies ?? [];
            rows.push({
                id: op.id,
                slot: op.issueSlot,
                known: !!evidenceOp,
                ready: !!evidenceOp && deps.every((d) => d.ready !== null && d.ready <= time)
            });
            const seen = new Set<number>();
            for (const dep of deps) {
                const age = dep.ready === null ? -Infinity : time - dep.ready;
                if (seen.has(dep.id) || (dep.ready !== null && dep.ready <= op.allocation!) || age >= 0.9) continue;
                seen.add(dep.id);
                const cell = {
                    consumer: op.id,
                    producer: dep.id,
                    row: op.issueSlot,
                    column: slots.get(dep.id) ?? null,
                    waiting: age < 0,
                    unknown: dep.ready === null,
                    alpha: age < 0 ? 1 : 1 - smooth(age / 0.9),
                    register: dep.register ?? null
                };
                (cell.column === null ? external : cells).push(cell);
                if (age >= 0) {
                    if (!broadcasts.has(dep.id))
                        broadcasts.set(dep.id, {
                            producer: dep.id,
                            column: cell.column,
                            rows: [],
                            progress: age / 0.9
                        });
                    broadcasts.get(dep.id)!.rows.push(op.issueSlot);
                }
            }
        }
        const issues = ops
            .filter(
                (op) =>
                    op.issue != null &&
                    op.allocation != null &&
                    op.issue < op.end &&
                    time >= op.issue &&
                    time < op.issue + 0.9
            )
            .map((op) => ({
                id: op.id,
                slot: op.issueSlot,
                column: rows.some((r) => r.slot === op.issueSlot && r.id !== op.id) ? null : op.issueSlot,
                progress: (time - op.issue!) / 0.9,
                targets: rows
                    .filter((row) => (byID.get(row.id)?.dependencies ?? []).some((d) => d.id === op.id))
                    .map((r) => ({ id: r.id, row: r.slot }))
            }));
        return {
            rows,
            cells,
            external,
            issues,
            broadcasts: [...broadcasts.values()],
            rowCount: count,
            columnCount: count,
            columns: rows.map((row) => ({ id: row.id, slot: row.slot })),
            kind: evidence?.kind ?? "unavailable"
        };
    }
    return { columnCount: count, columnAt, stateAt };
}
function createRegisterReplay(input: RegisterEvidence | null | undefined) {
    if (!input) return { stateAt: (_time: number) => ({ available: false as const, rows: [], events: [] }) };
    const data = input;
    const physicalIDs = [
        ...new Set([
            ...data.initial.owners.map(([id]) => id),
            ...data.initial.mapping.map(([, id]) => id),
            ...(data.allocation?.initial ?? []).map(([id]) => id),
            ...(data.allocation?.events ?? []).map((e) => e.physical),
            ...data.events.flatMap((e) => [e.physical, ...(e.previous === undefined ? [] : [e.previous])])
        ])
    ].sort((a, b) => a - b);
    function stateAt(time: number) {
        const mapping = new Map(data.initial.mapping),
            values = new Map(data.initial.values),
            owners = new Map(data.initial.owners),
            changed = new Map<number, RegisterEvent>(),
            physicalChanged = new Map<number, RegisterEvent>();
        const allocation = new Map(data.allocation?.initial ?? []),
            allocationChanged = new Map<number, AllocationEvent>();
        for (const e of data.allocation?.events ?? []) {
            if (e.cycle > time) break;
            if (allocation.get(e.physical) !== e.state) allocationChanged.set(e.physical, e);
            allocation.set(e.physical, e.state);
        }
        let lastWrite: Extract<RegisterEvent, { type: "write" }> | null = null;
        for (const e of data.events) {
            if (e.cycle > time) break;
            if (e.type === "map") {
                mapping.set(e.logical, e.physical);
            } else if (e.type === "observe") {
                values.set(e.physical, e.hex);
            } else if (e.type === "rename") {
                mapping.set(e.logical, e.physical);
                owners.set(e.physical, e.id);
                values.delete(e.physical);
                changed.set(e.logical, e);
                physicalChanged.set(e.physical, e);
            } else if (e.type === "restore" && mapping.get(e.logical) === e.physical) {
                mapping.set(e.logical, e.previous);
                changed.set(e.logical, e);
                physicalChanged.set(e.physical, e);
                physicalChanged.set(e.previous, e);
            } else if (e.type === "write" && owners.get(e.physical) === e.id) {
                values.set(e.physical, e.hex);
                lastWrite = e;
                physicalChanged.set(e.physical, e);
            }
        }
        const allocationCounts = { allocated: 0, free: 0, unknown: 0 };
        for (const physical of physicalIDs) allocationCounts[allocation.get(physical) ?? "unknown"]++;
        return {
            available: true as const,
            allocationCounts,
            rows: data.rows.map((logical) => {
                const physical = mapping.get(logical),
                    event = changed.get(logical);
                return {
                    logical,
                    constant: data.constantRows?.includes(logical) ?? false,
                    physical: physical ?? null,
                    value: physical === undefined ? null : (values.get(physical) ?? null),
                    writer: physical === undefined ? null : (owners.get(physical) ?? null),
                    event: event ?? null,
                    pulse: event ? 1 - smooth((time - event.cycle) / 1.2) : 0
                };
            }),
            physical: physicalIDs.map((physical) => {
                const event = physicalChanged.get(physical),
                    allocationEvent = allocationChanged.get(physical);
                return {
                    physical,
                    value: values.get(physical) ?? null,
                    writer: owners.get(physical) ?? null,
                    allocation: allocation.get(physical) ?? "unknown",
                    allocationEvent: allocationEvent ?? null,
                    allocationPulse: allocationEvent ? 1 - smooth((time - allocationEvent.cycle) / 0.65) : 0,
                    mappedTo: [...mapping].filter(([, p]) => p === physical).map(([r]) => r),
                    event: event ?? null,
                    pulse: event ? 1 - smooth((time - event.cycle) / 1.2) : 0
                };
            }),
            lastWrite,
            events: data.events.filter((e) => time >= e.cycle && time < e.cycle + 1.2)
        };
    }
    return { stateAt };
}

// 未読込みの管理部分から、描画に渡せる準備済みの状態を作る。
function createReplay({ samples }: { samples: readonly TraceData[] }) {
    let current: ReplayState | null = null;
    function loadData(trace: TraceData, options?: { continuityAt: number }): ReplayState {
        const at = options?.continuityAt;
        const continuity =
            current &&
            at !== undefined &&
            Number.isFinite(at) &&
            at >= Math.max(current.trace.firstCycle, trace.firstCycle) &&
            at <= Math.min(current.trace.lastCycle, trace.lastCycle)
                ? { at, replay: current }
                : undefined;
        const prepared = prepareTrace(trace, continuity);
        // 利用側が持つ参照を保ち、準備中や失敗時の状態を公開しない。
        if (current) Object.assign(current, prepared);
        else current = prepared;
        return current;
    }
    return {
        get current() {
            return current;
        },
        loadTrace(key: string): ReplayState {
            const trace = samples.find((sample) => sample.key === key) ?? samples[0];
            if (!trace) throw new Error("No traces available");
            return loadData(trace);
        },
        loadData
    };
}

type SlotUse = {
    intervals: { start: number; end: number }[];
    preferred?: number;
    assign: (slot: number) => void;
};

// 直前窓の位置を先に予約し、追加命令が後から使う場所を奪わないようにする。
function preserveSlots(uses: SlotUse[], at: number, limit = 512) {
    const slots: { start: number; end: number }[][] = [];
    const pending: SlotUse[] = [];
    const assignments = new Map<SlotUse, number>();
    const overlaps = (slot: number, use: SlotUse) =>
        use.intervals.some(({ start, end }) => {
            if (end <= start) return false;
            const intervals = slots[slot] ?? [];
            let lo = 0,
                hi = intervals.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (intervals[mid].end <= start) lo = mid + 1;
                else hi = mid;
            }
            return lo < intervals.length && intervals[lo].start < end;
        });
    function reserve(use: SlotUse, slot: number) {
        slots[slot] ??= [];
        slots[slot].push(...use.intervals.filter(({ start, end }) => end > start));
        slots[slot].sort((a, b) => a.start - b.start);
        assignments.set(use, slot);
    }
    const active = (use: SlotUse) => use.intervals.some(({ start, end }) => start <= at && at < end);
    // 途中読込みで滞在が延びた場合も、現在見えている命令の予約を優先する。
    for (const use of [...uses].sort((a, b) => Number(active(b)) - Number(active(a)))) {
        if (use.preferred !== undefined && use.preferred < limit && !overlaps(use.preferred, use))
            reserve(use, use.preferred);
        else pending.push(use);
    }
    for (const use of pending.sort((a, b) => a.intervals[0].start - b.intervals[0].start)) {
        let slot = 0;
        while (slot < limit && overlaps(slot, use)) slot++;
        if (slot === limit) return null;
        reserve(use, slot);
    }
    for (const [use, slot] of assignments) use.assign(slot);
    return slots.length;
}

// 命令と表示スロットはこの読込み専用の状態に組み立てる。
function prepareTrace(trace: TraceData, continuity?: { at: number; replay: ReplayState }): ReplayState {
    function allocateSlots(
        start: (op: Instruction) => number | null | undefined,
        end: (op: Instruction) => number | undefined,
        field: "issueSlot"
    ) {
        const ends: (number | undefined)[] = [];
        for (const op of [...ops]
            .filter((o) => start(o) != null)
            .sort((a, b) => start(a)! - start(b)! || a.id - b.id)) {
            let slot = ends.findIndex((e) => e! <= start(op)!);
            if (slot < 0) slot = ends.length;
            op[field] = slot;
            ends[slot] = end(op);
        }
    }

    function allocateRenameSlots() {
        const ends: number[] = [];
        const entries = ops.flatMap((op) =>
            op.stages.flatMap((stage, index) =>
                stage.names.includes("Rn") ? [{ op, stage, next: op.stages[index + 1] }] : []
            )
        );
        // 同時に滞在する命令を別々に置く。退場の補間中も元の場所を再利用しない。
        for (const { op, stage, next } of entries.sort((a, b) => a.stage.start - b.stage.start || a.op.id - b.op.id)) {
            let slot = ends.findIndex((end) => end <= stage.start);
            if (slot < 0) slot = ends.length;
            stage.displaySlot = slot;
            ends[slot] = Math.min(op.end, next ? next.start + stageTransition(next) : stage.end);
        }
    }

    const ops: Instruction[] = trace.ops.map((t, index) => {
        const [
            id,
            rid,
            fetch,
            retired,
            flush,
            label,
            source,
            allocation,
            issue,
            completion,
            execution,
            flushCycle,
            unfinished
        ] = t;
        // 未完了の末尾は退場させず、最後に観測した段階へ保持する。
        const end = unfinished ? Infinity : flush ? (flushCycle ?? retired) : retired;
        const type = memoryModel.instructionType(label);
        const kind = type === "integer" || type === "branch" ? type : "memory";
        const displayExecution = type === "atomic" ? "exec-memory" : `exec-${type}`;
        const stages: StageRange[] = [];
        for (const [name, sourceNode, start, finish] of source) {
            const node =
                sourceNode.startsWith("exec") || (sourceNode === "memory-wait" && type !== "load" && type !== "store")
                    ? displayExecution
                    : sourceNode;
            if (stages.at(-1)?.node === node) {
                stages.at(-1)!.end = Math.max(finish, stages.at(-1)!.end);
                stages.at(-1)!.names.push(name);
            } else stages.push({ names: [name], node, start, end: finish });
        }
        if (stages.length && end > stages.at(-1)!.end) stages.at(-1)!.end = end;
        return {
            id,
            rid,
            // ファイルの前段・接続レーンは、窓内の配列順による再採番を避ける。
            index: trace.key === "local-file" ? id : index,
            fetch,
            end,
            flush: !!flush,
            ...(unfinished ? { unfinished: true } : {}),
            label,
            stages,
            allocation,
            issue,
            completion,
            execution: displayExecution,
            kind,
            memoryKind: kind === "memory" ? (type as "load" | "store" | "atomic") : undefined,
            reads:
                trace.evidence?.registers?.origin === "gem5"
                    ? [
                          ...new Set(
                              (trace.evidence.registers.reads ?? []).filter((r) => r.id === id).map((r) => r.cycle)
                          )
                      ].map((time) => ({
                          start: time,
                          end: time + 0.7,
                          sources: (trace.evidence!.registers!.reads ?? [])
                              .filter((r) => r.id === id && r.cycle === time)
                              .map((r) => ({ physical: r.physical, hex: r.hex }))
                      }))
                    : source.filter((s) => s[0] === "Rr").map((s) => ({ start: s[2], end: s[3] })),
            sourceRegisters: trace.evidence?.scheduling.ops.find((o) => o.id === id)?.sources ?? []
        };
    });
    const memory = memoryModel.prepareMemory(ops, trace);
    allocateRenameSlots();
    const commitGroups = new Map();
    for (const op of ops
        .filter((o) => !o.flush && !o.unfinished)
        .sort((a, b) => a.end - b.end || a.rid - b.rid || a.id - b.id)) {
        const time = Math.floor(op.end),
            group = commitGroups.get(time) ?? [];
        op.commitSlot = group.length;
        group.push(op);
        commitGroups.set(time, group);
    }
    const ids = new Set(ops.map((op) => op.id));
    const feedOps: FeedInstruction[] = [...ops, ...(trace.feedPreview ?? []).filter((op) => !ids.has(op.id))].sort(
        (a, b) => a.fetch - b.fetch || a.id - b.id
    );
    const fetchGroups: FeedGroup[] = [];
    feedOps.forEach((op, index) => {
        op.feedText = `${String(op.id).padStart(6, "0")}  ${op.label.trim().replace(/\s+/g, " ")}`.slice(0, 42);
        if (fetchGroups.at(-1)?.time === op.fetch) fetchGroups.at(-1)!.count++;
        else fetchGroups.push({ time: op.fetch, start: index, count: 1 });
    });
    // 読込み窓の前後にある記録も、進行中の演出と既存の直前減速だけに使う。
    const eventFirstCycle = trace.firstCycle - (trace.key === "local-file" ? 6 : 0);
    const eventLastCycle = trace.lastCycle + (trace.key === "local-file" ? 1 : 0);
    const feedReplay = createFeedReplay(feedOps, {
        firstCycle: eventFirstCycle,
        lastCycle: eventLastCycle,
        rows: feedRows,
        lead: feedLead
    });
    allocateSlots(
        (o) => o.allocation,
        (o) => o.issue ?? o.end,
        "issueSlot"
    );
    if (continuity || trace.key === "local-file") {
        const previous = new Map(continuity?.replay.ops.map((op) => [op.id, op]));
        const at = continuity?.at ?? trace.firstCycle;
        const issueUses: SlotUse[] = ops
            .filter((op) => op.allocation != null)
            .map((op) => {
                const intervals = [{ start: op.allocation!, end: Math.min(op.end, op.issue ?? op.end) }];
                for (const [index, stage] of op.stages.entries()) {
                    if (stage.node !== "issue") continue;
                    const next = op.stages[index + 1];
                    const end = Math.min(op.end, next ? next.start + stageTransition(next) : stage.end);
                    const last = intervals.at(-1)!;
                    if (stage.start <= last.end) last.end = Math.max(last.end, end);
                    else intervals.push({ start: stage.start, end });
                }
                return {
                    intervals,
                    preferred: previous.get(op.id)?.issueSlot,
                    assign: (slot) => {
                        op.issueSlot = slot;
                    }
                };
            });
        // 128行の表示上限内で補間用の場所を確保する。実機容量の追加観測ではない。
        // 予約だけで上限を超える場合は、この窓の通常割当を残す。
        const queueCapacity = Math.max(trace.structure.queueCapacity, preserveSlots(issueUses, at, 128) ?? 0);
        if (queueCapacity !== trace.structure.queueCapacity)
            trace = { ...trace, structure: { ...trace.structure, queueCapacity } };
        for (const kind of ["rename", "memory-wait"] as const) {
            const uses = ops.flatMap((op) =>
                op.stages.flatMap((stage, index): SlotUse[] => {
                    if (kind === "rename" ? !stage.names.includes("Rn") : stage.node !== "memory-wait") return [];
                    const next = op.stages[index + 1];
                    const end = Math.min(op.end, next ? next.start + stageTransition(next) : stage.end);
                    const old = previous
                        .get(op.id)
                        ?.stages.find((value) => value.node === stage.node && value.start === stage.start);
                    return [
                        {
                            intervals: [{ start: stage.start, end }],
                            preferred: old?.displaySlot,
                            assign: (slot) => {
                                stage.displaySlot = slot;
                            }
                        }
                    ];
                })
            );
            const count = preserveSlots(uses, at);
            if (kind === "memory-wait" && count !== null) memory.waitSlots.load = count;
        }
        for (const node of memory.executionNodes.filter((node) => node.kind === "memory")) {
            const groups = new Map<number, Instruction[]>();
            for (const op of ops.filter((op) => op.execution === node.id)) {
                const start = op.stages.find((stage) => stage.node === node.id)?.start ?? Infinity;
                if (!groups.has(start)) groups.set(start, []);
                groups.get(start)!.push(op);
            }
            for (const group of groups.values()) {
                const used = new Set<number>();
                for (const op of group) {
                    const lane = previous.get(op.id)?.pipeLane;
                    if (lane !== undefined && lane < node.pipeCount) {
                        op.pipeLane = lane;
                        used.add(lane);
                    }
                }
                for (const op of group) {
                    const old = previous.get(op.id)?.pipeLane;
                    if (old !== undefined && old < node.pipeCount) continue;
                    const lane = !used.has(op.pipeLane!)
                        ? op.pipeLane
                        : Array.from({ length: node.pipeCount }, (_, i) => i).find((i) => !used.has(i));
                    if (lane !== undefined) op.pipeLane = lane;
                    used.add(op.pipeLane!);
                }
            }
        }
        for (const group of commitGroups.values() as Iterable<Instruction[]>) {
            const used = new Set<number>();
            for (const op of group) {
                const slot = previous.get(op.id)?.commitSlot;
                if (slot !== undefined) {
                    op.commitSlot = slot;
                    used.add(slot);
                }
            }
            for (const op of group) {
                if (previous.get(op.id)?.commitSlot !== undefined) continue;
                let slot = 0;
                while (used.has(slot)) slot++;
                op.commitSlot = slot;
                used.add(slot);
            }
        }
    }
    const dependencyReplay = createDependencyReplay(ops, trace.evidence?.scheduling, trace.structure.queueCapacity);
    const registerReplay = createRegisterReplay(trace.evidence?.registers);
    const regs = trace.evidence?.registers;
    const registerTags = regs
        ? [
              ...new Set([
                  ...regs.initial.owners.map(([p]) => p),
                  ...regs.initial.mapping.map(([, p]) => p),
                  ...(regs.allocation?.initial ?? []).map(([p]) => p),
                  ...(regs.allocation?.events ?? []).map((e) => e.physical),
                  ...regs.events.flatMap((e) => [e.physical, ...(e.previous === undefined ? [] : [e.previous])])
              ])
          ].sort((a, b) => a - b)
        : [];
    const robReplay = createRobReplay(
        ops,
        trace.structure.robCapacity,
        continuity?.replay.trace.structure.robCapacity === trace.structure.robCapacity
            ? { time: continuity.at, state: continuity.replay.robReplay.stateAt(continuity.at) }
            : undefined
    );
    for (const op of ops) op.robSlot = robReplay.slots.get(op.id);
    const memoryEvents = memoryCompletions(ops);
    const flushEvents = [
        ...new Set(ops.filter((o) => o.flush && o.end >= eventFirstCycle && o.end <= eventLastCycle).map((o) => o.end))
    ].sort((a, b) => a - b);
    const branchRecoveries = findRecoveryBranches(ops, trace.demo.events, flushEvents, trace.parser.startsWith("gem5"));

    const activity = Array.from({ length: trace.lastCycle - trace.firstCycle + 1 }, (_, i) => {
        const t = trace.firstCycle + i;
        return {
            active: ops.filter((o) => o.fetch <= t && o.end > t).length,
            retired: ops.filter((o) => !o.flush && o.end >= t && o.end < t + 1).length
        };
    });
    return {
        trace,
        ops,
        memory,
        commitGroups,
        feedOps,
        fetchGroups,
        feedReplay,
        dependencyReplay,
        registerReplay,
        registerTags,
        robReplay,
        memoryEvents,
        flushEvents,
        branchRecoveries,
        activity
    };
}

interface ReplayState {
    trace: TraceData;
    ops: Instruction[];
    memory: ReturnType<typeof memoryModel.prepareMemory>;
    flushEvents: number[];
    activity: { active: number; retired: number }[];
    commitGroups: Map<number, Instruction[]>;
    robReplay: ReturnType<typeof createRobReplay<Instruction>>;
    memoryEvents: ReturnType<typeof memoryCompletions<Instruction>>;
    branchRecoveries: ReturnType<typeof findRecoveryBranches<Instruction>>;
    dependencyReplay: ReturnType<typeof createDependencyReplay>;
    registerReplay: ReturnType<typeof createRegisterReplay>;
    registerTags: number[];
    feedOps: FeedInstruction[];
    fetchGroups: FeedGroup[];
    feedReplay: ReturnType<typeof createFeedReplay>;
}

namespace replayModel {
    export type Operation = Instruction;
    export type Stage = StageRange;
    export type Trace = TraceData;
    export type Replay = ReplayState;
    export type Registers = RegisterEvidence;
    export type Scheduling = SchedulingEvidence;
    export type TopDown = TopDownData;
    export type Bound = BoundCategory | "mixed" | "unavailable";
}
declare global {
    var sonataReplay: typeof replayModel;
}

const replayModel = {
    createRobReplay,
    memoryCompletions,
    createFeedReplay,
    codeRewindDuration,
    sampleTopDown,
    flushPlaybackRate,
    advancePlayback,
    createEmptyPlayback,
    createWaitPlayback,
    measureTransfers,
    createDependencyReplay,
    createRegisterReplay,
    findRecoveryBranches,
    createReplay,
    feedRows,
    feedLead
};
globalThis.sonataReplay = replayModel;
export = replayModel;

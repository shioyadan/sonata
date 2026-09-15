"use strict";
// 詳細注釈だけを逐次観測する。全文・全Opの複製を作らず、過去の証拠は
// コンパクトなtupleページとレジスタのcheckpointに保存する。
import type { Op } from "../vendor/konata-core/model";
import type replay = require("./replay-model.cts");
import windows = require("./trace-window.cts");

interface Config {
    isa?: "aarch64" | "x86" | "riscv";
    integerRegisters?: number;
    wordBits?: number;
}
interface RsdEvent {
    cycle: number;
    sourceCycle: number;
    id: number;
    kind: "branch-mispredict" | "dcache-miss" | "icache-miss";
    message: string;
    line: number;
}
type RegisterEvent = replay.Registers["events"][number] & { line?: number; observedCycle?: number };
type AllocationEvent = NonNullable<replay.Registers["allocation"]>["events"][number] & { line?: number; id?: number };
type Read = NonNullable<replay.Registers["reads"]>[number] & { line?: number };
type Entry =
    | { kind: "register"; data: RegisterEvent }
    | { kind: "allocation"; data: AllocationEvent }
    | { kind: "read"; data: Read }
    | { kind: "notice"; data: RsdEvent };
type Snapshot = replay.Registers["initial"] & {
    allocation: [number, "allocated" | "free"][];
    valueTimes: [number, number][];
};
const pageSize = 2048;
const maxWindowEvents = 131072;
const maxActive = 65536;
const registerLimit = 65536;
const eventKinds = ["map", "observe", "rename", "restore", "write"] as const;
type Tuple = (number | string | null)[];
function pack(entry: Entry): Tuple {
    const e = entry.data;
    if (entry.kind === "register") {
        const r = entry.data;
        return [
            0,
            r.cycle,
            eventKinds.indexOf(r.type),
            r.physical,
            "logical" in r ? (r.logical ?? null) : null,
            "id" in r ? r.id : null,
            r.previous ?? null,
            "hex" in r ? r.hex : null,
            r.line ?? null,
            r.observedCycle ?? null
        ];
    }
    if (entry.kind === "allocation") {
        const a = entry.data;
        return [1, a.cycle, a.physical, a.state === "allocated" ? 1 : 0, a.reason, a.line ?? null, a.id ?? null];
    }
    if (entry.kind === "read") {
        const r = entry.data;
        return [2, r.cycle, r.id, r.physical, r.hex, r.line ?? null];
    }
    const n = entry.data;
    return [3, e.cycle, n.id, n.sourceCycle, n.kind, n.message, n.line];
}
function unpack(t: Tuple): Entry {
    const cycle = t[1] as number;
    if (t[0] === 0) {
        const data = { type: eventKinds[t[2] as number], cycle, physical: t[3] as number } as RegisterEvent;
        if (t[4] !== null) Object.assign(data, { logical: t[4] });
        if (t[5] !== null) Object.assign(data, { id: t[5] });
        if (t[6] !== null) data.previous = t[6] as number;
        if (t[7] !== null) Object.assign(data, { hex: t[7] });
        if (t[8] !== null) data.line = t[8] as number;
        if (t[9] !== null) data.observedCycle = t[9] as number;
        return { kind: "register", data };
    }
    if (t[0] === 1)
        return {
            kind: "allocation",
            data: {
                cycle,
                physical: t[2] as number,
                state: t[3] ? "allocated" : "free",
                reason: t[4] as string,
                ...(t[5] === null ? {} : { line: t[5] as number }),
                ...(t[6] === null ? {} : { id: t[6] as number })
            }
        };
    if (t[0] === 2)
        return {
            kind: "read",
            data: {
                cycle,
                id: t[2] as number,
                physical: t[3] as number,
                hex: t[4] as string,
                ...(t[5] === null ? {} : { line: t[5] as number })
            }
        };
    return {
        kind: "notice",
        data: {
            cycle,
            id: t[2] as number,
            sourceCycle: t[3] as number,
            kind: t[4] as RsdEvent["kind"],
            message: t[5] as string,
            line: t[6] as number
        }
    };
}
function createState(initial?: Snapshot) {
    const mapping = new Map(initial?.mapping),
        values = new Map(initial?.values),
        owners = new Map(initial?.owners);
    const allocation = new Map(initial?.allocation),
        valueTimes = new Map(initial?.valueTimes);
    function apply(entry: Entry) {
        if (entry.kind === "allocation") allocation.set(entry.data.physical, entry.data.state);
        if (entry.kind !== "register") return;
        const e = entry.data;
        if (e.type === "map") mapping.set(e.logical, e.physical);
        if (e.type === "rename") {
            mapping.set(e.logical, e.physical);
            owners.set(e.physical, e.id);
            values.delete(e.physical);
            valueTimes.delete(e.physical);
        }
        if (e.type === "restore" && mapping.get(e.logical) === e.physical) mapping.set(e.logical, e.previous);
        if (e.type === "observe" || (e.type === "write" && owners.get(e.physical) === e.id)) {
            if ((valueTimes.get(e.physical) ?? -Infinity) <= e.cycle) {
                values.set(e.physical, e.hex);
                valueTimes.set(e.physical, e.cycle);
            }
        }
    }
    return {
        apply,
        snapshot: (): Snapshot => ({
            mapping: [...mapping],
            values: [...values],
            owners: [...owners],
            allocation: [...allocation],
            valueTimes: [...valueTimes]
        })
    };
}
function rank(entry: Entry) {
    if (entry.kind === "register") return { restore: 0, map: 1, rename: 1, observe: 2, write: 2 }[entry.data.type];
    if (entry.kind === "allocation") return entry.data.state === "free" ? 3 : 4;
    return 5;
}
function compare(a: Entry, b: Entry) {
    if (a.kind === "allocation" && b.kind === "allocation")
        return (
            a.data.cycle - b.data.cycle ||
            rank(a) - rank(b) ||
            (a.data.id !== undefined && b.data.id !== undefined
                ? a.data.id - b.data.id
                : (a.data.line ?? 0) - (b.data.line ?? 0))
        );
    return (
        a.data.cycle - b.data.cycle ||
        rank(a) - rank(b) ||
        (a.kind === "register" && b.kind === "register" && "id" in a.data && "id" in b.data
            ? a.data.type === "restore"
                ? b.data.id - a.data.id
                : a.data.id - b.data.id
            : 0)
    );
}
function createJournal(gem5Order: () => boolean) {
    const order = (a: Entry, b: Entry) =>
        gem5Order() ? a.data.cycle - b.data.cycle || (a.data.line ?? 0) - (b.data.line ?? 0) : compare(a, b);
    type Page = { first: number; last: number; initial: Snapshot; text: string };
    const pages: Page[] = [];
    const decoded = new Map<Page, Entry[]>();
    function entriesOf(page: Page) {
        let result = decoded.get(page);
        decoded.delete(page);
        if (!result) result = (JSON.parse(page.text) as Tuple[]).map(unpack);
        decoded.set(page, result);
        if (decoded.size > 2) decoded.delete(decoded.keys().next().value!);
        return result;
    }
    let state = createState(),
        initial = state.snapshot(),
        tail: Entry[] = [];
    function add(entry: Entry) {
        const time = entry.data.cycle;
        // RSDの最終Rwは退役時に確定するため、遅れて届くwriteを元の時刻へ挿入する。
        // 以後に別の命令へrenameされたセルや、より新しい観測値は変更しない。
        if (pages.length && time <= pages.at(-1)!.last) {
            let low = 0,
                high = pages.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (pages[middle].last < time) low = middle + 1;
                else high = middle;
            }
            const page = pages[low],
                entries = [...entriesOf(page)];
            entries.push(entry);
            entries.sort(order);
            page.text = JSON.stringify(entries.map(pack));
            decoded.delete(page);
            page.first = Math.min(page.first, time);
            for (let i = low + 1; i < pages.length; i++) {
                const next = createState(pages[i].initial);
                next.apply(entry);
                pages[i].initial = next.snapshot();
            }
            const next = createState(initial);
            next.apply(entry);
            initial = next.snapshot();
            state.apply(entry);
            return;
        }
        tail.push(entry);
        if (tail.length > maxWindowEvents) throw new Error("Too many register events at one timestamp.");
    }
    function advance(time: number) {
        if (tail.length < pageSize || tail.at(-1)!.data.cycle >= time) return;
        tail.sort(order);
        for (const e of tail) state.apply(e);
        pages.push({
            first: tail[0].data.cycle,
            last: tail.at(-1)!.data.cycle,
            initial,
            text: JSON.stringify(tail.map(pack))
        });
        initial = state.snapshot();
        tail = [];
    }
    function range(first: number, last: number) {
        let low = 0,
            high = pages.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (pages[middle].last < first) low = middle + 1;
            else high = middle;
        }
        const before = createState(pages[low]?.initial ?? initial),
            entries: Entry[] = [];
        const accept = (e: Entry) => {
            if (e.data.cycle < first) before.apply(e);
            else if (e.data.cycle <= last) {
                if (entries.length >= maxWindowEvents)
                    throw new Error("Too many register events in this window. Select a shorter range.");
                entries.push(e);
            }
        };
        for (let i = low; i < pages.length && pages[i].first <= last; i++)
            for (const entry of entriesOf(pages[i])) accept(entry);
        if (!pages.length || pages.at(-1)!.last < last) for (const e of [...tail].sort(order)) accept(e);
        return { initial: before.snapshot(), entries: entries.sort(order) };
    }
    return {
        add,
        advance,
        range,
        clear() {
            pages.length = 0;
            decoded.clear();
            tail = [];
            state = createState();
            initial = state.snapshot();
        },
        stats: () => ({
            pages: pages.length,
            decodedPages: decoded.size,
            bufferedEvents: tail.length,
            serializedCharacters: pages.reduce((n, p) => n + p.text.length, 0)
        })
    };
}

function logicalLayout(isa: Config["isa"], observed: Iterable<number>) {
    const base =
        isa === "aarch64"
            ? [...Array.from({ length: 31 }, (_, i) => i), 38]
            : isa
              ? Array.from({ length: 32 }, (_, i) => i)
              : [];
    const rows = [...new Set([...base, ...observed])].sort((a, b) => a - b);
    const x86 = [
        "RAX",
        "RCX",
        "RDX",
        "RBX",
        "RSP",
        "RBP",
        "RSI",
        "RDI",
        "R8",
        "R9",
        "R10",
        "R11",
        "R12",
        "R13",
        "R14",
        "R15"
    ];
    const logicalNames = Object.fromEntries(
        rows.map((r) => [
            r,
            isa === "x86"
                ? (x86[r] ?? (r < 32 ? `t${r - 16}` : `i${r}`))
                : isa === "aarch64"
                  ? r < 31
                      ? `x${r}`
                      : r === 38
                        ? "SP_EL0"
                        : `i${r}`
                  : isa === "riscv"
                    ? `r${r}`
                    : `i${r}`
        ])
    );
    return { rows, logicalNames };
}
type Reg = { logical: number; physical: number; previous?: number };
function registers(text: string): Reg[] {
    return [...text.matchAll(/r(\d+)\(p(\d+)\)/g)].map((m) => ({ logical: Number(m[1]), physical: Number(m[2]) }));
}
function mappingFrom(text: string) {
    const match = text.match(/map:\s*(.*?)\s*=\s*(.*?)\s*prev:\s*(.*?)(?:IQ alloc:|$)/);
    if (!match) return null;
    const dest = registers(match[1]),
        source = registers(match[2]),
        previous = registers(match[3]);
    for (const d of dest) d.previous = previous.find((p) => p.logical === d.logical)?.physical;
    return { dest, source };
}
function ready(op: Readonly<Op> | null | undefined) {
    if (!op) return null;
    const stages = op.lanes.flatMap((lane) => lane?.stages ?? []);
    return (
        stages.findLast((stage) => stage.name === "Rw")?.startCycle ??
        stages.findLast((stage) => ["Wb", "Mc", "Cm"].includes(stage.name))?.startCycle ??
        null
    );
}

function createEvidenceIndex(config: Config = {}) {
    if (
        config.integerRegisters !== undefined &&
        (!Number.isSafeInteger(config.integerRegisters) ||
            config.integerRegisters < 1 ||
            config.integerRegisters > registerLimit)
    )
        throw new Error("Invalid integer register capacity.");
    if (config.wordBits !== undefined && config.wordBits !== 32 && config.wordBits !== 64)
        throw new Error("Unsupported register word size.");
    const threads = new Set<number>();
    let kind: "gem5" | "rsd" | null = null;
    const journal = createJournal(() => kind === "gem5"),
        clock = windows.createStoreClock();
    const observedRows = new Set<number>(),
        physicals = new Set<number>();
    // 通常の連続seq/id対応を区間に畳む。疎な番号も欠番を埋めずに保持する。
    const sequences: { first: number; last: number; offset: number }[] = [];
    const owners = new Map<number, number>(),
        logicalForPhysical = new Map<number, number>();
    const history = new Map<number, Reg[]>(),
        squashed = new Map<number, number[]>();
    type Active = {
        label: string;
        map?: { cycle: number; line: number; dest: Reg[] };
        ready: number | null;
        result?: { cycle: number; hex: string; line: number };
        lastLoad?: Active["result"];
        lastAlu?: Active["result"];
    };
    const active = new Map<number, Active>();
    let cycle = 0,
        sourceCycle = 0,
        lineNumber = 0;
    let renameSeq = -1,
        renameTick = -1,
        executeSeq = -1,
        executeTick = -1;
    let pending: { physical: number; previous: number } | null = null;
    function checkRegister(physical: number, logical?: number) {
        if (
            !Number.isSafeInteger(physical) ||
            physical < 0 ||
            physical >= registerLimit ||
            (logical !== undefined && (!Number.isSafeInteger(logical) || logical < 0 || logical >= registerLimit))
        )
            throw new Error("Unsupported register number in trace annotations.");
        physicals.add(physical);
        if (logical !== undefined) observedRows.add(logical);
    }
    function emit(e: RegisterEvent) {
        checkRegister(e.physical, "logical" in e ? e.logical : undefined);
        if (e.previous !== undefined) checkRegister(e.previous);
        journal.add({ kind: "register", data: e });
    }
    function allocate(
        physical: number,
        at: number,
        state: AllocationEvent["state"],
        reason: string,
        line?: number,
        id?: number
    ) {
        checkRegister(physical);
        journal.add({
            kind: "allocation",
            data: {
                cycle: at,
                physical,
                state,
                reason,
                ...(line === undefined ? {} : { line }),
                ...(id === undefined ? {} : { id })
            }
        });
    }
    function observeOp(op: Readonly<Op>, parser: "onikiri" | "gem5") {
        if (op.tid >= 0) threads.add(op.tid);
        if (parser !== "gem5") return;
        clock.observe(op);
        let low = 0,
            high = sequences.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (sequences[middle].last < op.gid) low = middle + 1;
            else high = middle;
        }
        if (sequences[low]?.first <= op.gid) return;
        const offset = op.id - op.gid,
            previous = sequences[low - 1],
            next = sequences[low];
        if (previous?.last === op.gid - 1 && previous.offset === offset) previous.last = op.gid;
        else {
            sequences.splice(low, 0, { first: op.gid, last: op.gid, offset });
            low++;
        }
        const merged = sequences[low - 1];
        if (next?.first === merged.last + 1 && next.offset === offset) {
            merged.last = next.last;
            sequences.splice(low, 1);
        }
    }
    function idFor(seq: number) {
        if (seq < 0) return seq;
        let low = 0,
            high = sequences.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (sequences[middle].last < seq) low = middle + 1;
            else high = middle;
        }
        const found = sequences[low];
        return found?.first <= seq ? seq + found.offset : -1000000 - seq;
    }
    function gem5(line: string, tick: number) {
        let m: RegExpMatchArray | null;
        if ((m = line.match(/\.rename:.*Processing instruction \[sn:(\d+)\]/))) {
            renameSeq = Number(m[1]);
            renameTick = tick;
            pending = null;
        }
        if ((m = line.match(/\.rename:.*Looking up integer arch reg (\d+), got phys reg (\d+)/))) {
            kind = "gem5";
            emit({ type: "map", cycle: tick, logical: Number(m[1]), physical: Number(m[2]), line: lineNumber });
            allocate(Number(m[2]), tick, "allocated", "source mapping", lineNumber);
        }
        if ((m = line.match(/Renamed reg .* to physical reg (\d+) \(\d+\) old mapping was (\d+)/)))
            pending = { physical: Number(m[1]), previous: Number(m[2]) };
        if (
            (m = line.match(/\.rename:.*Renaming arch reg (\d+) \(integer\) to physical reg (\d+)/)) &&
            renameTick === tick &&
            renameSeq >= 0
        ) {
            const logical = Number(m[1]),
                physical = Number(m[2]);
            if (pending?.physical === physical) {
                kind = "gem5";
                const e = { logical, physical, previous: pending.previous };
                emit({ type: "rename", cycle: tick, id: renameSeq, ...e, line: lineNumber });
                const entries = history.get(renameSeq) ?? [];
                entries.push(e);
                history.set(renameSeq, entries);
                allocate(e.previous, tick, "allocated", "previous mapping", lineNumber);
                allocate(physical, tick, "allocated", "rename", lineNumber);
                owners.set(physical, renameSeq);
                logicalForPhysical.set(physical, logical);
                pending = null;
                if (history.size > maxActive) throw new Error("Too many unresolved register renames.");
            }
        }
        if (
            (m = line.match(
                /Removing history entry with sequence number (\d+) \(archReg: (\d+), newPhysReg: (\d+), prevPhysReg: (\d+)\)/
            ))
        ) {
            const seq = Number(m[1]),
                logical = Number(m[2]),
                physical = Number(m[3]),
                previous = Number(m[4]);
            const entries = history.get(seq),
                index =
                    entries?.findIndex(
                        (e) => e.logical === logical && e.physical === physical && e.previous === previous
                    ) ?? -1;
            if (entries && index >= 0) {
                entries.splice(index, 1);
                if (!entries.length) history.delete(seq);
                emit({ type: "restore", cycle: tick, id: seq, logical, physical, previous, line: lineNumber });
                if (physical !== previous) {
                    const tid = Number(line.match(/\[tid:(\d+)\]/)?.[1] ?? 0),
                        freed = squashed.get(tid) ?? [];
                    freed.push(physical);
                    squashed.set(tid, freed);
                }
            }
        }
        if ((m = line.match(/Freeing up older rename of reg (\d+) \(integer\), \[sn:(\d+)\]/))) {
            const physical = Number(m[1]),
                seq = Number(m[2]),
                entries = history.get(seq);
            const index = entries?.findIndex((e) => e.previous === physical) ?? -1;
            const entry = index < 0 ? null : entries!.splice(index, 1)[0];
            if (!entries?.length) history.delete(seq);
            if (entry?.physical !== physical) allocate(physical, tick, "free", "commit", lineNumber);
        }
        if (line.includes("Freeing phys regs of misspeculated instructions")) {
            const tid = Number(line.match(/\[tid:(\d+)\]/)?.[1] ?? 0);
            for (const physical of squashed.get(tid) ?? [])
                allocate(physical, tick, "free", "squash reclamation", lineNumber);
            squashed.delete(tid);
        }
        if ((m = line.match(/Execute: Processing PC .*\[sn:(\d+)\]/))) {
            executeSeq = Number(m[1]);
            executeTick = tick;
        }
        if ((m = line.match(/RegFile: Access to int register (\d+), has data (0x[\da-f]+)/i))) {
            kind = "gem5";
            const physical = Number(m[1]),
                hex = m[2];
            emit({ type: "observe", cycle: tick, physical, hex, line: lineNumber });
            if (executeSeq >= 0 && executeTick === tick)
                journal.add({ kind: "read", data: { id: executeSeq, cycle: tick, physical, hex, line: lineNumber } });
        }
        if ((m = line.match(/RegFile: Setting int register (\d+) to (0x[\da-f]+)/i))) {
            kind = "gem5";
            const physical = Number(m[1]),
                id = owners.get(physical),
                logical = logicalForPhysical.get(physical);
            // 所有者を観測していないwriteは値の観測として保持し、架空の命令へ結び付けない。
            emit(
                id === undefined
                    ? { type: "observe", cycle: tick, physical, hex: m[2], line: lineNumber }
                    : {
                          type: "write",
                          cycle: tick,
                          id,
                          ...(logical === undefined ? {} : { logical }),
                          physical,
                          hex: m[2],
                          line: lineNumber
                      }
            );
        }
    }
    function rsd(fields: string[]) {
        const command = fields[0],
            id = Number(fields[1]);
        if (!["L", "S", "R"].includes(command) || !Number.isSafeInteger(id) || id < 0) return;
        let r = active.get(id);
        if (command === "L" && fields[2] === "1") {
            const message = (fields[3] ?? "").replace(/\\n/g, " ").trim();
            const notice = /Br-pred-miss/i.test(message)
                ? "branch-mispredict"
                : /D\$[ -]miss/i.test(message)
                  ? "dcache-miss"
                  : /i-cache-miss/i.test(message)
                    ? "icache-miss"
                    : null;
            if (notice)
                journal.add({
                    kind: "notice",
                    data: { cycle, sourceCycle, id, kind: notice, message, line: lineNumber }
                });
            const map = mappingFrom(message);
            if (map) {
                kind = "rsd";
                r ??= { label: "", ready: null };
                r.map = { cycle, line: lineNumber, dest: map.dest };
                for (const d of map.dest.filter((d) => d.logical !== 0)) {
                    emit({ type: "rename", cycle, id, ...d, line: lineNumber });
                    if (d.previous !== undefined)
                        allocate(d.previous, cycle, "allocated", "previous mapping", lineNumber);
                    allocate(d.physical, cycle, "allocated", "rename", lineNumber);
                }
                for (const s of map.source) checkRegister(s.physical, s.logical);
            }
            const load = message.match(/#(0x[\da-f]+)\s*=\s*load\(\)/i),
                alu = message.match(/\bd:(0x[\da-f]+)\s*=\s*fu\(/i);
            if (r && (load || alu)) {
                const result = { cycle, hex: (load ?? alu)![1], line: lineNumber };
                if (load) r.lastLoad = result;
                else r.lastAlu = result;
                if (r.ready === cycle)
                    r.result = !r.label ? undefined : /\b(?:lb|lbu|lh|lhu|lw)\s/.test(r.label) ? r.lastLoad : r.lastAlu;
            }
        }
        if (r && command === "L" && fields[2] === "0") r.label = fields[3] ?? "";
        if (r && command === "S" && fields[2] === "0" && fields[3] === "Rw") {
            r.ready = cycle;
            r.result = !r.label ? undefined : /\b(?:lb|lbu|lh|lhu|lw)\s/.test(r.label) ? r.lastLoad : r.lastAlu;
        }
        if (command === "R") {
            const flush = fields[3] !== "0";
            for (const d of r?.map?.dest.filter((d) => d.logical !== 0) ?? []) {
                if (r!.result && r!.ready !== null && r!.ready < cycle)
                    emit({
                        type: "write",
                        cycle: r!.ready,
                        id,
                        logical: d.logical,
                        physical: d.physical,
                        hex: r!.result.hex,
                        line: r!.result.line,
                        observedCycle: r!.result.cycle
                    });
                const freed = flush ? d.physical : d.previous;
                if (freed !== undefined && d.previous !== d.physical)
                    allocate(freed, cycle, "free", flush ? "squash (inferred)" : "commit (inferred)", undefined, id);
                if (flush && d.previous !== undefined) emit({ type: "restore", cycle, id, ...d, previous: d.previous });
            }
            active.delete(id);
        } else if (r) {
            active.set(id, r);
            if (active.size > maxActive) throw new Error("Too many unfinished register annotations.");
        }
    }
    function observeLine(line: string) {
        lineNumber++;
        const thread = /\[tid:(\d+)\]/.exec(line);
        if (thread) threads.add(Number(thread[1]));
        if (line.startsWith("I\t")) {
            const fields = line.split("\t"),
                id = Number(fields[1]),
                tid = Number(fields[3]);
            if (Number.isSafeInteger(tid) && tid >= 0) threads.add(tid);
            // mapを持たないラベルの仮保存は有界にする。退役後のLで再作成しない。
            if (Number.isSafeInteger(id) && id >= 0 && active.size < maxActive && !active.has(id))
                active.set(id, { label: "", ready: null });
            return;
        }
        if (line.startsWith("C\t")) {
            cycle += Number(line.slice(2));
            sourceCycle += Number(line.slice(2));
            journal.advance(cycle);
            return;
        }
        if (line.startsWith("C=\t")) {
            sourceCycle = Number(line.slice(3));
            return;
        }
        if (/^[LSR]\t/.test(line)) {
            rsd(line.split("\t"));
            return;
        }
        const stamp = /^(\d+):/.exec(line);
        if (stamp) {
            const tick = Number(stamp[1]);
            journal.advance(tick);
            gem5(line, tick);
        }
    }
    function windowEvidence(
        first: number,
        last: number,
        sampleOps: readonly Readonly<Op>[] = [],
        getOp: (id: number) => Readonly<Op> | null | undefined = () => null
    ) {
        const calibration = clock.snapshot();
        const gem = kind === "gem5";
        const toCycle = (time: number) => (gem && calibration ? windows.storeCycle(calibration, time) : time);
        const toTime = (time: number) =>
            gem && calibration ? calibration.tick + (time - calibration.cycle) * calibration.period : time;
        if (gem && !calibration) return { registers: null, scheduling: null, events: [] as RsdEvent[] };
        const found = journal.range(toTime(first), toTime(last));
        const mapping = found.initial.mapping,
            values = found.initial.values;
        const ownerMap = new Map<number, number>(
            Array.from({ length: config.integerRegisters ?? 0 }, (_, p) => [p, -p - 1])
        );
        for (const [p, id] of found.initial.owners) ownerMap.set(p, gem ? idFor(id) : id);
        const initialOwners = [...ownerMap];
        const registerEvents: RegisterEvent[] = [],
            allocation: AllocationEvent[] = [],
            reads: Read[] = [],
            events: RsdEvent[] = [];
        for (const entry of found.entries) {
            const data = { ...entry.data, cycle: toCycle(entry.data.cycle) };
            if (gem && "id" in data && typeof data.id === "number") data.id = idFor(data.id);
            if (entry.kind === "register") registerEvents.push(data as RegisterEvent);
            if (entry.kind === "allocation") allocation.push(data as AllocationEvent);
            if (entry.kind === "read") reads.push(data as Read);
            if (entry.kind === "notice") events.push(data as RsdEvent);
        }
        const layout = logicalLayout(config.isa ?? (kind === "rsd" ? "riscv" : undefined), [
            ...mapping.map(([logical]) => logical),
            ...registerEvents.flatMap((e) => ("logical" in e && e.logical !== undefined ? [e.logical] : []))
        ]);
        let registerData: replay.Registers | null = kind
            ? {
                  kind: "recorded",
                  label: gem ? "gem5 O3CPUAll · integer rename / RegFile access" : "RSD rename / writeback annotations",
                  ...(gem ? { origin: "gem5", logicalPrefix: "i" } : { constantRows: [0] }),
                  ...layout,
                  ...(config.integerRegisters === undefined ? {} : { capacity: config.integerRegisters }),
                  ...(config.wordBits === undefined ? {} : { wordBits: config.wordBits }),
                  initial: { mapping, values, owners: initialOwners },
                  events: registerEvents,
                  allocation: {
                      kind: gem ? "recorded" : "inferred",
                      label: gem
                          ? "gem5 rename / commit free-list / delayed squash reclamation"
                          : "Allocation from RSD rename; release inferred at commit / squash. Observed cells only.",
                      initial: found.initial.allocation,
                      events: allocation
                  },
                  reads
              }
            : config.isa || config.integerRegisters
              ? {
                    kind: "configuration",
                    label: "Register configuration; mappings and values not logged",
                    ...layout,
                    ...(config.integerRegisters === undefined ? {} : { capacity: config.integerRegisters }),
                    ...(config.wordBits === undefined ? {} : { wordBits: config.wordBits }),
                    initial: { mapping: [], values: [], owners: initialOwners },
                    events: [],
                    reads: []
                }
              : null;
        // 整数mapのthread帰属を完全に分離できないログでは、SMTの値を混ぜて表示しない。
        if (threads.size > 1) registerData = null;
        const scheduling: replay.Scheduling | null =
            kind === "rsd" && threads.size <= 1
                ? {
                      kind: "recorded",
                      label: "Physical register dependencies · RSD map annotations",
                      ops: sampleOps.map((op) => {
                          const map = mappingFrom(op.labelDetail.replace(/\n/g, " "));
                          const stages = op.lanes.flatMap((lane) => lane?.stages ?? []);
                          const at = (
                              stages.find((stage) => stage.labels?.includes("map:")) ??
                              stages.find((stage) => stage.name === "Ds")
                          )?.startCycle;
                          const state = at === undefined ? null : journal.range(at, at);
                          const writers = new Map(state?.initial.owners);
                          for (const entry of state?.entries ?? [])
                              if (entry.kind === "register" && entry.data.type === "rename" && entry.data.id < op.id)
                                  writers.set(entry.data.physical, entry.data.id);
                          const sources = map?.source.filter((s) => s.logical !== 0) ?? [];
                          const dependencies = sources.flatMap((source) => {
                              const id = writers.get(source.physical);
                              return id === undefined
                                  ? []
                                  : [
                                        {
                                            id,
                                            ready: ready(getOp(id)),
                                            register: `r${source.logical} / p${source.physical}`
                                        }
                                    ];
                          });
                          const slot = Number(op.labelDetail.match(/IQ alloc:\s*(\d+)/)?.[1]);
                          return { id: op.id, dependencies, sources, ...(Number.isFinite(slot) ? { slot } : {}) };
                      })
                  }
                : sampleOps.some((op) => op.prods.length)
                  ? {
                        kind: "recorded",
                        label: "Recorded dependency edges",
                        ops: sampleOps.map((op) => ({
                            id: op.id,
                            dependencies: op.prods.map((d) => ({ id: d.opID, ready: ready(getOp(d.opID)) }))
                        }))
                    }
                  : null;
        return { registers: registerData, scheduling, events };
    }
    function clear() {
        journal.clear();
        clock.clear();
        threads.clear();
        observedRows.clear();
        physicals.clear();
        sequences.length = 0;
        owners.clear();
        logicalForPhysical.clear();
        history.clear();
        squashed.clear();
        active.clear();
        cycle = sourceCycle = lineNumber = 0;
        kind = null;
        renameSeq = renameTick = executeSeq = executeTick = -1;
        pending = null;
    }
    return {
        observeLine,
        observeOp,
        windowEvidence,
        clear,
        stats: () => ({
            ...journal.stats(),
            activeRecords: active.size + history.size,
            sequenceRanges: sequences.length,
            observedRegisters: physicals.size,
            lineCount: lineNumber
        })
    };
}

const evidence = { createEvidenceIndex, logicalLayout };
namespace evidence {
    export type Configuration = Config;
    export type Event = RsdEvent;
}
export = evidence;

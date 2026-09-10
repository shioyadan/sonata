import fs from "node:fs";
import type { Op } from "../vendor/konata-core/model";
import { allocationEvidence, type AllocationEvent } from "./register-allocation";

function logicalRegisterLayout(x86: boolean, observed: Iterable<number> = []) {
    // gem5 v25.1 の arch/{x86,arm}/regs/int.hh にある整数クラスの番号を使う。
    const base = x86 ? Array.from({ length: 32 }, (_, r) => r) : [...Array.from({ length: 31 }, (_, r) => r), 38]; // AArch64 の SP_EL0。
    const rows = [...new Set([...base, ...observed])].sort((a, b) => a - b);
    const x86Names = [
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
            x86 ? (x86Names[r] ?? (r < 32 ? `t${r - 16}` : `i${r}`)) : r < 31 ? `x${r}` : r === 38 ? "SP_EL0" : `i${r}`
        ])
    );
    return { rows, logicalNames };
}

// gem5 の O3CPUAll トレースに実際に出力された整数レジスタのイベントだけを扱う。
export function readGem5Registers(
    fileName: string,
    allOps: Readonly<Op>[],
    firstCycle: number,
    lastCycle: number,
    prefixBytes = 24 * 1024 * 1024
) {
    const fd = fs.openSync(fileName, "r"),
        buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, prefixBytes));
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const lines = buffer.subarray(0, size).toString("utf8").split("\n"),
        bySeq = new Map(allOps.map((o) => [o.gid, o.id]));
    let tickBase: number | undefined;
    for (const line of lines) {
        const f = line.match(/^O3PipeView:fetch:(\d+):[^:]+:[^:]+:(\d+):/);
        if (!f) continue;
        const op = allOps.find((o) => o.gid === Number(f[2]));
        if (op) {
            tickBase = Number(f[1]) - op.fetchedCycle * 500;
            break;
        }
    }
    if (tickBase === undefined) throw new Error("Missing gem5 tick origin");
    const owners = new Map<number, number>(Array.from({ length: 256 }, (_, p) => [p, -p - 1]));
    const logicalForPhysical = new Map<number, number>(),
        events: any[] = [],
        reads: any[] = [];
    const allocations: AllocationEvent[] = [],
        history = new Map<number, any[]>(),
        squashed = new Map<number, number[]>();
    const allocated = (physical: number, cycle: number, line: number, reason: string) =>
        allocations.push({ physical, cycle, line, state: "allocated", reason });
    let renameID: number | undefined,
        renameSeq = -1,
        renameTick = -1,
        executeID: number | undefined,
        executeTick = -1,
        pending: { physical: number; previous: number } | null = null;
    for (const [index, line] of lines.entries()) {
        const stamp = line.match(/^(\d+):/);
        if (!stamp) continue;
        const tick = Number(stamp[1]),
            cycle = (tick - tickBase) / 500;
        if (cycle > lastCycle + 1) break;
        let m;
        if ((m = line.match(/\.rename:.*Processing instruction \[sn:(\d+)\]/))) {
            renameSeq = Number(m[1]);
            renameID = bySeq.get(renameSeq) ?? -1000000 - renameSeq;
            renameTick = tick;
            pending = null;
        }
        if ((m = line.match(/\.rename:.*Looking up integer arch reg (\d+), got phys reg (\d+)/))) {
            events.push({ type: "map", cycle, logical: Number(m[1]), physical: Number(m[2]), line: index + 1 });
            allocated(Number(m[2]), cycle, index + 1, "source mapping");
        }
        if ((m = line.match(/Renamed reg .* to physical reg (\d+) \(\d+\) old mapping was (\d+)/)))
            pending = { physical: Number(m[1]), previous: Number(m[2]) };
        if (
            (m = line.match(/\.rename:.*Renaming arch reg (\d+) \(integer\) to physical reg (\d+)/)) &&
            renameTick === tick &&
            renameID !== undefined
        ) {
            const logical = Number(m[1]),
                physical = Number(m[2]);
            if (pending?.physical !== physical) continue;
            events.push({
                type: "rename",
                cycle,
                id: renameID,
                logical,
                physical,
                previous: pending.previous,
                line: index + 1
            });
            const entries = history.get(renameSeq) ?? [];
            entries.push({ logical, physical, previous: pending.previous });
            history.set(renameSeq, entries);
            allocated(pending.previous, cycle, index + 1, "previous mapping");
            allocated(physical, cycle, index + 1, "rename");
            owners.set(physical, renameID);
            logicalForPhysical.set(physical, logical);
            pending = null;
        }
        if (
            (m = line.match(
                /Removing history entry with sequence number (\d+) \(archReg: (\d+), newPhysReg: (\d+), prevPhysReg: (\d+)\)/
            ))
        ) {
            const seq = Number(m[1]),
                logical = Number(m[2]),
                physical = Number(m[3]),
                previous = Number(m[4]),
                entries = history.get(seq) ?? [];
            // 物理番号はレジスタクラス間で重なる。256 未満をすべて整数と扱わず、
            // 実際に記録された整数レジスタの rename と照合する。
            const match = entries.findIndex(
                (e) => e.logical === logical && e.physical === physical && e.previous === previous
            );
            if (match >= 0) {
                entries.splice(match, 1);
                events.push({
                    type: "restore",
                    cycle,
                    id: bySeq.get(seq) ?? -1,
                    logical,
                    physical,
                    previous,
                    line: index + 1
                });
                if (physical !== previous) {
                    const tid = Number(line.match(/\[tid:(\d+)\]/)?.[1] ?? 0),
                        pendingFree = squashed.get(tid) ?? [];
                    pendingFree.push(physical);
                    squashed.set(tid, pendingFree);
                }
            }
        }
        if ((m = line.match(/Freeing up older rename of reg (\d+) \(integer\), \[sn:(\d+)\]/))) {
            const physical = Number(m[1]),
                entries = history.get(Number(m[2])) ?? [],
                match = entries.findIndex((e) => e.previous === physical);
            const entry = match < 0 ? null : entries.splice(match, 1)[0];
            if (physical < 256 && entry?.physical !== physical)
                allocations.push({ cycle, physical, state: "free", reason: "commit", line: index + 1 });
        }
        if (line.includes("Freeing phys regs of misspeculated instructions")) {
            const tid = Number(line.match(/\[tid:(\d+)\]/)?.[1] ?? 0);
            for (const physical of squashed.get(tid) ?? [])
                allocations.push({ cycle, physical, state: "free", reason: "squash reclamation", line: index + 1 });
            squashed.delete(tid);
        }
        if ((m = line.match(/Execute: Processing PC .*\[sn:(\d+)\]/))) {
            executeID = bySeq.get(Number(m[1]));
            executeTick = tick;
        }
        if ((m = line.match(/RegFile: Access to int register (\d+), has data (0x[\da-f]+)/i))) {
            const physical = Number(m[1]),
                hex = m[2];
            events.push({ type: "observe", cycle, physical, hex, line: index + 1 });
            if (executeID !== undefined && executeTick === tick)
                reads.push({ id: executeID, cycle, physical, hex, line: index + 1 });
        }
        if ((m = line.match(/RegFile: Setting int register (\d+) to (0x[\da-f]+)/i))) {
            const physical = Number(m[1]);
            events.push({
                type: "write",
                cycle,
                id: owners.get(physical),
                logical: logicalForPhysical.get(physical) ?? null,
                physical,
                hex: m[2],
                line: index + 1
            });
        }
    }
    const initial = {
        mapping: new Map<number, number>(),
        values: new Map<number, string>(),
        owners: new Map<number, number>(Array.from({ length: 256 }, (_, p) => [p, -p - 1]))
    };
    for (const e of events) {
        if (e.cycle >= firstCycle) break;
        if (e.type === "map") initial.mapping.set(e.logical, e.physical);
        else if (e.type === "rename") {
            initial.mapping.set(e.logical, e.physical);
            initial.owners.set(e.physical, e.id);
            initial.values.delete(e.physical);
        } else if (e.type === "restore" && initial.mapping.get(e.logical) === e.physical)
            initial.mapping.set(e.logical, e.previous);
        else if (e.type === "observe" || (e.type === "write" && initial.owners.get(e.physical) === e.id))
            initial.values.set(e.physical, e.hex);
    }
    const window = events.filter((e) => e.cycle >= firstCycle && e.cycle <= lastCycle),
        x86 = fileName.includes("/x86/");
    const { rows, logicalNames } = logicalRegisterLayout(x86, [
        ...initial.mapping.keys(),
        ...window.filter((e) => e.logical !== null && e.logical !== undefined).map((e) => e.logical)
    ]);
    return {
        kind: "recorded",
        label: "gem5 O3CPUAll · integer rename / RegFile access",
        origin: "gem5",
        capacity: 256,
        logicalPrefix: "i",
        wordBits: 64,
        rows,
        logicalNames,
        initial: { mapping: [...initial.mapping], values: [...initial.values], owners: [...initial.owners] },
        events: window,
        allocation: allocationEvidence(
            allocations,
            firstCycle,
            lastCycle,
            "recorded",
            "gem5 rename / commit free-list / delayed squash reclamation"
        ),
        reads: reads.filter((r) => r.cycle >= firstCycle && r.cycle <= lastCycle)
    };
}

export function configuredGem5Registers() {
    return {
        kind: "configuration",
        label: "256 integer physical registers from config.ini; mappings and values not logged",
        origin: "gem5",
        capacity: 256,
        logicalPrefix: "i",
        wordBits: 64,
        ...logicalRegisterLayout(false),
        initial: { mapping: [], values: [], owners: Array.from({ length: 256 }, (_, p) => [p, -p - 1]) },
        events: [],
        reads: []
    };
}

import type { Op } from "../vendor/konata-core/model";
import evidence = require("../src/trace-evidence.cts");
import { evidenceLines } from "./evidence-input";

// File/HTTPのWorkerと同じ解析器を使い、名前からISAや記録の有無を推測しない。
export function readGem5Registers(
    fileName: string,
    allOps: Readonly<Op>[],
    firstCycle: number,
    lastCycle: number,
    prefixBytes = 24 * 1024 * 1024,
    config: evidence.Configuration = {}
) {
    const index = evidence.createEvidenceIndex(config);
    for (const line of evidenceLines(fileName, prefixBytes)) index.observeLine(line);
    for (const op of allOps) index.observeOp(op, "gem5");
    return index.windowEvidence(firstCycle, lastCycle).registers;
}

export function configuredGem5Registers(config: evidence.Configuration = {}) {
    if (config.integerRegisters === undefined) return null;
    return {
        kind: "configuration",
        label: `${config.integerRegisters} integer physical registers from configuration; mappings and values not logged`,
        origin: "gem5",
        capacity: config.integerRegisters,
        logicalPrefix: "i",
        ...(config.wordBits === undefined ? {} : { wordBits: config.wordBits }),
        ...evidence.logicalLayout(config.isa, []),
        initial: {
            mapping: [],
            values: [],
            owners: Array.from({ length: config.integerRegisters }, (_, p) => [p, -p - 1])
        },
        events: [],
        reads: []
    };
}

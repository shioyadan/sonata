"use strict";
// 公開カタログの短いデモだけを取得する。手元のFileと再生モデルは別に寿命を持つ。
import type replay = require("./replay-model.cts");

interface CatalogEntry {
    key: string;
    label: string;
    url: string;
}

function createLoader(catalog: readonly CatalogEntry[], pageURL: string) {
    const page = new URL(pageURL);
    const online = page.protocol === "https:" || page.protocol === "http:";
    const cache = new Map<string, replay.Trace>();
    let revision = 0;
    let controller: AbortController | null = null;
    function cancel() {
        revision++;
        controller?.abort();
        controller = null;
    }
    async function load(key: string): Promise<replay.Trace | null> {
        cancel();
        const request = revision;
        const entry = catalog.find((entry) => entry.key === key);
        if (!entry) throw new Error("Unknown sample. Choose a sample from the list.");
        if (!online)
            throw new Error(
                "Samples require the online site or a local HTTP server. Open a trace file to use Sonata offline."
            );
        // URLはビルドが用意した同じディレクトリのJSONだけ。hashを取得先に使わない。
        if (!/^[a-z0-9-]+$/.test(entry.key) || entry.url !== `samples/${entry.key}.json`)
            throw new Error("Invalid sample URL.");
        const cached = cache.get(key);
        if (cached) {
            cache.delete(key);
            cache.set(key, cached);
            return cached;
        }
        const next = new AbortController();
        controller = next;
        try {
            const response = await fetch(new URL(entry.url, page), { signal: next.signal, redirect: "error" });
            if (!response.ok) throw new Error(`Could not load ${entry.label}. HTTP ${response.status}.`);
            const trace: replay.Trace = await response.json();
            if (request !== revision) return null;
            if (
                trace?.key !== key ||
                !Array.isArray(trace.ops) ||
                !trace.structure?.frontNodes?.length ||
                !Array.isArray(trace.structure.executionNodes) ||
                !Array.isArray(trace.demo?.bookmarks) ||
                !trace.demo.provenance ||
                !Number.isFinite(trace.firstCycle) ||
                !Number.isFinite(trace.lastCycle)
            )
                throw new Error(`Invalid sample data for ${entry.label}.`);
            cache.set(key, trace);
            if (cache.size > 5) cache.delete(cache.keys().next().value!);
            return trace;
        } catch (error) {
            if (request !== revision) return null;
            throw error;
        } finally {
            if (controller === next) controller = null;
        }
    }
    return {
        load,
        cancel,
        forget: (key: string) => cache.delete(key),
        online,
        get revision() {
            return revision;
        }
    };
}

// 描画資源を一度だけ組み立てるための未選択状態。実トレースや観測値として表示しない。
function emptyTrace(): replay.Trace {
    return {
        key: "",
        label: "No trace selected",
        fileName: "",
        parser: "",
        machineOrder: "unknown",
        firstCycle: 0,
        lastCycle: 1,
        initialCycle: 0,
        fetchWidth: 1,
        retireWidth: 1,
        ops: [],
        structure: {
            queueCapacity: 1,
            robCapacity: 1,
            allocationWidth: 1,
            frontNodes: [{ id: "fetch", names: ["F"] }],
            executionNodes: [{ id: "exec-int", kind: "integer", names: ["Ex"], pipeCount: 1 }],
            memoryWait: null
        },
        topDown: null,
        demo: {
            events: [],
            bookmarks: [],
            screenshotCycle: 0,
            theme: "",
            provenance: {
                simulator: "",
                workload: "",
                processor: "",
                configuration: "",
                note: "",
                workloadKnown: false
            }
        }
    };
}

const demos = { createLoader, emptyTrace };
namespace demos {
    export type Entry = CatalogEntry;
}
export = demos;

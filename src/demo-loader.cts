"use strict";
// 公開サンプルもFileと同じWorkerで解析し、表示する短い区間だけをキャッシュする。
import type replay = require("./replay-model.cts");
import type files = require("./trace-file.cts");

interface CatalogEntry {
    key: string;
    label: string;
    url: string;
    name: string;
    size: number;
    firstCycle: number;
    lastCycle: number;
    initialCycle: number;
    provenance: replay.Trace["demo"]["provenance"];
    theme: string;
    bookmarks: replay.Trace["demo"]["bookmarks"];
    screenshotCycle: number;
    config?: files.TraceConfiguration;
}

function createLoader(catalog: readonly CatalogEntry[], pageURL: string) {
    const page = new URL(pageURL);
    const online = page.protocol === "https:" || page.protocol === "http:";
    const cache = new Map<string, replay.Trace>();
    let revision = 0;
    let abort: (() => void) | null = null;
    function cancel() {
        revision++;
        abort?.();
        abort = null;
    }
    function prepare(entry: CatalogEntry): Promise<replay.Trace | null> {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(
                new Blob([globalThis.sonataTraceWorkerSource], { type: "text/javascript" })
            );
            let worker: Worker;
            try {
                worker = new Worker(url);
            } finally {
                URL.revokeObjectURL(url);
            }
            let requested = false;
            let settled = false;
            function finish(trace: replay.Trace | null, error?: Error) {
                if (settled) return;
                settled = true;
                if (abort === stop) abort = null;
                const timeout = setTimeout(() => worker.terminate(), 500);
                worker.onmessage = (event: MessageEvent<files.WorkerResponse>) => {
                    if (event.data.type !== "closed") return;
                    clearTimeout(timeout);
                    worker.terminate();
                };
                worker.postMessage({ type: "close" } satisfies files.WorkerRequest);
                if (error) reject(error);
                else resolve(trace);
            }
            const stop = () => finish(null);
            abort = stop;
            worker.onerror = () => finish(null, new Error("The sample reader could not start."));
            worker.onmessage = (event: MessageEvent<files.WorkerResponse>) => {
                const response = event.data;
                if (response.type === "error") finish(null, new Error(response.message));
                else if (response.type === "loaded" && response.source.complete && !requested) {
                    if (response.source.firstCycle > entry.firstCycle || response.source.lastCycle < entry.lastCycle) {
                        finish(null, new Error(`The sample does not contain the selected interval: ${entry.label}.`));
                        return;
                    }
                    requested = true;
                    worker.postMessage({
                        type: "window",
                        request: 1,
                        cycle: entry.firstCycle,
                        span: entry.lastCycle - entry.firstCycle + 1,
                        thread: response.source.threads[0]
                    } satisfies files.WorkerRequest);
                } else if (response.type === "window" && response.request === 1) {
                    const trace = response.trace;
                    trace.key = entry.key;
                    trace.label = entry.label;
                    trace.initialCycle = entry.initialCycle;
                    trace.demo = {
                        ...trace.demo,
                        provenance: structuredClone(entry.provenance),
                        theme: entry.theme,
                        bookmarks: structuredClone(entry.bookmarks),
                        screenshotCycle: entry.screenshotCycle
                    };
                    finish(trace);
                }
            };
            worker.postMessage({
                type: "open",
                remote: { url: new URL(entry.url, page).href, name: entry.name, size: entry.size },
                config: entry.config
            } satisfies files.WorkerRequest);
        });
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
        // URLはビルドが用意した同じディレクトリの生トレースだけ。hashを取得先に使わない。
        if (!/^[a-z0-9-]+$/.test(entry.key) || !/^samples\/[a-z0-9-]+\.log\.gz$/.test(entry.url))
            throw new Error("Invalid sample URL.");
        const cached = cache.get(key);
        if (cached) {
            cache.delete(key);
            cache.set(key, cached);
            return cached;
        }
        const trace = await prepare(entry);
        if (request !== revision || !trace) return null;
        cache.set(key, trace);
        if (cache.size > 5) cache.delete(cache.keys().next().value!);
        return trace;
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

import type { ParsedTrace } from "./model.ts";
import type { MutableOpStore } from "./op_store.ts";

// Worker実装のlib.webworker型をDOM側へ引き込まず、呼出側が使う公開契約だけを示す。
// check-core.cjsで元実装との代入互換と、誤った呼出しが拒否されることを検査する。
declare namespace core {
    interface TraceInput {
        readonly name: string;
        readonly size: number;
        readonly type: string;
        stream(signal?: AbortSignal): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
    }
    interface LineReader {
        readonly name: string;
        readonly progress: number;
        readonly canceled: boolean;
        readLines(
            onLine: (line: string) => void,
            onProgress?: (progress: number) => void,
            signal?: AbortSignal
        ): Promise<void>;
        cancel(): Promise<void>;
    }
    interface ParseCallbacks {
        readonly onProgress?: (progress: number) => void;
        readonly onTrace?: (trace: ParsedTrace) => void;
    }
    interface ParseResult {
        readonly trace: ParsedTrace;
        readonly parserName: "OnikiriParser" | "Gem5O3PipeViewParser";
        readonly elapsedMilliseconds: number;
    }
    interface Parser {
        readonly name: string;
        parse(
            reader: LineReader,
            onProgress?: (progress: number) => void,
            onUpdate?: (trace: ParsedTrace) => void,
            signal?: AbortSignal
        ): Promise<ParsedTrace>;
    }
    interface PageOptions {
        pageSizeBits?: number;
        maxDecodedPages?: number;
        maxCachedOps?: number;
        levelSpans?: readonly number[];
    }
    interface PageStore extends MutableOpStore {
        readonly pageCodec: "json" | "zstd";
        readonly serializedPageCount: number;
        readonly decodedPageCount: number;
        readonly serializedCharacterCount: number;
        readonly storedSize: number;
        readonly opCacheAccessCount: number;
        readonly opCacheHitCount: number;
        waitForPendingCompression(): Promise<void>;
    }
}
declare const core: {
    readonly parseTraceFile: (
        file: core.TraceInput,
        callbacks?: core.ParseCallbacks,
        signal?: AbortSignal
    ) => Promise<core.ParseResult | null>;
    readonly StageStructureDetector: typeof import("./stage_structure_detector.ts").StageStructureDetector;
    readonly PagedOpStore: {
        new (options?: core.PageOptions): core.PageStore;
        createZstd(options?: core.PageOptions): Promise<core.PageStore>;
    };
    readonly OnikiriParser: new (store?: MutableOpStore) => core.Parser;
    readonly Gem5O3PipeViewParser: new (store?: MutableOpStore) => core.Parser;
    readonly FileLineReader: new (file: core.TraceInput) => core.LineReader;
};
export = core;

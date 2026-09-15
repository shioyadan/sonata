/**
 * 選択済みの`TraceInput`を、描画可能な`ParsedTrace`へ変換する解析境界をまとめる。
 * Kanataを先に試して形式不一致だけをgem5へ渡し、使用するPagedOpStoreの生成と、
 * 途中Traceを公開するまでの所有権をこの層が受け持つ。進捗、途中Trace、取消は
 * callbackとAbortSignalだけで呼出側へ伝え、Tab、UI Store、Reactには依存しない。
 * 完了時はParser名と所要時間も返し、表示方法やログ出力は呼出側が決める。
 */

import { Gem5O3PipeViewParser } from "./gem5_o3_pipe_view_parser";
import { FileLineReader, type TraceInput } from "./file_line_reader";
import type { ParsedTrace } from "./model";
import { OnikiriParser } from "./onikiri_parser";
import { PagedOpStore } from "./paged_op_store";

export interface TraceParseCallbacks {
    readonly onProgress?: (progress: number) => void;
    readonly onTrace?: (trace: ParsedTrace) => void;
    // 展開・行分割後の記録をParserより先に観測する。形式再判定では先頭から再通知する。
    readonly onLine?: (line: string) => void;
}

export interface TraceParseResult {
    readonly trace: ParsedTrace;
    readonly parserName: "OnikiriParser" | "Gem5O3PipeViewParser";
    readonly elapsedMilliseconds: number;
}

export async function parseTraceFile(
    file: TraceInput,
    callbacks: TraceParseCallbacks = {},
    signal?: AbortSignal,
): Promise<TraceParseResult | null> {
    const createReader = () => {
        const reader = new FileLineReader(file);
        const observe = callbacks.onLine;
        if (observe !== undefined) {
            const readLines = reader.readLines.bind(reader);
            reader.readLines = (onLine, onProgress, readSignal) => readLines((line) => {
                observe(line);
                onLine(line);
            }, onProgress, readSignal);
        }
        return reader;
    };
    let unpublishedStore: PagedOpStore | null = null;
    const closeUnpublishedStore = () => {
        unpublishedStore?.close();
        unpublishedStore = null;
    };
    const updateTrace = (trace: ParsedTrace) => {
        if (signal?.aborted) {
            return;
        }
        if (callbacks.onTrace !== undefined) {
            // 最初の公開以降、Storeの所有者は呼出側が受け取ったTraceになる。
            unpublishedStore = null;
            callbacks.onTrace(trace);
        }
    };

    try {
        let trace: ParsedTrace;
        let parserName: TraceParseResult["parserName"] = "OnikiriParser";
        let parsingStartedAt = 0;
        try {
            unpublishedStore = await PagedOpStore.createZstd();
            parsingStartedAt = performance.now();
            trace = await new OnikiriParser(unpublishedStore).parse(
                createReader(),
                callbacks.onProgress,
                updateTrace,
                signal,
            );
        }
        catch (error) {
            // 現行版と同じ順序で試し、Kanataとして不正な入力だけをgem5へ渡す。
            if (!(error instanceof Error) || error.message !== "The selected file is not a Kanata trace.") {
                throw error;
            }
            closeUnpublishedStore();
            unpublishedStore = await PagedOpStore.createZstd();
            parserName = "Gem5O3PipeViewParser";
            parsingStartedAt = performance.now();
            trace = await new Gem5O3PipeViewParser(unpublishedStore).parse(
                // Kanata判定で読んだstreamは再利用せず、先頭から読むReaderを作り直す。
                createReader(),
                callbacks.onProgress,
                updateTrace,
                signal,
            );
        }

        if (signal?.aborted) {
            trace.close();
            unpublishedStore = null;
            return null;
        }
        // 空入力などを除き通常はupdateTraceで移るが、完了値もTrace自身がStoreを所有する。
        unpublishedStore = null;
        return {
            trace,
            parserName,
            elapsedMilliseconds: performance.now() - parsingStartedAt,
        };
    }
    catch (error) {
        closeUnpublishedStore();
        throw error;
    }
}

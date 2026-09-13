"use strict";
// ファイル選択・進捗・区間移動。巨大なParsedTraceを画面側へ持ち込まない。
import type files = require("./trace-file.cts");
import type replay = require("./replay-model.cts");
declare global {
    var sonataTraceWorkerSource: string;
}

function createTraceImport({
    reset,
    apply,
    pause
}: {
    reset: () => void;
    apply: (trace: replay.Trace, preservePosition: boolean) => void;
    pause: () => void;
}) {
    const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const input = element<HTMLInputElement>("trace-file");
    const status = element<HTMLElement>("import-status");
    const progress = element<HTMLProgressElement>("import-progress");
    const cancel = element<HTMLButtonElement>("import-cancel");
    const panel = element<HTMLElement>("file-window");
    const cycle = element<HTMLInputElement>("file-cycle");
    const overview = element<HTMLInputElement>("file-overview");
    const span = element<HTMLSelectElement>("file-span");
    const thread = element<HTMLSelectElement>("file-thread");
    let worker: Worker | null = null;
    let source: files.Metadata | null = null;
    let requestID = 0;
    let loading = false;
    let selecting = false;
    let reading = "";
    let error = "";
    let displayedEnd = -Infinity;
    let refreshAfterSelection = false;
    let selection: { cycle: number; span: number; thread: number; preserve: boolean } | null = null;

    function message(text: string) {
        status.textContent = text;
        status.hidden = !text;
    }
    function updateStatus() {
        progress.hidden = !loading;
        cancel.hidden = !loading;
        panel.setAttribute("aria-busy", String(selecting));
        message(error || (selecting ? "Preparing cycle window…" : loading ? reading : ""));
    }
    function close() {
        requestID++;
        const previous = worker;
        worker = null;
        source = null;
        loading = selecting = false;
        selection = null;
        displayedEnd = -Infinity;
        refreshAfterSelection = false;
        error = reading = "";
        panel.hidden = true;
        document.querySelector('#trace-select option[value="local-file"]')?.remove();
        updateStatus();
        if (!previous) return;
        // AbortSignalで入力と子Workerを解放し、応答しない場合も寿命を有限にする。
        const timeout = setTimeout(() => previous.terminate(), 500);
        previous.onmessage = (event: MessageEvent<files.WorkerResponse>) => {
            if (event.data.type !== "closed") return;
            clearTimeout(timeout);
            previous.terminate();
        };
        previous.postMessage({ type: "close" } satisfies files.WorkerRequest);
    }
    function selectWindow(value = Number(cycle.value)) {
        if (!source || !worker) return;
        if (!Number.isFinite(value) || cycle.value === "") {
            fail("Enter a valid start cycle.");
            return;
        }
        const start = Math.max(source.firstCycle, Math.min(source.lastCycle - 1, Math.floor(value)));
        pause();
        selection = { cycle: start, span: Number(span.value), thread: Number(thread.value), preserve: false };
        cycle.value = overview.value = String(start);
        requestWindow();
    }
    function requestWindow(preserve = false) {
        if (!selection || !worker) return;
        selection.preserve = preserve && Number.isFinite(displayedEnd);
        selecting = true;
        error = "";
        updateStatus();
        worker.postMessage({
            type: "window",
            request: ++requestID,
            cycle: selection.cycle,
            span: selection.span,
            thread: selection.thread
        } satisfies files.WorkerRequest);
    }
    function refreshWindow() {
        if (!selection || !source || selecting || error) return;
        // 最初の小さな途中表示は選択幅まで伸ばす。全進捗通知で世界を再構築しない。
        if (refreshAfterSelection || displayedEnd < Math.min(source.lastCycle, selection.cycle + selection.span - 1)) {
            refreshAfterSelection = false;
            requestWindow(true);
        }
    }
    function fail(text: string) {
        selecting = false;
        error = text;
        updateStatus();
    }
    function windowFailed(text: string) {
        if (refreshAfterSelection && source?.complete) {
            selecting = false;
            error = "";
            refreshWindow();
        } else fail(text);
    }
    function openFile(file: File) {
        // 直前のファイルの圧縮storeを残したまま、もう一つの数GB入力を保持しない。
        reset();
        pause();
        loading = true;
        progress.value = 0;
        reading = `Reading ${file.name}…`;
        updateStatus();
        const url = URL.createObjectURL(new Blob([globalThis.sonataTraceWorkerSource], { type: "text/javascript" }));
        let next: Worker;
        try {
            next = new Worker(url);
        } catch (error) {
            loading = false;
            fail(error instanceof Error ? error.message : String(error));
            return;
        } finally {
            URL.revokeObjectURL(url);
        }
        worker = next;
        next.onerror = (event) => {
            if (worker !== next) return;
            event.preventDefault();
            reset();
            fail(event.message || "The trace reader stopped unexpectedly.");
        };
        next.onmessage = (event: MessageEvent<files.WorkerResponse>) => {
            if (worker !== next) return;
            const response = event.data;
            if (response.type === "progress") {
                progress.value = response.progress.value;
                reading = `${response.progress.phase === "reading" ? "Reading" : "Indexing"} ${file.name} · ${Math.floor(response.progress.value * 100)}%`;
                updateStatus();
            } else if (response.type === "loaded") {
                const previous = source;
                source = response.source;
                loading = !source.complete;
                cycle.min = overview.min = String(source.firstCycle);
                cycle.max = overview.max = String(Math.max(source.firstCycle, source.lastCycle - 1));
                if (!previous) cycle.value = overview.value = String(source.firstCycle);
                if (!previous || source.threads.join() !== previous.threads.join()) {
                    const selected = thread.value;
                    thread.replaceChildren(...source.threads.map((id) => new Option(`Thread ${id}`, String(id))));
                    if (previous && selected !== "" && source.threads.includes(Number(selected)))
                        thread.value = selected;
                }
                element<HTMLElement>("file-thread-field").hidden = source.threads.length < 2;
                element<HTMLElement>("file-summary").textContent =
                    `${source.opCount.toLocaleString()} ${loading ? "parsed instructions" : "instructions"} · cycles ${source.firstCycle.toLocaleString()}–${source.lastCycle.toLocaleString()}${source.warnings ? ` · ${source.warnings.toLocaleString()} parser warnings` : ""}`;
                element<HTMLElement>("file-partial").hidden = !loading;
                panel.hidden = false;
                updateStatus();
                if (!selection) selectWindow(source.firstCycle);
                else {
                    // 完了時も操作中の時刻・選択を保って、最後に追加された命令を反映する。
                    if (source.complete && !previous?.complete) {
                        refreshAfterSelection = true;
                        error = "";
                    }
                    refreshWindow();
                }
            } else if (response.type === "window" && response.request === requestID) {
                try {
                    apply(response.trace, selection?.preserve ?? false);
                    displayedEnd = response.trace.lastCycle;
                    cycle.value = overview.value = String(response.trace.firstCycle);
                    selecting = false;
                    updateStatus();
                    refreshWindow();
                } catch (error) {
                    windowFailed(error instanceof Error ? error.message : String(error));
                }
            } else if (
                response.type === "error" &&
                (response.request === undefined || response.request === requestID)
            ) {
                if (response.request === undefined) {
                    reset();
                    fail(response.message);
                } else windowFailed(response.message);
            }
        };
        next.postMessage({ type: "open", file } satisfies files.WorkerRequest);
    }

    element("trace-open").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
        const file = input.files?.[0];
        input.value = "";
        if (file) openFile(file);
    });
    cancel.addEventListener("click", () => {
        reset();
        message("Trace loading canceled.");
    });
    element("file-close").addEventListener("click", reset);
    element("file-go").addEventListener("click", () => selectWindow());
    cycle.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        selectWindow();
    });
    overview.addEventListener("input", () => {
        cycle.value = overview.value;
    });
    overview.addEventListener("change", () => selectWindow(Number(overview.value)));
    span.addEventListener("change", () => selectWindow());
    thread.addEventListener("change", () => selectWindow());
    element("file-previous").addEventListener("click", () => selectWindow(Number(cycle.value) - Number(span.value)));
    element("file-next").addEventListener("click", () => selectWindow(Number(cycle.value) + Number(span.value)));
    document.addEventListener("dragover", (event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    });
    document.addEventListener("drop", (event) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) openFile(file);
    });
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) reset();
    });
    return {
        close,
        openFile,
        selectWindow,
        get source() {
            return source;
        },
        get busy() {
            return loading || selecting;
        },
        get loading() {
            return loading;
        },
        get selecting() {
            return selecting;
        }
    };
}
export = createTraceImport;

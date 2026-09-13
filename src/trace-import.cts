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
    apply: (trace: replay.Trace) => void;
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
    let busy = false;

    function message(text: string) {
        status.textContent = text;
        status.hidden = !text;
    }
    function setBusy(value: boolean, loading = false) {
        busy = value;
        progress.hidden = !loading;
        cancel.hidden = !loading;
        panel.setAttribute("aria-busy", String(value));
        panel
            .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")
            .forEach((control) => {
                control.disabled = value;
            });
        // 画面更新中もファイルを閉じる操作は受け付ける。
        element<HTMLButtonElement>("file-close").disabled = false;
    }
    function close() {
        requestID++;
        const previous = worker;
        worker = null;
        source = null;
        panel.hidden = true;
        document.querySelector('#trace-select option[value="local-file"]')?.remove();
        setBusy(false);
        message("");
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
        if (!source || !worker || busy) return;
        if (!Number.isFinite(value)) return;
        const start = Math.max(source.firstCycle, Math.min(source.lastCycle - 1, Math.floor(value)));
        pause();
        setBusy(true);
        message("Preparing cycle window…");
        worker.postMessage({
            type: "window",
            request: ++requestID,
            cycle: start,
            span: Number(span.value),
            thread: Number(thread.value)
        } satisfies files.WorkerRequest);
    }
    function fail(text: string) {
        setBusy(false);
        message(text);
    }
    function openFile(file: File) {
        // 直前のファイルの圧縮storeを残したまま、もう一つの数GB入力を保持しない。
        reset();
        pause();
        setBusy(true, true);
        progress.value = 0;
        message(`Reading ${file.name}…`);
        const url = URL.createObjectURL(new Blob([globalThis.sonataTraceWorkerSource], { type: "text/javascript" }));
        let next: Worker;
        try {
            next = new Worker(url);
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
            return;
        } finally {
            URL.revokeObjectURL(url);
        }
        worker = next;
        next.onerror = (event) => {
            if (worker !== next) return;
            event.preventDefault();
            close();
            fail(event.message || "The trace reader stopped unexpectedly.");
        };
        next.onmessage = (event: MessageEvent<files.WorkerResponse>) => {
            if (worker !== next) return;
            const response = event.data;
            if (response.type === "progress") {
                progress.value = response.progress.value;
                message(
                    `${response.progress.phase === "reading" ? "Reading" : "Indexing"} ${file.name} · ${Math.floor(response.progress.value * 100)}%`
                );
            } else if (response.type === "loaded") {
                source = response.source;
                cycle.min = overview.min = String(source.firstCycle);
                cycle.max = overview.max = String(Math.max(source.firstCycle, source.lastCycle - 1));
                cycle.value = overview.value = String(source.firstCycle);
                thread.replaceChildren(...source.threads.map((id) => new Option(`Thread ${id}`, String(id))));
                element<HTMLElement>("file-thread-field").hidden = source.threads.length < 2;
                element<HTMLElement>("file-summary").textContent =
                    `${source.opCount.toLocaleString()} instructions · cycles ${source.firstCycle.toLocaleString()}–${source.lastCycle.toLocaleString()}${source.warnings ? ` · ${source.warnings.toLocaleString()} parser warnings` : ""}`;
                panel.hidden = false;
                setBusy(false);
                selectWindow(source.firstCycle);
            } else if (response.type === "window" && response.request === requestID) {
                try {
                    apply(response.trace);
                    cycle.value = overview.value = String(response.trace.firstCycle);
                    setBusy(false);
                    message("");
                } catch (error) {
                    fail(error instanceof Error ? error.message : String(error));
                }
            } else if (
                response.type === "error" &&
                (response.request === undefined || response.request === requestID)
            ) {
                if (response.request === undefined) close();
                fail(response.message);
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
        close();
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
            return busy;
        }
    };
}
export = createTraceImport;

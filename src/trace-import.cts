"use strict";
// ファイルとWorkerの寿命・区間要求・先読み。全体命令列はWorkerに保持する。
import type files = require("./trace-file.cts");
import type replay = require("./replay-model.cts");
import createNavigation = require("./trace-navigation.cts");
type View = createNavigation.Selection;
type Pending = { id: number; view: View; mode: "navigate" | "refresh" | "continue"; historyIndex?: number };
declare global {
    var sonataTraceWorkerSource: string;
}

function createTraceImport({
    reset,
    apply,
    read,
    pause
}: {
    reset: () => void;
    apply: (trace: replay.Trace, position: { cycle: number; selectedID: number | null; thread: number }) => void;
    read: () => { cycle: number; selectedID: number | null };
    pause: () => void;
}) {
    const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const input = element<HTMLInputElement>("trace-file");
    const status = element<HTMLElement>("import-status");
    const progress = element<HTMLProgressElement>("import-progress");
    const cancel = element<HTMLButtonElement>("import-cancel");
    const panel = element<HTMLElement>("file-window");
    const navigation = createNavigation({ read, navigate, search, pause });
    let worker: Worker | null = null;
    let source: files.Metadata | null = null;
    let serial = 0;
    let searchID = 0;
    let pending: Pending | null = null;
    let displayed: { view: View; end: number } | null = null;
    let prefetch: { id: number; view: View; trace?: replay.Trace } | null = null;
    let prefetchError: string | null = null;
    let loading = false;
    let reading = "";
    let error = "";
    let waiting = false;
    let refreshAfterSelection = false;

    function message(text: string) {
        status.textContent = text;
        status.hidden = !text;
    }
    function updateStatus() {
        progress.hidden = !loading;
        cancel.hidden = !loading;
        panel.setAttribute("aria-busy", String(Boolean(pending)));
        const text =
            error ||
            (pending ? "Preparing cycle window…" : waiting ? "Waiting for parsed cycles…" : loading ? reading : "");
        message(text);
        element("file-window-status").textContent = text;
        element("file-window-status").hidden = !text;
    }
    function close() {
        serial++;
        searchID++;
        const previous = worker;
        worker = null;
        source = null;
        loading = waiting = false;
        pending = null;
        displayed = null;
        prefetch = null;
        prefetchError = null;
        refreshAfterSelection = false;
        error = reading = "";
        navigation.reset();
        document.querySelector('#trace-select option[value="local-file"]')?.remove();
        updateStatus();
        if (!previous) return;
        const timeout = setTimeout(() => previous.terminate(), 500);
        previous.onmessage = (event: MessageEvent<files.WorkerResponse>) => {
            if (event.data.type !== "closed") return;
            clearTimeout(timeout);
            previous.terminate();
        };
        previous.postMessage({ type: "close" } satisfies files.WorkerRequest);
    }
    function bounded(view: View): View {
        const first = source!.firstCycle;
        const start = Math.max(first, Math.min(Math.max(first, source!.lastCycle - 1), Math.floor(view.start)));
        return { ...view, start, span: Math.max(16, Math.min(512, Math.round(view.span))) };
    }
    function navigate(view: View, historyIndex?: number) {
        if (!source || !worker) return;
        navigation.cancelGesture();
        navigation.rememberCurrent();
        // 全体位置の変更は現在の再生意図を保ち、応答待ちの間だけ時計を止める。
        waiting = false;
        prefetch = null;
        prefetchError = null;
        requestWindow(bounded(view), "navigate", historyIndex);
    }
    function selectWindow(value: number) {
        if (!source || !Number.isFinite(value)) return;
        navigate({
            start: value,
            cycle: value,
            span: displayed?.view.span ?? 128,
            thread: displayed?.view.thread ?? source.threads[0],
            selectedID: null
        });
    }
    function requestWindow(view: View, mode: Pending["mode"], historyIndex?: number) {
        if (!worker) return;
        pending = { id: ++serial, view, mode, historyIndex };
        error = "";
        updateStatus();
        worker.postMessage({
            type: "window",
            request: pending.id,
            cycle: view.start,
            span: view.span,
            thread: view.thread
        } satisfies files.WorkerRequest);
    }
    function refreshWindow() {
        if (!displayed || !source || pending || error) return;
        if (
            refreshAfterSelection ||
            displayed.end < Math.min(source.lastCycle, displayed.view.start + displayed.view.span - 1)
        ) {
            refreshAfterSelection = false;
            prefetch = null;
            prefetchError = null;
            requestWindow(displayed.view, "refresh");
        }
    }
    function fail(text: string) {
        pending = null;
        waiting = false;
        error = text;
        pause();
        updateStatus();
    }
    function windowFailed(text: string) {
        if (refreshAfterSelection && source?.complete) {
            const selection = pending;
            pending = null;
            refreshAfterSelection = false;
            if (selection) requestWindow(selection.view, selection.mode, selection.historyIndex);
        } else fail(text);
    }
    function show(trace: replay.Trace, selection: Pending) {
        const position =
            selection.mode === "refresh" && displayed
                ? read()
                : { cycle: selection.view.cycle, selectedID: selection.view.selectedID ?? null };
        position.cycle = Math.max(trace.firstCycle, Math.min(trace.lastCycle, position.cycle));
        const view = { ...selection.view, start: trace.firstCycle, ...position };
        apply(trace, { ...position, thread: view.thread });
        displayed = { view, end: trace.lastCycle };
        pending = null;
        waiting = false;
        navigation.applied(view, selection.mode === "navigate" || !navigation.snapshot(), selection.historyIndex);
        updateStatus();
        refreshWindow();
    }
    function prepareNext() {
        if (!source || !worker || !displayed || pending || prefetch || prefetchError || error) return;
        // 一つの境界サイクルを共有し、整数サイクル間の時間を飛ばさない。
        const start = displayed.end;
        if (start >= source.lastCycle || start <= displayed.view.start) return;
        const view = { ...displayed.view, start, cycle: start, selectedID: null };
        prefetch = { id: ++serial, view };
        worker.postMessage({
            type: "window",
            request: prefetch.id,
            cycle: start,
            span: view.span,
            thread: view.thread
        } satisfies files.WorkerRequest);
    }
    function advance(next: number): number | null {
        if (!displayed || !source) return null;
        if (pending) return read().cycle;
        if (element<HTMLInputElement>("file-loop").checked) {
            return next > displayed.end ? displayed.view.start : next;
        }
        if (next <= displayed.end) {
            if (displayed.end - next < displayed.view.span * 0.35) prepareNext();
            return next;
        }
        if (prefetchError || error) {
            fail(prefetchError || error);
            return displayed.end;
        }
        if (displayed.end >= source.lastCycle) {
            if (source.complete) pause();
            else {
                waiting = true;
                updateStatus();
            }
            return displayed.end;
        }
        prepareNext();
        if (!prefetch) return displayed.end;
        const view = { ...prefetch.view, cycle: next, selectedID: read().selectedID };
        const selection: Pending = { id: prefetch.id, view, mode: "continue" };
        if (prefetch.trace) {
            const trace = prefetch.trace;
            prefetch = null;
            try {
                show(trace, selection);
            } catch (error) {
                fail(error instanceof Error ? error.message : String(error));
            }
            return read().cycle;
        }
        pending = selection;
        prefetch = null;
        updateStatus();
        return displayed.end;
    }
    function seek(value: number) {
        if (!displayed || !source) return false;
        interact();
        if (value >= displayed.view.start && value <= displayed.end) return false;
        const cycle = Math.max(source.firstCycle, Math.min(source.lastCycle, value));
        const start = value < displayed.view.start ? cycle - displayed.view.span + 1 : cycle;
        navigate({ ...displayed.view, start, cycle, selectedID: read().selectedID });
        return true;
    }
    function interact() {
        navigation.cancelGesture();
        // 完了時の再取得は最新の再生位置を読んで反映するため、同区間シークでも保持する。
        if (displayed && pending?.mode !== "refresh") pending = null;
        prefetch = null;
        prefetchError = null;
        waiting = false;
        updateStatus();
        if (refreshAfterSelection) refreshWindow();
    }
    function cancelContinuation() {
        if (pending?.mode === "continue") interact();
    }
    function search(query: Omit<Extract<files.WorkerRequest, { type: "search" }>, "type" | "request">) {
        if (!worker || !source) return;
        worker.postMessage({ ...query, type: "search", request: ++searchID } satisfies files.WorkerRequest);
    }
    function openFile(file: File) {
        reset();
        pause();
        navigation.reset(file);
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
                navigation.setSource(source);
                updateStatus();
                if (!displayed && !pending) selectWindow(source.firstCycle);
                else {
                    if (source.complete && !previous?.complete) {
                        refreshAfterSelection = true;
                        prefetch = null;
                        error = "";
                    }
                    refreshWindow();
                }
            } else if (response.type === "window") {
                if (response.request === prefetch?.id) prefetch.trace = response.trace;
                else if (response.request === pending?.id) {
                    try {
                        show(response.trace, pending);
                    } catch (error) {
                        windowFailed(error instanceof Error ? error.message : String(error));
                    }
                }
            } else if (response.type === "search" && response.request === searchID) {
                navigation.found(response);
            } else if (response.type === "error") {
                if (response.operation === "search") {
                    if (response.request === searchID) navigation.searchFailed(response.message);
                } else if (response.request === undefined) {
                    reset();
                    fail(response.message);
                } else if (response.request === pending?.id) windowFailed(response.message);
                else if (response.request === prefetch?.id) {
                    // 現在区間は末尾まで再生し、境界で理由を示して停止する。
                    prefetch = null;
                    prefetchError = response.message;
                }
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
        advance,
        seek,
        interact,
        cancelContinuation,
        tick: navigation.tick,
        get source() {
            return source;
        },
        get busy() {
            return loading || Boolean(pending);
        },
        get loading() {
            return loading;
        },
        get selecting() {
            return Boolean(pending);
        },
        get searching() {
            return navigation.searching;
        },
        get view() {
            return navigation.snapshot();
        },
        get prefetched() {
            return Boolean(prefetch?.trace);
        }
    };
}
export = createTraceImport;

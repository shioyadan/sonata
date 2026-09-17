"use strict";
// ファイルとWorkerの寿命・区間要求・先読み。全体命令列はWorkerに保持する。
import type files = require("./trace-file.cts");
import replay = require("./replay-model.cts");
import createNavigation = require("./trace-navigation.cts");
type View = createNavigation.Selection;
type Pending = { id: number; view: View; mode: "navigate" | "refresh" | "continue" | "skip"; historyIndex?: number };
declare global {
    var sonataTraceWorkerSource: string;
}

function createTraceImport({
    reset,
    apply,
    read,
    pause
}: {
    reset: (reason: "open" | "close" | "error" | "restore") => void;
    apply: (
        trace: replay.Trace,
        position: { cycle: number; selectedID: number | null; thread: number }
    ) => readonly Pick<replay.Operation, "id" | "stages">[];
    read: () => { cycle: number; selectedID: number | null };
    pause: () => void;
}) {
    const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const input = element<HTMLInputElement>("trace-file");
    const status = element<HTMLElement>("import-status");
    const progress = element<HTMLProgressElement>("import-progress");
    const cancel = element<HTMLButtonElement>("import-cancel");
    const panel = element<HTMLElement>("file-window");
    const navigation = createNavigation({
        read,
        navigate,
        search,
        pause,
        beginInteraction,
        endInteraction: refreshWindow
    });
    let worker: Worker | null = null;
    let opening: AbortController | null = null;
    let source: files.Metadata | null = null;
    let serial = 0;
    let searchID = 0;
    let pending: Pending | null = null;
    let displayed: { view: View; end: number; safeUntil: number | null } | null = null;
    let prefetch: { id: number; view: View; trace?: replay.Trace } | null = null;
    let prefetchError: string | null = null;
    let loading = false;
    let reading = "";
    let error = "";
    let waiting = false;
    let refreshAfterSelection = false;
    let emptyTarget: ((cycle: number) => number | null) | null = null;
    let emptySeconds = 0;
    let waitTarget: ((cycle: number) => number | null) | null = null;
    let waitUntil: number | null = null;
    let waitSeconds = 0;
    let fastWait = false;
    let skipNotice = "";
    let noticeUntil = 0;
    const accelerationDelay = 0.15;

    function resetAcceleration() {
        emptySeconds = 0;
        waitUntil = null;
        waitSeconds = 0;
        fastWait = false;
        skipNotice = "";
    }
    function showFastWait(active: boolean) {
        if (fastWait === active) return;
        fastWait = active;
        updateStatus();
    }
    function describeSkip(from: number, to: number) {
        skipNotice = `Skipped ${Math.floor(to - from).toLocaleString()} empty cycles`;
        noticeUntil = performance.now() + 2000;
        emptySeconds = 0;
    }

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
            (pending?.mode === "skip"
                ? "Skipping empty cycles…"
                : pending
                  ? "Preparing cycle window…"
                  : waiting
                    ? "Waiting for parsed cycles…"
                    : fastWait
                      ? "Fast-forwarding wait · 16×"
                      : loading
                        ? reading
                        : skipNotice);
        message(text);
        element("file-window-status").textContent = text;
        element("file-window-status").hidden = !text;
    }
    function cancelOpening() {
        opening?.abort();
        if (!opening) return;
        opening = null;
        loading = false;
        reading = "";
        updateStatus();
    }
    function close() {
        cancelOpening();
        serial++;
        searchID++;
        const previous = worker;
        worker = null;
        source = null;
        loading = waiting = false;
        pending = null;
        displayed = null;
        emptyTarget = null;
        waitTarget = null;
        resetAcceleration();
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
        resetAcceleration();
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
    function beginInteraction() {
        resetAcceleration();
        // 指を離すまで新しい区間は作らず、解析と検索は継続する。
        if (pending?.mode === "refresh") refreshAfterSelection = true;
        pending = null;
        prefetch = null;
        prefetchError = null;
        waiting = false;
        worker?.postMessage({ type: "cancel-window" } satisfies files.WorkerRequest);
        updateStatus();
    }
    function requestWindow(view: View, mode: Pending["mode"], historyIndex?: number) {
        if (!worker) return;
        pending = { id: ++serial, view, mode, historyIndex };
        if (mode === "navigate") navigation.requested(view, historyIndex);
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
        if (!displayed || !source || pending || error || navigation.dragging) return;
        if (
            refreshAfterSelection ||
            (displayed.safeUntil !== null &&
                displayed.safeUntil <= displayed.end &&
                (source.settledCycle ?? -Infinity) > displayed.end) ||
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
        navigation.cancelGesture();
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
        const previousCycle = read().cycle;
        const position =
            selection.mode === "refresh" && displayed
                ? read()
                : { cycle: selection.view.cycle, selectedID: selection.view.selectedID ?? null };
        position.cycle = Math.max(trace.firstCycle, Math.min(trace.lastCycle, position.cycle));
        const view = { ...selection.view, start: trace.firstCycle, ...position };
        const operations = apply(trace, { ...position, thread: view.thread });
        displayed = { view, end: trace.lastCycle, safeUntil: trace.playbackSafeUntil ?? null };
        emptyTarget = replay.createEmptyPlayback(trace);
        waitTarget = replay.createWaitPlayback(trace, operations);
        waitUntil = null;
        fastWait = false;
        if (selection.mode !== "continue") {
            emptySeconds = 0;
            waitSeconds = 0;
        }
        if (selection.mode === "skip") describeSkip(previousCycle, position.cycle);
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
    function advance(next: number, seconds: number): number | null {
        if (!displayed || !source) return null;
        if (pending || navigation.dragging) return read().cycle;
        if (element<HTMLInputElement>("file-loop").checked) {
            resetAcceleration();
            return next > displayed.end ? displayed.view.start : next;
        }
        // 全体の解析が進んでも、表示窓の取得時に未公開だった命令は飛ばさない。
        const cycle = read().cycle;
        const safeUntil =
            Math.min(
                displayed.safeUntil ?? -Infinity,
                source.complete ? source.lastCycle : (source.settledCycle ?? -Infinity)
            ) - 2;
        const canAccelerate = cycle < safeUntil && !error && !prefetchError;
        const empty =
            canAccelerate && element<HTMLInputElement>("file-skip-empty").checked
                ? (emptyTarget?.(cycle) ?? null)
                : null;
        const target = empty === null || Math.min(empty, safeUntil) - cycle < 16 ? null : Math.min(empty, safeUntil);
        emptySeconds = target === null ? 0 : emptySeconds + seconds;
        if (target !== null && emptySeconds >= accelerationDelay) {
            const destination = Math.min(target, source.lastCycle);
            if (destination <= displayed.end) {
                describeSkip(read().cycle, destination);
                updateStatus();
                return destination;
            }
            // 空の窓を一つずつ取得せず、次の命令の直前へ同じ表示幅で移る。
            prefetch = null;
            requestWindow(
                {
                    ...displayed.view,
                    start: Math.floor(destination),
                    cycle: destination,
                    selectedID: read().selectedID
                },
                "skip"
            );
            return read().cycle;
        }
        if (!canAccelerate || !element<HTMLInputElement>("file-speed-waits").checked) {
            waitUntil = null;
            waitSeconds = 0;
        } else {
            // 開始後は短くなった残りも進めるが、窓交換時には記録から判定し直す。
            if (waitUntil !== null && cycle >= waitUntil) waitUntil = null;
            const target = waitUntil ?? waitTarget?.(cycle) ?? null;
            waitUntil = target === null ? null : Math.min(target, safeUntil);
            waitSeconds = waitUntil === null ? 0 : waitSeconds + seconds;
        }
        const accelerating = waitUntil !== null && waitSeconds >= accelerationDelay;
        showFastWait(accelerating);
        if (accelerating) {
            // 加速分で次の窓の未確認イベントを通り過ぎない。
            next =
                cycle < displayed.end
                    ? Math.min(waitUntil!, displayed.end, cycle + (next - cycle) * 16)
                    : Math.min(next, displayed.end + 0.001);
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
        resetAcceleration();
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
        resetAcceleration();
        if (pending?.mode === "skip") worker?.postMessage({ type: "cancel-window" } satisfies files.WorkerRequest);
        if (pending?.mode === "continue" || pending?.mode === "skip") interact();
        updateStatus();
    }
    function tick(position: number) {
        navigation.tick(position);
        if (skipNotice && performance.now() >= noticeUntil) {
            skipNotice = "";
            updateStatus();
        }
    }
    function search(query: Omit<Extract<files.WorkerRequest, { type: "search" }>, "type" | "request">) {
        if (!worker || !source) return;
        worker.postMessage({ ...query, type: "search", request: ++searchID } satisfies files.WorkerRequest);
    }
    function openFile(file: File) {
        reset("open");
        pause();
        navigation.reset(file);
        loading = true;
        progress.value = 0;
        reading = `Reading ${file.name}…`;
        updateStatus();
        startReader({ type: "open", file }, file.name);
    }
    async function openLauncher() {
        if (!["http:", "https:"].includes(location.protocol)) return;
        reset("open");
        pause();
        const controller = new AbortController();
        opening = controller;
        loading = true;
        progress.value = 0;
        reading = "Opening launcher trace…";
        updateStatus();
        try {
            // helperの固定endpointだけを使い、fragmentや応答中のURLは通信先にしない。
            const response = await fetch(new URL("/trace-info", location.href), {
                signal: controller.signal,
                redirect: "error"
            });
            if (!response.ok) throw new Error(`Could not open the launcher trace. HTTP ${response.status}.`);
            const info: unknown = await response.json();
            if (opening !== controller) return;
            if (
                !info ||
                typeof info !== "object" ||
                !("name" in info) ||
                typeof info.name !== "string" ||
                !info.name ||
                !("size" in info) ||
                typeof info.size !== "number" ||
                !Number.isSafeInteger(info.size) ||
                info.size <= 0 ||
                !("lastModified" in info) ||
                typeof info.lastModified !== "number" ||
                !Number.isSafeInteger(info.lastModified) ||
                info.lastModified < 0
            )
                throw new Error("The launcher returned invalid trace metadata.");
            opening = null;
            navigation.reset({ name: info.name, size: info.size, lastModified: info.lastModified });
            reading = `Reading ${info.name}…`;
            updateStatus();
            startReader(
                {
                    type: "open",
                    remote: { name: info.name, size: info.size, url: new URL("/trace1", location.href).href }
                },
                info.name
            );
        } catch (error) {
            if (opening !== controller) return;
            reset("error");
            fail(error instanceof Error ? error.message : String(error));
        }
    }
    function startReader(request: Extract<files.WorkerRequest, { type: "open" }>, name: string) {
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
            reset("error");
            fail(event.message || "The trace reader stopped unexpectedly.");
        };
        next.onmessage = (event: MessageEvent<files.WorkerResponse>) => {
            if (worker !== next) return;
            const response = event.data;
            if (response.type === "progress") {
                progress.value = response.progress.value;
                reading = `${response.progress.phase === "reading" ? "Reading" : "Indexing"} ${name} · ${Math.floor(response.progress.value * 100)}%`;
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
                    reset("error");
                    fail(response.message);
                } else if (response.request === pending?.id) windowFailed(response.message);
                else if (response.request === prefetch?.id) {
                    // 現在区間は末尾まで再生し、境界で理由を示して停止する。
                    prefetch = null;
                    prefetchError = response.message;
                }
            }
        };
        next.postMessage(request);
    }
    element("trace-open").addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
        const file = input.files?.[0];
        input.value = "";
        if (file) openFile(file);
    });
    cancel.addEventListener("click", () => {
        reset("close");
        message("Trace loading canceled.");
    });
    element("file-close").addEventListener("click", () => reset("close"));
    element("file-skip-empty").addEventListener("change", cancelContinuation);
    element("file-speed-waits").addEventListener("change", cancelContinuation);
    element("file-loop").addEventListener("change", cancelContinuation);
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
        if (event.persisted) reset("restore");
    });
    return {
        close,
        openFile,
        openLauncher,
        cancelOpening,
        selectWindow,
        advance,
        seek,
        interact,
        cancelContinuation,
        tick,
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

"use strict";
// 全体時間軸・検索結果・訪問履歴。ファイルと命令の寿命はimport側が所有する。
import type files = require("./trace-file.cts");

interface View {
    start: number;
    span: number;
    thread: number;
    cycle: number;
    selectedID?: number | null;
}
type Search = Omit<Extract<files.WorkerRequest, { type: "search" }>, "type" | "request">;
type SearchResult = Extract<files.WorkerResponse, { type: "search" }>;
type Bookmark = { name: string; view: View };

function createNavigation({
    read,
    navigate,
    search,
    pause
}: {
    read: () => { cycle: number; selectedID: number | null };
    navigate: (view: View, historyIndex?: number) => void;
    search: (query: Search) => void;
    pause: () => void;
}) {
    const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const overview = el<HTMLInputElement>("file-overview");
    const span = el<HTMLSelectElement>("file-span");
    const cycle = el<HTMLInputElement>("file-cycle");
    const thread = el<HTMLSelectElement>("file-thread");
    const query = el<HTMLInputElement>("file-search-query");
    const kind = el<HTMLSelectElement>("file-search-kind");
    const searchStatus = el("file-search-status");
    const searchMore = el<HTMLButtonElement>("file-search-more");
    const storageKey = "sonata.trace-bookmarks.v1";
    let source: files.Metadata | null = null;
    let view: View | null = null;
    let history: View[] = [];
    let historyIndex = -1;
    let bookmarks: Bookmark[] = [];
    let identity = "";
    let lastHit: number | undefined;
    let lastSearch: Search | null = null;
    let searching = false;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    let wheelView: View | null = null;

    function snapshot(): View | null {
        return view ? { ...view, ...read() } : null;
    }
    function clampView(next: View): View {
        const first = source!.firstCycle;
        const last = source!.lastCycle;
        const start = Math.max(first, Math.min(Math.max(first, last - 1), Math.floor(next.start)));
        const width = Math.max(16, Math.min(512, Math.round(next.span)));
        return { ...next, start, span: width, cycle: Math.max(start, Math.min(last, start + width - 1, next.cycle)) };
    }
    function go(next: View, index?: number) {
        if (!source) return;
        clearTimeout(wheelTimer);
        wheelView = null;
        navigate(clampView(next), index);
    }
    function rememberCurrent() {
        const current = snapshot();
        if (current && historyIndex >= 0) history[historyIndex] = current;
    }
    function cancelGesture() {
        clearTimeout(wheelTimer);
        wheelView = null;
        drag = null;
    }
    function goStart(start: number) {
        if (!view || !Number.isFinite(start)) return;
        go({ ...view, start, cycle: start, selectedID: null });
    }
    function controls() {
        el<HTMLButtonElement>("file-back").disabled = historyIndex <= 0;
        el<HTMLButtonElement>("file-forward").disabled = historyIndex >= history.length - 1;
        el<HTMLButtonElement>("file-zoom-in").disabled = !view || view.span <= 16;
        el<HTMLButtonElement>("file-zoom-out").disabled = !view || view.span >= 512;
        el<HTMLButtonElement>("file-previous").disabled = !view || view.start <= source!.firstCycle;
        el<HTMLButtonElement>("file-next").disabled = !view || view.start + view.span > source!.lastCycle;
        el<HTMLButtonElement>("file-first").disabled = !view;
        el<HTMLButtonElement>("file-last").disabled = !view;
    }
    function setSource(next: files.Metadata) {
        const previous = source;
        source = next;
        cycle.min = overview.min = String(source.firstCycle);
        cycle.max = overview.max = String(Math.max(source.firstCycle, source.lastCycle - 1));
        if (!previous || source.threads.join() !== previous.threads.join()) {
            const selected = thread.value;
            thread.replaceChildren(...source.threads.map((id) => new Option(`Thread ${id}`, String(id))));
            if (previous && selected !== "" && source.threads.includes(Number(selected))) thread.value = selected;
        }
        el("file-thread-field").hidden = source.threads.length < 2;
        el("file-summary").textContent =
            `${source.name} · ${source.opCount.toLocaleString()} ${source.complete ? "instructions" : "parsed instructions"}${source.warnings ? ` · ${source.warnings.toLocaleString()} parser warnings` : ""}`;
        el("file-partial").hidden = source.complete;
        el("file-read-state").textContent = source.complete
            ? "Entire file parsed. Activity shows all threads."
            : "Showing parsed cycles only; the unread cycle range is not yet known. Activity shows all threads.";
        el("file-window").hidden = el("file-tools").hidden = el("file-detail-controls").hidden = false;
        draw();
        controls();
        for (const [index, button] of el("file-bookmarks")
            .querySelectorAll<HTMLButtonElement>("[data-bookmark-jump]")
            .entries()) {
            const bookmark = bookmarks[index];
            button.disabled = bookmark.view.cycle > source.lastCycle || !source.threads.includes(bookmark.view.thread);
        }
    }
    function applied(next: View, remember: boolean, index?: number) {
        view = { ...next };
        if (remember) {
            if (index !== undefined) historyIndex = index;
            else {
                history.splice(historyIndex + 1);
                history.push({ ...view });
                if (history.length > 100) history.shift();
                historyIndex = history.length - 1;
            }
        }
        cycle.value = overview.value = String(view.start);
        // ホイールで選んだ中間倍率もselectで正しく表示する。
        span.querySelector("option[data-custom]")?.remove();
        if (![...span.options].some((option) => Number(option.value) === view!.span)) {
            const option = new Option(`${view.span} cycles`, String(view.span));
            option.dataset.custom = "true";
            span.add(option);
        }
        span.value = String(view.span);
        thread.value = String(view.thread);
        controls();
        tick(next.cycle);
        draw();
    }
    function tick(position: number) {
        if (!source || !view) return;
        const end = Math.min(source.lastCycle, view.start + view.span - 1);
        el("file-position").textContent =
            `${view.start.toLocaleString()}–${end.toLocaleString()} · cycle ${Math.floor(position).toLocaleString()}`;
    }
    function draw() {
        if (!source) return;
        const canvas = el<HTMLCanvasElement>("file-activity");
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const dpr = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        const context = canvas.getContext("2d")!;
        context.scale(dpr, dpr);
        const duration = Math.max(1, source.lastCycle - source.firstCycle + 1);
        const summary = source.overview;
        const palette = getComputedStyle(document.documentElement);
        const peak = Math.max(1, ...summary.bins.map((bin) => bin.fetched + bin.committed + bin.flushed));
        for (const [i, bin] of summary.bins.entries()) {
            const x = ((summary.firstCycle + i * summary.binWidth - source.firstCycle) / duration) * width;
            const w = Math.max(1, (summary.binWidth / duration) * width);
            let y = height;
            for (const [count, color] of [
                [bin.fetched, palette.getPropertyValue("--purple")],
                [bin.committed, palette.getPropertyValue("--cyan")],
                [bin.flushed, palette.getPropertyValue("--red")]
            ] as const) {
                const h = (count / peak) * (height - 5);
                context.fillStyle = color;
                context.globalAlpha = 0.75;
                y -= h;
                context.fillRect(x, y, w, h);
            }
        }
        if (view) {
            const viewport = el("file-viewport");
            viewport.style.left = `${((view.start - source.firstCycle) / duration) * 100}%`;
            viewport.style.width = `${(Math.min(view.span, source.lastCycle - view.start + 1) / duration) * 100}%`;
            overview.setAttribute(
                "aria-valuetext",
                `Window starts at cycle ${view.start}; parsed through ${source.lastCycle}`
            );
        }
    }
    function zoom(factor: number, fraction?: number, deferred = false) {
        if (!view || !source) return;
        const current = wheelView ?? snapshot()!;
        fraction ??= Math.max(0, Math.min(1, (current.cycle - current.start) / Math.max(1, current.span - 1)));
        const width = Math.max(16, Math.min(512, Math.round(current.span * factor)));
        if (width === current.span) return;
        const anchor = current.start + fraction * (current.span - 1);
        const next = clampView({ ...current, span: width, start: anchor - fraction * (width - 1) });
        if (!deferred) go(next);
        else {
            wheelView = next;
            clearTimeout(wheelTimer);
            wheelTimer = setTimeout(() => go(next), 100);
        }
    }
    function runSearch(more = false) {
        if (!source || !view) return;
        if (!more) {
            lastHit = undefined;
            lastSearch = { kind: kind.value as Search["kind"], query: query.value.trim(), thread: view.thread };
        }
        if (!lastSearch) return;
        searching = true;
        searchStatus.textContent = "Searching parsed instructions…";
        searchMore.hidden = true;
        search({ ...lastSearch, after: more ? lastHit : undefined });
    }
    function found(result: SearchResult) {
        searching = false;
        lastHit = result.hits.at(-1)?.id;
        searchMore.hidden = !result.more;
        searchStatus.textContent = `Thread ${lastSearch?.thread ?? 0} · ${result.hits.length} matches${result.more ? " · more available" : ""}${source?.complete ? "" : " · parsed instructions only; search again as loading continues"}`;
        el("file-search-results").replaceChildren(
            ...result.hits.map((hit) => {
                const button = document.createElement("button");
                button.className = "file-search-hit";
                const heading = document.createElement("strong");
                heading.textContent = `#${hit.id} · cycle ${hit.cycle.toLocaleString()} · thread ${hit.tid}`;
                const label = document.createElement("small");
                label.textContent = hit.label;
                button.append(heading, label);
                button.title =
                    hit.endCycle === null
                        ? "End time unobserved"
                        : `Recorded lifetime: ${hit.endCycle - hit.cycle} cycles`;
                button.addEventListener("click", () => {
                    if (!view) return;
                    // 検索は選んだ命令の時刻を観察するため停止し、区間移動の再生継続と分ける。
                    pause();
                    go({
                        ...view,
                        start: hit.cycle - Math.min(8, view.span / 4),
                        cycle: hit.cycle,
                        thread: hit.tid,
                        selectedID: hit.id
                    });
                    const panel = el<HTMLDialogElement>("mobile-panel");
                    if (panel.open) panel.close();
                });
                return button;
            })
        );
    }
    function searchFailed(message: string) {
        searching = false;
        searchStatus.textContent = message;
    }
    function validBookmark(value: unknown): value is Bookmark {
        if (!value || typeof value !== "object") return false;
        const item = value as Bookmark;
        return (
            typeof item.name === "string" &&
            item.name.length <= 100 &&
            Boolean(item.view) &&
            [item.view.start, item.view.cycle, item.view.span, item.view.thread].every(Number.isFinite) &&
            item.view.span >= 16 &&
            item.view.span <= 512 &&
            Number.isSafeInteger(item.view.thread) &&
            (item.view.selectedID == null || Number.isSafeInteger(item.view.selectedID))
        );
    }
    function saved() {
        try {
            const records: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
            return records && typeof records === "object" && !Array.isArray(records)
                ? (records as Record<string, unknown>)
                : {};
        } catch {
            return {};
        }
    }
    function saveBookmarks() {
        try {
            const records = saved();
            delete records[identity];
            const entries = Object.entries(records).slice(-19);
            entries.push([identity, bookmarks]);
            localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
        } catch {
            searchStatus.textContent = "Bookmarks are available for this session; browser storage is unavailable.";
        }
    }
    function drawBookmarks() {
        el("file-bookmarks").replaceChildren(
            ...bookmarks.map((bookmark, index) => {
                const row = document.createElement("div");
                row.className = "file-bookmark-row";
                const name = document.createElement("input");
                name.type = "text";
                name.value = bookmark.name;
                name.maxLength = 100;
                name.setAttribute("aria-label", `Bookmark ${index + 1} name`);
                name.addEventListener("change", () => {
                    bookmark.name = name.value.trim() || `Cycle ${bookmark.view.cycle}`;
                    saveBookmarks();
                });
                const jump = document.createElement("button");
                jump.dataset.bookmarkJump = "true";
                jump.textContent = "Go";
                jump.title = `Cycle ${bookmark.view.cycle} · thread ${bookmark.view.thread}`;
                jump.disabled =
                    !source || bookmark.view.cycle > source.lastCycle || !source.threads.includes(bookmark.view.thread);
                jump.addEventListener("click", () => {
                    go(bookmark.view);
                    const panel = el<HTMLDialogElement>("mobile-panel");
                    if (panel.open) panel.close();
                });
                const remove = document.createElement("button");
                remove.textContent = "×";
                remove.setAttribute("aria-label", `Remove bookmark ${index + 1}`);
                remove.addEventListener("click", () => {
                    bookmarks.splice(index, 1);
                    saveBookmarks();
                    drawBookmarks();
                });
                row.append(name, jump, remove);
                return row;
            })
        );
    }
    function reset(file?: File) {
        source = null;
        view = null;
        history = [];
        historyIndex = -1;
        searching = false;
        lastSearch = null;
        lastHit = undefined;
        cancelGesture();
        el("file-window").hidden = el("file-tools").hidden = el("file-detail-controls").hidden = true;
        el<HTMLInputElement>("file-loop").checked = false;
        el("file-search-results").replaceChildren();
        searchStatus.textContent = "";
        searchMore.hidden = true;
        kind.value = "text";
        query.value = "";
        query.disabled = false;
        query.placeholder = "PC or instruction text";
        (document.querySelector(".file-navigation-options") as HTMLDetailsElement).open = false;
        identity = file ? JSON.stringify([file.name, file.size, file.lastModified]) : "";
        const record = saved()[identity];
        bookmarks = Array.isArray(record) ? record.filter(validBookmark).slice(0, 50) : [];
        drawBookmarks();
    }
    el("file-go").addEventListener("click", () => goStart(cycle.value === "" ? NaN : Number(cycle.value)));
    cycle.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            goStart(cycle.value === "" ? NaN : Number(cycle.value));
        }
    });
    overview.addEventListener("input", () => {
        cycle.value = overview.value;
    });
    overview.addEventListener("change", () => goStart(Number(overview.value)));
    overview.addEventListener("pointermove", (event) => {
        if (!source) return;
        const rect = overview.getBoundingClientRect();
        const at =
            source.firstCycle + ((event.clientX - rect.left) / rect.width) * (source.lastCycle - source.firstCycle);
        const summary = source.overview;
        const index = Math.floor((at - summary.firstCycle) / summary.binWidth);
        const bin = summary.bins[index];
        if (!bin) return;
        const start = Math.max(source.firstCycle, summary.firstCycle + index * summary.binWidth);
        const end = Math.min(source.lastCycle, summary.firstCycle + (index + 1) * summary.binWidth - 1);
        overview.title = `Cycles ${start.toLocaleString()}–${end.toLocaleString()} · fetched ${bin.fetched.toLocaleString()} · committed ${bin.committed.toLocaleString()} · squashed ${bin.flushed.toLocaleString()} · all threads`;
    });
    span.addEventListener("change", () => {
        if (view) go({ ...snapshot()!, span: Number(span.value) });
    });
    thread.addEventListener("change", () => {
        if (view) go({ ...snapshot()!, thread: Number(thread.value), selectedID: null });
    });
    el("file-previous").addEventListener("click", () => {
        if (view) goStart(view.start - view.span);
    });
    el("file-next").addEventListener("click", () => {
        if (view) goStart(view.start + view.span);
    });
    el("file-first").addEventListener("click", () => {
        if (source) goStart(source.firstCycle);
    });
    el("file-last").addEventListener("click", () => {
        // 末尾そのものではなく最後の区間へ移動し、再生中ならその区間から続ける。
        if (source && view) goStart(Math.max(source.firstCycle, source.lastCycle - view.span + 1));
    });
    el("file-back").addEventListener("click", () => {
        if (historyIndex > 0) go(history[historyIndex - 1], historyIndex - 1);
    });
    el("file-forward").addEventListener("click", () => {
        if (historyIndex + 1 < history.length) go(history[historyIndex + 1], historyIndex + 1);
    });
    el("file-zoom-in").addEventListener("click", () => zoom(0.5));
    el("file-zoom-out").addEventListener("click", () => zoom(2));
    el("file-bookmark").addEventListener("click", () => {
        const current = snapshot();
        if (!current) return;
        if (bookmarks.length >= 50) {
            searchStatus.textContent = "Up to 50 bookmarks can be saved per file.";
            return;
        }
        bookmarks.push({ name: `Cycle ${Math.floor(current.cycle).toLocaleString()}`, view: current });
        saveBookmarks();
        drawBookmarks();
    });
    el("file-search").addEventListener("click", () => runSearch());
    searchMore.addEventListener("click", () => runSearch(true));
    query.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            runSearch();
        }
    });
    kind.addEventListener("change", () => {
        query.disabled = kind.value === "flush";
        query.placeholder =
            kind.value === "long"
                ? "Minimum lifetime in cycles"
                : kind.value === "id"
                  ? "Instruction ID"
                  : "PC or instruction text";
        query.value = kind.value === "long" ? "100" : "";
    });
    const detail = el("detail-timeline");
    const menu = document.querySelector(".file-navigation-options") as HTMLDetailsElement;
    menu.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !menu.open) return;
        event.preventDefault();
        event.stopPropagation();
        menu.open = false;
        menu.querySelector("summary")!.focus();
    });
    document.addEventListener("pointerdown", (event) => {
        if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    });
    detail.addEventListener(
        "wheel",
        (event) => {
            if (!view || !source) return;
            event.preventDefault();
            if (event.shiftKey) {
                const current = wheelView ?? snapshot()!;
                const shift = Math.sign(event.deltaY || event.deltaX) * Math.max(1, Math.round(current.span / 4));
                const next = clampView({ ...current, start: current.start + shift, cycle: current.cycle + shift });
                wheelView = next;
                clearTimeout(wheelTimer);
                wheelTimer = setTimeout(() => go(next), 100);
            } else {
                const rect = detail.getBoundingClientRect();
                zoom(
                    event.deltaY > 0 ? 1.25 : 0.8,
                    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
                    true
                );
            }
        },
        { passive: false }
    );
    let drag: { x: number; view: View; pointer: number } | null = null;
    detail.addEventListener(
        "pointerdown",
        (event) => {
            if (!view || (!event.shiftKey && event.button !== 1)) return;
            event.preventDefault();
            event.stopPropagation();
            drag = { x: event.clientX, view: snapshot()!, pointer: event.pointerId };
            detail.setPointerCapture(event.pointerId);
        },
        true
    );
    detail.addEventListener("pointerup", (event) => {
        if (!drag || event.pointerId !== drag.pointer) return;
        const shift = Math.round(((drag.x - event.clientX) / detail.clientWidth) * drag.view.span);
        const destination = { ...drag.view, start: drag.view.start + shift, cycle: drag.view.cycle + shift };
        drag = null;
        go(destination);
    });
    detail.addEventListener("pointercancel", () => {
        drag = null;
    });
    new ResizeObserver(draw).observe(el("file-overview-wrap"));
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return {
        reset,
        setSource,
        applied,
        tick,
        found,
        searchFailed,
        snapshot,
        rememberCurrent,
        cancelGesture,
        get searching() {
            return searching;
        }
    };
}
namespace createNavigation {
    export type Selection = View;
}
export = createNavigation;

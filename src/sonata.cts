"use strict";
// アプリの起動・再生時計・共通操作。描画と観測モデルには必要な依存だけを渡す。
import geometry = require("./geometry.cts");
const { clamp, smooth, rgb, instructionRadius, createPaths } = geometry;
import sonataReplay = require("./replay-model.cts");
import sceneModel = require("./scene.cts");
const { createScene, styles } = sceneModel;
import activityModel = require("./activity.cts");
const { createActivity, wakeFlightCycles } = activityModel;
import rendering = require("./renderer.cts");
const { createGpu, createRenderer } = rendering;
import cameraModel = require("./camera.cts");
import createTraceImport = require("./trace-import.cts");
const { createCamera } = cameraModel;
type CameraMode = cameraModel.Mode;
interface Session {
    cycle: number;
    playing: boolean;
    speed: number;
    selectedID: number | null;
    visualStyle: sceneModel.StyleKey;
    style: sceneModel.Style;
    reducedMotion: boolean;
    bloom: number;
    trails: boolean;
    instructionStream: boolean;
}
type ElementFor<ID extends string> = ID extends "scene" | "activity"
    ? HTMLCanvasElement
    : ID extends "license-panel" | "mobile-panel"
      ? HTMLDialogElement
      : ID extends "trace-select" | "speed"
        ? HTMLSelectElement
        : ID extends "timeline" | "bloom"
          ? HTMLInputElement
          : ID extends "show-highlight" | "next-flush"
            ? HTMLButtonElement
            : HTMLElement;
// HTML に定義した固定要素は存在を前提とし、値・描画面・ダイアログの型だけを区別する。
const $ = <ID extends string>(id: ID) => document.getElementById(id) as ElementFor<ID>;
declare global {
    var embeddedFlowTraces: sonataReplay.Trace[];
    var sonata: ReturnType<typeof start> | undefined;
}
// 権利表示は WebGL の初期化状態にかかわらず開けるようにする。
$("license-open").addEventListener("click", () => $("license-panel").showModal());
$("license-panel").addEventListener("keydown", (event) => event.stopPropagation());
const canvas = $("scene");
const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "high-performance" });
if (!gl) {
    $("fallback").hidden = false;
    document.querySelectorAll<HTMLButtonElement>("[data-style-choice]").forEach((button) => (button.disabled = true));
    $("renderer-status").textContent = "WebGL 2 unavailable";
} else start(gl);

function start(gl: WebGL2RenderingContext) {
    // 利用者の選択だけを共有し、トレース・描画結果・GPU 資源は各モジュールが所有する。
    const session: Session = {
        cycle: 0,
        playing: true,
        speed: 4,
        selectedID: null,
        visualStyle: "neon",
        style: styles.neon,
        reducedMotion: false,
        bloom: 1.7,
        trails: true,
        instructionStream: true
    };
    const clock = {
        setPlaying,
        setCycle,
        lastPlayback: { seconds: 0, cycles: 0, rate: 1 },
        lastTime: performance.now(),
        artTime: 0,
        frameCount: 0,
        fpsTime: performance.now(),
        fps: 0,
        nextUI: 0,
        animationID: null as number | null
    };
    function setPlaying(value: boolean) {
        if (!value) fileImport.cancelContinuation();
        session.playing = value;
        $("play").textContent = session.playing ? "Ⅱ" : "▶";
        $("play").setAttribute("aria-label", session.playing ? "Pause" : "Play");
        $("play").title = session.playing ? "Pause (Space)" : "Play (Space)";
        $("play-status").textContent = session.playing ? "LIVE" : "PAUSED";
    }

    function setCycle(value: number) {
        if (!Number.isFinite(value)) return;
        session.cycle = clamp(value, replay.trace.firstCycle, replay.trace.lastCycle);
        render();
        updateUI();
        // シーク時はフラッシュ通知も含め、移動先のサイクルを即座に表示する。
        $("flush-alert")
            .getAnimations()
            .forEach((animation) => animation.finish());
    }

    function step(delta: number) {
        setPlaying(false);
        const value = Math.floor(session.cycle) + delta;
        if (!fileImport.seek(value)) setCycle(value);
    }

    function windowFlushEvents() {
        return replay.flushEvents.filter(
            (cycle) => cycle >= replay.trace.firstCycle && cycle <= replay.trace.lastCycle
        );
    }

    function nextFlush() {
        const events = windowFlushEvents();
        if (!events.length) return;
        const t = events.find((t) => t > session.cycle + 0.1) ?? events[0];
        setCycle(Math.max(replay.trace.firstCycle, t - 0.65));
        setPlaying(true);
    }

    function animate(now: number) {
        if (gpu.contextLost) return;
        const dt = Math.min(0.075, Math.max(0, (now - clock.lastTime) / 1000));
        clock.lastTime = now;
        if (!document.hidden) {
            if (!session.reducedMotion) clock.artTime += dt;
            if (session.playing) {
                const duration = session.instructionStream ? sonataReplay.codeRewindDuration : 2.5;
                const next = sonataReplay.advancePlayback(session.cycle, dt, session.speed, replay.flushEvents, {
                    duration,
                    reducedMotion: session.reducedMotion
                });
                clock.lastPlayback = {
                    seconds: dt,
                    cycles: next - session.cycle,
                    rate: dt > 0 ? (next - session.cycle) / (dt * session.speed) : 1
                };
                session.cycle =
                    fileImport.advance(next) ?? (next > replay.trace.lastCycle ? replay.trace.firstCycle : next);
            }
            render(dt);
            if (now >= clock.nextUI) {
                updateUI();
                clock.nextUI = now + 80;
            }
            clock.frameCount++;
            if (now - clock.fpsTime >= 1200) {
                clock.fps = Math.round((clock.frameCount * 1000) / (now - clock.fpsTime));
                clock.frameCount = 0;
                clock.fpsTime = now;
                $("renderer-status").textContent =
                    `WebGL 2 · ${clock.fps} fps · ${gpu.msaaSamples ? `${gpu.msaaSamples}× MSAA + ` : ""}${session.style.matte ? "matte surfaces" : "smooth light"}`;
            }
        }
        clock.animationID = requestAnimationFrame(animate);
    }

    const samples = globalThis.embeddedFlowTraces;
    const gpu = createGpu({ gl, canvas, onResize: drawTimeline });
    const replaySource = sonataReplay.createReplay({ samples });
    const replay = replaySource.loadTrace(samples.find((sample) => sample.key === "rename-rush")?.key ?? "");
    const scene = createScene({ gpu, replay, session });
    const paths = createPaths<sonataReplay.Operation>({ scene, replay, session });
    const camera = createCamera({
        viewport: gpu,
        world: $("world"),
        autoCamera: $("auto-camera"),
        onPick(x, y) {
            const closest = activity.visibleParticles
                .map((p) => ({ p, d: Math.hypot(p.screen[0] - x, p.screen[1] - y) }))
                .sort((a, b) => a.d - b.d)[0];
            session.selectedID = closest && closest.d < 22 ? closest.p.op.id : null;
            clock.nextUI = 0;
        }
    });
    const activity = createActivity({ camera, clock, scene, gpu, paths, replay, session });
    const { stream, topDown } = activity;
    const renderer = createRenderer({ activity, camera, clock, gpu, session });
    const fileLayouts = new Map<string, Pick<sonataReplay.Trace, "structure" | "fetchWidth" | "retireWidth">>();

    function retainFileLayout(trace: sonataReplay.Trace, thread: number) {
        const structure = trace.structure;
        // 同じ前段構成では観測済みの表示容量を縮めない。実機の容量とは区別する。
        const key = JSON.stringify([thread, structure.frontNodes, structure.registerRead]);
        const previous = fileLayouts.get(key);
        if (previous) {
            structure.queueCapacity = Math.max(structure.queueCapacity, previous.structure.queueCapacity);
            structure.robCapacity = Math.max(structure.robCapacity, previous.structure.robCapacity);
            structure.allocationWidth = Math.max(structure.allocationWidth, previous.structure.allocationWidth);
            trace.fetchWidth = Math.max(trace.fetchWidth, previous.fetchWidth);
            trace.retireWidth = Math.max(trace.retireWidth, previous.retireWidth);
            for (const node of previous.structure.executionNodes) {
                const current = structure.executionNodes.find((item) => item.id === node.id);
                if (current) current.pipeCount = Math.max(current.pipeCount, node.pipeCount);
                else structure.executionNodes.push(structuredClone(node));
            }
        }
        if (fileLayouts.size >= 32 && !fileLayouts.has(key)) fileLayouts.delete(fileLayouts.keys().next().value!);
        fileLayouts.set(
            key,
            structuredClone({ structure, fetchWidth: trace.fetchWidth, retireWidth: trace.retireWidth })
        );
    }

    function render(dt = 0) {
        if (gpu.contextLost) return;
        renderer.render(dt);
        updateLabels(dt);
    }
    function rebuildWorld(reuse = false) {
        const previous = scene.worldBuildCount();
        paths.setGround(scene.buildWorld(reuse));
        activity.reset();
        if (scene.worldBuildCount() !== previous) renderer.buildMaterialShadow();
    }
    function loadTrace(key: string) {
        if (key === "local-file") return;
        fileImport.close();
        fileLayouts.clear();
        replaySource.loadTrace(key);
        applyTrace();
    }
    const fileImport = createTraceImport({
        reset: () => {
            loadTrace("rename-rush");
            render();
            updateUI();
        },
        pause: () => setPlaying(false),
        read: () => ({ cycle: session.cycle, selectedID: session.selectedID }),
        apply: (trace, position) => {
            const sameThread = fileImport.view?.thread === position.thread;
            const overlapStart = Math.max(replay.trace.firstCycle, trace.firstCycle);
            const overlapEnd = Math.min(replay.trace.lastCycle, trace.lastCycle);
            retainFileLayout(trace, position.thread);
            const sameFront =
                JSON.stringify([replay.trace.structure.frontNodes, replay.trace.structure.registerRead]) ===
                JSON.stringify([trace.structure.frontNodes, trace.structure.registerRead]);
            const continuityAt =
                sameThread && sameFront && overlapStart <= overlapEnd
                    ? clamp(session.cycle, overlapStart, overlapEnd)
                    : undefined;
            replaySource.loadData(trace, continuityAt === undefined ? undefined : { continuityAt });
            retainFileLayout(replay.trace, position.thread);
            let option = $("trace-select").querySelector<HTMLOptionElement>('option[value="local-file"]');
            if (!option) {
                option = new Option(trace.label, "local-file");
                $("trace-select").append(option);
            }
            option.textContent = trace.label;
            applyTrace(sameThread);
            session.cycle = clamp(position.cycle, trace.firstCycle, trace.lastCycle);
            session.selectedID = replay.ops.some((op) => op.id === position.selectedID) ? position.selectedID : null;
            render();
            updateUI();
        }
    });
    function applyTrace(reuse = false) {
        $("trace-select").value = replay.trace.key;
        session.selectedID = null;
        rebuildWorld(reuse);
        session.cycle = replay.trace.initialCycle;
        showTrace();
    }
    function setVisualStyle(key: sceneModel.StyleKey) {
        if (!Object.hasOwn(styles, key) || key === session.visualStyle || gpu.contextLost) return;
        session.visualStyle = key;
        session.style = styles[key];
        document.documentElement.dataset.style = key;
        const theme = session.style.matte ? "light" : "dark";
        document.documentElement.dataset.theme = theme;
        document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')!.content = theme;
        for (const el of document.querySelectorAll<HTMLElement>("[data-bound]")) {
            if (el.closest(".bound-bar,.bound-scene-key"))
                el.style.setProperty(
                    "--bound-color",
                    session.style.bounds[el.dataset.bound as keyof typeof session.style.bounds]
                );
        }
        for (const button of document.querySelectorAll<HTMLButtonElement>("[data-style-choice]"))
            button.setAttribute("aria-pressed", String(button.dataset.styleChoice === key));
        $("bloom").disabled = session.style.matte;
        $("bloom-value").textContent = session.style.matte ? "Not used" : `${Math.round(session.bloom * 100)}%`;
        $("trails").title = session.style.matte ? "Show the selected instruction's trail" : "Show instruction trails";
        // 時計・選択・カメラを保持し、描画用の資源だけを更新する。
        rebuildWorld();
        drawTimeline();
        render();
        updateUI();
    }

    for (const sample of samples) {
        const option = document.createElement("option");
        option.value = sample.key;
        option.textContent = sample.label;
        $("trace-select").append(option);
    }
    document
        .querySelectorAll<HTMLButtonElement>("[data-style-choice]")
        .forEach((button) =>
            button.addEventListener("click", () => setVisualStyle(button.dataset.styleChoice as sceneModel.StyleKey))
        );
    $("trace-select").addEventListener("change", () => {
        loadTrace($("trace-select").value);
        render();
        updateUI();
    });
    $("play").addEventListener("click", () => setPlaying(!session.playing));
    $("previous").addEventListener("click", () => step(-1));
    $("next").addEventListener("click", () => step(1));
    $("reset").addEventListener("click", () => {
        session.selectedID = null;
        if (fileImport.source) fileImport.selectWindow(fileImport.source.firstCycle);
        else setCycle(replay.trace.firstCycle);
    });
    $("timeline").addEventListener("input", () => {
        setPlaying(false);
        fileImport.interact();
        setCycle(Number($("timeline").value));
    });
    $("speed").addEventListener("change", () => {
        session.speed = Number($("speed").value);
        document.querySelector(".speed-unit")!.textContent = `${session.speed} cycles / sec`;
    });
    $("next-flush").addEventListener("click", nextFlush);
    $("show-highlight").addEventListener("click", () => {
        const bookmarks = replay.trace.demo.bookmarks;
        const bookmark = bookmarks.find((b) => b.cycle > session.cycle + 1) ?? bookmarks[0];
        if (bookmark) {
            setCycle(bookmark.cycle - 2);
            setPlaying(true);
        }
        if ($("mobile-panel").open) $("mobile-panel").close();
    });
    $("bloom").addEventListener("input", () => {
        session.bloom = Number($("bloom").value) / 100;
        $("bloom-value").textContent = `${Math.round(session.bloom * 100)}%`;
    });
    $("trails").addEventListener("click", () => {
        session.trails = !session.trails;
        $("trails").setAttribute("aria-pressed", String(session.trails));
        $("trails").lastElementChild!.textContent = session.trails ? "ON" : "OFF";
    });
    $("instruction-stream").addEventListener("click", () => {
        session.instructionStream = !session.instructionStream;
        $("instruction-stream").setAttribute("aria-pressed", String(session.instructionStream));
        $("instruction-stream").lastElementChild!.textContent = session.instructionStream ? "ON" : "OFF";
    });
    $("motion-effects").addEventListener("click", () => {
        session.reducedMotion = !session.reducedMotion;
        render();
        updateUI();
    });
    $("enable-animation").addEventListener("click", () => {
        session.reducedMotion = false;
        session.instructionStream = true;
        $("instruction-stream").setAttribute("aria-pressed", "true");
        $("instruction-stream").lastElementChild!.textContent = "ON";
        if (replay.flushEvents.length) nextFlush();
        else {
            setPlaying(true);
            render();
            updateUI();
        }
    });
    $("auto-camera").addEventListener("click", () => camera.toggleAuto());
    $("unpin").addEventListener("click", () => {
        session.selectedID = null;
        clock.nextUI = 0;
    });
    document
        .querySelectorAll<HTMLButtonElement>("[data-view]")
        .forEach((b) => b.addEventListener("click", () => camera.setCamera(b.dataset.view as CameraMode)));
    $("fullscreen").addEventListener("click", async () => {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
        } catch {
            $("fullscreen").title = "Fullscreen is unavailable in this browser window";
        }
    });
    document.addEventListener("fullscreenchange", () => {
        $("fullscreen").firstChild!.textContent = document.fullscreenElement ? "Exit fullscreen " : "Fullscreen ";
    });
    document.addEventListener("keydown", (event) => {
        if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLSelectElement ||
            event.target instanceof HTMLButtonElement ||
            event.target instanceof HTMLAnchorElement ||
            (event.target instanceof Element && Boolean(event.target.closest("summary,[contenteditable]"))) ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
        )
            return;
        if (event.code === "Space") {
            event.preventDefault();
            setPlaying(!session.playing);
        } else if (fileImport.source && (event.key === "PageUp" || event.key === "PageDown")) {
            event.preventDefault();
            $(event.key === "PageUp" ? "file-previous" : "file-next").click();
        } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            step(-1);
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            step(1);
        } else if (event.key.toLowerCase() === "f") nextFlush();
        else if (event.key.toLowerCase() === "c") camera.setCamera(camera.cameraMode === "cinema" ? "orbit" : "cinema");
        else if (event.key === "Escape") {
            session.selectedID = null;
            if (camera.cameraMode === "cinema") camera.setCamera("orbit");
        }
    });
    const telemetryPanel = document.querySelector(".telemetry")!,
        mobilePanel = $("mobile-panel");
    function syncCompactLayout() {
        if (mobilePanel.open) mobilePanel.close();
        (camera.compactMedia.matches ? mobilePanel : document.querySelector("main")!).append(telemetryPanel);
        gpu.resize();
    }
    camera.compactMedia.addEventListener("change", syncCompactLayout);
    syncCompactLayout();
    $("mobile-details").addEventListener("click", () => {
        mobilePanel.scrollTop = 0;
        mobilePanel.showModal();
    });
    $("mobile-close").addEventListener("click", () => mobilePanel.close());
    mobilePanel.addEventListener("click", (event) => {
        const rect = mobilePanel.getBoundingClientRect();
        if (
            event.target === mobilePanel &&
            (event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom)
        )
            mobilePanel.close();
    });
    mobilePanel.addEventListener("keydown", (event) => event.stopPropagation());
    $("zoom-fit").addEventListener("click", () => camera.setCamera(camera.cameraMode));
    $("zoom-in").addEventListener("click", () => {
        camera.toggleAuto(false);
        camera.targetRadius = clamp(camera.targetRadius / 1.3, camera.minCameraRadius, camera.maxCameraRadius);
    });
    $("zoom-out").addEventListener("click", () => {
        camera.toggleAuto(false);
        camera.targetRadius = clamp(camera.targetRadius * 1.3, camera.minCameraRadius, camera.maxCameraRadius);
    });

    canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        gpu.contextLost = true;
        cancelAnimationFrame(clock.animationID!);
        $("fallback").hidden = false;
        document
            .querySelectorAll<HTMLButtonElement>("[data-style-choice]")
            .forEach((button) => (button.disabled = true));
        $("fallback").firstElementChild!.textContent = "Graphics context interrupted.";
        $("fallback").querySelector("p")!.textContent = "Restoring the light field…";
        $("renderer-status").textContent = "Graphics context lost";
    });
    canvas.addEventListener("webglcontextrestored", () => globalThis.location.reload());
    document.addEventListener("visibilitychange", () => {
        clock.lastTime = performance.now();
    });
    new ResizeObserver(() => {
        if (!gpu.contextLost) gpu.resize();
    }).observe($("world"));
    window.addEventListener("resize", drawTimeline);
    applyTrace();
    camera.toggleAuto(camera.autoOrbit);
    setPlaying(session.playing);
    render();
    updateUI();
    // 最初の描画後に診断 API を公開し、同じ戻り値から公開型を導く。
    const diagnostics = createDiagnostics();
    globalThis.sonata = diagnostics;
    clock.animationID = requestAnimationFrame(animate);
    return diagnostics;
    // シーンの DOM ラベル、情報パネルとタイムライン。
    // loadTrace → rebuildWorld → render が設定した状態・要素を参照する。
    function updateLabels(dt = 0) {
        for (const n of scene.nodes.values()) {
            const memoryPipe = n.id === "exec-load" || n.id === "exec-store";
            const side = n.id.startsWith("exec") && !memoryPipe,
                below = n.id === "issue" && n.d > 6;
            const p = camera.project(
                below
                    ? [n.x, n.h, n.z + n.d * 0.7]
                    : memoryPipe
                      ? [n.x, n.h + 0.6, n.z]
                      : side
                        ? [n.x + n.w / 2 + 0.5, n.h + 0.6, n.z]
                        : [n.x, n.h + 0.7, n.z - n.d * 0.52]
            );
            const alignment = below ? "-50%,8px" : side ? "0,-50%" : "-50%,-100%";
            n.element!.style.transform = `translate(${p[0].toFixed(1)}px,${p[1].toFixed(1)}px) translate(${alignment})`;
            n.element!.classList.toggle("below-label", below);
            n.element!.style.display = p[2] < 0 ? "none" : "";
        }
        const committed = (replay.commitGroups.get(Math.floor(session.cycle)) ?? []).filter(
            (op) => session.cycle >= op.end
        ).length;
        scene.nodes.get("commit")!.element!.querySelector("small")!.textContent =
            `${committed} / ${replay.trace.retireWidth} THIS CYCLE`;
        if (activity.frame.registers.available) {
            for (const cell of activity.frame.registers.physical) {
                const p = scene.physicalTagPosition(cell.physical),
                    screen = camera.project([p[0], p[1] + 0.06, p[2] - 0.02]),
                    el = activity.physicalElements.get(cell.physical)!;
                const reading = activity.registerReads.some((r) => r.sources.some((s) => s.physical === cell.physical));
                el.style.transform = `translate(${screen[0]}px,${screen[1]}px) translate(-50%,-100%)`;
                el.hidden = replay.registerTags.length > 64 && !reading && cell.pulse < 0.01;
                el.style.color = rgb(activity.registerCellColor(cell));
                el.style.opacity = String(
                    reading ? 1 : cell.allocation === "allocated" ? 0.85 : cell.allocation === "free" ? 0.3 : 0.2
                );
                el.dataset.allocation = cell.allocation;
            }
            for (const [state, count] of Object.entries(activity.frame.registers.allocationCounts)) {
                const item = $("register-allocation").querySelector<HTMLElement>(`[data-state="${state}"]`)!;
                item.lastElementChild!.textContent = `${state === "allocated" ? "ALLOC" : state === "free" ? "FREE" : "?"} ${count}`;
                item.title =
                    state === "unknown"
                        ? "Allocation state not observed"
                        : state === "allocated"
                          ? "Allocated, including older versions held until reclamation"
                          : "Free physical registers";
            }
            const n = scene.nodes.get("register-read")!,
                write = activity.frame.registers.lastWrite,
                screen = camera.project([n.x, n.h + 0.35, n.z + n.d * 0.53]);
            const label = $("register-writeback");
            label.style.transform = `translate(${screen[0]}px,${screen[1] + 12}px) translateX(-50%)`;
            label.textContent = write
                ? `WB p${write.physical} ← ${write.hex}`
                : replay.trace.evidence!.registers!.kind === "configuration"
                  ? "VALUES NOT LOGGED"
                  : "WRITEBACK · —";
        }
        const marker = $("recovery-branch"),
            branch = activity.activeBranches.at(-1);
        marker.hidden = !branch;
        if (branch) {
            const p = camera.project(
                    session.style.matte
                        ? paths.groundedPiece(branch.op, session.cycle)!.position
                        : paths.positionAt(branch.op, session.cycle)!
                ),
                retiring = session.cycle >= branch.op.end;
            const location = retiring
                ? "COMMIT"
                : paths.stageAt(branch.op, session.cycle)?.node === "rob"
                  ? "ROB"
                  : (scene.nodes.get(paths.stageAt(branch.op, session.cycle)?.node!)?.label ?? "IN FLIGHT");
            marker.firstElementChild!.textContent = `${branch.inferred ? "RECOVERY BRANCH ≈" : "MISPREDICT"} #${branch.id}`;
            marker.lastElementChild!.textContent = `${location} · ${retiring ? "COMMITTED" : "PRESERVED"}`;
            marker.style.transform = `translate(${clamp(p[0] - 8, 4, gpu.cssWidth - 235)}px,${clamp(p[1] - 72, 4, gpu.cssHeight - 45)}px)`;
            marker.style.opacity = String(1 - smooth((session.cycle - (branch.until - 0.7)) / 0.7));
            marker.title = branch.inferred
                ? "Candidate: branch immediately before the squashed instruction sequence; cause inferred from O3PipeView."
                : "Recorded branch misprediction. Only younger wrong-path instructions are squashed.";
        }
        const fifo = replay.robReplay.stateAt(session.cycle),
            oldest = fifo.entries[0]?.op;
        const headPoint = camera.project(scene.robCell(fifo.head, 0.72)),
            tailPoint = camera.project(scene.robCell(fifo.tail, 0.62));
        const headLabel = $("rob-head-label"),
            tailLabel = $("rob-tail-label");
        const ready = oldest?.completion != null && session.cycle >= oldest.completion;
        headLabel.textContent = oldest ? `HEAD #${oldest.id} · ${ready ? "READY" : "WAIT"}` : "HEAD · EMPTY";
        headLabel.style.color = rgb(ready ? session.style.palette.integer : session.style.palette.memory);
        tailLabel.textContent = `TAIL ${fifo.entries.length === replay.trace.structure.robCapacity ? "· FULL" : `→ ${fifo.tail}`}`;
        headLabel.style.transform = `translate(${headPoint[0] + 13}px,${headPoint[1]}px)`;
        const separation = Math.abs(tailPoint[1] - headPoint[1]) < 23 ? 24 : 0;
        tailLabel.style.transform = `translate(${tailPoint[0] + 13}px,${tailPoint[1] + separation}px)`;
        const feedLabel = $("instruction-stream-label"),
            feedAnchor = camera.project(activity.feedPath(0));
        feedLabel.hidden = !session.instructionStream || feedAnchor[2] < 0;
        feedLabel.style.transform = `translate(${feedAnchor[0] + (camera.cameraMode === "plan" ? 135 : 0)}px,${feedAnchor[1] + (camera.cameraMode === "plan" ? -28 : 24)}px) translateX(-50%)`;
        activity.updateTopDownUI(dt > 0 && !session.reducedMotion);
        // 任意ログのpipe数・長さでもLOAD/STORE/WAITの説明を重ねない。
        // 投影後の3ラベルだけをまとめて測り、衝突したものを下へ離す。
        if (!camera.compactMedia.matches) {
            const labels = [...scene.nodes.values()]
                .filter((n) => ["exec-load", "exec-store", "memory-wait"].includes(n.id))
                .map((n) => ({ element: n.element!, rect: n.element!.getBoundingClientRect() }))
                .filter(({ rect }) => rect.width > 0)
                .sort((a, b) => a.rect.top - b.rect.top);
            const placed: { left: number; right: number; top: number; bottom: number }[] = [];
            for (const { element, rect } of labels) {
                let top = rect.top;
                for (const other of placed)
                    if (rect.left < other.right + 4 && rect.right > other.left - 4 && top < other.bottom + 4)
                        top = other.bottom + 4;
                if (top > rect.top) element.style.transform += ` translateY(${top - rect.top}px)`;
                placed.push({ left: rect.left, right: rect.right, top, bottom: top + rect.height });
            }
        }
        // 全体表示では読めるステージ名を残し、拡大に応じて詳細を表示する。
        // 投影したラベルが操作部や他のラベルを覆わないようにする。
        if (camera.compactMedia.matches) {
            const bounds = gpu.canvas.getBoundingClientRect();
            const occupied = [
                ...document.querySelectorAll(".view-controls,.mobile-run,.mobile-cycle,.touch-camera,.bound-scene")
            ].map((el) => el.getBoundingClientRect());
            const priority = (n: sceneModel.Node) =>
                (({ issue: 0, "register-read": 1, rob: 2 }) as Record<string, number>)[n.id] ?? 3;
            const candidates = [...scene.nodes.values()]
                .sort((a, b) => priority(a) - priority(b))
                .map((n) => ({ el: n.element!, rect: n.element!.getBoundingClientRect() }));
            for (const { el, rect } of candidates) {
                const fits =
                    rect.left >= bounds.left + 3 &&
                    rect.right <= bounds.right - 3 &&
                    rect.top >= bounds.top + 3 &&
                    rect.bottom <= bounds.bottom - 3;
                const overlaps = occupied.some(
                    (r) =>
                        rect.left < r.right + 3 &&
                        rect.right > r.left - 3 &&
                        rect.top < r.bottom + 3 &&
                        rect.bottom > r.top - 3
                );
                el.style.visibility = fits && !overlaps ? "" : "hidden";
                if (fits && !overlaps) occupied.push(rect);
            }
        } else for (const n of scene.nodes.values()) n.element!.style.visibility = "";
    }

    function drawTimeline() {
        if (!replay.activity.length) return;
        const el = $("activity"),
            w = el.clientWidth,
            h = el.clientHeight,
            dpr = Math.min(devicePixelRatio || 1, 2);
        el.width = Math.max(1, Math.round(w * dpr));
        el.height = Math.max(1, Math.round(h * dpr));
        const ctx = el.getContext("2d")!;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        const peak = Math.max(...replay.activity.map((a) => a.active), 1),
            retirePeak = Math.max(...replay.activity.map((a) => a.retired), 1);
        const bar = w / replay.activity.length;
        for (let i = 0; i < replay.activity.length; i++) {
            const a = replay.activity[i],
                x = i * bar;
            const ah = (a.active / peak) * (h - 6),
                rh = (a.retired / retirePeak) * (h - 10);
            ctx.fillStyle = session.style.timeline[0];
            ctx.fillRect(x, h - ah, Math.max(1, bar - 0.7), ah);
            ctx.fillStyle = session.style.timeline[1];
            ctx.globalAlpha = 0.55 + (a.retired / retirePeak) * 0.25;
            ctx.fillRect(x, h - rh, Math.max(1, bar - 0.7), rh);
            ctx.globalAlpha = 1;
        }
        ctx.fillStyle = session.style.timeline[2];
        ctx.fillRect(0, h - 1, w, 1);
    }

    function updateUI() {
        fileImport.tick(session.cycle);
        const integer = Math.floor(session.cycle),
            fraction = Math.floor((session.cycle - integer) * 100 + 1e-6);
        $("cycle-value").replaceChildren(
            document.createTextNode(integer.toLocaleString("en-US")),
            Object.assign(document.createElement("span"), { textContent: `.${String(fraction).padStart(2, "0")}` })
        );
        $("mobile-cycle-value").textContent = `${integer.toLocaleString("en-US")}.${String(fraction).padStart(2, "0")}`;
        $("timeline").value = String(session.cycle);
        $("playhead").style.left =
            `${clamp((session.cycle - replay.trace.firstCycle) / Math.max(1, replay.trace.lastCycle - replay.trace.firstCycle)) * 100}%`;
        $("active-count").textContent = String(activity.frame.stats.active.length);
        $("ipc-value").textContent = activity.frame.stats.ipc.toFixed(2);
        const traceEvents = (replay.trace.demo.events ?? []).filter(
            (e) => session.cycle >= e.cycle && session.cycle < e.endCycle!
        );
        const notice = $("trace-event-notice"),
            signature = traceEvents.map((e) => `${e.kind}:${e.id}:${e.cycle}`).join(",");
        notice.hidden = traceEvents.length === 0;
        if (notice.dataset.events !== signature) {
            notice.dataset.events = signature;
            notice.replaceChildren(
                ...traceEvents.map((e) => {
                    const row = document.createElement("div"),
                        label = document.createElement("strong"),
                        detail = document.createElement("small");
                    label.textContent = {
                        "branch-mispredict": "BRANCH MISPREDICTION",
                        "dcache-miss": "D-CACHE MISS",
                        "icache-miss": "I-CACHE MISS"
                    }[e.kind];
                    detail.textContent = `#${e.id} · cycle ${e.cycle.toLocaleString()} · recorded`;
                    row.style.setProperty(
                        "--event-color",
                        e.kind === "branch-mispredict"
                            ? session.style.bounds.badSpeculation
                            : session.style.bounds.backend
                    );
                    row.append(label, detail);
                    return row;
                })
            );
        }
        const feedLabel = $("instruction-stream-label"),
            feedTitle = feedLabel.querySelector("span")!,
            feedDetail = feedLabel.querySelector("small")!;
        const feedPhase = stream.feedState!.phase,
            rewinding = feedPhase === "rewind" || feedPhase === "discard" || feedPhase === "notice";
        $("motion-notice").hidden = !session.reducedMotion;
        $("motion-effects").setAttribute("aria-pressed", String(!session.reducedMotion));
        $("motion-effects").lastElementChild!.textContent = session.reducedMotion ? "OFF" : "ON";
        feedLabel.classList.toggle("rewinding", rewinding);
        feedLabel.classList.toggle("recovering", feedPhase === "refill");
        feedTitle.textContent = rewinding
            ? session.reducedMotion
                ? "CODE SQUASH"
                : feedPhase === "discard"
                  ? "CODE UNRAVEL"
                  : "↶ CODE REWIND"
            : feedPhase === "refill"
              ? "↗ FETCH RESUMES"
              : "INSTRUCTION STREAM";
        feedDetail.textContent =
            stream.feedState!.time !== null
                ? `${stream.feedState!.count} SQUASHED · ${feedPhase === "refill" ? "RESUMING FLOW" : "WRONG PATH"}`
                : "TRACE SEQUENCE ↗ FETCH";
        $("memory-notice").hidden = activity.activeNotifications.length === 0;
        $("memory-notice-detail").textContent =
            activity.activeNotifications.length === 1
                ? `#${activity.activeNotifications[0].id} → scheduler · completion broadcast`
                : `${activity.activeNotifications.length} completions → scheduler`;
        $("ipc-value").title = "Committed instructions / elapsed cycle over the previous 16 cycles in this excerpt";
        for (const [name, count, capacity] of [
            ["issue", activity.frame.stats.issued.length, replay.trace.structure.queueCapacity],
            ["rob", activity.frame.stats.rob.length, replay.trace.structure.robCapacity]
        ] as const) {
            $(`${name}-count`).textContent = `${count} / ${capacity}`;
            [...$(`${name}-meter`).children].forEach((el, i) =>
                el.classList.toggle("on", i < Math.ceil((count / capacity) * 24))
            );
        }
        const currentEvent = replay.flushEvents.findLast((t) => session.cycle >= t && session.cycle < t + 2.8);
        $("flush-alert").classList.toggle("visible", currentEvent !== undefined);
        if (currentEvent !== undefined)
            $("flush-detail").textContent =
                `${replay.ops.filter((o) => o.flush && o.end === currentEvent).length} instructions squashed · ${replay.trace.parser.startsWith("gem5") ? "≈ " : ""}cycle ${currentEvent.toLocaleString()}`;
        const selected = session.selectedID !== null ? replay.ops.find((o) => o.id === session.selectedID) : null;
        const candidates = activity.frame.stats.active.filter((o) =>
            paths.stageAt(o, session.cycle)?.node.startsWith("exec")
        );
        const op =
            selected ||
            candidates[Math.floor(session.cycle / 5) % Math.max(1, candidates.length)] ||
            activity.frame.stats.active.at(-1);
        $("unpin").hidden = session.selectedID === null;
        const write = $("op-write");
        write.hidden = op?.memoryKind !== "store";
        write.textContent = "";
        if (op?.memoryKind === "store") {
            const completion = replay.trace.storeCompletions?.find(([id]) => id === op.id)?.[1];
            // 完了時刻は到達後に表示し、コミット前から書込み待ちや完了を先取りしない。
            write.textContent =
                completion == null || op.flush
                    ? "WRITE COMPLETION · NOT LOGGED"
                    : session.cycle < op.end
                      ? "WRITE · AWAITING COMMIT"
                      : session.cycle < completion
                        ? "WRITE · PENDING"
                        : `WRITE · COMPLETE @ ${completion}`;
        }
        if (op) {
            const stage = paths.stageAt(op, session.cycle),
                stageIndex = op.stages.indexOf(stage as sonataReplay.Stage);
            $("op-id").textContent = `#${op.id}`;
            $("op-code").textContent = op.label;
            $("op-code").title = op.label;
            $("op-stage").textContent =
                session.cycle < op.fetch
                    ? "PENDING"
                    : session.cycle >= op.end
                      ? op.flush
                          ? "SQUASHED"
                          : "COMMITTED"
                      : scene.nodes.get(stage?.node!)?.label || "IN FLIGHT";
            $("op-state").textContent = op.unfinished
                ? "Outcome not recorded · incomplete trace"
                : selected
                  ? "Pinned instruction"
                  : "Click an instruction to pin";
            $("spotlight").style.borderLeftColor = rgb(
                op.flush && session.cycle >= op.end
                    ? session.style.palette.red
                    : paths.instructionColor(op, session.cycle)
            );
            $("op-progress").replaceChildren(
                ...op.stages.map((s, i) => {
                    const el = document.createElement("i");
                    el.className = i === stageIndex ? "current" : session.cycle >= s.end ? "done" : "";
                    el.title = `${s.names.join(" / ")}: ${s.start}–${Number.isFinite(s.end) ? s.end : "unobserved"}`;
                    return el;
                })
            );
        } else {
            $("op-id").textContent = "—";
            $("op-code").textContent = "No instructions in flight";
            $("op-stage").textContent = "IDLE";
            $("op-state").textContent = "Seek the timeline to explore";
            $("op-progress").replaceChildren();
        }
    }

    function showTrace() {
        $("timeline").min = String(replay.trace.firstCycle);
        $("timeline").max = String(replay.trace.lastCycle);
        const provenance = replay.trace.demo.provenance;
        $("run-simulator").textContent = provenance.simulator;
        $("mobile-demo").textContent = replay.trace.label;
        $("mobile-simulator").textContent = provenance.simulator;
        $("mobile-workload").textContent = provenance.workload;
        $("run-workload").textContent = provenance.workload;
        $("run-workload").classList.toggle("unconfirmed", !provenance.workloadKnown);
        $("run-processor").textContent = provenance.processor;
        $("run-configuration").textContent = provenance.configuration;
        $("run-note").textContent = provenance.note;
        $("matrix-source").textContent =
            replay.trace.evidence?.scheduling.kind === "recorded"
                ? "MATRIX · RECORDED DEPS"
                : replay.trace.key === "local-file"
                  ? "MATRIX · UNOBSERVED"
                  : "MATRIX · RAW ESTIMATE";
        $("matrix-source").title =
            `${replay.trace.evidence?.scheduling.label ?? "Dependency information unavailable"}. Rows and columns are the same scheduler entries. Dependencies on issued instructions remain on the external wake-up bus. Cell colors follow the consumer row; brightness marks dependency release. Register map / values: ${replay.trace.evidence?.registers ? "recorded RSD annotations" : "not recorded in this trace"}.`;
        $("run-file").textContent = replay.trace.fileName;
        $("run-excerpt").textContent =
            `${replay.ops.length.toLocaleString()} excerpt ops · cycles ${replay.trace.firstCycle.toLocaleString()}–${replay.trace.lastCycle.toLocaleString()}`;
        $("cinema-source").textContent = `${provenance.simulator} / ${provenance.workload}`;
        $("scene-theme").textContent = replay.trace.demo.theme;
        $("show-highlight").disabled = replay.trace.demo.bookmarks.length === 0;
        $("show-highlight").title = replay
            .trace!.demo.bookmarks.map((b) => `${b.label} · cycle ${b.cycle.toLocaleString()}`)
            .join("\n");
        $("architecture").textContent = replay.trace.machineOrder.toUpperCase();
        $("width-value").textContent = `${replay.trace.fetchWidth}-WIDE FETCH`;
        $("queue-label").textContent = replay.trace.machineOrder === "in-order" ? "Schedule queue" : "Scheduler";
        $("rob-label").textContent = replay.trace.machineOrder === "in-order" ? "Completion buffer" : "Reorder buffer";
        const flushEvents = windowFlushEvents();
        $("next-flush").disabled = flushEvents.length === 0;
        $("next-flush").title = flushEvents.length
            ? `Jump to the next squash event (F) · timing ${replay.trace.parser.startsWith("gem5") ? "inferred" : "recorded"}`
            : "This excerpt contains no flush events";
        $("range-label").textContent = `${replay.trace.lastCycle - replay.trace.firstCycle + 1} CYCLES`;
        $("first-cycle").textContent = replay.trace.firstCycle.toLocaleString();
        $("last-cycle").textContent = replay.trace.lastCycle.toLocaleString();
        for (const id of ["issue-meter", "rob-meter"]) {
            $(id).replaceChildren(...Array.from({ length: 24 }, () => document.createElement("i")));
        }
        const markers = flushEvents.map((t) => {
            const marker = document.createElement("span");
            marker.className = "event-marker";
            marker.style.left = `${((t - replay.trace.firstCycle) / Math.max(1, replay.trace.lastCycle - replay.trace.firstCycle)) * 100}%`;
            return marker;
        });
        for (const bookmark of replay.trace.demo.bookmarks.filter((b) => b.type !== "flush")) {
            const marker = document.createElement("span");
            marker.className = "event-marker highlight-marker";
            marker.style.left = `${((bookmark.cycle - replay.trace.firstCycle) / Math.max(1, replay.trace.lastCycle - replay.trace.firstCycle)) * 100}%`;
            markers.push(marker);
        }
        $("event-markers").replaceChildren(...markers);
        drawTimeline();
        clock.nextUI = 0;
    }

    // 描画と同じ状態を読む検証用 API。
    function createDiagnostics() {
        return {
            get visualStyle() {
                return session.visualStyle;
            },
            get selectedID() {
                return session.selectedID;
            },
            get camera() {
                return {
                    mode: camera.cameraMode,
                    radius: camera.radius,
                    targetRadius: camera.targetRadius,
                    azimuth: camera.azimuth,
                    targetAzimuth: camera.targetAzimuth,
                    elevation: camera.elevation,
                    targetElevation: camera.targetElevation,
                    focus: [...camera.focus],
                    targetFocus: [...camera.targetFocus],
                    pointers: camera.pointers.size,
                    compact: camera.compactMedia.matches
                };
            },
            get trace() {
                return replay.trace;
            },
            get cycle() {
                return session.cycle;
            },
            get playing() {
                return session.playing;
            },
            get ops() {
                return replay.ops;
            },
            get flushEvents() {
                return [...replay.flushEvents];
            },
            get stats() {
                return {
                    active: activity.frame.stats.active.length,
                    issue: activity.frame.stats.issued.length,
                    rob: activity.frame.stats.rob.length,
                    ipc: activity.frame.stats.ipc
                };
            },
            get topDown() {
                return sonataReplay.sampleTopDown(replay.trace.topDown, session.cycle);
            },
            get topDownVisual() {
                return {
                    region: topDown.topDownRegion
                        ? { ...topDown.topDownRegion, bounds: [...topDown.topDownRegion.bounds] }
                        : null,
                    rail: topDown.topDownRail.map((s) => ({ ...s })),
                    shares: { ...topDown.boundDisplay.shares },
                    weights: { ...topDown.boundDisplay.weights },
                    color: [...topDown.boundDisplay.color]
                };
            },
            get particles() {
                return activity.visibleParticles.map((p) => ({
                    id: p.op.id,
                    screen: p.screen,
                    position: p.position,
                    pathPosition: [...p.pathPosition],
                    state: p.state,
                    brightness: p.brightness,
                    color: [...p.color]
                }));
            },
            get pieces() {
                return activity.visiblePieces.map((p) => ({
                    ...p,
                    position: [...p.position],
                    pathPosition: [...p.pathPosition],
                    contact: p.contact ? [...p.contact] : null,
                    transfer: p.transfer ? { ...p.transfer, from: [...p.transfer.from], to: [...p.transfer.to] } : null,
                    rotation: [...p.rotation]
                }));
            },
            get instructionLayout() {
                return {
                    radius: instructionRadius,
                    scheduler: Array.from({ length: replay.trace.structure.queueCapacity }, (_, row) =>
                        scene.matrixPosition(row)
                    ),
                    rob: Array.from({ length: replay.trace.structure.robCapacity }, (_, slot) =>
                        scene.robCell(slot, 0.19)
                    ),
                    rename: Array.from({ length: scene.renameNode()?.instructionSlots ?? 0 }, (_, slot) =>
                        scene.renameInstructionPosition(slot)
                    )
                };
            },
            get executionNodes() {
                return replay.memory.executionNodes;
            },
            get memoryTiming() {
                return { minimum: replay.memory.minimum, sharedPipes: replay.memory.sharedPipes };
            },
            get pendingStores() {
                return replay.memory.pendingStores
                    .filter((store) => session.cycle >= store.start && session.cycle < store.end)
                    .map(({ id, start, end }) => ({ id, start, end }));
            },
            get executionPipes() {
                return [...scene.nodes.values()]
                    .filter((n) => n.pipeCount)
                    .flatMap((n) =>
                        Array.from({ length: n.pipeCount! }, (_, index) => ({
                            node: n.id,
                            index,
                            ...scene.executionLane(n, index)
                        }))
                    );
            },
            get connections() {
                return scene.connections.map((c) => ({
                    from: c.from,
                    to: c.to,
                    peak: c.peak,
                    lineCount: c.lanes.length,
                    lanes: c.lanes.map((l) => ({ source: [...l.source], target: [...l.target] }))
                }));
            },
            get sceneBuilds() {
                return scene.worldBuildCount();
            },
            get playbackStep() {
                return { ...clock.lastPlayback };
            },
            get dependencyMatrix() {
                return replay.dependencyReplay.stateAt(session.cycle);
            },
            get schedulerGrid() {
                const grid = scene.nodes.get("issue")!.grid!;
                return Object.fromEntries(
                    Object.entries(grid).map(([key, segments]) => [
                        key,
                        segments.map((segment) => segment.map((p) => [...p]))
                    ])
                );
            },
            get issuePaths() {
                return activity.frame.matrix.issues.map(scene.issuePath);
            },
            get registers() {
                return replay.registerReplay.stateAt(session.cycle);
            },
            get commitSlots() {
                const group = replay.commitGroups.get(Math.floor(session.cycle)) ?? [];
                return Array.from({ length: replay.trace.retireWidth }, (_, index) => {
                    const op = group[index];
                    return { index, ...scene.commitSlot(index), id: op && session.cycle >= op.end ? op.id : null };
                });
            },
            get registerReads() {
                return activity.registerReads.map((r) => ({
                    id: r.id,
                    kind: r.op.kind,
                    color: [...session.style.palette[r.op.kind]],
                    sources: r.sources,
                    port: scene.registerReadPort(r.op)
                }));
            },
            get registerReadCells() {
                return activity.frame.registers.available
                    ? activity.frame.registers.physical
                          .filter((c) => activity.registerReaders(c.physical).length)
                          .map((c) => ({
                              physical: c.physical,
                              color: [...activity.registerCellColor(c)],
                              readers: activity.registerReaders(c.physical).map((r) => r.id)
                          }))
                    : [];
            },
            get registerAllocationCells() {
                return activity.frame.registers.available
                    ? activity.frame.registers.physical.map((c) => ({
                          physical: c.physical,
                          state: c.allocation,
                          ...activity.registerCellAppearance(c)
                      }))
                    : [];
            },
            get renameMapWords() {
                return activity.renameWords;
            },
            get registerLayout() {
                return activity.frame.registers.available
                    ? {
                          renameNode: scene.renameNode()!.id,
                          renamePosition: [scene.renameNode()!.x, scene.renameNode()!.z],
                          mapWords: activity.renameWords.length,
                          physicalNode: "register-read",
                          cells: replay.registerTags.map((id) => ({ id, position: scene.physicalTagPosition(id) }))
                      }
                    : null;
            },
            get recoveryBranches() {
                return activity.activeBranches.map((e) => ({
                    id: e.id,
                    cycle: e.cycle,
                    until: e.until,
                    inferred: e.inferred,
                    pathPosition: paths.positionAt(e.op, session.cycle),
                    position: session.style.matte
                        ? paths.groundedPiece(e.op, session.cycle)?.position
                        : paths.positionAt(e.op, session.cycle)
                }));
            },
            get instructionFeed() {
                return stream.feedVisible.map((row) => ({ ...row, position: [...row.position] }));
            },
            get codeFragments() {
                return stream.codeFragments.map((g) => ({
                    ...g,
                    origin: [...g.origin],
                    position: [...g.position],
                    screen: camera.project(g.position),
                    originScreen: camera.project(g.origin)
                }));
            },
            get codeRewind() {
                return { ...stream.feedState!, ids: [...stream.feedState!.ids], visible: session.instructionStream };
            },
            get rob() {
                const s = replay.robReplay.stateAt(session.cycle);
                return {
                    head: s.head,
                    tail: s.tail,
                    capacity: replay.robReplay.capacity,
                    entries: s.entries.map((e) => ({
                        id: e.op.id,
                        slot: e.slot,
                        ready: e.op.completion != null && session.cycle >= e.op.completion
                    }))
                };
            },
            get memoryReturns() {
                return replay.memoryEvents.map((e) => ({ id: e.id, time: e.time }));
            },
            get notifications() {
                return activity.activeNotifications.map((e) => ({
                    id: e.id,
                    time: e.time,
                    phase: session.cycle - e.time < wakeFlightCycles ? "flight" : "arrived",
                    target: scene.wakeBusEntry(),
                    column: replay.dependencyReplay.columnAt(e.id, session.cycle)
                }));
            },
            get renderer() {
                return {
                    width: gpu.renderWidth,
                    height: gpu.renderHeight,
                    pixelRatio: gpu.pixelRatio,
                    msaaSamples: gpu.msaaSamples,
                    fps: clock.fps,
                    contextLost: gpu.contextLost,
                    style: session.visualStyle,
                    instructionShape: session.style.matte
                        ? session.style.surface.paper
                            ? "paper-box"
                            : "metal-puck"
                        : "glow",
                    pieceVertices: gpu.instructionPieces.count * gpu.instructionPieces.vertices,
                    pieceInstances: gpu.instructionPieces.count,
                    materialInstances: gpu.staticMaterials!.count,
                    pieceShadows: renderer.pieceShadows,
                    error: gl.getError()
                };
            },
            setCycle: clock.setCycle,
            setPlaying: clock.setPlaying,
            loadTrace,
            get fileImport() {
                return {
                    source: fileImport.source,
                    busy: fileImport.busy,
                    loading: fileImport.loading,
                    selecting: fileImport.selecting,
                    searching: fileImport.searching,
                    view: fileImport.view,
                    prefetched: fileImport.prefetched
                };
            },
            setCamera: camera.setCamera,
            captureAt(t: number) {
                clock.setPlaying(false);
                clock.setCycle(t);
                return { cycle: session.cycle, active: activity.frame.stats.active.length };
            }
        };
    }
}

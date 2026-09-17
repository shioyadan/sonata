"use strict";
// カメラの状態・投影とポインター操作。GPU 資源には依存せず、表示寸法だけを参照する。
import geometry = require("./geometry.cts");
const { clamp, mix, multiply, perspective, lookAt } = geometry;
type Vec3 = geometry.Vector;
type CameraMode = "orbit" | "plan" | "cinema";
interface Viewport {
    canvas: HTMLCanvasElement;
    cssWidth: number;
    cssHeight: number;
    resize(): void;
}

// カメラの補間・投影とマウス／タッチ操作。
function createCamera({
    viewport,
    world,
    autoCamera,
    sceneBounds,
    onPick
}: {
    viewport: Viewport;
    world: HTMLElement;
    autoCamera: HTMLElement;
    sceneBounds?: () => { left: number; right: number; back: number; front: number };
    onPick(x: number, y: number): void;
}) {
    const camera = {
        cameraMode: "orbit" as CameraMode,
        azimuth: 0.2,
        elevation: 0.73,
        radius: 32.5,
        targetAzimuth: 0.2,
        targetElevation: 0.73,
        targetRadius: 32.5,
        maxCameraRadius: 62,
        focus: [0, 0, 0] as Vec3,
        targetFocus: [0, 0, 0] as Vec3,
        autoOrbit: true,
        compactMedia: matchMedia("(max-width:760px), (max-width:1000px) and (max-height:600px)"),
        viewProjection: new Float32Array(16),
        eye: [0, 20, 30] as Vec3
    };
    const minCameraRadius = 3;
    let fittedBounds: string | undefined;
    const targetState = () =>
        JSON.stringify([camera.targetAzimuth, camera.targetElevation, camera.targetRadius, camera.targetFocus]);
    // 初回サンプルもFitの対象にし、読込み前の手動操作は一致判定で保持する。
    let fitted = targetState();
    function project(p: Vec3): Vec3 {
        const m = camera.viewProjection;
        const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        return [
            (((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w) * viewport.cssWidth) / 2 + viewport.cssWidth / 2,
            ((-(m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * viewport.cssHeight) / 2 +
                viewport.cssHeight / 2,
            w
        ];
    }

    function setCamera(mode: CameraMode) {
        camera.cameraMode = mode;
        document.body.classList.toggle("cinema", mode === "cinema");
        camera.targetFocus = [0, 0, 0];
        if (mode === "plan") {
            camera.targetElevation = 1.49;
            camera.targetAzimuth = 0;
            camera.targetRadius = 33;
        } else if (mode === "cinema") {
            camera.targetElevation = 0.55;
            camera.targetAzimuth = 0.38;
            camera.targetRadius = 30.5;
        } else {
            camera.targetElevation = 0.73;
            camera.targetAzimuth = 0.2;
            camera.targetRadius = 32.5;
        }
        // 大きい観測容量で基板が広がった場合も、Fitで全体へ戻れるようにする。
        camera.maxCameraRadius = 62;
        const bounds = sceneBounds?.();
        if (bounds) {
            const scale = Math.max(1, (bounds.right - bounds.left) / 29.4, (bounds.front - bounds.back) / 15);
            if (scale > 1.001) {
                camera.targetFocus = [(bounds.left + bounds.right) / 2, 0, (bounds.back + bounds.front) / 2];
                camera.targetRadius *= scale;
                camera.maxCameraRadius *= scale;
            }
        }
        document
            .querySelectorAll<HTMLButtonElement>("[data-view]")
            .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === mode)));
        fitted = targetState();
        fittedBounds = JSON.stringify(bounds);
        viewport.resize();
    }

    function fitLayout() {
        // Fit後に利用者が回転・拡大・平行移動していなければ、構造の拡大にも追従する。
        if (fitted === targetState() && fittedBounds !== JSON.stringify(sceneBounds?.())) setCamera(camera.cameraMode);
    }

    function toggleAuto(value = !camera.autoOrbit) {
        camera.autoOrbit = value;
        autoCamera.setAttribute("aria-pressed", String(camera.autoOrbit));
        autoCamera.lastElementChild!.textContent = camera.autoOrbit ? "ON" : "OFF";
    }

    // 2 点のタッチで拡大と平行移動を制御する。片方の指を先に離す場合も、
    // 2 点の中心に対応するシーン上の位置を保つ。
    const pointers = new Map<
        number,
        { x: number; y: number; startX: number; startY: number; moved: boolean; zoom: boolean }
    >();
    let pinch: ReturnType<typeof touchPair> | null = null;
    function touchPair() {
        const [a, b] = [...pointers.values()];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    }
    function moveFocus(dx: number, dy: number, units: number) {
        const a = camera.targetAzimuth,
            e = camera.targetElevation,
            right = [Math.cos(a), 0, -Math.sin(a)],
            up = [-Math.sin(a) * Math.sin(e), Math.cos(e), -Math.cos(a) * Math.sin(e)];
        camera.targetFocus = camera.targetFocus.map((v, i) =>
            clamp(v + (right[i] * dx - up[i] * dy) * units, -[20, 12, 14][i], [20, 12, 14][i])
        ) as Vec3;
    }
    viewport.canvas.addEventListener("pointerdown", (event) => {
        const zoom = event.pointerType === "mouse" && event.button === 2;
        if ((event.button !== 0 && !zoom) || pointers.size >= 2) return;
        if (pointers.size && (zoom || [...pointers.values()].some((p) => p.zoom))) return;
        pointers.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            zoom
        });
        viewport.canvas.setPointerCapture(event.pointerId);
        if (pointers.size === 2) {
            for (const p of pointers.values()) p.moved = true;
            pinch = touchPair();
            toggleAuto(false);
        }
    });
    viewport.canvas.addEventListener("pointermove", (event) => {
        const drag = pointers.get(event.pointerId);
        if (!drag) return;
        const dx = event.clientX - drag.x,
            dy = event.clientY - drag.y;
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (pointers.size === 2) {
            const next = touchPair(),
                oldRadius = camera.targetRadius,
                rect = viewport.canvas.getBoundingClientRect();
            camera.targetRadius = clamp(
                (oldRadius * pinch!.distance) / next.distance,
                minCameraRadius,
                camera.maxCameraRadius
            );
            const scale = camera.targetRadius / oldRadius,
                units =
                    (2 *
                        Math.tan(0.66 / 2) *
                        oldRadius *
                        Math.max(1, 1.48 / (viewport.cssWidth / viewport.cssHeight))) /
                    viewport.cssHeight;
            moveFocus(
                (pinch!.x - rect.left - rect.width / 2) * (1 - scale) - (next.x - pinch!.x) * scale,
                (pinch!.y - rect.top - rect.height / 2) * (1 - scale) - (next.y - pinch!.y) * scale,
                units
            );
            pinch = next;
        } else if (drag.moved) {
            toggleAuto(false);
            if (drag.zoom)
                camera.targetRadius = clamp(
                    camera.targetRadius * Math.exp(dy * 0.008),
                    minCameraRadius,
                    camera.maxCameraRadius
                );
            else {
                camera.targetAzimuth -= dx * 0.006;
                camera.targetElevation = clamp(camera.targetElevation + dy * 0.005, 0.24, 1.5);
            }
        }
    });
    function endPointer(event: PointerEvent) {
        const drag = pointers.get(event.pointerId);
        if (!drag) return;
        if (event.type === "pointerup" && !drag.moved && !drag.zoom) {
            const rect = viewport.canvas.getBoundingClientRect(),
                x = event.clientX - rect.left,
                y = event.clientY - rect.top;
            onPick(x, y);
        }
        pointers.delete(event.pointerId);
        pinch = null;
        if (viewport.canvas.hasPointerCapture(event.pointerId)) viewport.canvas.releasePointerCapture(event.pointerId);
    }
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const)
        viewport.canvas.addEventListener(type, endPointer);
    viewport.canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.targetRadius = clamp(
                camera.targetRadius * Math.exp(event.deltaY * 0.001),
                minCameraRadius,
                camera.maxCameraRadius
            );
        },
        { passive: false }
    );
    // 右ボタンのドラッグ中にブラウザのメニューが開いて操作を中断しないようにする。
    viewport.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    viewport.canvas.addEventListener("dblclick", () => setCamera("orbit"));

    function update(dt: number, artTime: number) {
        const ease = 1 - Math.exp(-dt * 5);
        camera.azimuth = mix(camera.azimuth, camera.targetAzimuth, ease);
        camera.elevation = mix(camera.elevation, camera.targetElevation, ease);
        camera.radius = mix(camera.radius, camera.targetRadius, ease);
        camera.focus = camera.focus.map((value, i) => mix(value, camera.targetFocus[i], ease)) as Vec3;
        world.classList.toggle("zoomed", camera.radius < 24);
        const drift = camera.autoOrbit && camera.cameraMode !== "plan" ? Math.sin(artTime * 0.12) * 0.16 : 0;
        const a = camera.azimuth + drift;
        // 縦画面でもプロセッサ全体が収まるようにする。
        const distance = camera.radius * Math.max(1, 1.48 / (viewport.cssWidth / viewport.cssHeight));
        camera.eye = [
            Math.sin(a) * Math.cos(camera.elevation) * distance,
            Math.sin(camera.elevation) * distance,
            Math.cos(a) * Math.cos(camera.elevation) * distance
        ].map((value, i) => value + camera.focus[i]) as Vec3;
        camera.viewProjection = multiply(
            perspective(viewport.cssWidth / viewport.cssHeight, distance),
            lookAt(camera.eye, camera.focus)
        );
    }
    return Object.assign(camera, {
        project,
        setCamera,
        fitLayout,
        toggleAuto,
        update,
        pointers,
        minCameraRadius
    });
}

const camera = { createCamera };
namespace camera {
    export type Mode = CameraMode;
    export type Camera = ReturnType<typeof createCamera>;
}
export = camera;

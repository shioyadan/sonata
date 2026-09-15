"use strict";
import assert = require("node:assert/strict");
import type { BrowserWindow } from "electron";

interface ReviewState {
    keyReleased?: boolean;
    pointerReleased?: boolean;
    wheelReceived?: boolean;
    context?: WEBGL_lose_context | null;
}
declare global {
    var browserReview: ReviewState | undefined;
}
type ElementFor<ID extends string> = ID extends "scene"
    ? HTMLCanvasElement
    : ID extends "bloom" | "timeline"
      ? HTMLInputElement
      : ID extends "license-panel" | "mobile-panel"
        ? HTMLDialogElement
        : HTMLElement;

// この関数だけをブラウザ側へ渡す。外側の変数を参照せず、実際の診断 API と DOM を取得する。
function pageContext() {
    const $ = <ID extends string>(id: ID): ElementFor<ID> => {
        const element = document.getElementById(id);
        if (!element) throw new Error(`Missing test element: ${id}`);
        return element as ElementFor<ID>;
    };
    return {
        $,
        get sonata() {
            const app = globalThis.sonata;
            if (!app) throw new Error("Sonata is not initialized");
            return app;
        },
        get gl() {
            const context = $("scene").getContext("webgl2");
            if (!context) throw new Error("WebGL 2 is unavailable");
            return context;
        },
        get state() {
            return (globalThis.browserReview ??= {});
        }
    };
}
type PageContext = ReturnType<typeof pageContext>;
type PageFunction<Args extends unknown[], Result> = (page: PageContext, ...args: Args) => Result;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const expired = Symbol("expired");

// 応答しない Promise も期限で打ち切る。ブラウザ側の処理自体は取り消さない。
// 同じ deadline を使い、ポーリングや描画の段階ごとに待機時間を延ばさない。
async function beforeDeadline<T>(operation: () => T | Promise<T>, deadline: number): Promise<T | typeof expired> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return expired;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            new Promise<typeof expired>((resolve) => {
                timer = setTimeout(() => resolve(expired), remaining);
            }),
            Promise.resolve().then(operation)
        ]);
        // タイマーの配送が遅れても、期限後の成功を受け入れない。
        return performance.now() < deadline ? result : expired;
    } finally {
        clearTimeout(timer);
    }
}

async function waitFor(
    condition: () => unknown | Promise<unknown>,
    message: string,
    {
        timeout = 10000,
        interval = 50,
        diagnostics,
        diagnosticsTimeout = 1000
    }: {
        timeout?: number;
        interval?: number;
        diagnostics?: () => unknown | Promise<unknown>;
        diagnosticsTimeout?: number;
    } = {}
) {
    const deadline = performance.now() + timeout;
    let failure = message;
    while (performance.now() < deadline) {
        const ready = await beforeDeadline(condition, deadline);
        if (ready === expired) break;
        if (ready) return;
        const remaining = deadline - performance.now();
        if (remaining > 0) await delay(Math.min(interval, remaining));
    }
    if (diagnostics) {
        // 診断の失敗・無応答で、本来の待機失敗を隠さない。
        try {
            const state = await beforeDeadline(diagnostics, performance.now() + diagnosticsTimeout);
            failure += state === expired ? " (diagnostics timed out)" : `: ${JSON.stringify(state)}`;
        } catch (error) {
            failure += ` (diagnostics failed: ${error instanceof Error ? error.message : String(error)})`;
        }
    }
    assert.fail(failure);
}

function createBrowserTest(window: Pick<BrowserWindow, "webContents">) {
    // 外側のローカル変数は捕捉せず、JSONにできる引数を明示して渡す。
    // コールバック本体は通常の TypeScript として型検査される。
    function evaluate<Args extends unknown[], Result>(fn: PageFunction<Args, Result>, ...args: Args) {
        const source = `(${fn.toString()})((${pageContext.toString()})(),...${JSON.stringify(args)})`;
        return window.webContents.executeJavaScript(source) as Promise<Awaited<Result>>;
    }
    // 採取した状態を保持し、次の描画へ制御を返してから次のサンプルへ進む。
    // 採取と1フレームの待機で同じ期限を共有し、期限後は後続の評価を始めない。
    async function sampleFrame<T>(sample: () => T | Promise<T>, { timeout = 10000 } = {}) {
        const deadline = performance.now() + timeout;
        const result = await beforeDeadline(sample, deadline);
        if (result === expired) assert.fail(`Frame sample did not complete within ${timeout} ms`);
        const frame = await beforeDeadline(
            () => evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))),
            deadline
        );
        if (frame === expired) assert.fail(`Animation frame after sample did not settle within ${timeout} ms`);
        return result;
    }
    async function settle({ finish = false, timeout = 10000 }: { finish?: boolean; timeout?: number } = {}) {
        const deadline = performance.now() + timeout;
        const frames = await beforeDeadline(
            () =>
                evaluate(
                    () =>
                        new Promise<void>((resolve) =>
                            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
                        )
                ),
            deadline
        );
        if (frames === expired) assert.fail(`Animation frames did not settle within ${timeout} ms`);
        if (finish && (await beforeDeadline(() => evaluate(({ gl }) => gl.finish()), deadline)) === expired)
            assert.fail(`GPU completion did not settle within ${timeout} ms`);
    }
    return { evaluate, sampleFrame, settle };
}

// 新しいページの起動前に行う故障注入にも、型検査済みの関数を使う。
function pageScript(fn: () => void) {
    return `(${fn.toString()})()`;
}

// hash付きの同じURLも、ページ内移動ではなく初期状態から検査する。
async function loadPage(window: BrowserWindow, entry: string) {
    await window.loadURL("about:blank");
    await window.loadURL(entry);
}

const browserTest = { createBrowserTest, delay, waitFor, pageScript, loadPage };
namespace browserTest {
    export type Context = PageContext;
    export type PageCallback<Args extends unknown[], Result> = PageFunction<Args, Result>;
}
export = browserTest;

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

async function waitFor(
    condition: () => unknown | Promise<unknown>,
    message: string,
    {
        timeout = 10000,
        interval = 50,
        diagnostics
    }: {
        timeout?: number;
        interval?: number;
        diagnostics?: () => unknown | Promise<unknown>;
    } = {}
) {
    const deadline = Date.now() + timeout;
    do {
        if (await condition()) return;
        await delay(interval);
    } while (Date.now() < deadline);
    assert.fail(diagnostics ? `${message}: ${JSON.stringify(await diagnostics())}` : message);
}

function createBrowserTest(window: Pick<BrowserWindow, "webContents">) {
    // 外側のローカル変数は捕捉せず、JSONにできる引数を明示して渡す。
    // コールバック本体は通常の TypeScript として型検査される。
    function evaluate<Args extends unknown[], Result>(fn: PageFunction<Args, Result>, ...args: Args) {
        const source = `(${fn.toString()})((${pageContext.toString()})(),...${JSON.stringify(args)})`;
        return window.webContents.executeJavaScript(source) as Promise<Awaited<Result>>;
    }
    async function settle({ finish = false }: { finish?: boolean } = {}) {
        await evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        );
        if (finish) await evaluate(({ gl }) => gl.finish());
    }
    return { evaluate, settle };
}

// 新しいページの起動前に行う故障注入にも、型検査済みの関数を使う。
function pageScript(fn: () => void) {
    return `(${fn.toString()})()`;
}

const browserTest = { createBrowserTest, delay, waitFor, pageScript };
namespace browserTest {
    export type Context = PageContext;
    export type PageCallback<Args extends unknown[], Result> = PageFunction<Args, Result>;
}
export = browserTest;

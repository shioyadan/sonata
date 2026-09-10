"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const loadTest = require("./load-test.cjs");
const helpers = loadTest("browser-test.cts");

async function checkBrowserTest() {
    assert.equal(loadTest("browser-test.cts"), helpers, "Typed test modules were loaded twice");
    assert.equal(
        typeof loadTest("check-browser.cts"),
        "function",
        "Browser review did not load through the CLI bridge"
    );
    assert.throws(() => loadTest("../src/sonata.cts"), /Expected a local .cts test/);

    // executeJavaScript 相当の別コンテキストへ渡し、外側のクロージャーを読まずに往復させる。
    const context = vm.createContext({ setTimeout });
    vm.runInContext(
        `globalThis.sonata={cycle:0,captureAt(value){this.cycle=value;}};
        globalThis.frameCallbacks=0;globalThis.finished=0;
        globalThis.requestAnimationFrame=callback=>setTimeout(()=>{frameCallbacks++;callback(frameCallbacks);},0);
        globalThis.document={getElementById(id){return id==='scene'?{getContext(){return {finish(){finished++;}};}}:null;}};`,
        context
    );
    const { evaluate, settle } = helpers.createBrowserTest({
        webContents: {
            async executeJavaScript(source) {
                return structuredClone(await vm.runInContext(source, context));
            }
        }
    });
    const argument = {
        text: "quotes: \" ' `; newline:\n${globalThis.injection=true}; slash:\\",
        values: [null, true, 7]
    };
    assert.deepEqual(await evaluate((_page, value) => value, argument), argument, "JSON arguments changed in transit");
    assert.equal(context.injection, undefined, "A string argument was executed as source");
    assert.equal(
        await evaluate(async ({ sonata }, value) => {
            await Promise.resolve();
            sonata.captureAt(value);
            return sonata.cycle;
        }, 12.5),
        12.5,
        "Promise results or diagnostic API access changed in transit"
    );
    await assert.rejects(
        evaluate(() => {
            throw new Error("page failure");
        }),
        /page failure/
    );
    await evaluate(({ state }) => {
        state.keyReleased = true;
    });
    assert.equal(await evaluate(({ state }) => state.keyReleased), true, "Input flags did not survive evaluations");
    await settle();
    assert.equal(context.frameCallbacks, 2, "Settle did not wait for two frames");
    assert.equal(context.finished, 0, "Default settle introduced a GPU finish wait");
    await settle({ finish: true });
    assert.equal(context.frameCallbacks, 4);
    assert.equal(context.finished, 1, "Explicit GPU completion was not awaited");

    let attempts = 0;
    await helpers.waitFor(
        () => {
            attempts++;
            return true;
        },
        "immediate",
        { timeout: 1000, interval: 1 }
    );
    assert.equal(attempts, 1, "An already satisfied condition was polled again");
    attempts = 0;
    await helpers.waitFor(async () => ++attempts === 3, "delayed", { timeout: 1000, interval: 1 });
    assert.equal(attempts, 3, "Wait did not observe the eventual condition");
    await assert.rejects(
        helpers.waitFor(() => false, "Timed out", { timeout: 5, interval: 1, diagnostics: () => ({ radius: 3.2 }) }),
        (error) => error.code === "ERR_ASSERTION" && error.message === 'Timed out: {"radius":3.2}'
    );
    await assert.rejects(
        helpers.waitFor(() => {
            throw new Error("condition failure");
        }, "unused"),
        /condition failure/
    );
    vm.runInContext(
        helpers.pageScript(() => {
            globalThis.injection = "typed function";
        }),
        context
    );
    assert.equal(context.injection, "typed function", "Startup injection did not execute its function");
    vm.runInContext("delete globalThis.sonata", context);
    assert.equal(
        await evaluate(() => typeof globalThis.sonata),
        "undefined",
        "Fallback inspection required a running app"
    );
    await assert.rejects(
        evaluate(({ sonata }) => sonata.cycle),
        /Sonata is not initialized/
    );
    console.log(
        "Browser test helpers: isolated evaluation, JSON arguments, Promise/errors, typed loading, frame/GPU waits and timeout diagnostics passed"
    );
}
checkBrowserTest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

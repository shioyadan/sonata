"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const loadTest = require("./load-test.cjs");
const helpers = loadTest("browser-test.cts");

// 期限の回帰で検査自体が停止しないよう、独立した上限を置く。
async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Deadline regression test did not finish")), 2000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}
const isTimeout = (message) => (error) => error.code === "ERR_ASSERTION" && error.message === message;

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
        bounded(
            helpers.waitFor(() => false, "Timed out", { timeout: 5, interval: 1, diagnostics: () => ({ radius: 3.2 }) })
        ),
        (error) => error.code === "ERR_ASSERTION" && error.message === 'Timed out: {"radius":3.2}'
    );
    await assert.rejects(
        helpers.waitFor(() => {
            throw new Error("condition failure");
        }, "unused"),
        /condition failure/
    );
    // 応答が止まった条件も終了し、遅れた応答を受けてポーリングを再開しない。
    for (const lateValue of [true, false]) {
        let resolveCondition,
            polls = 0;
        const response = new Promise((resolve) => {
            resolveCondition = resolve;
        });
        await assert.rejects(
            bounded(
                helpers.waitFor(
                    () => {
                        polls++;
                        return response;
                    },
                    "No condition response",
                    { timeout: 100, interval: 1 }
                )
            ),
            isTimeout("No condition response")
        );
        resolveCondition(lateValue);
        await helpers.delay(10);
        assert.equal(polls, 1, "A timed-out wait started another condition check");
    }

    const never = () => new Promise(() => {});
    await assert.rejects(
        bounded(
            helpers.waitFor(() => false, "Original failure", {
                timeout: 5,
                interval: 1,
                diagnostics: never,
                diagnosticsTimeout: 100
            })
        ),
        isTimeout("Original failure (diagnostics timed out)")
    );
    for (const diagnostics of [
        () => {
            throw new Error("diagnostic exception");
        },
        () => Promise.reject(new Error("diagnostic exception"))
    ]) {
        await assert.rejects(
            bounded(
                helpers.waitFor(() => false, "Original failure", {
                    timeout: 5,
                    interval: 1,
                    diagnostics
                })
            ),
            isTimeout("Original failure (diagnostics failed: diagnostic exception)")
        );
    }
    const conditionError = new Error("condition rejection");
    await assert.rejects(
        bounded(helpers.waitFor(() => Promise.reject(conditionError), "unused")),
        (error) => error === conditionError
    );

    // 第1・第2フレームが来ない場合に、後続のGPU処理へ進まない。
    for (const deliveredFrames of [0, 1]) {
        const originalRAF = context.requestAnimationFrame;
        let requested = 0;
        const finished = context.finished;
        context.requestAnimationFrame = (callback) => {
            if (++requested <= deliveredFrames) callback();
        };
        try {
            await assert.rejects(
                bounded(settle({ finish: true, timeout: 100 })),
                isTimeout("Animation frames did not settle within 100 ms")
            );
            assert.equal(requested, deliveredFrames + 1);
            assert.equal(context.finished, finished, "GPU work started after a frame timeout");
        } finally {
            context.requestAnimationFrame = originalRAF;
        }
    }

    // タイムアウト後のrejectも捕捉し、別の未処理エラーにしない。
    const unhandled = [];
    const recordUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", recordUnhandled);
    try {
        for (const phase of ["condition", "diagnostics", "gpu"]) {
            let rejectLate;
            const response = new Promise((_, reject) => {
                rejectLate = reject;
            });
            if (phase === "gpu") {
                let evaluations = 0;
                const stuck = helpers.createBrowserTest({
                    webContents: {
                        executeJavaScript() {
                            return ++evaluations === 1 ? Promise.resolve() : response;
                        }
                    }
                });
                await assert.rejects(
                    bounded(stuck.settle({ finish: true, timeout: 100 })),
                    isTimeout("GPU completion did not settle within 100 ms")
                );
                assert.equal(evaluations, 2);
            } else {
                await assert.rejects(
                    bounded(
                        helpers.waitFor(phase === "condition" ? () => response : () => false, "Delayed rejection", {
                            timeout: 100,
                            interval: 1,
                            diagnostics: phase === "diagnostics" ? () => response : undefined,
                            diagnosticsTimeout: 100
                        })
                    ),
                    isTimeout(
                        phase === "diagnostics" ? "Delayed rejection (diagnostics timed out)" : "Delayed rejection"
                    )
                );
            }
            rejectLate(new Error(`late ${phase} rejection`));
            await helpers.delay(1);
        }
        assert.deepEqual(unhandled, [], "Late failures escaped the deadline handler");
    } finally {
        process.removeListener("unhandledRejection", recordUnhandled);
    }

    // 仮の単調時計で、期限後の成功と段階ごとの期限更新を検出する。
    const originalNow = performance.now;
    let elapsed = 0;
    performance.now = () => elapsed;
    try {
        await assert.rejects(
            bounded(
                helpers.waitFor(
                    () => {
                        elapsed += 21;
                        return true;
                    },
                    "Late success",
                    { timeout: 20 }
                )
            ),
            isTimeout("Late success")
        );
        const staged = helpers.createBrowserTest({
            webContents: {
                executeJavaScript() {
                    elapsed += 15;
                    return Promise.resolve();
                }
            }
        });
        await assert.rejects(
            bounded(staged.settle({ finish: true, timeout: 20 })),
            isTimeout("GPU completion did not settle within 20 ms")
        );
    } finally {
        performance.now = originalNow;
    }

    // 成功・例外のどちらでも、長い期限タイマーを残してNodeの終了を妨げない。
    const cleanup = spawnSync(
        process.execPath,
        [
            "-e",
            `
        const {waitFor, createBrowserTest}=require('./scripts/load-test.cjs')('browser-test.cts');
        (async()=>{
            await waitFor(()=>true, 'ready', {timeout:60000});
            await waitFor(()=>{throw Error('expected')}, 'unused', {timeout:60000}).catch(()=>{});
            const {settle}=createBrowserTest({webContents:{executeJavaScript:()=>Promise.resolve()}});
            await settle({finish:true, timeout:60000});
            console.log('Deadline timers cleared');
        })().catch(error=>{console.error(error);process.exitCode=1});
    `
        ],
        { cwd: require("node:path").resolve(__dirname, ".."), encoding: "utf8", timeout: 5000 }
    );
    assert.ifError(cleanup.error);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stdout, /Deadline timers cleared/);

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
        "Browser test helpers: isolated evaluation, JSON arguments, Promise/errors, typed loading, frame/GPU deadlines, late responses, timer cleanup and timeout diagnostics passed"
    );
}
checkBrowserTest().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

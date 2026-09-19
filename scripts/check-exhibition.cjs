"use strict";
const assert = require("node:assert/strict");
const { createExhibition } = require("../src/exhibition.cts");

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function harness(keys = ["a", "b", "c"]) {
    const requests = [];
    const changes = [];
    let activeRequest = null;
    const presentations = [];
    let cancellations = 0;
    const mode = createExhibition({
        keys,
        load(key) {
            assert.equal(activeRequest, null, "The previous reader must finish or be cancelled before another starts");
            const pending = deferred();
            const request = {
                key,
                resolve(value) {
                    if (activeRequest === request) activeRequest = null;
                    pending.resolve(value);
                },
                reject(error) {
                    if (activeRequest === request) activeRequest = null;
                    pending.reject(error);
                }
            };
            requests.push(request);
            activeRequest = request;
            return pending.promise;
        },
        cancelLoad() {
            cancellations++;
            activeRequest = null;
        },
        present(reason) {
            presentations.push(reason);
        },
        changed(state) {
            changes.push(state);
        }
    });
    return {
        mode,
        requests,
        changes,
        reasons: presentations,
        get presentations() {
            return presentations.length;
        },
        get cancellations() {
            return cancellations;
        }
    };
}
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

async function main() {
    const empty = harness([]);
    empty.mode.start();
    empty.mode.loop();
    empty.mode.interact();
    empty.mode.resume();
    empty.mode.tick(1000);
    assert.deepEqual(empty.mode.snapshot(), { active: false, phase: "off", key: null, idleRemaining: 0, error: null });
    assert.equal(empty.requests.length, 0);

    // 通常操作は無効化されず、展示開始と再生末尾だけがサンプルを切り替える。
    const tour = harness();
    tour.mode.interact();
    tour.mode.tick(1000);
    assert.equal(tour.changes.length, 0);
    tour.mode.start("b");
    assert.equal(tour.mode.key, "b");
    tour.mode.tick(0.39);
    assert.equal(tour.requests.length, 0, "The transition must be visible before loading");
    tour.mode.tick(0.01);
    assert.equal(tour.requests[0].key, "b");
    assert.equal(tour.mode.phase, "loading");
    tour.mode.loop();
    tour.requests[0].resolve(true);
    await settle();
    assert.equal(tour.mode.phase, "playing");
    assert.equal(tour.presentations, 1);
    tour.mode.tick(3600);
    assert.equal(tour.mode.phase, "playing", "Elapsed wall time must not cut off a sample before its loop");
    for (const key of ["c", "a", "b"]) {
        tour.mode.loop();
        tour.mode.loop();
        tour.mode.tick(0.4);
        assert.equal(tour.requests.at(-1).key, key);
        tour.requests.at(-1).resolve(true);
        await settle();
    }
    assert.equal(tour.presentations, 4);
    assert.deepEqual(tour.reasons, ["start", "next", "next", "next"]);

    // 入力中は読み直さず、手を離してから30秒の猶予を取り直す。
    tour.mode.interact();
    assert.equal(tour.mode.phase, "exploring");
    tour.mode.tick(29);
    assert.equal(tour.mode.idleRemaining, 1);
    tour.mode.tick(120, true);
    assert.equal(tour.mode.idleRemaining, 30);
    tour.mode.tick(29);
    tour.mode.interact();
    assert.equal(tour.mode.idleRemaining, 30);
    const lastNotice = tour.changes.length;
    tour.mode.tick(0.1);
    assert.equal(tour.changes.length, lastNotice, "The idle display must not rebuild every animation frame");
    tour.mode.tick(29.9);
    assert.equal(tour.mode.phase, "transition");
    assert.equal(tour.mode.key, "b");
    tour.mode.tick(0.4);
    tour.requests.at(-1).resolve(true);
    await settle();
    assert.equal(tour.reasons.at(-1), "resume", "Idle return must retain the presentation chosen while exploring");
    tour.mode.interact();
    tour.mode.resume();
    tour.mode.tick(0.4);
    tour.requests.at(-1).resolve(true);
    await settle();
    assert.equal(tour.mode.phase, "playing");
    assert.deepEqual(tour.reasons.slice(-2), ["resume", "resume"]);

    // 停止・操作・再開始より古い非同期完了は、再生や画面を取り戻してはいけない。
    for (const action of ["stop", "interact", "restart"]) {
        const stale = harness();
        stale.mode.start();
        stale.mode.tick(0.4);
        const old = stale.requests[0];
        if (action === "restart") stale.mode.start("c");
        else stale.mode[action]();
        const before = stale.mode.snapshot();
        const notices = stale.changes.length;
        old.resolve(true);
        await settle();
        assert.deepEqual(stale.mode.snapshot(), before, action);
        assert.equal(stale.changes.length, notices, action);
        assert.equal(stale.presentations, 0, action);
        assert.equal(stale.cancellations, 1, action);
        if (action !== "stop") {
            if (action === "interact") stale.mode.resume();
            stale.mode.tick(0.4);
            stale.requests[1].resolve(true);
            await settle();
            assert.equal(stale.presentations, 1);
            assert.deepEqual(stale.reasons, [action === "interact" ? "resume" : "start"]);
        }
        stale.mode.stop();
        stale.mode.tick(1000);
        assert.equal(stale.mode.active, false);
    }
    const visible = harness();
    visible.mode.start("c");
    visible.mode.interact("a");
    visible.mode.tick(30);
    assert.equal(visible.mode.key, "a", "Idle return must restart the visible sample after cancelling a transition");
    visible.mode.interact("unknown-file");
    assert.equal(visible.mode.key, "a", "An arbitrary File must not enter the exhibition catalogue");
    visible.mode.resume("b");
    assert.equal(visible.mode.key, "b", "Explicit resume can choose a manually selected sample");
    visible.mode.stop();

    const staleRejection = harness();
    staleRejection.mode.start();
    staleRejection.mode.tick(0.4);
    staleRejection.mode.stop();
    staleRejection.requests[0].reject(new Error("Late network failure"));
    await settle();
    assert.equal(staleRejection.mode.error, null);

    // 次デモの取得を操作で中断したら、遅れた完了に次回巡回の演出を実行させない。
    const interrupted = harness();
    interrupted.mode.start();
    interrupted.mode.tick(0.4);
    interrupted.requests[0].resolve(true);
    await settle();
    interrupted.mode.loop();
    interrupted.mode.tick(0.4);
    const nextRequest = interrupted.requests[1];
    interrupted.mode.interact("a");
    interrupted.mode.resume();
    interrupted.mode.tick(0.4);
    interrupted.requests[2].resolve(true);
    await settle();
    nextRequest.resolve(true);
    await settle();
    assert.deepEqual(interrupted.reasons, ["start", "resume"]);
    interrupted.mode.loop();
    interrupted.mode.tick(0.4);
    interrupted.requests[3].resolve(true);
    await settle();
    assert.deepEqual(interrupted.reasons, ["start", "resume", "next"]);
    interrupted.mode.stop();

    // 応答しない取得を取消し、全件失敗なら短い再試行を延々繰り返さない。
    const retry = harness();
    retry.mode.start();
    retry.mode.tick(0.4);
    for (const invalid of [NaN, Infinity, -1]) retry.mode.tick(invalid);
    assert.equal(retry.mode.phase, "loading");
    retry.mode.tick(29.9);
    assert.equal(retry.mode.phase, "loading");
    retry.mode.tick(0.1);
    assert.equal(retry.cancellations, 1);
    assert.equal(retry.mode.phase, "waiting");
    assert.match(retry.mode.error, /timed out/);
    retry.requests[0].resolve(true);
    await settle();
    assert.equal(retry.presentations, 0);
    retry.mode.tick(1.9);
    assert.equal(retry.requests.length, 1);
    retry.mode.tick(0.1);
    retry.mode.tick(0.4);
    assert.equal(retry.requests[1].key, "b");
    retry.requests[1].resolve(false);
    await settle();
    retry.mode.tick(2);
    retry.mode.tick(0.4);
    assert.equal(retry.requests[2].key, "c");
    retry.requests[2].reject(new Error("Sample unavailable"));
    await settle();
    assert.equal(retry.mode.error, "Sample unavailable");
    assert.deepEqual(retry.reasons, [], "Failed or timed-out samples must not trigger presentation changes");
    retry.mode.tick(29);
    assert.equal(retry.mode.phase, "waiting");
    assert.equal(retry.requests.length, 3);
    retry.mode.tick(1);
    retry.mode.tick(0.4);
    assert.equal(retry.requests[3].key, "a");
    retry.requests[3].resolve(true);
    await settle();
    assert.equal(retry.mode.error, null);
    assert.deepEqual(retry.reasons, ["next"], "Continuing after failed samples must use the next-sample presentation");
    retry.mode.loop();
    assert.equal(retry.mode.key, "b", "A recovered connection must retry previously failed samples");
    retry.mode.stop();

    let reentrantLoads = 0;
    const stoppedByUI = createExhibition({
        keys: ["a"],
        load() {
            reentrantLoads++;
            return Promise.resolve(true);
        },
        cancelLoad() {},
        present() {
            assert.fail("Stopping during the loading notification must prevent presentation");
        },
        changed(state) {
            if (state.phase === "loading") stoppedByUI.stop();
        }
    });
    stoppedByUI.start();
    stoppedByUI.tick(0.4);
    await settle();
    assert.equal(reentrantLoads, 0);

    // カタログのコピーと有界な失敗履歴で、長時間巡回も同じ順序を保つ。
    const keys = ["a", "b", "a"];
    const repeated = harness(keys);
    keys.push("unexpected");
    repeated.mode.start("missing");
    for (let i = 0; i < 1000; i++) {
        repeated.mode.tick(0.4);
        assert.equal(repeated.requests[i].key, i % 2 ? "b" : "a");
        repeated.requests[i].resolve(true);
        await settle();
        repeated.mode.loop();
    }
    repeated.mode.stop();
    assert.equal(repeated.presentations, 1000);
    assert.equal(repeated.cancellations, 0);
    console.log("Exhibition: tours, idle return, input holds, cancellation, timeouts and failure recovery passed.");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

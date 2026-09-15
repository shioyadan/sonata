"use strict";
const assert = require("node:assert/strict");
const { createBrowserTest, waitFor } = require("./load-test.cjs")("browser-test.cts");

module.exports = async function reviewStageTransfers(window) {
    const started = performance.now();
    const { evaluate, sampleFrame } = createBrowserTest(window);
    const setup = await evaluate(({ sonata }) => {
        const saved = { style: sonata.visualStyle, cycle: sonata.cycle };
        const trace = sonata.trace,
            cases = new Map();
        for (const op of sonata.ops) {
            for (let i = 1; i < op.stages.length; i++) {
                const from = op.stages[i - 1],
                    to = op.stages[i];
                const duration =
                    to.entryCycles ??
                    (to.node.startsWith("exec")
                        ? Math.min(0.35, (to.end - to.start) * 0.22)
                        : Math.min(0.82, Math.max(0.08, to.end - to.start)));
                const key = from.node + " → " + to.node;
                if (
                    from.node !== to.node &&
                    to.start >= trace.firstCycle &&
                    to.start + duration < Math.min(op.end, trace.lastCycle) &&
                    duration > 0.05 &&
                    !cases.has(key)
                )
                    cases.set(key, { id: op.id, start: to.start, end: to.start + duration });
            }
            if (!op.flush && op.end >= trace.firstCycle && op.end + 1.99 < trace.lastCycle) {
                if (!cases.has("ROB → COMMIT"))
                    cases.set("ROB → COMMIT", { id: op.id, start: op.end, end: op.end + 0.45 });
                if (!cases.has("COMMIT → output"))
                    cases.set("COMMIT → output", { id: op.id, start: op.end + 0.95, end: op.end + 1.99 });
            }
        }
        return { saved, trace: trace.key, cases: [...cases] };
    });
    const transfers = [];
    await sampleFrame(() => evaluate(({ $ }) => $("style-aluminum").click()));
    for (const [key, { id, start, end }] of setup.cases) {
        const frames = [];
        for (let i = 0; i <= 8; i++) {
            // 全サンプルを描画し、次の時刻を送る前にブラウザへ制御を返す。
            frames.push(
                await sampleFrame(() =>
                    evaluate(
                        ({ sonata }, cycle, id, key) => {
                            sonata.captureAt(cycle);
                            const piece = sonata.pieces.find((piece) => piece.id === id);
                            if (!piece) throw new Error(key + ": instruction disappeared at " + cycle);
                            return {
                                cycle,
                                height: piece.position[1],
                                radius: piece.radius,
                                contact: !!piece.contact,
                                position: piece.position,
                                path: piece.pathPosition
                            };
                        },
                        start + ((end - start) * i) / 8,
                        id,
                        key
                    )
                )
            );
        }
        // 駒の上下幅ぶんだけ許容し、両端より土台まで落ちる回帰を検出する。
        const lower = Math.min(frames[0].height, frames.at(-1).height) - frames[0].radius * 2 - 0.02;
        const minimum = Math.min(...frames.map((frame) => frame.height));
        const biggestStep = Math.max(...frames.slice(1).map((frame, i) => Math.abs(frame.height - frames[i].height)));
        const returnedPosition = await sampleFrame(() =>
            evaluate(
                ({ sonata }, start, id) => {
                    sonata.captureAt(start);
                    return sonata.pieces.find((piece) => piece.id === id)?.position;
                },
                start,
                id
            )
        );
        transfers.push({
            key,
            id,
            start,
            end,
            minimum,
            lower,
            biggestStep,
            returned: JSON.stringify(returnedPosition) === JSON.stringify(frames[0].position),
            airborne: frames.filter((frame) => !frame.contact).length,
            frames,
            sameHorizontalPath: frames.every(
                (frame) => frame.position[0] === frame.path[0] && frame.position[2] === frame.path[2]
            )
        });
    }
    // 失敗した採取の後は追加の評価を送らず、元のエラーを呼び出し側へ返す。
    const error = await sampleFrame(() =>
        evaluate(({ sonata, $, gl }, saved) => {
            const error = gl.getError();
            $("style-" + saved.style).click();
            sonata.captureAt(saved.cycle);
            return error;
        }, setup.saved)
    );
    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
    const result = { trace: setup.trace, transfers, error, seconds };
    assert.ok(result.transfers.length >= 5, `${result.trace}: too few stage transitions exercised`);
    assert.ok(
        result.transfers.some((t) => t.airborne > 0),
        `${result.trace}: transitions still follow the board`
    );
    for (const transfer of result.transfers) {
        assert.ok(
            transfer.minimum >= transfer.lower,
            `${result.trace}: ${transfer.key} fell below the stage heights (${transfer.minimum} < ${transfer.lower})`
        );
        assert.ok(
            transfer.biggestStep < 0.4,
            `${result.trace}: ${transfer.key} jumps vertically between samples: ${JSON.stringify(transfer)}`
        );
        assert.ok(
            transfer.returned && transfer.sameHorizontalPath,
            `${result.trace}: ${transfer.key} changed with seek order or left its horizontal path`
        );
    }
    assert.equal(result.error, 0);
    console.log(`[transfers] ${setup.trace}: passed (${seconds}s)`);
    return result;
};

// 経路の座標検査は材質の画素比較から独立して実行できる。
// desktop の配置を保った小さな描画面で全9時刻を描き、終了後は元の表示サイズへ戻す。
module.exports.all = async function reviewAllTransfers(window) {
    const { evaluate, sampleFrame } = createBrowserTest(window);
    const [width, height] = window.getContentSize();
    const traces = [];
    const viewport = { width: 1001, height: 620 };
    const restored = () =>
        evaluate(({ sonata }) => ({ width: innerWidth, height: innerHeight, compact: sonata.camera.compact }));
    const waitSize = async (width, height) => {
        let actual;
        await waitFor(
            async () => {
                actual = await restored();
                return actual.width === width && actual.height === height && !actual.compact;
            },
            "Stage transfer viewport did not settle",
            { timeout: 5000, diagnostics: () => actual }
        );
    };
    try {
        window.setContentSize(viewport.width, viewport.height);
        await waitSize(viewport.width, viewport.height);
        await sampleFrame(() =>
            evaluate(({ sonata, $ }) => {
                sonata.setPlaying(false);
                if ($("auto-camera").getAttribute("aria-pressed") === "true") $("auto-camera").click();
                $("style-aluminum").click();
            })
        );
        const keys = await evaluate(() => sonataDemoCatalog.map((trace) => trace.key));
        for (const key of keys) {
            await sampleFrame(() =>
                evaluate(async ({ sonata }, key) => {
                    await sonata.loadTrace(key);
                    sonata.captureAt(sonata.trace.demo.screenshotCycle);
                }, key)
            );
            traces.push(await module.exports(window));
        }
        await sampleFrame(() => evaluate(({ $ }) => $("style-neon").click()));
    } finally {
        window.setContentSize(width, height);
    }
    // 本体が失敗した場合は復帰のassertで元の原因を置き換えない。
    await waitSize(width, height);
    return { viewport, traces, restored: await restored() };
};

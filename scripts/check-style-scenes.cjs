"use strict";
const assert = require("node:assert/strict");
const { createBrowserTest } = require("./load-test.cjs")("browser-test.cts");

// 同じ材質の時刻をまとめて検査し、各時刻で固定シーンを作り直さない。
// Neon に戻した後も全時刻を再照合し、切替前後の再生状態とキャッシュの復元を検査する。
module.exports = async function reviewStyleScenes(window, capture) {
    const js = (source) => window.webContents.executeJavaScript(source);
    const { sampleFrame } = createBrowserTest(window);
    const matteStyles = ["aluminum", "paper"];
    let fixedRadius;
    const scenes = [];
    const switchStyle = async (style) => {
        const state = await sampleFrame(() =>
            js(`(() => {
                const before = reviewState(), trace = sonata.trace;
                reviewStyle(${JSON.stringify(style)});
                return { before, after: reviewState(), sameTrace: trace === sonata.trace };
            })()`)
        );
        assert.ok(state.sameTrace, `${style}: style replaced the trace`);
        assert.deepEqual(state.after, state.before, `${style}: style changed replay, selection or camera state`);
    };
    const sample = (cycle, withGeometry = false) =>
        sampleFrame(() =>
            js(`(() => {
                sonata.captureAt(${cycle});
                const renderer = sonata.renderer;
                return {
                    state: reviewState(),
                    geometry: ${withGeometry} ? {
                        pieces: sonata.pieces,
                        colors: sonata.particles.map(p => ({ id: p.id, color: p.color })),
                        layout: sonata.instructionLayout,
                        instances: renderer.materialInstances,
                        pieceInstances: renderer.pieceInstances,
                        vertices: renderer.pieceVertices
                    } : null,
                    radii: ${withGeometry} ? [...new Set(sonata.pieces.map(p => p.radius))] : null,
                    shape: renderer.instructionShape,
                    error: renderer.error,
                    contextLost: document.getElementById('scene').getContext('webgl2').isContextLost()
                };
            })()`)
        );
    // カメラの補間はフレームごとに進むため、同時刻の別フレーム間では再生状態を照合する。
    // カメラと選択の不変性は上の同期的な切替前後で、実際の切替すべてを検査する。
    const replayState = ({ camera, ...state }) => state;
    const comparableGeometry = (geometry) => ({
        ...geometry,
        // 紙箱と金属パックは高さと接触点が異なる。正立と実接地は形状別の検査で確認する。
        pieces: geometry.pieces.map(({ position, contact, rotation, ...pose }) => ({
            ...pose,
            position: [position[0], position[2]]
        }))
    });
    for (const key of await js("sonataDemoCatalog.map(t => t.key)")) {
        const started = performance.now();
        const checkpoints = await js(`(async () => {
            await sonata.loadTrace(${JSON.stringify(key)});
            return [sonata.trace.demo.screenshotCycle, ...sonata.trace.demo.bookmarks.map(b => b.cycle + .4)];
        })()`);
        await switchStyle("neon");
        const stageLayout = await require("./check-stage-layout.cjs")(window);
        const layout = await js("sonata.instructionLayout");
        const spacing = {};
        for (const name of ["scheduler", "rob", "rename"]) {
            let minimum = Infinity;
            const positions = layout[name];
            for (let i = 0; i < positions.length; i++)
                for (let j = i + 1; j < positions.length; j++)
                    minimum = Math.min(
                        minimum,
                        Math.hypot(positions[i][0] - positions[j][0], positions[i][2] - positions[j][2])
                    );
            assert.ok(minimum > layout.radius * 2, `${key}: ${name} slots overlap fixed-size instructions`);
            spacing[name] = minimum;
        }
        const references = [];
        for (const cycle of checkpoints) references.push(replayState((await sample(cycle)).state));
        await js(`sonata.captureAt(${checkpoints[0]}); document.querySelector('.telemetry').scrollTop = 0`);
        const neon = await capture(`${key}-neon`);
        const appearances = {};
        const referenceGeometry = [];
        let referencePixels;
        for (const style of matteStyles) {
            await switchStyle(style);
            for (const [index, cycle] of checkpoints.entries()) {
                const result = await sample(cycle, true);
                const context = `${key} @ ${cycle} / ${style}`;
                assert.equal(result.contextLost, false, `${context}: graphics context lost during sampling`);
                if (fixedRadius === undefined) fixedRadius = result.radii[0];
                assert.deepEqual(
                    result.radii,
                    [fixedRadius],
                    `${context}: instruction size changed with stage or state`
                );
                assert.deepEqual(
                    replayState(result.state),
                    references[index],
                    `${context}: style changed replay state`
                );
                assert.ok(result.geometry.vertices > 0, `${context}: instruction geometry is empty`);
                assert.equal(result.error, 0, `${context}: WebGL error`);
                assert.equal(
                    result.shape,
                    style === "paper" ? "paper-box" : "metal-puck",
                    `${context}: instruction shape changed`
                );
                for (const piece of result.geometry.pieces)
                    assert.deepEqual(
                        piece.rotation,
                        [0, 0, 0, 1],
                        `${context}: sliding instruction ${piece.id} rotated`
                    );
                const geometry = comparableGeometry(result.geometry);
                if (style === "aluminum") referenceGeometry.push(geometry);
                else
                    assert.deepEqual(
                        geometry,
                        referenceGeometry[index],
                        `${context}: style changed shared poses, instruction colors or instance counts`
                    );
            }
            await js(`sonata.captureAt(${checkpoints[0]})`);
            const frame = await capture(`${key}-${style}`, referencePixels);
            assert.ok(
                frame.metrics.background.reduce((sum, value) => sum + value, 0) >
                    neon.metrics.background.reduce((sum, value) => sum + value, 0) + 300,
                `${style}: style did not change the rendered canvas`
            );
            appearances[style] = frame.metrics;
            if (!referencePixels) referencePixels = frame.pixels;
            await switchStyle("neon");
            for (const [index, cycle] of checkpoints.entries()) {
                const restored = await sample(cycle);
                assert.deepEqual(
                    replayState(restored.state),
                    references[index],
                    `${key} @ ${cycle}: Neon restoration after ${style} changed state`
                );
                assert.equal(restored.contextLost, false, `${key}: restoring Neon lost the graphics context`);
                assert.equal(restored.error, 0, `${key}: restoring Neon caused a WebGL error`);
            }
        }
        const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
        console.log(`[styles] ${key}: passed (${seconds}s)`);
        scenes.push({
            key,
            checkpoints: checkpoints.length,
            neon: neon.metrics,
            ...appearances,
            spacing,
            stageLayout,
            seconds
        });
    }
    // 次のデモ読込みでも明示的に選んだ材質が保たれることを、呼出し側で確認する。
    await switchStyle(matteStyles.at(-1));
    return { scenes, fixedRadius };
};

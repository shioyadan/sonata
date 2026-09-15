"use strict";
const assert = require("node:assert/strict");
const { createBrowserTest, waitFor } = require("./load-test.cjs")("browser-test.cts");

// タッチ・キーボード・全デモ・ダイアログの操作は check-mobile.cjs で一度だけ検査する。
// ここでは材質ごとの DPR 2 描画、4画面の配置とデスクトップ復帰を確認する。
module.exports = async function reviewStyleMobile(window, capture) {
    const js = (source) => window.webContents.executeJavaScript(source);
    const { settle } = createBrowserTest(window);
    const debuggerAPI = window.webContents.debugger;
    const command = (method, args = {}) => debuggerAPI.sendCommand(method, args);
    const [desktopWidth, desktopHeight] = window.getContentSize();
    const results = {};
    const restore = async () => {
        window.setContentSize(desktopWidth, desktopHeight);
        await command("Emulation.clearDeviceMetricsOverride");
    };
    debuggerAPI.attach("1.3");
    try {
        await js(`(async () => {
            await sonata.loadTrace('rename-rush');
            sonata.captureAt(sonata.trace.demo.screenshotCycle);
            document.getElementById('zoom-fit').click();
        })()`);
        for (const style of ["aluminum", "paper"]) {
            await js(`reviewStyle(${JSON.stringify(style)})`);
            const layouts = [];
            for (const [width, height] of [
                [320, 568],
                [390, 844],
                [430, 932],
                [932, 430]
            ]) {
                window.setContentSize(width, height);
                await command("Emulation.setDeviceMetricsOverride", {
                    width,
                    height,
                    deviceScaleFactor: 2,
                    mobile: true
                });
                await waitFor(
                    () =>
                        js(`innerWidth === ${width} && innerHeight === ${height} && sonata.camera.compact
                        && document.getElementById('mobile-panel').contains(document.querySelector('.telemetry'))`),
                    `${style}: mobile layout did not settle at ${width} px`,
                    { timeout: 5000 }
                );
                await settle();
                const layout = await require("./check-mobile.cjs").layout(window, width, height);
                const material = await js("({ style: sonata.visualStyle, shape: sonata.renderer.instructionShape })");
                assert.equal(material.style, style);
                assert.equal(material.shape, style === "paper" ? "paper-box" : "metal-puck");
                const frame = await capture(`${style}-mobile-${width}`);
                layouts.push({ ...layout, pixels: frame.metrics });
            }
            await js("document.getElementById('mobile-details').click()");
            assert.ok(await js("document.getElementById('mobile-panel').open"));
            await restore();
            let desktop;
            await waitFor(
                async () => {
                    desktop = await js(`({ width: innerWidth, height: innerHeight, compact: sonata.camera.compact,
                    style: sonata.visualStyle, sidebarInMain: document.querySelector('main').contains(document.querySelector('.telemetry')),
                    panelOpen: document.getElementById('mobile-panel').open,
                    focusInClosedPanel: document.getElementById('mobile-panel').contains(document.activeElement) })`);
                    return (
                        desktop.width === desktopWidth &&
                        desktop.height === desktopHeight &&
                        !desktop.compact &&
                        desktop.sidebarInMain &&
                        !desktop.panelOpen &&
                        !desktop.focusInClosedPanel
                    );
                },
                `${style}: desktop did not return after resize`,
                { timeout: 5000, diagnostics: () => desktop }
            );
            assert.equal(desktop.style, style, "Mobile layout restoration reset the style");
            results[style] = { layouts, desktopRestore: desktop };
        }
    } finally {
        try {
            await restore();
        } finally {
            debuggerAPI.detach();
        }
    }
    return results;
};

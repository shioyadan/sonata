"use strict";
// リポジトリのルートから実行する。--listで検査範囲を確認できる。
const { selectSections, sections, scriptArguments } = require("./render-plan.cjs");
const args = scriptArguments(process.argv, __filename).filter((arg) => arg !== "--no-sandbox");
if (args.length === 1 && args[0] === "--list") {
    console.log(
        `Render sections: ${sections.join(", ")}\nSelect with --sections=name,name; no option runs the full review.`
    );
    process.exit(0);
}
let selected;
try {
    selected = selectSections(args, Boolean(process.env.SONATA_MOBILE_ONLY));
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const load = require("./load-test.cjs");
const { waitFor, loadPage } = load("browser-test.cts");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
const root = path.resolve(__dirname, "..");
const screenshots = path.join(root, "artifacts/screenshots");
const reportPath = path.join(root, "artifacts/render-results.json");
fs.mkdirSync(screenshots, { recursive: true });
const sourceEntry = process.env.SONATA_HTML ? path.resolve(process.env.SONATA_HTML) : require("./build.cjs").build();
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-offline-"));
app.setPath("userData", path.join(isolated, "profile"));
const offlineEntry = path.join(isolated, "sonata.html");
fs.copyFileSync(sourceEntry, offlineEntry);
const siteDirectory = path.join(isolated, "site");
fs.mkdirSync(siteDirectory);
const siteEntry = path.join(siteDirectory, "sonata.html");
fs.copyFileSync(sourceEntry, siteEntry);
fs.cpSync(path.join(path.dirname(sourceEntry), "samples"), path.join(siteDirectory, "samples"), { recursive: true });
const server = require("./serve.cjs").createServer(siteEntry);
const errors = [],
    unexpectedRequests = [],
    requests = [],
    timings = [];
const results = {};
let currentSection;
const started = performance.now();
const begin = (name) => {
    const start = performance.now();
    console.log(`[render] ${name}: start`);
    return () => {
        const seconds = Number(((performance.now() - start) / 1000).toFixed(2));
        timings.push({ name, seconds });
        console.log(`[render] ${name}: passed (${seconds}s)`);
    };
};
const writeReport = (status, error) => {
    fs.writeFileSync(
        reportPath,
        JSON.stringify(
            {
                status,
                sections: selected,
                seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
                timings,
                results,
                errors,
                externalRequests: unexpectedRequests,
                ...(error && { failure: { section: currentSection, message: error.message, stack: error.stack } })
            },
            null,
            2
        ) + "\n"
    );
};
app.whenReady()
    .then(async () => {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const baseURL = `http://127.0.0.1:${server.address().port}/`;
        const entry = `${baseURL}sonata.html#demo=rename-rush`;
        const allowedURLs = new Set([
            "about:blank",
            pathToFileURL(offlineEntry).href,
            baseURL,
            `${baseURL}sonata.html`,
            ...fs.readdirSync(path.join(siteDirectory, "samples")).map((file) => `${baseURL}samples/${file}`)
        ]);
        const window = new BrowserWindow({
            width: 1440,
            height: 1000,
            show: true,
            webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
        });
        window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
            const url = new URL(request.url);
            url.hash = "";
            requests.push(url.href);
            const allowed = allowedURLs.has(url.href);
            if (!allowed) unexpectedRequests.push(request.url);
            callback({ cancel: !allowed });
        });
        window.webContents.on("console-message", (event) => {
            if (event.level === "error") errors.push(event.message);
        });
        window.webContents.on("preload-error", (_event, _path, error) => errors.push(String(error)));
        const run = {
            demos: () => load("check-demo-loading.cts")(window, offlineEntry, baseURL, requests, screenshots),
            desktop: () => require("./check-desktop.cjs")(window, screenshots),
            evidence: () => require("./check-evidence-render.cjs")(window, screenshots),
            mobile: () => require("./check-mobile.cjs")(window, screenshots),
            motion: () => require("./check-motion.cjs")(window, entry, screenshots),
            browser: () => load("check-browser.cts")(window, entry, screenshots),
            styles: () => require("./check-styles.cjs")(window, entry, screenshots),
            memory: () => require("./check-memory-render.cjs")(window, screenshots),
            transfers: () => require("./check-stage-transfers.cjs").all(window),
            smoke: () => load("check-smoke.cts")(window, screenshots, begin),
            launcher: () => load("check-launcher-render.cts")(window, screenshots, (url) => allowedURLs.add(url)),
            import: () => load("check-import.cts")(window, screenshots)
        };
        for (const group of ["basic", "navigation", "streaming", "playback", "layout"])
            run[`import-${group}`] = () => load("check-import.cts")(window, screenshots, { sections: [group] });
        for (const name of selected) {
            currentSection = name;
            const done = begin(name);
            // 直前のsuiteの選択・速度・画面幅に依存せず、単独でも同じ初期状態から検査する。
            window.setSize(1440, 1000);
            if (!["demos", "motion", "browser", "styles", "launcher"].includes(name)) {
                await loadPage(window, entry);
                await waitFor(
                    () =>
                        window.webContents.executeJavaScript(
                            "globalThis.sonata?.hasTrace && sonata.trace.key === 'rename-rush'"
                        ),
                    `${name}: the initial sample did not load`
                );
            }
            results[name] = await run[name]();
            assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
            assert.deepEqual(
                unexpectedRequests,
                [],
                "The app requested a resource outside the published sample allowlist"
            );
            done();
        }
        writeReport("passed");
        console.log(`[render] passed; report: ${path.relative(root, reportPath)}`);
        window.destroy();
    })
    .catch((error) => {
        console.error(error);
        if (errors.length) console.error("Renderer errors:", errors);
        writeReport("failed", error);
        process.exitCode = 1;
    })
    .finally(() => {
        server.close();
        fs.rmSync(isolated, { recursive: true, force: true });
        app.exit(process.exitCode || 0);
    });

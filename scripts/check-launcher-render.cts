"use strict";
// 実helperのHTTPストリームと、File読込みへ引き継ぐ際の取消を小さな入力で検査する。
import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import zlib = require("node:zlib");
import childProcess = require("node:child_process");
import url = require("node:url");
const { pathToFileURL } = url;
import type { BrowserWindow } from "electron";
const { createBrowserTest, waitFor, loadPage } = require("./load-test.cjs")(
    "browser-test.cts"
) as typeof import("./browser-test.cts");

declare global {
    var launcherReview:
        | {
              fetch: typeof fetch;
              release?: () => void;
              pending?: Promise<void>;
              aborted: boolean;
              started: boolean;
          }
        | undefined;
}

async function reviewLauncher(window: BrowserWindow, screenshots: string, allowURL: (url: string) => void) {
    const root = path.resolve(__dirname, "..");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-launcher-render-"));
    const distribution = path.join(directory, "dist");
    fs.mkdirSync(distribution);
    fs.copyFileSync(path.join(root, "sonata.sh"), path.join(directory, "sonata.sh"));
    const html = path.join(distribution, "sonata.html");
    fs.copyFileSync(process.env.SONATA_HTML || path.join(root, "dist/sonata.html"), html);
    const text =
        "Kanata\t0004\n" +
        Array.from(
            { length: 24 },
            (_, id) =>
                `I\t${id}\t${id}\t0\nL\t${id}\t0\t0x1000: add r1, r2\nS\t${id}\t0\tF\nC\t2\nE\t${id}\t0\tF\nS\t${id}\t0\tX\nC\t2\nE\t${id}\t0\tX\nR\t${id}\t${id}\t0\nC\t12\n`
        ).join("");
    const { evaluate } = createBrowserTest(window);
    const state = () =>
        evaluate(({ sonata }) => ({
            loaded: sonata.hasTrace,
            name: sonata.fileImport.source?.name,
            complete: sonata.fileImport.source?.complete,
            count: sonata.fileImport.source?.opCount,
            busy: sonata.fileImport.busy,
            cycle: sonata.cycle,
            first: sonata.trace.firstCycle,
            status: document.getElementById("import-status")!.textContent
        }));
    const ready = () => waitFor(() => evaluate(() => Boolean(globalThis.sonata)), "Launcher page did not initialize");
    const until = (check: (value: Awaited<ReturnType<typeof state>>) => boolean, message: string) =>
        waitFor(async () => check(await state()), message, { diagnostics: state });
    let helper: childProcess.ChildProcess | null = null;
    async function stop() {
        if (!helper || helper.exitCode !== null) return;
        const running = helper;
        helper = null;
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => running.kill("SIGKILL"), 3000);
            running.once("exit", () => {
                clearTimeout(timeout);
                resolve();
            });
            running.kill("SIGTERM");
        });
    }
    async function start(file: string) {
        let output = "";
        let failure = "";
        const environment = { ...process.env };
        delete environment.SONATA_PORT;
        helper = childProcess.spawn("bash", [path.join(directory, "sonata.sh"), file], {
            cwd: directory,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"]
        });
        helper.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        helper.stderr!.on("data", (chunk: Buffer) => {
            failure += chunk.toString();
        });
        helper.on("error", (error) => {
            failure += error.message;
        });
        await waitFor(() => {
            if (failure) throw new Error(failure);
            if (helper!.exitCode !== null) throw new Error(`Launcher exited: ${output}`);
            return /^Sonata URL: (http:\/\/127\.0\.0\.1:\d+\/#trace=1)$/m.test(output);
        }, "The helper did not announce its URL");
        const href = output.match(/^Sonata URL: (http:\/\/127\.0\.0\.1:\d+\/#trace=1)$/m)![1];
        const base = new URL(href).origin;
        for (const route of ["/", "/sonata.html", "/trace-info", "/trace1"]) allowURL(base + route);
        return href;
    }
    async function delayedMetadata() {
        await evaluate(() => {
            const original = globalThis.fetch;
            const control = (globalThis.launcherReview = {
                fetch: original,
                aborted: false,
                started: false
            } as NonNullable<typeof globalThis.launcherReview>);
            globalThis.fetch = async (input, options) => {
                if (
                    new URL(input instanceof Request ? input.url : String(input), location.href).pathname !==
                    "/trace-info"
                )
                    return original(input, options);
                options?.signal?.addEventListener(
                    "abort",
                    () => {
                        control.aborted = true;
                    },
                    { once: true }
                );
                control.started = true;
                // Abort後にも到着する応答で、世代判定の漏れを検出する。
                await new Promise<void>((resolve) => {
                    control.release = resolve;
                });
                return new Response(JSON.stringify({ name: "late.kanata", size: 100, lastModified: 0 }));
            };
            control.pending = globalThis.sonata!.openLauncherTrace();
        });
        await waitFor(() => evaluate(() => globalThis.launcherReview?.started), "Metadata request did not start");
    }
    async function releaseMetadata() {
        return evaluate(async () => {
            const control = globalThis.launcherReview!;
            globalThis.fetch = control.fetch;
            control.release?.();
            await control.pending;
            const aborted = control.aborted;
            delete globalThis.launcherReview;
            return aborted;
        });
    }
    try {
        const offline = pathToFileURL(html).href;
        allowURL(offline);
        await loadPage(window, `${offline}#trace=1`);
        await ready();
        assert.equal((await state()).loaded, false, "A file URL tried to open a launcher trace");
        assert.equal((await state()).busy, false);

        const { Zstd } = await import("@hpcc-js/wasm-zstd");
        const zstd = await Zstd.load();
        const formats = [
            ["gz", zlib.gzipSync(text)],
            ["zst", zstd.compress(new TextEncoder().encode(text))]
        ] as const;
        for (const [extension, bytes] of formats) {
            const name = `launcher trace.${extension}`;
            const file = path.join(directory, name);
            fs.writeFileSync(file, bytes);
            const href = await start(file);
            if (extension === "gz") {
                await loadPage(window, new URL(href).origin + "/");
                await ready();
                assert.equal((await state()).loaded, false, "Normal startup fetched a trace eagerly");
                assert.deepEqual(
                    await evaluate(() =>
                        performance
                            .getEntriesByType("resource")
                            .filter((entry) => ["/trace-info", "/trace1"].includes(new URL(entry.name).pathname))
                            .map((entry) => entry.name)
                    ),
                    []
                );
            }
            await loadPage(window, href);
            await ready();
            await until(
                (s) => s.name === name && Boolean(s.complete) && !s.busy,
                `${extension}: helper trace did not reach EOF`
            );
            assert.equal((await state()).count, 24);
            assert.equal(
                await evaluate(({ sonata }) => sonata.trace.evidence?.registers ?? null),
                null,
                "A launcher trace inherited a demo register map"
            );
            await evaluate(() => {
                (document.getElementById("file-cycle") as HTMLInputElement).value = "240";
                document.getElementById("file-go")!.click();
            });
            await until((s) => s.first === 240 && !s.busy, `${extension}: helper trace did not navigate`);
            assert.equal(await evaluate(({ sonata }) => sonata.trace.ops.some((op) => op[0] === 15)), true);
            if (extension === "gz") {
                fs.writeFileSync(
                    path.join(screenshots, "launcher-gzip.png"),
                    (await window.webContents.capturePage()).toPNG()
                );
                await loadPage(window, href);
                await ready();
                await until(
                    (s) => s.name === name && Boolean(s.complete) && !s.busy,
                    "Refreshing the helper page lost its trace"
                );
                await evaluate(() => document.getElementById("file-close")!.click());
                assert.equal((await state()).loaded, false);
                await stop();
            }
        }
        await delayedMetadata();
        await evaluate(() => document.getElementById("import-cancel")!.click());
        assert.equal(await releaseMetadata(), true, "Cancel did not abort metadata retrieval");
        assert.equal((await state()).loaded, false, "Canceled metadata restored its trace");
        assert.match((await state()).status!, /canceled/);
        await delayedMetadata();
        await evaluate((_page, text) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([text], "newer.kanata"));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
        }, text);
        assert.equal(await releaseMetadata(), true, "A new File did not abort metadata retrieval");
        await until(
            (s) => s.name === "newer.kanata" && Boolean(s.complete) && !s.busy,
            "Late metadata replaced a newer File"
        );
        for (const response of ["missing", "invalid"] as const) {
            await evaluate(async ({ sonata }, response) => {
                const original = globalThis.fetch;
                globalThis.fetch = async () =>
                    response === "missing"
                        ? new Response("Not found", { status: 404 })
                        : new Response(JSON.stringify({ name: "bad", size: -1, lastModified: 0 }));
                try {
                    await sonata.openLauncherTrace();
                } finally {
                    globalThis.fetch = original;
                }
            }, response);
            const failed = await state();
            assert.equal(failed.busy, false, "Failed metadata left the importer busy");
            assert.match(failed.status!, response === "missing" ? /HTTP 404/ : /invalid trace metadata/);
        }
        return {
            actualHelper: true,
            formats: ["gzip", "zstd"],
            eof: true,
            navigation: true,
            refresh: true,
            lazyStartup: true,
            cancelMetadata: true,
            newerFile: true,
            metadataFailures: true
        };
    } finally {
        await stop();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
export = reviewLauncher;

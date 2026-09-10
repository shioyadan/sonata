"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");

async function main() {
    const child = spawn(process.execPath, [path.join(root, "scripts/serve.cjs")], {
        cwd: root,
        env: { ...process.env, SONATA_HOST: "127.0.0.1", SONATA_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "",
        errors = "";
    child.stderr.on("data", (chunk) => {
        errors += chunk;
    });
    const stopped = new Promise((resolve) => child.once("close", resolve));
    try {
        const port = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Preview server did not start.")), 10000);
            child.stdout.on("data", (chunk) => {
                output += chunk;
                const match = /Sonata: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
                if (match) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                }
            });
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                reject(new Error(`Preview server exited: ${code}; ${errors}`));
            });
        });
        const request = (target, method = "GET") =>
            new Promise((resolve, reject) => {
                const req = http.request(
                    { hostname: "127.0.0.1", port, path: target, method, timeout: 5000 },
                    (res) => {
                        const chunks = [];
                        res.on("data", (chunk) => chunks.push(chunk));
                        res.on("error", reject);
                        res.on("end", () =>
                            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
                        );
                    }
                );
                req.on("timeout", () => req.destroy(new Error("Preview request timed out.")));
                req.on("error", reject);
                req.end();
            });
        const html = fs.readFileSync(path.join(root, "dist/sonata.html"));
        for (const target of ["/", "/sonata.html", "/?demo=1"]) {
            const response = await request(target);
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, html);
            assert.match(response.headers["content-type"], /text\/html; charset=utf-8/);
        }
        const head = await request("/", "HEAD");
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
        assert.equal(Number(head.headers["content-length"]), html.length);
        for (const target of [
            "/src/sonata.cts",
            "/src/geometry.cts",
            "/src/replay-model.cts",
            "/data/traces.js",
            "/.git/config",
            "/work/HANDOFF.md",
            "/../README.md",
            "/%2e%2e/README.md"
        ]) {
            assert.equal((await request(target)).status, 404, `Source path exposed: ${target}`);
        }
        const post = await request("/", "POST");
        assert.equal(post.status, 405);
        assert.equal(post.headers.allow, "GET, HEAD");
        // 不正なリクエストを拒否した後も、次の利用者へ配信できることを確認する。
        for (const target of ["//[", "//%"]) {
            assert.equal((await request(target)).status, 400);
            assert.equal((await request("/")).status, 200, "Malformed URL stopped the server");
        }
        // Node の型変換が出す既知の警告だけを許容し、その他の診断は引き続き失敗にする。
        const transformWarning =
            `(node:${child.pid}) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time\n` +
            "(Use `node --trace-warnings ...` to show where the warning was created)\n";
        assert.ok(errors === "" || errors === transformWarning, `Unexpected server diagnostics:\n${errors}`);
        console.log("Server: HTML / HEAD / source isolation / method rejection / malformed URL recovery verified");
    } finally {
        child.kill();
        await stopped;
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

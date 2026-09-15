"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createServer } = require("./serve.cjs");
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
            "/%2e%2e/README.md",
            "/samples/../data/traces.js",
            "/samples/%2e%2e/.git/config",
            "/samples/missing.log.gz",
            "/samples/gem5-arm-coremark.log.gz/extra"
        ]) {
            assert.equal((await request(target)).status, 404, `Source path exposed: ${target}`);
        }
        const sampleDirectory = path.join(root, "dist/samples");
        for (const file of fs.readdirSync(sampleDirectory)) {
            const target = `/samples/${file}`;
            const bytes = fs.readFileSync(path.join(sampleDirectory, file));
            const response = await request(`${target}?cache=1`);
            assert.equal(response.status, 200);
            assert.deepEqual(response.body, bytes);
            assert.match(response.headers["content-type"], /^application\/gzip$/);
            assert.equal(response.headers["x-content-type-options"], "nosniff");
            assert.equal(
                response.headers["content-encoding"],
                undefined,
                "gzip bytes must reach the trace reader unchanged"
            );
            const sampleHead = await request(target, "HEAD");
            assert.equal(sampleHead.status, 200);
            assert.equal(sampleHead.body.length, 0);
            assert.equal(Number(sampleHead.headers["content-length"]), bytes.length);
            assert.equal((await request(target, "POST")).status, 405);
        }
        const post = await request("/", "POST");
        assert.equal(post.status, 405);
        assert.equal(post.headers.allow, "GET, HEAD");
        // 不正なリクエストを拒否した後も、次の利用者へ配信できることを確認する。
        for (const target of ["//[", "//%", "/samples/%", "/samples/%ff"]) {
            assert.equal((await request(target)).status, 400);
            assert.equal((await request("/")).status, 200, "Malformed URL stopped the server");
        }
        // Node の型変換が出す既知の警告だけを許容し、その他の診断は引き続き失敗にする。
        const transformWarning =
            `(node:${child.pid}) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time\n` +
            "(Use `node --trace-warnings ...` to show where the warning was created)\n";
        assert.ok(errors === "" || errors === transformWarning, `Unexpected server diagnostics:\n${errors}`);
        console.log(
            "Server: HTML / samples / HEAD / source isolation / method rejection / malformed URL recovery verified"
        );
    } finally {
        child.kill();
        await stopped;
    }
}
async function checkIsolatedDistribution() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-server-"));
    let server;
    try {
        fs.cpSync(path.join(root, "dist"), temp, { recursive: true });
        const htmlPath = path.join(temp, "sonata.html");
        fs.writeFileSync(path.join(temp, "samples/unlisted.json"), '{"private":true}');
        server = createServer(htmlPath);
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const origin = `http://127.0.0.1:${server.address().port}`;
        assert.equal(await (await fetch(origin)).text(), fs.readFileSync(htmlPath, "utf8"));
        for (const file of fs.readdirSync(path.join(root, "dist/samples"))) {
            const response = await fetch(`${origin}/samples/${file}`);
            assert.equal(response.status, 200);
            assert.deepEqual(
                Buffer.from(await response.arrayBuffer()),
                fs.readFileSync(path.join(temp, "samples", file))
            );
        }
        assert.equal((await fetch(`${origin}/samples/unlisted.json`)).status, 404, "Server exposed an unlisted file");
        const missing = fs.readdirSync(path.join(root, "dist/samples"))[0];
        fs.unlinkSync(path.join(temp, "samples", missing));
        assert.equal((await fetch(`${origin}/samples/${missing}`)).status, 404, "Missing sample did not return 404");
        const missingHead = await fetch(`${origin}/samples/${missing}`, { method: "HEAD" });
        assert.equal(missingHead.status, 404);
        assert.equal((await missingHead.arrayBuffer()).byteLength, 0);
        const html = fs.readFileSync(htmlPath, "utf8");
        for (const entry of [
            { key: "../escape", url: "samples/../escape.log.gz" },
            { key: "branch-storm", url: "https://example.test/trace.log.gz" },
            { key: "branch-storm", url: "samples/../escape.log.gz" },
            { key: "branch-storm", url: "../data/traces.js" }
        ]) {
            fs.writeFileSync(
                htmlPath,
                html.replace(
                    /^globalThis\.sonataDemoCatalog=(.+);$/m,
                    () => `globalThis.sonataDemoCatalog=${JSON.stringify([entry])};`
                )
            );
            assert.throws(() => createServer(htmlPath), /Invalid or duplicate demo URL/);
        }
        console.log("Server: relocated distribution / fixed catalog / missing sample recovery verified");
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

main()
    .then(checkIsolatedDistribution)
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

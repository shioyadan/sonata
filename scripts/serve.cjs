"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { build } = require("./build.cjs");

function createServer(htmlPath = build()) {
    const html = fs.readFileSync(htmlPath);
    const assignment = /^globalThis\.sonataDemoCatalog=(.+);$/m.exec(html.toString("utf8"));
    if (!assignment) throw new Error("Missing demo catalog");
    const catalog = JSON.parse(assignment[1]);
    if (!Array.isArray(catalog)) throw new Error("Invalid demo catalog");
    const samples = new Map();
    for (const { key, url } of catalog) {
        if (
            typeof key !== "string" ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) ||
            url !== `samples/${key}.json` ||
            samples.has(`/${url}`)
        )
            throw new Error(`Invalid or duplicate demo URL: ${url}`);
        samples.set(`/${url}`, path.join(path.dirname(htmlPath), url));
    }
    return http.createServer((request, response) => {
        const fail = (status, message) => {
            response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
            response.end(request.method === "HEAD" ? undefined : message);
        };
        let pathname;
        try {
            pathname = new URL(request.url, "http://localhost").pathname;
            decodeURI(pathname); // 不正なパーセント表記も、配信経路の照合前に拒否する。
        } catch {
            fail(400, "Bad request");
            return;
        }
        if (!["GET", "HEAD"].includes(request.method)) {
            response.writeHead(405, { Allow: "GET, HEAD" });
            response.end();
            return;
        }
        const send = (content, type) => {
            response.writeHead(200, {
                "Content-Type": `${type}; charset=utf-8`,
                "Cache-Control": "no-store",
                "Content-Length": content.length,
                "X-Content-Type-Options": "nosniff"
            });
            response.end(request.method === "HEAD" ? undefined : content);
        };
        if (["/", "/sonata.html"].includes(pathname)) {
            send(html, "text/html");
            return;
        }
        const sample = samples.get(pathname);
        if (!sample) {
            fail(404, "Not found");
            return;
        }
        // カタログで確定した生成物だけを配信する。URL から任意の fs パスを組み立てない。
        fs.readFile(sample, (error, content) => {
            if (error) fail(error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Read failed");
            else send(content, "application/json");
        });
    });
}

if (require.main === module) {
    const listenHost = process.env.SONATA_HOST ?? "127.0.0.1";
    const listenPort = Number(process.env.SONATA_PORT ?? 4173);
    const server = createServer();
    server.on("error", (error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
    server.listen(listenPort, listenHost, () =>
        console.log(`Sonata: http://${listenHost}:${server.address().port} · Ctrl+C to stop`)
    );
}
module.exports = { createServer };

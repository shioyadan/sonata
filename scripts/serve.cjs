"use strict";
const http = require("node:http");
const fs = require("node:fs");
const { build } = require("./build.cjs");
const html = fs.readFileSync(build());
const listenHost = process.env.SONATA_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.SONATA_PORT ?? 4173);
const server = http.createServer((request, response) => {
    let pathname;
    try {
        pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Bad request");
        return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
    }
    if (!["/", "/sonata.html"].includes(pathname)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
    }
    response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": html.length
    });
    response.end(request.method === "HEAD" ? undefined : html);
});
server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
});
server.listen(listenPort, listenHost, () =>
    console.log(`Sonata: http://${listenHost}:${server.address().port} · Ctrl+C to stop`)
);

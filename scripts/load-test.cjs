"use strict";
// Electron の既存 CLI から検査用 .cts を読む。製品のモジュール解決には介入しない。
const fs = require("node:fs");
const path = require("node:path");
const { Module, stripTypeScriptTypes } = require("node:module");
const cache = new Map();
module.exports = function loadTest(name) {
    const file = path.resolve(__dirname, name);
    if (path.dirname(file) !== __dirname || !file.endsWith(".cts")) throw new Error("Expected a local .cts test");
    if (cache.has(file)) return cache.get(file);
    const test = new Module(file, module);
    test.filename = file;
    test.paths = module.paths;
    test._compile(stripTypeScriptTypes(fs.readFileSync(file, "utf8"), { mode: "transform" }), file);
    cache.set(file, test.exports);
    return test.exports;
};

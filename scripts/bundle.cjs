"use strict";
// src 内の CommonJS を単一のスクリプトへ結合する。実行時の外部読み込みは行わない。
const fs = require("node:fs"),
    path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");
function bundle(directory, entry) {
    const files = [];
    function collect(folder) {
        for (const item of fs
            .readdirSync(folder, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
            const file = path.join(folder, item.name);
            if (item.isDirectory()) collect(file);
            else if (item.isFile() && /\.(js|cts)$/.test(item.name) && !item.name.endsWith(".d.cts")) files.push(file);
        }
    }
    collect(directory);
    const modules = files.map((file) => {
        const name = path.relative(directory, file).split(path.sep).join("/");
        const source = fs.readFileSync(file, "utf8");
        // 型と CommonJS の import/export 構文を Node 標準機能で変換する。型検査は別途行う。
        const code = file.endsWith(".cts") ? stripTypeScriptTypes(source, { mode: "transform" }) : source;
        return `${JSON.stringify(name)}:function(require,module,exports){\n${code}\n}`;
    });
    // この関数は生成 HTML 内でもそのまま実行する。Node の API には依存しない。
    function run(modules, entry) {
        const cache = Object.create(null);
        function load(file) {
            if (cache[file]) return cache[file].exports;
            if (!Object.hasOwn(modules, file)) throw new Error(`Unknown bundled module: ${file}`);
            const module = { exports: {} };
            cache[file] = module;
            const require = (specifier) => {
                if (!specifier.startsWith("./") && !specifier.startsWith("../"))
                    throw new Error(`Expected a relative module: ${specifier}`);
                const parts = file.split("/");
                parts.pop();
                for (const part of specifier.split("/")) {
                    if (part === "..") {
                        if (!parts.length) throw new Error("Module is outside the source directory");
                        parts.pop();
                    } else if (part !== "." && part !== "") parts.push(part);
                }
                return load(parts.join("/"));
            };
            modules[file](require, module, module.exports);
            return module.exports;
        }
        return load(entry);
    }
    return `(${run.toString()})({\n${modules.join(",\n")}\n},${JSON.stringify(entry)});\n`;
}
module.exports = { bundle };

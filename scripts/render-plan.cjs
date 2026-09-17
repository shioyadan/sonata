"use strict";
const path = require("node:path");
// 検査範囲の選択はElectron起動前に検証する。単独実行に無関係なsuiteを足さない。
const full = [
    "demos",
    "desktop",
    "evidence",
    "mobile",
    "motion",
    "browser",
    "styles",
    "transfers",
    "memory",
    "import",
    "launcher"
];
const sections = [
    ...full,
    "smoke",
    "import-basic",
    "import-navigation",
    "import-streaming",
    "import-playback",
    "import-layout"
];
const aliases = {
    smoke: ["demos", "smoke", "import-basic", "launcher"],
    mobile: ["mobile"],
    styles: ["styles"],
    browser: ["browser"],
    import: ["import"],
    desktop: ["desktop"],
    evidence: ["evidence"],
    motion: ["motion"],
    memory: ["memory"],
    transfers: ["transfers"],
    demos: ["demos"],
    launcher: ["launcher"]
};
// Electronは自身のスイッチをスクリプトの前にも残すため、実行ファイルの位置から引数を取る。
function scriptArguments(argv, filename) {
    const entry = argv.findIndex((arg, index) => index > 0 && path.resolve(arg) === filename);
    if (entry < 0) throw new Error("The render script was not found in argv");
    return argv.slice(entry + 1);
}
function selectSections(args, mobileOnly = false) {
    // Electron自身に渡すスイッチがargvに残る環境も扱う。
    args = args.filter((arg) => arg !== "--no-sandbox");
    if (!args.length) return mobileOnly ? [...aliases.mobile] : [...full];
    if (args.length !== 1) throw new Error("Choose one render option, or combine suites with --sections=name,name");
    const option = args[0];
    if (Object.hasOwn(aliases, option.slice(2)) && option.startsWith("--")) return [...aliases[option.slice(2)]];
    if (!option.startsWith("--sections=")) throw new Error(`Unknown render option: ${option}`);
    const selected = option.slice("--sections=".length).split(",");
    for (const name of selected) {
        if (!sections.includes(name)) throw new Error(`Unknown render section: ${name || "(empty)"}`);
    }
    if (new Set(selected).size !== selected.length) throw new Error("Duplicate render sections are not allowed");
    if (selected.includes("import") && selected.some((name) => name.startsWith("import-")))
        throw new Error("The import suite already includes every import-* section");
    return selected;
}
module.exports = { full, sections, scriptArguments, selectSections };

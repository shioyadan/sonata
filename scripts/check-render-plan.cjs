"use strict";
const assert = require("node:assert/strict");
const { full, sections, selectSections, scriptArguments } = require("./render-plan.cjs");
assert.deepEqual(selectSections([]), [
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
    "launcher",
    "exhibition"
]);
assert.deepEqual(selectSections(["--smoke"]), ["demos", "smoke", "import-basic", "launcher", "exhibition-basic"]);
for (const name of [
    "mobile",
    "styles",
    "browser",
    "import",
    "desktop",
    "evidence",
    "motion",
    "memory",
    "transfers",
    "demos",
    "launcher",
    "exhibition"
])
    assert.deepEqual(selectSections([`--${name}`]), [name], `${name}: unrelated tests ran in a focused review`);
assert.deepEqual(selectSections(["--sections=memory,import-streaming"]), ["memory", "import-streaming"]);
assert.deepEqual(selectSections([], true), ["mobile"]);
assert.deepEqual(selectSections(["--styles"], true), ["styles"]);
assert.deepEqual(selectSections(["--no-sandbox", "--browser"]), ["browser"]);
for (const args of [
    ["--unknown"],
    ["--sections="],
    ["--sections=styles,typo"],
    ["--sections=styles,"],
    ["--sections=styles,styles"],
    ["--sections=import,import-basic"],
    ["--styles", "--mobile"]
])
    assert.throws(() => selectSections(args));
const selected = selectSections([]);
selected.pop();
assert.deepEqual(selectSections([]), full, "Selection mutated the next run's coverage");
assert.equal(new Set(sections).size, sections.length);

const entry = require("node:path").resolve("scripts/render.cjs");
for (const argv of [
    ["node", "scripts/render.cjs", "--smoke"],
    ["electron", "--no-sandbox", "scripts/render.cjs", "--smoke"],
    ["electron", entry, "--smoke"],
    ["electron", "--no-sandbox", entry, "--smoke"]
])
    assert.deepEqual(selectSections(scriptArguments(argv, entry)), [
        "demos",
        "smoke",
        "import-basic",
        "launcher",
        "exhibition-basic"
    ]);
assert.throws(() => scriptArguments(["electron", "--smoke"], entry), /not found/);

console.log("Render scope selection and invalid-option rejection passed");

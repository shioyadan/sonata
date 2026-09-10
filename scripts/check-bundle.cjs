"use strict";
// 配布用ローダーをブラウザ相当の独立した環境で動かす。
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const {bundle}=require("./bundle.cjs");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"sonata-bundle-"));
try{
    fs.mkdirSync(path.join(root,"nested"));
    const files={
        "main.js":`const local="entry",a=require("./shared.js"),b=require("./nested/consumer.js");
            module.exports={local,same:a===b,loads:globalThis.loads,cycle:require("./cycle-a.js")};`,
        "shared.js":`const local="shared";globalThis.loads=(globalThis.loads??0)+1;module.exports={local};`,
        "nested/consumer.js":`const local="consumer";module.exports=require("../typed.cts");`,
        "typed.cts":`import shared = require("./shared.js");
            namespace typed { export type Label = string; }
            const typed: {local: typed.Label}=shared; export = typed;`,
        "typed-main.cts":`import main = require("./main.js"); export = main;`,
        "unused.d.cts":`declare const absent: unknown; export = absent;`,
        "cycle-a.js":`exports.name="a";exports.b=require("./cycle-b.js").name;`,
        "cycle-b.js":`exports.name="b";exports.a=require("./cycle-a.js").name;`,
        "unused.js":`throw new Error("Unreferenced modules must not execute");`
    };
    for(const [name,source] of Object.entries(files))fs.writeFileSync(path.join(root,name),source);
    const source=bundle(root,"main.js"),result=vm.runInNewContext(source);
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{local:"entry",same:true,loads:1,cycle:{name:"a",b:"b"}});
    assert.equal(bundle(root,"main.js"),source,"Bundling must be deterministic");
    assert.equal(vm.runInNewContext(source).loads,1,"Separate runtimes must not share their module cache");
    const typedResult=vm.runInNewContext(bundle(root,"typed-main.cts"));
    assert.deepEqual(JSON.parse(JSON.stringify(typedResult)),JSON.parse(JSON.stringify(result)),"TypeScript entry must execute the same module graph");
    assert.ok(!source.includes('"unused.d.cts":'),"Type declarations must not become runtime modules");
    for(const [specifier,error] of [["./missing.js",/Unknown bundled module/],["node:fs",/Expected a relative module/],["../outside.js",/outside the source directory/]]){
        fs.writeFileSync(path.join(root,"main.js"),`require(${JSON.stringify(specifier)})`);
        assert.throws(()=>vm.runInNewContext(bundle(root,"main.js")),error);
    }
    fs.writeFileSync(path.join(root,"typed.cts"),"const broken: = 1;");
    assert.throws(()=>bundle(root,"main.js"),/Expected|Unexpected/,"Invalid TypeScript must fail the build");
    console.log("Bundled modules: mixed JS/TypeScript, relative paths, scope, cache, cycles, isolation and invalid imports passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}

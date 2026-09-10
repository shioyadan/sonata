"use strict";
// 別の場所へ移したソースだけで、Konata・node_modules・元ログなしにビルドできることを確認する。
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const vm=require("node:vm");
const {spawnSync}=require("node:child_process");
const {createHash}=require("node:crypto");
const {build,formatTraceScript}=require("./build.cjs");
const root=path.resolve(__dirname,"..");
const read=file=>fs.readFileSync(path.join(root,file),"utf8");
const readTrace=source=>{
    const context={};vm.runInNewContext(source,context,{timeout:10000});
    return JSON.parse(JSON.stringify(context.embeddedFlowTraces));
};
const original=read("data/traces.js");
const expected=readTrace(original);
assert.deepEqual(readTrace(formatTraceScript(original)),expected);
assert.equal(formatTraceScript(formatTraceScript(original)),formatTraceScript(original),"Trace formatting is not idempotent");
const strings='globalThis.embeddedFlowTraces='+JSON.stringify([{text:'quotes " , backslash \\ and </script>',items:Array(300).fill('a,b\n"\\')},[0,-1,.25,null,true,false]])+';';
assert.deepEqual(readTrace(formatTraceScript(strings)),readTrace(strings));
const output=build(),bytes=fs.readFileSync(output);
const html=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
assert.ok(!bytes.some(c=>c<32&&![9,10,13].includes(c)),"Binary control character in HTML");
assert.ok(!/<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel="stylesheet"/i.test(html));
assert.ok(html.includes(read("LICENSE.md").trim()),"Standalone HTML lost its license notice");
const noticeBlock=/<pre id="license-text">([\s\S]*?)<\/pre>/.exec(html);
assert.ok(noticeBlock,"Standalone HTML lost its readable license panel");
const notices=noticeBlock[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
for(const file of ["LICENSE.md","THIRD_PARTY_NOTICES.md","licenses/COREMARK-LICENSE.md","licenses/RSD-LICENSE.txt","licenses/RSD-CREDITS.md"]){
    assert.ok(notices.includes(read(file).trim()),`Standalone HTML lost third-party notice: ${file}`);
}
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
assert.equal(scripts.length,6);
assert.deepEqual(readTrace(scripts[0]),expected,"HTML changed the recorded demo data");
assert.equal(new Set(expected.map(t=>t.key)).size,5);
for(const script of scripts)new vm.Script(script);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"sonata-build-"));
try{
    for(const entry of ["src","data","LICENSE.md","THIRD_PARTY_NOTICES.md","licenses"]){
        fs.cpSync(path.join(root,entry),path.join(temp,entry),{recursive:true});
    }
    fs.mkdirSync(path.join(temp,"scripts"));
    fs.copyFileSync(path.join(root,"scripts/build.cjs"),path.join(temp,"scripts/build.cjs"));
    const result=spawnSync(process.execPath,[path.join(temp,"scripts/build.cjs")],{cwd:os.tmpdir(),encoding:"utf8"});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(temp,"dist/sonata.html")),bytes,"Build depends on checkout location or installed packages");
}finally{fs.rmSync(temp,{recursive:true,force:true});}
const upstream=JSON.parse(read("vendor/konata-core/UPSTREAM.json"));
for(const [file,hash] of Object.entries(upstream.files)){
    const actual=createHash("sha256").update(fs.readFileSync(path.join(root,"vendor/konata-core",file))).digest("hex");
    assert.equal(actual,hash,`Vendored ${file} changed; document the change in UPSTREAM.json`);
}
console.log(`Build: ${expected.length} demos unchanged; UTF-8; offline; reproducible outside checkout; ${Object.keys(upstream.files).length} upstream files verified`);

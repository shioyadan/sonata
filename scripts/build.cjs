"use strict";
// Node の標準機能だけでオフライン配布用 HTML を生成し、実行時の外部資源を不要にする。
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=file=>fs.readFileSync(path.join(root,file),"utf8");

function formatTraceScript(source) {
    const marker="globalThis.embeddedFlowTraces=",start=source.indexOf(marker);
    if(start<0)throw new Error("Missing embedded trace assignment");
    const json=source.slice(start+marker.length).trim().replace(/;$/,"");
    JSON.parse(json); // 整形対象を JSON に限定し、任意の JavaScript は整形しない。
    let quoted=false,escaped=false,column=0,formatted="";
    for(let index=0;index<json.length;index++){
        const char=json[index];
        formatted+=char;column++;
        if(quoted){
            if(escaped)escaped=false;
            else if(char==='\\')escaped=true;
            else if(char==='"')quoted=false;
        }else if(char==='"')quoted=true;
        else if(char===","&&column>=120&&json[index+1]!=="\n"&&json[index+1]!=="\r"){formatted+="\n";column=0;}
        if(char==="\n")column=0;
    }
    return source.slice(0,start)+marker+formatted+";\n";
}

function build() {
    let html=read("src/index.html");
    const license=read("LICENSE.md").replace(/--/g,"—");
    html=html.replace("<!doctype html>",()=>`<!doctype html>\n<!-- Sonata · BSD-3-Clause\n${license}\n-->`);
    // 単一 HTML をコピーして配布する場合も、第三者の権利表示と全文を持ち運ぶ。
    const noticeFiles=["LICENSE.md","THIRD_PARTY_NOTICES.md","licenses/COREMARK-LICENSE.md","licenses/RSD-LICENSE.txt","licenses/RSD-CREDITS.md"];
    const notices=noticeFiles.map(file=>`${file}\n${"=".repeat(file.length)}\n${read(file).trim()}`).join("\n\n");
    const noticeMarker="<!-- SONATA_LICENSE_NOTICES -->";
    if(!html.includes(noticeMarker))throw new Error("Missing license notice placeholder");
    html=html.replace(noticeMarker,()=>notices.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"));
    const css=read("src/sonata.css").replace(/<\/style/gi,"<\\/style");
    html=html.replace('<link rel="stylesheet" href="sonata.css">',()=>`<style>\n${css}\n</style>`);
    for(const [url,file] of [["../data/traces.js","data/traces.js"],["replay-model.js","src/replay-model.js"],["visual-styles.js","src/visual-styles.js"],["piece-motion.js","src/piece-motion.js"],["piece-grounding.js","src/piece-grounding.js"],["sonata.js","src/sonata.js"]]){
        const source=read(file);
        const code=(file==="data/traces.js"?formatTraceScript(source):source).replace(/<\/script/gi,"<\\/script");
        const tag=`<script src="${url}"></script>`;
        if(!html.includes(tag))throw new Error(`Missing source script: ${url}`);
        html=html.replace(tag,()=>`<script>\n${code}\n</script>`);
    }
    if(/<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel="stylesheet"|(?:src|href)="(?:\.\.\/|sonata-)/i.test(html))throw new Error("The deliverable still depends on another file.");
    const output=path.join(root,"dist/sonata.html");
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,html);
    console.log(`${path.relative(process.cwd(),output)} · ${Math.round(Buffer.byteLength(html)/1024)} KiB · self-contained`);
    return output;
}
if(require.main===module)build();
module.exports={build,formatTraceScript};

/** Build the hand-picked GL demo reels from genuine trace excerpts.
 * node --import tsx scripts/generate-demos.ts
 * Set SONATA_TRACE_ROOT to relocate the source log directory.
 */
import fs from "node:fs";
import path from "node:path";
import { buildSample } from "./import-trace";
import { candidates } from "./select-traces";
import { runProvenance } from "./provenance";
import { readRsdEvents } from "./read-rsd-events";
import { formatTraceScript } from "./build.cjs";

const scenes = [
    { source: "gem5-arm-coremark", key: "branch-storm", title: "01 · Branch storm", window: [73208,73335] as const,
        description: "Wide bursts of work, then successive waves of wrong-path instructions scatter.", theme: "BRANCH RECOVERY" },
    { source: "gem5-arm-coremark", key: "wide-open", title: "02 · Wide open", window: [73388,73515] as const,
        description: "A dense stream of instructions fills the machine and pours into commit.", theme: "HIGH THROUGHPUT" },
    { source: "rsd-mshr", key: "memory-tide", title: "03 · Miss & recover", window: [3964,4091] as const,
        description: "D-cache misses hold up loads, then a branch misprediction clears the wrong path.", theme: "BRANCH + CACHE MISSES" },
    { source: "gem5-arm-detailed", key: "rename-rush", title: "04 · Rename rush", window: [404,531] as const,
        description: "ARM64 fills the register bank with new versions, then unwinds mappings on recovery.", theme: "RECORDED REGISTER ACTIVITY" },
    { source: "gem5-x86-detailed", key: "x86-recovery", title: "05 · x86 recovery", window: [1596,1723] as const,
        description: "x86 micro-ops fan out across the machine, with real register reads and waves of recovery.", theme: "MICRO-OPS + REGISTER VALUES" },
];

async function main() {
    const samples = [], report = [];
    const log = console.log, warn = console.warn;
    for (const scene of scenes) {
        const source = candidates.find(s => s.key === scene.source)!;
        console.log = () => undefined; console.warn = () => undefined;
        let sample;
        try { sample = await buildSample({...source, key:scene.key, label:scene.title, window:scene.window, initialCycle:scene.window[0],includeTopDown:true,includeEvidence:true}); }
        finally {console.log=log;console.warn=warn;}
        const provenance = runProvenance[scene.source];
        if (provenance.robEntries !== undefined) sample.structure.robCapacity = provenance.robEntries;
        const end = op => op[4] ? op[11] ?? op[3] : op[3];
        const flushes = new Map<number,number>();
        for (const op of sample.ops) if(op[4] && end(op)>=sample.firstCycle && end(op)<=sample.lastCycle) flushes.set(end(op),(flushes.get(end(op))??0)+1);
        const retired = sample.ops.filter(op=>!op[4] && op[3]>=sample.firstCycle && op[3]<=sample.lastCycle).length;
        const active = [], memoryWait = [], queued = [], commits = [];
        for(let t=sample.firstCycle;t<=sample.lastCycle;t++) {
            active.push(sample.ops.filter(op=>op[2]<=t && end(op)>t).length);
            queued.push(sample.ops.filter(op=>op[7]!=null && op[7]<=t && t<(op[8]??end(op))).length);
            memoryWait.push(sample.ops.filter(op=>op[6].some(s=>s[1]==="memory-wait" && s[2]<=t && t<s[3])).length);
            commits.push(sample.ops.filter(op=>!op[4] && op[3]===t).length);
        }
        const peakCycle = values => sample.firstCycle+values.indexOf(Math.max(...values));
        let bookmarks = scene.key==="branch-storm" ? [...flushes].sort((a,b)=>a[0]-b[0]).map(([cycle,count])=>({cycle,label:`${count} squashed`,type:"flush"})) :
            [{cycle:peakCycle(scene.key==="wide-open"?commits:scene.key==="memory-tide"?memoryWait:queued),label:scene.key==="wide-open"?"Commit burst":scene.key==="memory-tide"?"Memory wait":"Queue pressure",type:"highlight"}];
        const events=scene.source==="rsd-mshr"?readRsdEvents(source.fileName,sample.firstCycle,sample.lastCycle).map(event=>{
            const op=sample.ops.find(op=>op[0]===event.id);
            return {...event,endCycle:event.kind==="dcache-miss"&&op&&!op[4]?Math.max(event.cycle+1,op[9]??event.cycle+3):event.cycle+3,instruction:op?.[5]??"Undecoded instruction"};
        }):[];
        if (scene.key === "memory-tide") {
            if(!events.some(e=>e.kind==="dcache-miss")||!events.some(e=>e.kind==="branch-mispredict")||flushes.size===0)throw new Error("The RSD reel must contain explicit cache misses and branch mispredictions with squash.");
            const cacheMiss=events.find(e=>e.kind==="dcache-miss")!;
            const branchMiss=events.find(e=>e.kind==="branch-mispredict")!;
            bookmarks=[{cycle:cacheMiss.cycle,label:"D-cache miss",type:"highlight"},
                {cycle:branchMiss.cycle,label:"Branch misprediction",type:"highlight"},
                ...[...flushes].map(([cycle,count])=>({cycle,label:`${count} squashed`,type:"flush"}))];
            const firstReady = sample.ops.find(op => op[0]===cacheMiss.id && !op[4] && op[9]<sample.lastCycle);
            if (firstReady) bookmarks.push({cycle:firstReady[9],label:"Memory ready → scheduler",type:"highlight"});
            bookmarks.sort((a,b)=>a.cycle-b.cycle);
        }
        if(scene.source.endsWith("-detailed")){
            const writes=Array.from({length:sample.lastCycle-sample.firstCycle+1},(_,i)=>sample.evidence.registers.events.filter(e=>e.type==="write"&&Math.floor(e.cycle)===sample.firstCycle+i).length);
            bookmarks=[{cycle:peakCycle(writes),label:"Register write burst",type:"highlight"},
                ...[...flushes].map(([cycle,count])=>({cycle,label:`${count} squashed · mapping recovery`,type:"flush"}))].sort((a,b)=>a.cycle-b.cycle);
        }
        const demo = {source:source.label, provenance, description:scene.description, theme:scene.theme, bookmarks,events,
            retired, squashed:[...flushes.values()].reduce((sum,n)=>sum+n,0), peakActive:Math.max(...active),
            screenshotCycle:scene.key==="branch-storm"?sample.firstCycle+3.4:peakCycle(scene.key==="memory-tide"?memoryWait:active)+.4,
            squashTiming:source.parser==="gem5"?"inferred from the last observed stage of each contiguous squashed instruction group":"recorded in the Kanata trace"};
        samples.push({...sample,demo});
        const metrics={key:sample.key,provenance,window:scene.window,ops:sample.ops.length,retired,flushes:[...flushes],peakActive:demo.peakActive,
            activeRange:[Math.min(...active),Math.max(...active)],queueRange:[Math.min(...queued),Math.max(...queued)],peakMemoryWait:Math.max(...memoryWait),
            frontNodes:sample.structure.frontNodes,executionNodes:sample.structure.executionNodes,queueCapacity:sample.structure.queueCapacity,robCapacity:sample.structure.robCapacity,bookmarks,events,
            topDown:sample.topDown?{method:sample.topDown.method,allocationWidth:sample.topDown.allocationWidth,firstCycle:sample.topDown.firstCycle,cycles:sample.topDown.slots.length}:null};
        report.push(metrics);log(JSON.stringify(metrics));
    }
    const data=path.resolve(__dirname,"../data");
    fs.mkdirSync(data,{recursive:true});
    fs.writeFileSync(path.join(data,"traces.js"), formatTraceScript(`// Curated real trace excerpts. Generated by generate-demos.ts.\nglobalThis.embeddedFlowTraces=${JSON.stringify(samples)};\n`));
    fs.writeFileSync(path.join(data,"demo-manifest.json"),JSON.stringify(report,null,2)+"\n");
}
void main();

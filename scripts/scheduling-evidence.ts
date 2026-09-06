import fs from "node:fs";
import {allocationEvidence,type AllocationEvent} from "./register-allocation";
import type { Op } from "../vendor/konata-core/model";

type Timing = { allocation:(op:Readonly<Op>)=>number|null; ready:(op:Readonly<Op>)=>number|null; end:(op:Readonly<Op>)=>number };
type Dependency = { id:number; ready:number|null; register?:string };
type EvidenceOp = { id:number; dependencies:Dependency[]; slot?:number };

// This intentionally covers the scalar ARM64 instructions in the embedded reels.
// It estimates register RAW edges only, never memory aliasing or physical names.
function armOperands(label:string) {
    const text=label.replace(/^(?:0x)?[0-9a-f]+:\s*/i,"").trim().toLowerCase();
    const mnemonic=text.split(/\s+/)[0],args=text.slice(mnemonic.length);
    const registers=(s:string)=>[...s.matchAll(/\b(?:[wx](?:[12]?\d|30)|sp|[wx]zr)\b/g)]
        .map(m=>m[0].replace(/^w/,"x")).filter(r=>r!=="xzr");
    const regs=registers(args),dest:string[]=[],source:string[]=[];
    if(/^b\./.test(mnemonic))source.push("nzcv");
    else if(mnemonic==="b"||mnemonic==="nop"){}
    else if(mnemonic==="bl"){dest.push("x30");}
    else if(mnemonic==="ret"){source.push(...(regs.length?regs:["x30"]));}
    else if(/^(?:str|stp|cmp|cmn|tst|cbz|cbnz|tbz|tbnz|br|blr)$/.test(mnemonic)){
        source.push(...regs);if(/^(?:cmp|cmn|tst)$/.test(mnemonic))dest.push("nzcv");
        if(mnemonic==="blr")dest.push("x30");
    }else if(/^(?:add|addxi_uop|adds|sub|subs|madd|and|ands|orr|movz|movk|sbfm|csinc|ldr|ldrsh|ldrb|ldrh)$/.test(mnemonic)){
        const first=registers(args.split(",")[0])[0];if(first)dest.push(first);
        source.push(...registers(args.slice(args.indexOf(",")+1)));
        if(mnemonic==="movk"&&first)source.push(first);
        if(mnemonic==="csinc")source.push("nzcv");
        if(/^(?:adds|subs|ands)$/.test(mnemonic))dest.push("nzcv");
    }else return null;
    return {source:[...new Set(source)],dest:[...new Set(dest)]};
}

export function buildSchedulingEvidence(allOps:Readonly<Op>[],sampleOps:Readonly<Op>[],timing:Timing) {
    const byID=new Map(allOps.map(o=>[o.id,o])),wanted=new Set(sampleOps.map(o=>o.id));
    const native=sampleOps.some(op=>op.prods.length>0);
    if(native)return {kind:"recorded",label:"Recorded dependency edges",ops:sampleOps.map(op=>({id:op.id,
        dependencies:op.prods.map(d=>({id:d.opID,ready:byID.has(d.opID)?timing.ready(byID.get(d.opID)!):null}))}))};
    const writers=new Map<string,number>(),previous=new Map<number,Array<[string,number|undefined]>>(),result:EvidenceOp[]=[];
    const events=allOps.flatMap(op=>{
        const at=timing.allocation(op);
        return at===null?[]:[{time:at,op,flush:false},...(op.flush?[{time:timing.end(op),op,flush:true}]:[])];
    }).sort((a,b)=>a.time-b.time||Number(b.flush)-Number(a.flush)||(a.flush?b.op.id-a.op.id:a.op.id-b.op.id));
    for(const event of events){
        const {op}=event;
        if(event.flush){
            for(const [reg,id] of previous.get(op.id)??[])if(writers.get(reg)===op.id){if(id===undefined)writers.delete(reg);else writers.set(reg,id);}
            continue;
        }
        const operands=armOperands(op.labelName);if(!operands)continue;
        const dependencies=operands.source.flatMap(register=>{
            const id=writers.get(register);return id===undefined?[]:[{id,register,ready:timing.ready(byID.get(id)!)}];
        });
        if(wanted.has(op.id))result.push({id:op.id,dependencies});
        previous.set(op.id,operands.dest.map(reg=>[reg,writers.get(reg)]));
        operands.dest.forEach(reg=>writers.set(reg,op.id));
    }
    return {kind:"inferred",label:"Register RAW · disassembly estimate",ops:result};
}

export function readRsdRegisterEvidence(fileName:string,firstCycle:number,lastCycle:number,wanted:Set<number>) {
    type Reg={logical:number;physical:number;previous?:number};
    type Record={id:number;label:string;map?:{cycle:number;line:number;dest:Reg[];source:Reg[]};slot?:number;
        dependencies:Dependency[];ready:number|null;end:number;flush:boolean;results:Array<{cycle:number;hex:string;load:boolean;line:number}>};
    const records=new Map<number,Record>(),physicalWriter=new Map<number,number>();let cycle=0;
    const get=(id:number)=>{if(!records.has(id))records.set(id,{id,label:"",dependencies:[],ready:null,end:Infinity,flush:false,results:[]});return records.get(id)!;};
    const regs=(s:string):Reg[]=>[...s.matchAll(/r(\d+)\(p(\d+)\)/g)].map(m=>({logical:Number(m[1]),physical:Number(m[2])}));
    for(const [index,line] of fs.readFileSync(fileName,"utf8").split("\n").entries()){
        const f=line.split("\t");
        if(f[0]==="C"){cycle+=Number(f[1]);continue;}
        if(!["L","S","R"].includes(f[0]))continue;
        const r=get(Number(f[1]));
        if(f[0]==="R"){r.end=cycle;r.flush=f[3]!=="0";continue;}
        if(f[0]==="S"){if(f[2]==="0"&&f[3]==="Rw")r.ready=cycle;continue;}
        if(f[2]==="0"){r.label=f[3]??"";continue;}
        if(f[2]!=="1")continue;const message=(f[3]??"").replace(/\\n/g," ");
        const mapping=message.match(/map:\s*(.*?)\s*=\s*(.*?)\s*prev:\s*(.*?)(?:IQ alloc:|$)/);
        if(mapping){
            const dest=regs(mapping[1]),source=regs(mapping[2]),previous=regs(mapping[3]);
            dest.forEach(d=>{d.previous=previous.find(p=>p.logical===d.logical)?.physical;});
            r.map={cycle,line:index+1,dest,source};r.slot=Number(message.match(/IQ alloc:\s*(\d+)/)?.[1]);
            r.dependencies=source.filter(s=>s.logical!==0).flatMap(s=>{
                const id=physicalWriter.get(s.physical);return id===undefined?[]:[{id,ready:null,register:`r${s.logical} / p${s.physical}`}];
            });
            dest.filter(d=>d.logical!==0).forEach(d=>physicalWriter.set(d.physical,r.id));
        }
        const load=message.match(/#(0x[\da-f]+)\s*=\s*load\(\)/i),alu=message.match(/\bd:(0x[\da-f]+)\s*=\s*fu\(/i);
        if(load||alu)r.results.push({cycle,hex:(load??alu)![1],load:!!load,line:index+1});
    }
    const registerEvents:any[]=[],allocations:AllocationEvent[]=[];
    for(const r of records.values()){
        r.dependencies.forEach(d=>{d.ready=records.get(d.id)?.ready??null;});
        if(!r.map)continue;
        const load=/\b(?:lb|lbu|lh|lhu|lw)\s/.test(r.label);
        const result=r.results.filter(v=>v.load===load&&v.cycle<=(r.ready??-Infinity)).at(-1);
        for(const d of r.map.dest.filter(d=>d.logical!==0)){
            registerEvents.push({type:"rename",cycle:r.map.cycle,id:r.id,...d,line:r.map.line});
            if(d.previous!==undefined)allocations.push({cycle:r.map.cycle,physical:d.previous,state:"allocated",reason:"previous mapping",line:r.map.line});
            allocations.push({cycle:r.map.cycle,physical:d.physical,state:"allocated",reason:"rename",line:r.map.line});
            const freed=r.flush?d.physical:d.previous;
            if(Number.isFinite(r.end)&&freed!==undefined&&d.previous!==d.physical)allocations.push({cycle:r.end,physical:freed,state:"free",reason:r.flush?"squash (inferred)":"commit (inferred)",id:r.id});
            if(result&&r.ready!==null&&r.ready<r.end)registerEvents.push({type:"write",cycle:r.ready,id:r.id,
                logical:d.logical,physical:d.physical,hex:result.hex,line:result.line,observedCycle:result.cycle});
            if(r.flush&&d.previous!==undefined)registerEvents.push({type:"restore",cycle:r.end,id:r.id,...d});
        }
    }
    const priority={restore:0,rename:1,write:2};
    registerEvents.sort((a,b)=>a.cycle-b.cycle||priority[a.type]-priority[b.type]||(a.type==="restore"?b.id-a.id:a.id-b.id));
    const mapping=new Map<number,number>(),values=new Map<number,string>(),owners=new Map<number,number>();
    for(const e of registerEvents){
        if(e.cycle>=firstCycle)break;
        if(e.type==="rename"){mapping.set(e.logical,e.physical);owners.set(e.physical,e.id);values.delete(e.physical);}
        else if(e.type==="restore"&&mapping.get(e.logical)===e.physical)mapping.set(e.logical,e.previous);
        else if(e.type==="write"&&owners.get(e.physical)===e.id)values.set(e.physical,e.hex);
    }
    const events=registerEvents.filter(e=>e.cycle>=firstCycle&&e.cycle<=lastCycle);
    allocations.sort((a,b)=>a.cycle-b.cycle||(a.state==="free"?0:1)-(b.state==="free"?0:1));
    const rows=Array.from({length:32},(_,logical)=>logical);
    return {
        scheduling:{kind:"recorded",label:"Physical register dependencies · RSD map annotations",ops:[...records.values()].filter(r=>wanted.has(r.id)).map(r=>({id:r.id,dependencies:r.dependencies,sources:r.map?.source.filter(s=>s.logical!==0)??[],slot:r.slot}))},
        registers:{kind:"recorded",label:"RSD rename / writeback annotations",rows,constantRows:[0],initial:{mapping:[...mapping],values:[...values],owners:[...owners]},events,
            allocation:allocationEvidence(allocations,firstCycle,lastCycle,"inferred","Allocation from RSD rename; release inferred at commit / squash. Observed cells only.")}
    };
}

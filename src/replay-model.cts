"use strict";
// 記録時刻から再生状態を復元し、同梱デモを配置で使う構造へ準備する。
import geometry = require("./geometry.cts");
const {stageTransition}=geometry;
const feedRows=24,feedLead=.7;

// 入力記録と表示準備後の命令を区別し、未観測の時刻・値は null のまま扱う。
interface StageRange { node:string; start:number; end:number; names:string[]; displaySlot?:number }
interface Instruction {
    id:number; rid:number; index:number; fetch:number; end:number; flush:boolean; label:string;
    stages:StageRange[]; allocation:number|null; issue:number|null; completion:number|null;
    execution:string; kind:"integer"|"memory"|"branch"; reads:ReadInterval[]; sourceRegisters:RegisterSource[];
    issueSlot?:number; robSlot?:number; memorySlot?:number; commitSlot?:number; feedText?:string;
}
type ReadInterval={start:number;end:number;sources?:{physical:number;hex:string}[]};
type RegisterSource={logical:number;physical:number;previous?:number};
type CompactStage=[name:string,node:string,start:number,end:number];
type CompactOperation=[id:number,rid:number,fetch:number,retired:number,flush:number,label:string,
    stages:CompactStage[],allocation:number|null,issue:number|null,completion:number|null,execution:string,flushCycle?:number|null];
type Dependency={id:number;ready:number|null;register?:string};
interface SchedulingEvidence { kind:string; label?:string; ops:{id:number;dependencies:Dependency[];sources?:RegisterSource[]}[] }
type RegisterEventBase={cycle:number;physical:number;previous?:number};
type RegisterEvent=RegisterEventBase & (
    {type:"map";logical:number}|{type:"observe";hex:string}|
    {type:"rename";logical:number;id:number}|{type:"restore";logical:number;id:number;previous:number}|
    {type:"write";id:number;hex:string;logical?:number}
);
type AllocationState="allocated"|"free"|"unknown";
type AllocationEvent={cycle:number;physical:number;state:Exclude<AllocationState,"unknown">;reason:string};
interface RegisterEvidence {
    origin?:string; rows:number[]; constantRows?:number[];
    kind?:string;label?:string;capacity?:number;logicalNames?:Record<number,string>;logicalPrefix?:string;wordBits?:number;
    initial:{mapping:[number,number][];values:[number,string][];owners:[number,number][]};
    allocation?:{initial:[number,Exclude<AllocationState,"unknown">][];events:AllocationEvent[];kind?:string;label?:string};
    events:RegisterEvent[]; reads?:{id:number;cycle:number;physical:number;hex:string}[];
}
interface TopDownData {
    firstCycle:number;windowCycles:number;slots:number[][];
    method?:string;
    observationTimes?:{outcomes:[allocated:number,observed:number,outcome:0|1][];recoveryNotices:([time:number,category:3|4]|null)[]};
}
type DemoEvent={kind:"branch-mispredict"|"dcache-miss"|"icache-miss";id:number;cycle:number;endCycle?:number};
interface TraceData {
    key:string;firstCycle:number;lastCycle:number;fetchWidth:number;parser:string;ops:CompactOperation[];
    label:string;fileName:string;initialCycle:number;retireWidth:number;machineOrder:string;
    structure:{queueCapacity:number;robCapacity:number;allocationWidth:number;
        frontNodes:{id:string;names:string[]}[];executionNodes:{id:string;kind:Instruction["kind"];names:string[];pipeCount:number}[];
        memoryWait:{id:string;waitStageNames:string[];completionStageNames:string[];observedOps:number;baseLatency:number|null}|null};
    demo:{events?:DemoEvent[];bookmarks:{cycle:number;label:string;type:string}[];screenshotCycle:number;theme:string;
        provenance:{simulator:string;workload:string;processor:string;configuration:string;note:string;workloadKnown:boolean}};
    evidence?:{scheduling:SchedulingEvidence;registers?:RegisterEvidence|null};topDown?:TopDownData|null;
}
type RobOperation=Pick<Instruction,"id"|"end"|"flush"> & {allocation?:number|null};
type QueueEntry<T>={op:T;slot:number};
type RobSnapshot<T>={time:number;head:number;tail:number;entries:QueueEntry<T>[];retired:number[];squashed:number[]};
type FeedGroup={time:number;start:number;count:number};
type FeedState={phase:"flow"|"notice"|"rewind"|"discard"|"refill";time:number|null;count:number;age:number;
    cursor:number;normalCursor:number;cancelAlpha:number;flowAlpha:number;dissolve:number;recovery:number;ids:number[]};
type PlaybackOptions={duration?:number;reducedMotion?:boolean};
type BoundCategory="active"|"badSpeculation"|"frontend"|"backend"|"unresolved";
type DependencyOperation=Pick<Instruction,"id"|"end"|"allocation"|"issue"|"issueSlot">;
type DependencyCell={consumer:number;producer:number;row:number|undefined;column:number|null;waiting:boolean;unknown:boolean;alpha:number;register:string|null};
type Broadcast={producer:number;column:number|null;rows:(number|undefined)[];progress:number};

function createRobReplay<T extends RobOperation>(ops:readonly T[], capacity:number) {
    const events = new Map<number,{allocate:T[]}>(), slots = new Map<number,number>();
    const at = (time:number) => {
        if (!events.has(time)) events.set(time, {allocate: []});
        return events.get(time)!;
    };
    for (const op of ops) {
        if (op.allocation == null || op.allocation >= op.end) continue;
        at(op.allocation).allocate.push(op);
        at(op.end);
    }
    let head = 0, tail = 0;
    const queue:QueueEntry<T>[] = [], snapshots:RobSnapshot<T>[] = [];
    for (const time of [...events.keys()].sort((a,b) => a-b)) {
        const retired:number[] = [], squashed:number[] = [];
        // 誤経路の命令を取り消し、キュー末尾の若い命令から巻き戻す。
        while (queue.length && queue.at(-1)!.op.flush && queue.at(-1)!.op.end <= time) {
            const entry = queue.pop()!; tail = entry.slot; squashed.push(entry.op.id);
        }
        // 完了時は ready を立てるだけとし、先頭はコミット時にだけ進める。
        while (queue.length && queue[0].op.end <= time && !queue[0].op.flush) {
            const entry = queue.shift()!; head = (entry.slot + 1) % capacity; retired.push(entry.op.id);
        }
        if (queue.some(entry => entry.op.end <= time)) throw new Error(`Trace is not FIFO at cycle ${time}.`);
        if (!queue.length) head = tail;
        for (const op of events.get(time)!.allocate.sort((a,b) => a.id-b.id)) {
            if (queue.length >= capacity) throw new Error(`ROB capacity exceeded at cycle ${time}.`);
            if (queue.length && queue.at(-1)!.op.id >= op.id) throw new Error(`ROB allocation order regressed at cycle ${time}.`);
            slots.set(op.id, tail); queue.push({op, slot: tail}); tail = (tail + 1) % capacity;
        }
        snapshots.push({time, head, tail, entries: [...queue], retired, squashed});
    }
    const empty:RobSnapshot<T> = {time: -Infinity, head: 0, tail: 0, entries: [], retired: [], squashed: []};
    function stateAt(time:number) {
        let lo = 0, hi = snapshots.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (snapshots[mid].time <= time) lo = mid + 1; else hi = mid;
        }
        return snapshots[lo-1] ?? empty;
    }
    return {capacity, slots, snapshots, stateAt};
}

function memoryCompletions<T extends Pick<Instruction,"id"|"flush"|"completion"|"end"> & {stages:{node:string;start:number}[]}>(ops:readonly T[]) {
    return ops.flatMap(op => {
        if (op.flush || op.completion == null || op.completion > op.end) return [];
        const wait = op.stages.find(stage => stage.node === "memory-wait" && stage.start < op.completion!) as T["stages"][number] | undefined;
        return wait ? [{id: op.id, time: op.completion, op, wait}] : [];
    }).sort((a,b) => a.time-b.time || a.id-b.id);
}

const codeRewindDuration = 4;
const smooth=(x:number)=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
function flushPlaybackRate(time:number,events:readonly number[],{duration=codeRewindDuration,reducedMotion=false}:PlaybackOptions={}) {
    if(reducedMotion)return 1;
    let rate=1;
    for(const event of events){
        const age=time-event;
        if(age<-.8||age>=duration+1.4)continue;
        const recoveryStart=Math.min(2.8,duration);
        const eventRate=age<0?1-.73*smooth((age+.8)/.8)
            :.27+.73*smooth((age-recoveryStart)/(duration+1.4-recoveryStart));
        rate=Math.min(rate,eventRate);
    }
    return rate;
}
function advancePlayback(time:number,seconds:number,speed:number,events:readonly number[],options?:PlaybackOptions) {
    // 速度の連続的な変化を小刻みに積分し、フレームレートが低い場合も
    // スローモーションの終了時に再生時計が大きく飛ばないようにする。
    const steps=Math.max(1,Math.ceil(seconds*120)),dt=seconds/steps;
    for(let i=0;i<steps;i++){
        const midpoint=time+dt*speed*flushPlaybackRate(time,events,options)/2;
        time+=dt*speed*flushPlaybackRate(midpoint,events,options);
    }
    return time;
}

function measureTransfers(ops:readonly (Pick<Instruction,"id"|"fetch"|"allocation"|"end"|"flush"> & {stages:{node:string;start:number}[]})[],
    {firstCycle=-Infinity,lastCycle=Infinity,frontNodes=[]}:{firstCycle?:number;lastCycle?:number;frontNodes?:{id:string}[]}={}) {
    const edges=new Map<string,{from:string;to:string;cycles:Map<number,Set<number>>}>(),lastFront=frontNodes.at(-1)?.id;
    function record(from:string,to:string,time:number,id:number){
        if(!Number.isFinite(time)||time<firstCycle||time>=lastCycle+1)return;
        const key=`${from}>${to}`,cycle=Math.floor(time);
        if(!edges.has(key))edges.set(key,{from,to,cycles:new Map()});
        const edge=edges.get(key)!;
        if(!edge.cycles.has(cycle))edge.cycles.set(cycle,new Set());
        edge.cycles.get(cycle)!.add(id);
    }
    for(const op of ops){
        if(frontNodes.length)record("input",frontNodes[0].id,op.fetch,op.id);
        // スケジューラ滞在が 0 サイクルだとステージ区間に現れない場合がある。
        // その場合も allocation と実行開始から入口・出口の通過を数える。
        if(lastFront&&op.allocation!=null&&op.allocation<op.end)record(lastFront,"issue",op.allocation,op.id);
        const admission=op.stages.find(stage=>stage.node==="register-read"||stage.node.startsWith("exec"));
        if(admission&&op.allocation!=null&&op.allocation<=admission.start&&admission.start<op.end)
            record("issue",admission.node,admission.start,op.id);
        let previous;
        for(const stage of op.stages){
            if(stage.start<op.end){
                if(previous&&previous.node!==stage.node&&stage.node!=="commit")record(previous.node,stage.node,stage.start,op.id);
            }
            previous=stage;
        }
        if(!op.flush){record("rob","commit",op.end,op.id);record("commit","output",op.end,op.id);}
    }
    return new Map([...edges].map(([key,e])=>{
        const counts=[...e.cycles].sort((a,b)=>a[0]-b[0]).map(([cycle,ids])=>({cycle,count:ids.size}));
        return [key,{from:e.from,to:e.to,peak:Math.max(...counts.map(c=>c.count)),total:counts.reduce((sum,c)=>sum+c.count,0),counts}];
    }));
}
// このカーソルは流入する命令列の表示だけを制御し、プロセッサの時刻は巻き戻さない。
function createFeedReplay(orderedOps:readonly Pick<Instruction,"id"|"fetch"|"flush"|"end">[],
    {firstCycle=-Infinity,lastCycle=Infinity,rows=24,lead=.7}:{firstCycle?:number;lastCycle?:number;rows?:number;lead?:number}={}) {
    const groups:FeedGroup[]=[],squashes=new Map<number,{id:number;index:number}[]>();
    orderedOps.forEach((op,index)=>{
        if(groups.at(-1)?.time===op.fetch)groups.at(-1)!.count++;
        else groups.push({time:op.fetch,start:index,count:1});
        if(op.flush&&op.end>=firstCycle&&op.end<=lastCycle){
            if(!squashes.has(op.end))squashes.set(op.end,[]);
            squashes.get(op.end)!.push({id:op.id,index});
        }
    });
    function cursorAt(time:number) {
        const group=groups.find(g=>g.time>time);
        return group?group.start+group.count*smooth((time-group.time+lead)/lead):orderedOps.length;
    }
    const events=[...squashes].sort((a,b)=>a[0]-b[0]).map(([time,entries])=>{
        const start=cursorAt(time),turn=Math.max(0,entries[0].index,start-rows*1.25);
        return {time,start,turn,ids:entries.map(e=>e.id)};
    });
    function stateAt(time:number,reducedMotion=false):FeedState {
        const normalCursor=cursorAt(time),event=events.findLast(e=>e.time<=time&&time<e.time+codeRewindDuration);
        const flow:FeedState={phase:"flow",time:null,count:0,age:0,cursor:normalCursor,normalCursor,cancelAlpha:0,flowAlpha:1,dissolve:0,recovery:1,ids:[]};
        if(!event)return flow;
        const age=time-event.time,base={...flow,time:event.time,count:event.ids.length,age,ids:[...event.ids]};
        if(reducedMotion)return {...base,phase:"notice"};
        const cursor=event.start+(event.turn-event.start)*smooth(age/.9);
        // 文字は漂いながら薄くなり、命令列が再流入する直前まで短い余韻を残す。
        const dissolve=smooth((age-.9)/1.65),recovery=smooth((age-2.8)/1.2);
        return {...base,phase:age<.9?"rewind":age<2.8?"discard":"refill",cursor,
            cancelAlpha:1-smooth((age-.9)/2.1),flowAlpha:recovery,dissolve,recovery};
    }
    return {cursorAt,stateAt,events};
}

function sampleTopDown(data:TopDownData|null|undefined,time:number) {
    if(!data||!Number.isFinite(time))return {available:false as const};
    const end=Math.min(data.slots.length,time-data.firstCycle);
    const first=Math.max(0,end-data.windowCycles);
    if(end<=first)return {available:false as const};
    const counts=[0,0,0,0,0,0,0];
    const observations=data.observationTimes;
    for(let i=Math.floor(first);i<Math.ceil(end);i++){
        const weight=Math.min(end,i+1)-Math.max(first,i),row=[...data.slots[i],0];
        if(observations){
            // 結果が未確定でも割り当て自体は判明している。処理中の仕事と、
            // 判断に必要な記録が欠けているスロットを分けて扱う。
            row[6]=row[0]+row[1];row[0]=row[1]=0;
            const recovery=observations.recoveryNotices[i];
            if(recovery&&time<recovery[0]){row[recovery[1]]+=row[2];row[2]=0;}
        }
        row.forEach((n,j)=>counts[j]+=n*weight);
    }
    for(const [allocated,observed,outcome] of observations?.outcomes??[]){
        if(observed>time)continue;
        const index=allocated-data.firstCycle,weight=Math.max(0,Math.min(end,index+1)-Math.max(first,index));
        counts[6]-=weight;counts[outcome]+=weight;
    }
    for(let i=0;i<counts.length;i++)if(Math.abs(counts[i])<1e-9)counts[i]=0;
    const total=counts.reduce((sum,n)=>sum+n,0);
    if(total<=0)return {available:false as const};
    const shares={retiring:counts[0]/total,badSpeculation:(counts[1]+counts[2])/total,
        frontend:counts[3]/total,backend:counts[4]/total,unresolved:counts[5]/total,inFlight:counts[6]/total};
    // 主表示では有効な割り当てと失われた処理能力を比較する。
    // コミットは有効な割り当ての内訳を確定するため、レイテンシが長いだけで
    // 主表示が未確定・不明のままにならないようにする。
    const ranked=Object.entries({active:shares.retiring+shares.inFlight,badSpeculation:shares.badSpeculation,
        frontend:shares.frontend,backend:shares.backend,unresolved:shares.unresolved}).sort((a,b)=>b[1]-a[1]);
    const dominant:BoundCategory|"mixed"=Math.abs(ranked[0][1]-ranked[1][1])<1e-9?"mixed":ranked[0][0] as BoundCategory;
    return {available:true as const,firstCycle:data.firstCycle+first,lastCycle:data.firstCycle+end,
        cycles:end-first,totalSlots:total,counts,shares,dominant,dominantShare:ranked[0][1]};
}
function findRecoveryBranches<T extends Pick<Instruction,"id"|"flush"|"end"|"execution"|"completion">>(ops:readonly T[],events:readonly DemoEvent[]|undefined,flushes:readonly number[],infer=false) {
    const result=[];
    for(const event of events??[]){
        if(event.kind!=="branch-mispredict")continue;
        const op=ops.find(o=>o.id===event.id);if(!op||op.flush)continue;
        const flush=flushes.find(t=>t>=event.cycle&&t<=event.cycle+4);
        result.push({id:op.id,op,cycle:event.cycle,until:Math.min(op.end+1.6,(flush??event.cycle)+5.4),inferred:false});
    }
    if(infer)for(const time of flushes){
        const first=Math.min(...ops.filter(o=>o.flush&&o.end===time).map(o=>o.id));
        // O3PipeView には原因の注釈がない。直前の命令が生存する分岐の場合だけ、
        // 推定候補であることを明示して表示する。
        const op=ops.find(o=>o.id===first-1&&!o.flush&&o.execution==="exec-branch"
            &&o.completion!==null&&o.completion<=time&&o.completion>=time-8&&o.end>time);
        if(op)result.push({id:op.id,op,cycle:time,until:Math.min(op.end+1.6,time+5.4),inferred:true});
    }
    return result.sort((a,b)=>a.cycle-b.cycle);
}
function createDependencyReplay(ops:readonly DependencyOperation[],evidence:SchedulingEvidence|null|undefined,capacity?:number) {
    const byID=new Map((evidence?.ops??[]).map(o=>[o.id,o]));
    const count=capacity??Math.max(1,...ops.map(o=>(o.issueSlot??-1)+1));
    const resident=(op:DependencyOperation,time:number)=>op.allocation!=null&&op.allocation<=time&&time<Math.min(op.issue??op.end,op.end);
    function columnAt(id:number,time:number){const op=ops.find(o=>o.id===id);return op&&resident(op,time)?op.issueSlot:null;}
    function stateAt(time:number){
        const active=ops.filter(op=>resident(op,time)),slots=new Map(active.map(op=>[op.id,op.issueSlot]));
        const rows:{id:number;slot:number|undefined;known:boolean;ready:boolean}[]=[],cells:DependencyCell[]=[],external:DependencyCell[]=[],broadcasts=new Map<number,Broadcast>();
        for(const op of active){
            const evidenceOp=byID.get(op.id),deps=evidenceOp?.dependencies??[];
            rows.push({id:op.id,slot:op.issueSlot,known:!!evidenceOp,ready:!!evidenceOp&&deps.every(d=>d.ready!==null&&d.ready<=time)});
            const seen=new Set<number>();
            for(const dep of deps){
                const age=dep.ready===null?-Infinity:time-dep.ready;
                if(seen.has(dep.id)||dep.ready!==null&&dep.ready<=op.allocation!||age>=.9)continue;
                seen.add(dep.id);
                const cell={consumer:op.id,producer:dep.id,row:op.issueSlot,column:slots.get(dep.id)??null,waiting:age<0,
                    unknown:dep.ready===null,alpha:age<0?1:1-smooth(age/.9),register:dep.register??null};
                (cell.column===null?external:cells).push(cell);
                if(age>=0){
                    if(!broadcasts.has(dep.id))broadcasts.set(dep.id,{producer:dep.id,column:cell.column,rows:[],progress:age/.9});
                    broadcasts.get(dep.id)!.rows.push(op.issueSlot);
                }
            }
        }
        const issues=ops.filter(op=>op.issue!=null&&op.allocation!=null&&op.issue<op.end&&time>=op.issue&&time<op.issue+.9).map(op=>({
            id:op.id,slot:op.issueSlot,column:rows.some(r=>r.slot===op.issueSlot&&r.id!==op.id)?null:op.issueSlot,
            progress:(time-op.issue!)/.9,targets:rows.filter(row=>(byID.get(row.id)?.dependencies??[]).some(d=>d.id===op.id)).map(r=>({id:r.id,row:r.slot}))
        }));
        return {rows,cells,external,issues,broadcasts:[...broadcasts.values()],rowCount:count,columnCount:count,
            columns:rows.map(row=>({id:row.id,slot:row.slot})),kind:evidence?.kind??"unavailable"};
    }
    return {columnCount:count,columnAt,stateAt};
}
function createRegisterReplay(input:RegisterEvidence|null|undefined) {
    if(!input)return {stateAt:(_time:number)=>({available:false as const,rows:[],events:[]})};
    const data=input;
    const physicalIDs=[...new Set([...data.initial.owners.map(([id])=>id),...data.initial.mapping.map(([,id])=>id),
        ...(data.allocation?.initial??[]).map(([id])=>id),...(data.allocation?.events??[]).map(e=>e.physical),
        ...data.events.flatMap(e=>[e.physical,...(e.previous===undefined?[]:[e.previous])])])].sort((a,b)=>a-b);
    function stateAt(time:number){
        const mapping=new Map(data.initial.mapping),values=new Map(data.initial.values),owners=new Map(data.initial.owners),changed=new Map<number,RegisterEvent>(),physicalChanged=new Map<number,RegisterEvent>();
        const allocation=new Map(data.allocation?.initial??[]),allocationChanged=new Map<number,AllocationEvent>();
        for(const e of data.allocation?.events??[]){
            if(e.cycle>time)break;
            if(allocation.get(e.physical)!==e.state)allocationChanged.set(e.physical,e);
            allocation.set(e.physical,e.state);
        }
        let lastWrite:Extract<RegisterEvent,{type:"write"}>|null=null;
        for(const e of data.events){
            if(e.cycle>time)break;
            if(e.type==="map"){
                mapping.set(e.logical,e.physical);
            }else if(e.type==="observe"){
                values.set(e.physical,e.hex);
            }else if(e.type==="rename"){
                mapping.set(e.logical,e.physical);owners.set(e.physical,e.id);values.delete(e.physical);changed.set(e.logical,e);physicalChanged.set(e.physical,e);
            }else if(e.type==="restore"&&mapping.get(e.logical)===e.physical){
                mapping.set(e.logical,e.previous);changed.set(e.logical,e);physicalChanged.set(e.physical,e);physicalChanged.set(e.previous,e);
            }else if(e.type==="write"&&owners.get(e.physical)===e.id){
                values.set(e.physical,e.hex);lastWrite=e;physicalChanged.set(e.physical,e);
            }
        }
        const allocationCounts={allocated:0,free:0,unknown:0};
        for(const physical of physicalIDs)allocationCounts[allocation.get(physical)??"unknown"]++;
        return {available:true as const,allocationCounts,rows:data.rows.map(logical=>{
            const physical=mapping.get(logical),event=changed.get(logical);
            return {logical,constant:data.constantRows?.includes(logical)??false,physical:physical??null,value:physical===undefined?null:values.get(physical)??null,
                writer:physical===undefined?null:owners.get(physical)??null,event:event??null,pulse:event?1-smooth((time-event.cycle)/1.2):0};
        }),physical:physicalIDs.map(physical=>{
            const event=physicalChanged.get(physical),allocationEvent=allocationChanged.get(physical);
            return {physical,value:values.get(physical)??null,writer:owners.get(physical)??null,
                allocation:allocation.get(physical)??"unknown",allocationEvent:allocationEvent??null,
                allocationPulse:allocationEvent?1-smooth((time-allocationEvent.cycle)/.65):0,
                mappedTo:[...mapping].filter(([,p])=>p===physical).map(([r])=>r),event:event??null,pulse:event?1-smooth((time-event.cycle)/1.2):0};
        }),lastWrite,events:data.events.filter(e=>time>=e.cycle&&time<e.cycle+1.2)};
    }
    return {stateAt};
}

// デモの選択と、命令・表示スロットの準備。
function createReplay({samples}:{samples:readonly TraceData[]}) {
    const replay:ReplayState={
        trace:null,ops:[],flushEvents:[],activity:[],commitGroups:new Map(),robReplay:null,
        memoryEvents:[],branchRecoveries:[],dependencyReplay:null,registerReplay:null,registerTags:[],
        feedOps:[],fetchGroups:[],feedReplay:null
    };
    function instructionKind(label:string):Instruction["kind"] {
        const mnemonic=label.replace(/^(?:0x)?[0-9a-f]+:\s*/i,"").trim().replace(/^[A-Z0-9_]+\s*:\s*/,"").split(/\s+/)[0].toLowerCase();
        if (/^(b|bl|br|bx|cbz|cbnz|tbz|tbnz|jal|jalr|jr|ret|wrip)/.test(mnemonic)) return "branch";
        if (/^(ld|ldr|ldp|lw|lh|lb|sd|st|sw|sh|sb|load|store)/.test(mnemonic)) return "memory";
        return "integer";
    }

    function allocateSlots(start:(op:Instruction)=>number|null|undefined, end:(op:Instruction)=>number|undefined, field:"issueSlot"|"memorySlot") {
        const ends:(number|undefined)[]=[];
        for (const op of [...replay.ops].filter((o)=>start(o)!=null).sort((a,b)=>start(a)!-start(b)!||a.id-b.id)) {
            let slot=ends.findIndex((e)=>e!<=start(op)!);
            if(slot<0)slot=ends.length;
            op[field]=slot;ends[slot]=end(op);
        }
    }

    function allocateRenameSlots(){
        const ends:number[]=[];
        const entries=replay.ops.flatMap(op=>op.stages.flatMap((stage,index)=>stage.names.includes("Rn")?[{op,stage,next:op.stages[index+1]}]:[]));
        // 同時に滞在する命令を別々に置く。退場の補間中も元の場所を再利用しない。
        for(const {op,stage,next} of entries.sort((a,b)=>a.stage.start-b.stage.start||a.op.id-b.op.id)){
            let slot=ends.findIndex(end=>end<=stage.start);
            if(slot<0)slot=ends.length;
            stage.displaySlot=slot;
            ends[slot]=Math.min(op.end,next?next.start+stageTransition(next):stage.end);
        }
    }

    function loadTrace(key:string) {
        const trace=samples.find((s)=>s.key===key)||samples[0];
        replay.trace=trace;
        replay.ops=trace.ops.map((t,index)=>{
            const [id,rid,fetch,retired,flush,label,source,allocation,issue,completion,execution,flushCycle]=t;
            const end=flush?(flushCycle??retired):retired;
            const stages:StageRange[]=[];
            for(const [name,node,start,finish] of source){
                if(stages.at(-1)?.node===node){stages.at(-1)!.end=Math.max(finish,stages.at(-1)!.end);stages.at(-1)!.names.push(name);}
                else stages.push({names:[name],node,start,end:finish});
            }
            if(stages.length&&end>stages.at(-1)!.end)stages.at(-1)!.end=end;
            return {id,rid,index,fetch,end,flush:!!flush,label,stages,allocation,issue,completion,execution,kind:instructionKind(label),
                reads:trace.evidence?.registers?.origin==="gem5"?[...new Set((trace.evidence.registers.reads??[]).filter(r=>r.id===id).map(r=>r.cycle))].map(time=>({start:time,end:time+.7,sources:(trace.evidence!.registers!.reads??[]).filter(r=>r.id===id&&r.cycle===time).map(r=>({physical:r.physical,hex:r.hex}))})):source.filter(s=>s[0]==="Rr").map(s=>({start:s[2],end:s[3]})),
                sourceRegisters:trace.evidence?.scheduling.ops.find(o=>o.id===id)?.sources??[]};
        });
        allocateRenameSlots();
        replay.commitGroups=new Map();
        for(const op of replay.ops.filter(o=>!o.flush).sort((a,b)=>a.end-b.end||a.rid-b.rid||a.id-b.id)){
            const time=Math.floor(op.end),group=replay.commitGroups.get(time)??[];
            op.commitSlot=group.length;group.push(op);replay.commitGroups.set(time,group);
        }
        replay.feedOps=[...replay.ops].sort((a,b)=>a.fetch-b.fetch||a.id-b.id);replay.fetchGroups=[];
        replay.feedOps.forEach((op,index)=>{
            op.feedText=`${String(op.id).padStart(6,"0")}  ${op.label.trim().replace(/\s+/g," ")}`.slice(0,42);
            if(replay.fetchGroups.at(-1)?.time===op.fetch)replay.fetchGroups.at(-1)!.count++;
            else replay.fetchGroups.push({time:op.fetch,start:index,count:1});
        });
        replay.feedReplay=createFeedReplay(replay.feedOps,{firstCycle:trace.firstCycle,lastCycle:trace.lastCycle,rows:feedRows,lead:feedLead});
        allocateSlots(o=>o.allocation,o=>o.issue??o.end,"issueSlot");
        replay.dependencyReplay=createDependencyReplay(replay.ops,trace.evidence?.scheduling,trace.structure.queueCapacity);
        replay.registerReplay=createRegisterReplay(trace.evidence?.registers);
        const regs=trace.evidence?.registers;
        replay.registerTags=regs?[...new Set([...regs.initial.owners.map(([p])=>p),...regs.initial.mapping.map(([,p])=>p),
            ...(regs.allocation?.initial??[]).map(([p])=>p),...(regs.allocation?.events??[]).map(e=>e.physical),
            ...regs.events.flatMap(e=>[e.physical,...(e.previous===undefined?[]:[e.previous])])])].sort((a,b)=>a-b):[];
        replay.robReplay=createRobReplay(replay.ops,trace.structure.robCapacity);
        for(const op of replay.ops)op.robSlot=replay.robReplay.slots.get(op.id);
        allocateSlots(o=>o.stages.find(s=>s.node==="memory-wait")?.start,o=>o.stages.find(s=>s.node==="memory-wait")?.end,"memorySlot");
        replay.memoryEvents=memoryCompletions(replay.ops);
        replay.flushEvents=[...new Set(replay.ops.filter(o=>o.flush&&o.end>=trace.firstCycle&&o.end<=trace.lastCycle).map(o=>o.end))].sort((a,b)=>a-b);
        replay.branchRecoveries=findRecoveryBranches(replay.ops,trace.demo.events,replay.flushEvents,trace.parser.startsWith("gem5"));

        replay.activity=Array.from({length:trace.lastCycle-trace.firstCycle+1},(_,i)=>{
            const t=trace.firstCycle+i;
            return {active:replay.ops.filter(o=>o.fetch<=t&&o.end>t).length,retired:replay.ops.filter(o=>!o.flush&&o.end>=t&&o.end<t+1).length};
        });

    }
    return Object.assign(replay,{loadTrace});
}

interface ReplayState {
    trace:TraceData|null;ops:Instruction[];flushEvents:number[];activity:{active:number;retired:number}[];
    commitGroups:Map<number,Instruction[]>;robReplay:ReturnType<typeof createRobReplay<Instruction>>|null;
    memoryEvents:ReturnType<typeof memoryCompletions<Instruction>>;branchRecoveries:ReturnType<typeof findRecoveryBranches<Instruction>>;
    dependencyReplay:ReturnType<typeof createDependencyReplay>|null;registerReplay:ReturnType<typeof createRegisterReplay>|null;registerTags:number[];
    feedOps:Instruction[];fetchGroups:FeedGroup[];feedReplay:ReturnType<typeof createFeedReplay>|null;
}

namespace replayModel {
    export type Operation=Instruction;
    export type Stage=StageRange;
    export type Trace=TraceData;
    export type Replay=ReturnType<typeof createReplay>;
    export type Registers=RegisterEvidence;
    export type Scheduling=SchedulingEvidence;
    export type TopDown=TopDownData;
    export type Bound=BoundCategory|"mixed"|"unavailable";
}
declare global { var sonataReplay:typeof replayModel }

const replayModel={createRobReplay, memoryCompletions, createFeedReplay, codeRewindDuration, sampleTopDown,flushPlaybackRate,advancePlayback,measureTransfers,createDependencyReplay,createRegisterReplay,findRecoveryBranches,createReplay,feedRows,feedLead};
globalThis.sonataReplay=replayModel;
export = replayModel;

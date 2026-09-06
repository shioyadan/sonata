/* Deterministic trace replay shared by the WebGL view and its checks. */
((root) => {
    "use strict";
    function createRobReplay(ops, capacity) {
        const events = new Map(), slots = new Map();
        const at = time => {
            if (!events.has(time)) events.set(time, {allocate: []});
            return events.get(time);
        };
        for (const op of ops) {
            if (op.allocation == null || op.allocation >= op.end) continue;
            at(op.allocation).allocate.push(op);
            at(op.end);
        }
        let head = 0, tail = 0;
        const queue = [], snapshots = [];
        for (const time of [...events.keys()].sort((a,b) => a-b)) {
            const retired = [], squashed = [];
            // Wrong-path instructions roll back the newest part of the queue.
            while (queue.length && queue.at(-1).op.flush && queue.at(-1).op.end <= time) {
                const entry = queue.pop(); tail = entry.slot; squashed.push(entry.op.id);
            }
            // Completion only sets a ready flag. Only retirement advances head.
            while (queue.length && queue[0].op.end <= time && !queue[0].op.flush) {
                const entry = queue.shift(); head = (entry.slot + 1) % capacity; retired.push(entry.op.id);
            }
            if (queue.some(entry => entry.op.end <= time)) throw new Error(`Trace is not FIFO at cycle ${time}.`);
            if (!queue.length) head = tail;
            for (const op of events.get(time).allocate.sort((a,b) => a.id-b.id)) {
                if (queue.length >= capacity) throw new Error(`ROB capacity exceeded at cycle ${time}.`);
                if (queue.length && queue.at(-1).op.id >= op.id) throw new Error(`ROB allocation order regressed at cycle ${time}.`);
                slots.set(op.id, tail); queue.push({op, slot: tail}); tail = (tail + 1) % capacity;
            }
            snapshots.push({time, head, tail, entries: [...queue], retired, squashed});
        }
        const empty = {time: -Infinity, head: 0, tail: 0, entries: [], retired: [], squashed: []};
        function stateAt(time) {
            let lo = 0, hi = snapshots.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (snapshots[mid].time <= time) lo = mid + 1; else hi = mid;
            }
            return snapshots[lo-1] ?? empty;
        }
        return {capacity, slots, snapshots, stateAt};
    }

    function memoryCompletions(ops) {
        return ops.flatMap(op => {
            if (op.flush || op.completion == null || op.completion > op.end) return [];
            const wait = op.stages.find(stage => stage.node === "memory-wait" && stage.start < op.completion);
            return wait ? [{id: op.id, time: op.completion, op, wait}] : [];
        }).sort((a,b) => a.time-b.time || a.id-b.id);
    }

    const codeRewindDuration = 4;
    const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
    function flushPlaybackRate(time,events,{duration=codeRewindDuration,reducedMotion=false}={}) {
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
    function advancePlayback(time,seconds,speed,events,options) {
        // Integrate the gradual speed change in small steps, so low frame rates
        // cannot turn the end of slow motion into a large clock jump.
        const steps=Math.max(1,Math.ceil(seconds*120)),dt=seconds/steps;
        for(let i=0;i<steps;i++){
            const midpoint=time+dt*speed*flushPlaybackRate(time,events,options)/2;
            time+=dt*speed*flushPlaybackRate(midpoint,events,options);
        }
        return time;
    }

    function measureTransfers(ops,{firstCycle=-Infinity,lastCycle=Infinity,frontNodes=[]}={}) {
        const edges=new Map(),lastFront=frontNodes.at(-1)?.id;
        function record(from,to,time,id){
            if(!Number.isFinite(time)||time<firstCycle||time>=lastCycle+1)return;
            const key=`${from}>${to}`,cycle=Math.floor(time);
            if(!edges.has(key))edges.set(key,{from,to,cycles:new Map()});
            const edge=edges.get(key);
            if(!edge.cycles.has(cycle))edge.cycles.set(cycle,new Set());
            edge.cycles.get(cycle).add(id);
        }
        for(const op of ops){
            if(frontNodes.length)record("input",frontNodes[0].id,op.fetch,op.id);
            // A zero-cycle scheduler stay may be absent from stage ranges.
            // Allocation and execution admissions still record both crossings.
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
    // This cursor only controls the incoming code ribbon; processor time never rewinds.
    function createFeedReplay(orderedOps, {firstCycle=-Infinity,lastCycle=Infinity,rows=24,lead=.7}={}) {
        const groups=[],squashes=new Map();
        orderedOps.forEach((op,index)=>{
            if(groups.at(-1)?.time===op.fetch)groups.at(-1).count++;
            else groups.push({time:op.fetch,start:index,count:1});
            if(op.flush&&op.end>=firstCycle&&op.end<=lastCycle){
                if(!squashes.has(op.end))squashes.set(op.end,[]);
                squashes.get(op.end).push({id:op.id,index});
            }
        });
        function cursorAt(time) {
            const group=groups.find(g=>g.time>time);
            return group?group.start+group.count*smooth((time-group.time+lead)/lead):orderedOps.length;
        }
        const events=[...squashes].sort((a,b)=>a[0]-b[0]).map(([time,entries])=>{
            const start=cursorAt(time),turn=Math.max(0,entries[0].index,start-rows*1.25);
            return {time,start,turn,ids:entries.map(e=>e.id)};
        });
        function stateAt(time,reducedMotion=false) {
            const normalCursor=cursorAt(time),event=events.findLast(e=>e.time<=time&&time<e.time+codeRewindDuration);
            const flow={phase:"flow",time:null,count:0,age:0,cursor:normalCursor,normalCursor,cancelAlpha:0,flowAlpha:1,dissolve:0,recovery:1,ids:[]};
            if(!event)return flow;
            const age=time-event.time,base={...flow,time:event.time,count:event.ids.length,age,ids:[...event.ids]};
            if(reducedMotion)return {...base,phase:"notice"};
            const cursor=event.start+(event.turn-event.start)*smooth(age/.9);
            // Letters lose opacity while they drift, with a short soft tail before refill.
            const dissolve=smooth((age-.9)/1.65),recovery=smooth((age-2.8)/1.2);
            return {...base,phase:age<.9?"rewind":age<2.8?"discard":"refill",cursor,
                cancelAlpha:1-smooth((age-.9)/2.1),flowAlpha:recovery,dissolve,recovery};
        }
        return {cursorAt,stateAt,events};
    }

    function sampleTopDown(data,time) {
        if(!data||!Number.isFinite(time))return {available:false};
        const end=Math.min(data.slots.length,time-data.firstCycle);
        const first=Math.max(0,end-data.windowCycles);
        if(end<=first)return {available:false};
        const counts=[0,0,0,0,0,0,0];
        const observations=data.observationTimes;
        for(let i=Math.floor(first);i<Math.ceil(end);i++){
            const weight=Math.min(end,i+1)-Math.max(first,i),row=[...data.slots[i],0];
            if(observations){
                // Allocation is known even when its outcome is not. Keep live
                // work separate from slots with genuinely missing evidence.
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
        if(total<=0)return {available:false};
        const shares={retiring:counts[0]/total,badSpeculation:(counts[1]+counts[2])/total,
            frontend:counts[3]/total,backend:counts[4]/total,unresolved:counts[5]/total,inFlight:counts[6]/total};
        // The main state compares productive allocation with lost capacity.
        // Commit settles work within that group, so long pipeline latency alone
        // cannot leave the headline stuck in a pending/unknown state.
        const ranked=Object.entries({active:shares.retiring+shares.inFlight,badSpeculation:shares.badSpeculation,
            frontend:shares.frontend,backend:shares.backend,unresolved:shares.unresolved}).sort((a,b)=>b[1]-a[1]);
        const dominant=Math.abs(ranked[0][1]-ranked[1][1])<1e-9?"mixed":ranked[0][0];
        return {available:true,firstCycle:data.firstCycle+first,lastCycle:data.firstCycle+end,
            cycles:end-first,totalSlots:total,counts,shares,dominant,dominantShare:ranked[0][1]};
    }
    function findRecoveryBranches(ops,events,flushes,infer=false) {
        const result=[];
        for(const event of events??[]){
            if(event.kind!=="branch-mispredict")continue;
            const op=ops.find(o=>o.id===event.id);if(!op||op.flush)continue;
            const flush=flushes.find(t=>t>=event.cycle&&t<=event.cycle+4);
            result.push({id:op.id,op,cycle:event.cycle,until:Math.min(op.end+1.6,(flush??event.cycle)+5.4),inferred:false});
        }
        if(infer)for(const time of flushes){
            const first=Math.min(...ops.filter(o=>o.flush&&o.end===time).map(o=>o.id));
            // O3PipeView has no cause annotation. Only show a labeled candidate
            // when the immediately preceding instruction is a surviving branch.
            const op=ops.find(o=>o.id===first-1&&!o.flush&&o.execution==="exec-branch"
                &&o.completion!==null&&o.completion<=time&&o.completion>=time-8&&o.end>time);
            if(op)result.push({id:op.id,op,cycle:time,until:Math.min(op.end+1.6,time+5.4),inferred:true});
        }
        return result.sort((a,b)=>a.cycle-b.cycle);
    }
    function createDependencyReplay(ops,evidence,capacity) {
        const byID=new Map((evidence?.ops??[]).map(o=>[o.id,o]));
        const count=capacity??Math.max(1,...ops.map(o=>(o.issueSlot??-1)+1));
        const resident=(op,time)=>op.allocation!=null&&op.allocation<=time&&time<Math.min(op.issue??op.end,op.end);
        function columnAt(id,time){const op=ops.find(o=>o.id===id);return op&&resident(op,time)?op.issueSlot:null;}
        function stateAt(time){
            const active=ops.filter(op=>resident(op,time)),slots=new Map(active.map(op=>[op.id,op.issueSlot]));
            const rows=[],cells=[],external=[],broadcasts=new Map();
            for(const op of active){
                const evidenceOp=byID.get(op.id),deps=evidenceOp?.dependencies??[];
                rows.push({id:op.id,slot:op.issueSlot,known:!!evidenceOp,ready:!!evidenceOp&&deps.every(d=>d.ready!==null&&d.ready<=time)});
                const seen=new Set();
                for(const dep of deps){
                    const age=dep.ready===null?-Infinity:time-dep.ready;
                    if(seen.has(dep.id)||dep.ready!==null&&dep.ready<=op.allocation||age>=.9)continue;
                    seen.add(dep.id);
                    const cell={consumer:op.id,producer:dep.id,row:op.issueSlot,column:slots.get(dep.id)??null,waiting:age<0,
                        unknown:dep.ready===null,alpha:age<0?1:1-smooth(age/.9),register:dep.register??null};
                    (cell.column===null?external:cells).push(cell);
                    if(age>=0){
                        if(!broadcasts.has(dep.id))broadcasts.set(dep.id,{producer:dep.id,column:cell.column,rows:[],progress:age/.9});
                        broadcasts.get(dep.id).rows.push(op.issueSlot);
                    }
                }
            }
            const issues=ops.filter(op=>op.issue!=null&&op.allocation!=null&&op.issue<op.end&&time>=op.issue&&time<op.issue+.9).map(op=>({
                id:op.id,slot:op.issueSlot,column:rows.some(r=>r.slot===op.issueSlot&&r.id!==op.id)?null:op.issueSlot,
                progress:(time-op.issue)/.9,targets:rows.filter(row=>(byID.get(row.id)?.dependencies??[]).some(d=>d.id===op.id)).map(r=>({id:r.id,row:r.slot}))
            }));
            return {rows,cells,external,issues,broadcasts:[...broadcasts.values()],rowCount:count,columnCount:count,
                columns:rows.map(row=>({id:row.id,slot:row.slot})),kind:evidence?.kind??"unavailable"};
        }
        return {columnCount:count,columnAt,stateAt};
    }
    function createRegisterReplay(data) {
        if(!data)return {stateAt:()=>({available:false,rows:[],events:[]})};
        const physicalIDs=[...new Set([...data.initial.owners.map(([id])=>id),...data.initial.mapping.map(([,id])=>id),
            ...(data.allocation?.initial??[]).map(([id])=>id),...(data.allocation?.events??[]).map(e=>e.physical),
            ...data.events.flatMap(e=>[e.physical,...(e.previous===undefined?[]:[e.previous])])])].sort((a,b)=>a-b);
        function stateAt(time){
            const mapping=new Map(data.initial.mapping),values=new Map(data.initial.values),owners=new Map(data.initial.owners),changed=new Map(),physicalChanged=new Map();
            const allocation=new Map(data.allocation?.initial??[]),allocationChanged=new Map();
            for(const e of data.allocation?.events??[]){
                if(e.cycle>time)break;
                if(allocation.get(e.physical)!==e.state)allocationChanged.set(e.physical,e);
                allocation.set(e.physical,e.state);
            }
            let lastWrite=null;
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
            return {available:true,allocationCounts,rows:data.rows.map(logical=>{
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
    const api = {createRobReplay, memoryCompletions, createFeedReplay, codeRewindDuration, sampleTopDown,flushPlaybackRate,advancePlayback,measureTransfers,createDependencyReplay,createRegisterReplay,findRecoveryBranches};
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    root.sonataReplay = api;
})(globalThis);

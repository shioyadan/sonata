"use strict";
const assert=require("node:assert/strict");
const {createRobReplay,memoryCompletions,createFeedReplay,codeRewindDuration,sampleTopDown,flushPlaybackRate,advancePlayback,measureTransfers,createDependencyReplay,createRegisterReplay,findRecoveryBranches}=require("../src/replay-model.js");

const matrix=createDependencyReplay([
    {id:10,allocation:0,issue:4,end:8,issueSlot:3},
    {id:11,allocation:1,issue:6,end:9,issueSlot:0},
    {id:12,allocation:2,issue:5,end:9,issueSlot:1},
    {id:13,allocation:2,issue:null,end:4,issueSlot:2},
    {id:14,allocation:4,issue:7,end:9,issueSlot:3},
],{kind:'recorded',ops:[
    {id:10,dependencies:[]},{id:14,dependencies:[]},
    {id:11,dependencies:[{id:10,ready:4}]},
    {id:12,dependencies:[{id:10,ready:4}]},
    {id:13,dependencies:[{id:9,ready:null}]},
]},4);
const waiting=matrix.stateAt(3);
assert.equal(waiting.rowCount,4);assert.equal(waiting.columnCount,4);
assert.equal(waiting.rows.length,4);assert.equal(waiting.cells.length,2);assert.equal(waiting.external.length,1);
assert.equal(waiting.cells[0].column,3);assert.equal(waiting.cells[1].column,3);
assert.ok(waiting.rows.filter(r=>r.id!==10).every(r=>!r.ready));
const wake=matrix.stateAt(4.2);
assert.equal(wake.rows.length,3);assert.ok(wake.rows.every(r=>r.ready));
assert.equal(wake.cells.length,0,'Reused producer slot must not receive the old dependency');
assert.equal(wake.external.length,2);assert.ok(wake.external.every(c=>!c.waiting&&c.alpha>0));
assert.equal(wake.broadcasts.length,1);assert.equal(wake.broadcasts[0].column,null);
assert.equal(wake.issues[0].id,10);assert.equal(wake.issues[0].column,null,'Issue pulse must not select a reused column');
assert.equal(matrix.stateAt(5.2).issues[0].id,12);
assert.equal(matrix.stateAt(4.95).external.length,0);assert.equal(matrix.stateAt(7).rows.length,0);
assert.deepEqual(matrix.stateAt(3),waiting,'Matrix replay depends on seek direction');

const registers=createRegisterReplay({rows:[1],initial:{mapping:[[1,1]],values:[[1,'0x10']],owners:[[1,10],[3,-4]]},allocation:{initial:[[1,'allocated']],events:[
    {cycle:1,physical:2,state:'allocated',reason:'rename'},
    {cycle:4.5,physical:2,state:'free',reason:'squash reclamation'},
    {cycle:5,physical:2,state:'allocated',reason:'rename'},
    {cycle:8,physical:1,state:'free',reason:'commit'},
]},events:[
    {type:'rename',cycle:1,id:11,logical:1,physical:2,previous:1},
    {type:'write',cycle:2,id:10,logical:1,physical:1,hex:'0x20'},
    {type:'write',cycle:3,id:11,logical:1,physical:2,hex:'0x30'},
    {type:'restore',cycle:4,id:11,logical:1,physical:2,previous:1},
    {type:'rename',cycle:5,id:12,logical:1,physical:2,previous:1},
    {type:'write',cycle:6,id:11,logical:1,physical:2,hex:'0xbad'},
    {type:'write',cycle:7,id:12,logical:1,physical:2,hex:'0x40'},
]});
assert.equal(registers.stateAt(0).rows[0].value,'0x10');
assert.equal(registers.stateAt(2).rows[0].value,null,'An older physical write contaminated a newer mapping');
assert.equal(registers.stateAt(2).physical.find(p=>p.physical===1).value,'0x20','A physical value must survive after the RAT selects a newer version');
assert.equal(registers.stateAt(3).rows[0].value,'0x30');
assert.equal(registers.stateAt(4).rows[0].physical,1);assert.equal(registers.stateAt(4).rows[0].value,'0x20');
assert.equal(registers.stateAt(6).rows[0].value,null,'A stale write corrupted a reused physical register');
assert.equal(registers.stateAt(6).physical.find(p=>p.physical===2).value,null);
assert.equal(registers.stateAt(7).rows[0].value,'0x40');
assert.equal(registers.stateAt(2).rows[0].value,null);
const allocation=(time,p)=>registers.stateAt(time).physical.find(c=>c.physical===p).allocation;
assert.equal(allocation(2,1),'allocated','An older version must stay allocated after the RAT switches');
assert.equal(allocation(4.2,2),'allocated','RAT rollback must not anticipate delayed squash reclamation');
assert.equal(allocation(4.8,2),'free');assert.equal(allocation(5,2),'allocated');
assert.equal(allocation(7,1),'allocated');assert.equal(allocation(8,1),'free');
assert.equal(allocation(8,3),'unknown','An unobserved register must not be advertised as free');
assert.deepEqual(registers.stateAt(4.8).allocationCounts,{allocated:1,free:1,unknown:1});
const allocationSnapshot=registers.stateAt(4.8);registers.stateAt(8);assert.deepEqual(registers.stateAt(4.8),allocationSnapshot);
assert.equal(createRegisterReplay(null).stateAt(4).available,false);

// 従来の 4 サイクル境界でも、スローモーションから連続的に復帰することを確認する。
for(const boundary of [-.8,0,2.8,4,5.4]){
    assert.ok(Math.abs(flushPlaybackRate(boundary-.0001,[0])-flushPlaybackRate(boundary+.0001,[0]))<.0001);
}
let lastRate=.27;
for(let t=2.8;t<=5.5;t+=.01){const rate=flushPlaybackRate(t,[0]);assert.ok(rate>=lastRate-1e-12&&rate<=1);lastRate=rate;}
assert.equal(flushPlaybackRate(2,[0]),.27);assert.equal(flushPlaybackRate(5.5,[0]),1);
assert.equal(flushPlaybackRate(2,[0],{reducedMotion:true}),1);
assert.equal(flushPlaybackRate(4,[0,3]),.27,'A second flush must retain slow motion');
const integrate=step=>{let t=2.6;for(let elapsed=0;elapsed<1.5-1e-8;elapsed+=step)t=advancePlayback(t,Math.min(step,1.5-elapsed),4,[0]);return t;};
assert.ok(Math.abs(integrate(1/15)-integrate(1/120))<.002,'Recovery speed depends on frame rate');
for(const speed of [1,4,16]){
    const t=advancePlayback(-.001,.075,speed,[0]);
    assert.ok(t>0&&t<.9,'Playback skipped the visible beginning of a flush');
}
// 滞在時間や同一実行モジュール内の重複区間ではなく、境界の通過を数える。
const transfers=measureTransfers([
    {id:1,fetch:0,allocation:1,end:5,flush:false,stages:[{node:'front-0',start:0},{node:'exec-integer',start:1},{node:'exec-integer',start:2},{node:'rob',start:3}]},
    {id:2,fetch:0,allocation:1,end:5,flush:false,stages:[{node:'front-0',start:0},{node:'issue',start:1},{node:'exec-integer',start:2},{node:'rob',start:4}]},
    {id:3,fetch:0,allocation:1,end:4,flush:true,stages:[{node:'front-0',start:0},{node:'issue',start:1},{node:'exec-integer',start:2}]},
    {id:4,fetch:0,allocation:1,end:6,flush:false,stages:[{node:'front-0',start:0},{node:'exec-integer',start:1},{node:'rob',start:3}]},
],{firstCycle:1,lastCycle:5,frontNodes:[{id:'front-0'}]});
assert.equal(transfers.get('front-0>issue').peak,4,'Missing zero-cycle issue rows lost allocation crossings');
assert.equal(transfers.get('issue>exec-integer').peak,2);
assert.equal(transfers.get('issue>exec-integer').total,4,'An execution stay was counted more than once');
assert.equal(transfers.get('exec-integer>rob').peak,2);
assert.equal(transfers.get('rob>commit').peak,2,'Squash or an out-of-window retirement counted as a transfer');
assert.equal(transfers.has('input>front-0'),false,'Out-of-window fetches affected the width');

// 後方の平均窓に将来のボトルネックが入り込まないことを確認する。
const topDownFixture={firstCycle:10,windowCycles:2,slots:[[2,0,0,0,0,0],[0,0,0,0,2,0],[0,1,1,0,0,0],[0,0,0,0,0,2]]};
assert.equal(sampleTopDown(topDownFixture,10.5).dominant,"active");
assert.equal(sampleTopDown(topDownFixture,12).dominant,"mixed");
assert.equal(sampleTopDown(topDownFixture,13).shares.badSpeculation,.5);
assert.equal(sampleTopDown(topDownFixture,14).shares.unresolved,.5);
assert.equal(sampleTopDown(topDownFixture,12.5).firstCycle,10.5);
assert.equal(sampleTopDown(topDownFixture,12.5).lastCycle,12.5);
assert.equal(sampleTopDown(topDownFixture,12.5).shares.badSpeculation,.25,'The window edge must move with the fractional current cycle');
assert.equal(sampleTopDown(null,12).available,false);
assert.equal(sampleTopDown(topDownFixture,9).available,false);
const causalTopDown={firstCycle:0,windowCycles:4,slots:[[1,1,0,0,0,0],[0,0,2,0,0,0],[0,0,0,2,0,0],[0,0,0,0,2,0]],
    observationTimes:{outcomes:[[0,2,0],[0,3,1]],recoveryNotices:[null,[3,3],null,null]}};
const pendingTopDown=sampleTopDown(causalTopDown,1.5);
assert.equal(pendingTopDown.shares.badSpeculation,0,'Future squash or recovery leaked into the display');
assert.equal(pendingTopDown.shares.retiring,0,'A future commit was classified before observation');
assert.equal(pendingTopDown.shares.inFlight,2/3);assert.equal(pendingTopDown.shares.unresolved,0);
assert.equal(pendingTopDown.dominant,'active','Known in-flight work must not be classified as missing evidence');
assert.equal(sampleTopDown(causalTopDown,2.5).shares.retiring,.2);
assert.equal(sampleTopDown(causalTopDown,2.5).shares.badSpeculation,0);
assert.equal(sampleTopDown(causalTopDown,3).shares.badSpeculation,.5);
assert.deepEqual(sampleTopDown(causalTopDown,1.5),pendingTopDown,'Backward seek retained a future outcome');
const busyPipeline={firstCycle:0,windowCycles:8,slots:Array.from({length:16},()=>[2,0,0,0,0,0]),
    observationTimes:{outcomes:Array.from({length:16},(_,c)=>[[c,c+12,0],[c,c+12,0]]).flat(),recoveryNotices:Array(16).fill(null)}};
for(const t of [8,10.5,13,15.5]){
    const state=sampleTopDown(busyPipeline,t);
    assert.equal(state.dominant,'active');assert.equal(state.dominantShare,1);assert.equal(state.shares.inFlight,1);
    assert.equal(state.shares.unresolved,0,'Commit latency longer than the window must not make a busy pipeline permanently pending');
}

// 若い命令が先に完了しても、スロットを解放したり先頭を追い越したりできない。
const fixture=[
    {id:1,allocation:0,completion:4,end:5,flush:false},
    {id:2,allocation:1,completion:1.5,end:6,flush:false},
    {id:3,allocation:2,completion:3,end:8,flush:false},
    {id:4,allocation:5,completion:6,end:7,flush:true},
    {id:5,allocation:7,completion:8,end:9,flush:false},
];
const r=createRobReplay(fixture,3);
assert.deepEqual(r.stateAt(4).entries.map(e=>e.op.id),[1,2,3]);
assert.equal(r.stateAt(4).head,0);
assert.equal(r.stateAt(4).tail,0); // 満杯かどうかは個数で区別する。
assert.equal(r.slots.get(4),0); // 任意の空きを再利用せず、末尾を循環させる。
assert.deepEqual(r.stateAt(5).entries.map(e=>e.op.id),[2,3,4]);
assert.equal(r.stateAt(5).head,1);
assert.equal(r.slots.get(5),0); // squash では取り消した末尾の開始位置へ巻き戻す。
assert.deepEqual(r.stateAt(7).entries.map(e=>e.op.id),[3,5]);
assert.equal(r.stateAt(9).entries.length,0);
// 逆向きシークの結果は、直前に描画したフレームに依存しない。
assert.equal(r.stateAt(1).tail,2);
assert.deepEqual(r.stateAt(1).entries.map(e=>e.op.id),[1,2]);

require("../data/traces.js");
assert.equal(globalThis.embeddedFlowTraces.length,5);
assert.ok(!globalThis.embeddedFlowTraces.some(t=>t.key==='pressure-release'));
for(const trace of globalThis.embeddedFlowTraces){
    if(trace.topDown){
        for(const row of trace.topDown.slots)assert.equal(row.reduce((sum,n)=>sum+n,0),trace.topDown.allocationWidth);
        for(let t=trace.firstCycle;t<=trace.lastCycle;t++){
            const s=sampleTopDown(trace.topDown,t);
            assert.equal(s.cycles,8);assert.equal(s.lastCycle,t);assert.equal(s.firstCycle,t-8);
            assert.ok(Math.abs(Object.values(s.shares).reduce((sum,n)=>sum+n,0)-1)<1e-9);
            assert.ok(s.counts.every(n=>n>=0));
        }
        const notices=trace.topDown.observationTimes,firstSquash=Math.min(...notices.outcomes.filter(e=>e[2]===1).map(e=>e[1]),...notices.recoveryNotices.filter(Boolean).map(e=>e[0]));
        for(let t=trace.firstCycle;t<Math.min(firstSquash,trace.lastCycle);t+=.5)assert.equal(sampleTopDown(trace.topDown,t).shares.badSpeculation,0,`${trace.key}: Bad speculation appeared before its first observed squash`);
    }else assert.equal(sampleTopDown(trace.topDown,trace.initialCycle).available,false);
    if(trace.evidence.registers){
        const data=trace.evidence.registers,replay=createRegisterReplay(data);
        for(let time=trace.firstCycle;time<=trace.lastCycle;time++){
            const state=replay.stateAt(time);
            assert.equal(Object.values(state.allocationCounts).reduce((n,v)=>n+v,0),state.physical.length);
            for(const cell of state.physical)if(cell.mappedTo.length&&data.allocation)assert.equal(cell.allocation,'allocated',`${trace.key} p${cell.physical} at ${time}: mapped register is not allocated`);
            for(const read of data.reads?.filter(r=>r.cycle===time)??[])assert.notEqual(state.physical.find(p=>p.physical===read.physical)?.allocation,'free','Reading a register already marked free');
        }
        if(data.allocation){
            assert.ok(data.allocation.events.some(e=>e.state==='allocated'));
            assert.ok(data.allocation.events.some(e=>e.state==='free'));
        }else assert.equal(replay.stateAt(trace.firstCycle).allocationCounts.unknown,256);
    }
    if(trace.evidence.registers?.origin==='gem5'){
        const data=trace.evidence.registers,replay=createRegisterReplay(data),initial=replay.stateAt(trace.firstCycle);
        assert.equal(initial.physical.length,256);
        if(data.kind==='configuration'){
            assert.equal(initial.rows.length,32);assert.ok(initial.rows.every(r=>r.physical===null&&r.value===null&&r.event===null));
            assert.equal(data.logicalNames[38],'SP_EL0');
            assert.ok(initial.physical.every(p=>p.value===null));assert.equal(data.events.length,0);
        }else{
            const expected=trace.key==='rename-rush'?{cycle:404,physical:83,hex:'0x4a9120'}:{cycle:1596,physical:191,hex:'0x4b0780'};
            const event=data.events.find(e=>e.type==='write');
            for(const [key,value] of Object.entries(expected))assert.equal(event[key],value);
            assert.equal(replay.stateAt(event.cycle).physical.find(p=>p.physical===event.physical).value,event.hex);
            assert.ok(data.reads.length>400);assert.ok(data.events.some(e=>e.type==='restore'));
            const before=replay.stateAt(trace.firstCycle+.4);replay.stateAt(trace.lastCycle);
            assert.deepEqual(replay.stateAt(trace.firstCycle+.4),before);
            if(trace.key==='x86-recovery'){
                for(const op of trace.ops){
                    if(/:\s+(ld|st)\s/.test(op[5]))assert.equal(op[10],'exec-memory');
                    if(/:\s+wripi?\s/.test(op[5]))assert.equal(op[10],'exec-branch');
                }
            }
        }
    }
    if(trace.key==="memory-tide"){
        const events=trace.demo.events;
        assert.ok(events.some(e=>e.kind==="branch-mispredict"&&/Br-pred-miss/.test(e.message)));
        assert.ok(events.some(e=>e.kind==="dcache-miss"&&/D\$[ -]miss/.test(e.message)));
        for(const e of events)assert.ok(trace.ops.some(op=>op[0]===e.id),"Recorded event must refer to an embedded instruction");
        assert.ok(trace.ops.some(op=>op[4]&&op[3]>=trace.firstCycle&&op[3]<=trace.lastCycle));
        for(const op of trace.ops){
            for(const stage of op[6]){
                if(stage[0]==='Rr')assert.equal(stage[1],'register-read');
                if(stage[0]==='X')assert.equal(stage[1],op[10]);
            }
        }
        assert.equal(trace.ops.find(o=>o[0]===4454)[9],4067,'RSD branch completion must follow X, not Is');
        const data=trace.evidence.registers;
        const write=data.events.filter(e=>e.type==='write'&&e.id===4355);
        assert.equal(write.length,1);assert.equal(write[0].cycle,4014);assert.equal(write[0].hex,'0x0');
        assert.equal(write[0].observedCycle,4013,'A failed cache-miss attempt was presented as the final register value');
        const replay=createRegisterReplay(data),allRows=replay.stateAt(4068).rows,restored=allRows.filter(r=>[12,13,15].includes(r.logical));
        assert.equal(allRows.length,32);assert.equal(allRows.find(r=>r.logical===20).physical,null);assert.equal(allRows.find(r=>r.logical===0).constant,true);
        assert.deepEqual(restored.map(r=>[r.logical,r.physical]),[[12,7],[13,11],[15,8]]);
        assert.ok(restored.every(r=>r.event.type==='restore'));
    }
    const ops=trace.ops.map(o=>({id:o[0],fetch:o[2],allocation:o[7],completion:o[9],end:o[4]?(o[11]??o[3]):o[3],flush:!!o[4],execution:o[10],stages:o[6].map(s=>({node:s[1],start:s[2],end:s[3]}))}));
    const flushes=[...new Set(ops.filter(o=>o.flush&&o.end>=trace.firstCycle&&o.end<=trace.lastCycle).map(o=>o.end))];
    const branches=findRecoveryBranches(ops,trace.demo.events,flushes,trace.parser.startsWith('gem5'));
    for(const b of branches){
        assert.equal(b.op.flush,false);assert.ok(b.until>b.cycle);
        if(b.inferred)assert.ok(ops.some(o=>o.id===b.id+1&&o.flush&&o.end===b.cycle));
        else assert.ok(trace.demo.events.some(e=>e.kind==='branch-mispredict'&&e.id===b.id));
    }
    if(trace.key==='memory-tide'){
        assert.deepEqual(branches.map(b=>b.id),[4454,4470]);
        const deps=new Map(trace.evidence.scheduling.ops.map(o=>[o.id,o.dependencies]));
        const loads=trace.ops.filter(o=>o[7]!==null&&/: l(?:b|bu|h|hu|w) /.test(o[5]));
        assert.ok(loads.length>20);
        for(const load of loads)assert.equal(deps.get(load[0]).length,1,`RSD load #${load[0]} must have one base register source`);
    }
    const replay=createRobReplay(ops,trace.structure.robCapacity);
    for(const snapshot of replay.snapshots){
        const expected=ops.filter(o=>o.allocation!=null&&o.allocation<=snapshot.time&&o.end>snapshot.time).sort((a,b)=>a.id-b.id);
        assert.deepEqual(snapshot.entries.map(e=>e.op.id),expected.map(o=>o.id),`${trace.key}: FIFO membership`);
        assert.equal(new Set(snapshot.entries.map(e=>e.slot)).size,expected.length);
        snapshot.entries.forEach((e,i)=>assert.equal(e.slot,(snapshot.head+i)%replay.capacity,`${trace.key}: contiguous FIFO`));
        assert.equal(snapshot.tail,(snapshot.head+expected.length)%replay.capacity);
    }
    const returns=memoryCompletions(ops);
    assert.equal(returns.length,ops.filter(o=>!o.flush&&o.completion!=null&&o.completion<=o.end&&o.stages.some(s=>s.node==="memory-wait"&&s.start<o.completion)).length);
    for(const e of returns){assert.equal(e.time,e.op.completion);assert.ok(!e.op.flush);}
    const feed=createFeedReplay([...ops].sort((a,b)=>a.fetch-b.fetch||a.id-b.id),trace);
    for(const event of feed.events){
        const t=event.time;
        assert.equal(feed.stateAt(t-.001).phase,"flow");
        assert.equal(feed.stateAt(t).cursor,feed.cursorAt(t),"Rewind must start without a cursor jump");
        assert.ok(feed.stateAt(t+.2).cursor>feed.stateAt(t+.6).cursor,"Code cursor must reverse");
        assert.equal(feed.stateAt(t+1.05).phase,"discard");
        const separated=feed.stateAt(t+2.1);
        assert.equal(separated.phase,"discard");
        assert.ok(separated.dissolve>.5,"Letters must visibly separate");
        assert.ok(separated.cancelAlpha>.25&&separated.cancelAlpha<feed.stateAt(t+1.5).cancelAlpha,"Letters must fade as they separate");
        assert.equal(separated.flowAlpha,0,"Incoming code covered the unraveling letters too early");
        assert.equal(feed.stateAt(t+3.1).phase,"refill");
        assert.ok(feed.stateAt(t+3.1).flowAlpha>0);
        assert.ok(feed.stateAt(t+3.1).cancelAlpha<1);
        assert.equal(feed.stateAt(t+codeRewindDuration).phase,"flow");
        assert.equal(feed.stateAt(t+codeRewindDuration).cursor,feed.cursorAt(t+codeRewindDuration));
        const before=feed.stateAt(t+.6);feed.stateAt(trace.lastCycle);
        assert.deepEqual(feed.stateAt(t+.6),before,"Rewind must be deterministic after seeking");
        assert.deepEqual(before.ids,ops.filter(o=>o.flush&&o.end===t).sort((a,b)=>a.fetch-b.fetch||a.id-b.id).map(o=>o.id));
        const reduced=feed.stateAt(t+.6,true);
        assert.equal(reduced.phase,"notice");assert.equal(reduced.cursor,feed.cursorAt(t+.6));assert.equal(reduced.cancelAlpha,0);
    }
    if(!feed.events.length)assert.equal(feed.stateAt(trace.initialCycle).phase,"flow");
    console.log(`${trace.key}: ${replay.snapshots.length} FIFO snapshots; ${returns.length} memory broadcasts; ${feed.events.length} code rewinds`);
}

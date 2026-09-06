"use strict";
// リポジトリのルートから実行する。
// xvfb-run -a -s '-screen 0 1600x1100x24' node_modules/.bin/electron --no-sandbox scripts/render.cjs
const {app, BrowserWindow} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {pathToFileURL}=require("node:url");
const assert = require("node:assert/strict");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
const root=path.resolve(__dirname,"..");
const screenshots=path.join(root,"artifacts/screenshots");
fs.mkdirSync(screenshots,{recursive:true});
const sourceEntry=process.env.SONATA_HTML?path.resolve(process.env.SONATA_HTML):require("./build.cjs").build();
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sonata-offline-"));
const entry=path.join(isolated,"sonata.html");fs.copyFileSync(sourceEntry,entry);
const unexpectedRequests=[];
app.whenReady().then(async () => {
    const window = new BrowserWindow({width: 1440, height: 1000, show: true, webPreferences: {contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    window.webContents.session.webRequest.onBeforeRequest((request,callback)=>{
        const allowed=request.url===pathToFileURL(entry).href;
        if(!allowed)unexpectedRequests.push(request.url);
        callback({cancel:!allowed});
    });
    window.webContents.on("console-message", event => {
        if (event.level === "error") errors.push(event.message);
    });
    window.webContents.on("preload-error", (_event, _path, error) => errors.push(String(error)));
    const js = source => window.webContents.executeJavaScript(source);
    const settle=async()=>{
        await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        await js("document.getElementById('scene').getContext('webgl2').finish()");
    };
    const waitFor=async(source,message)=>{
        const deadline=Date.now()+5000;
        while(Date.now()<deadline){if(await js(source))return;await delay(60);}
        assert.fail(message);
    };
    await window.loadFile(entry);
    if(process.env.SONATA_MOBILE_ONLY||process.argv.includes("--mobile")){
        const mobile=await require("./check-mobile.cjs")(window,screenshots);
        assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);
        console.log(JSON.stringify({mobile,errors,externalRequests:unexpectedRequests},null,2));
        fs.rmSync(isolated,{recursive:true,force:true});app.quit();return;
    }
    await delay(700);
    assert.equal(await js("typeof sonata"), "object", "WebGL mockup did not initialize");
    assert.equal(await js("document.querySelectorAll('script[src],link[rel=stylesheet]').length"),0,"Deliverable has external code or styles");
    await js("sonata.setPlaying(false); document.getElementById('auto-camera').click();");
    await js("document.getElementById('license-open').click()");
    assert.ok(await js("document.getElementById('license-panel').open&&document.getElementById('license-text').textContent.includes('Embedded Microprocessor Benchmark Consortium')"),"License notices are not readable from the app");
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-licenses.png"),(await window.webContents.capturePage()).toPNG());
    await js("document.querySelector('#license-panel button').click()");
    assert.ok(await js("!document.getElementById('license-panel').open"));
    const results = [];
    const keys = await js("embeddedFlowTraces.map(t => t.key)");
    assert.deepEqual(keys,["branch-storm","wide-open","memory-tide","rename-rush","x86-recovery"]);
    for (const key of keys) {
        const result = await js(`(() => {
            sonata.loadTrace(${JSON.stringify(key)});
            const trace=sonata.trace;
            const checkpoints=[trace.firstCycle,trace.demo.screenshotCycle,...trace.demo.bookmarks.map(b=>b.cycle+.4),trace.lastCycle];
            const matching=checkpoints.every(t=>{
                sonata.captureAt(t);
                const active=trace.ops.filter(o=>o[2]<=t && (o[4]?o[11]??o[3]:o[3])>t);
                return sonata.stats.active===active.length && sonata.particles.every(p=>p.position.every(Number.isFinite));
            });
            const commitMatches=checkpoints.every(t=>{
                sonata.captureAt(t);const slots=sonata.commitSlots;
                const committed=trace.ops.filter(o=>!o[4]&&Math.floor(o[3])===Math.floor(t)&&o[3]<=t).sort((a,b)=>a[3]-b[3]||a[1]-b[1]||a[0]-b[0]);
                return slots.length===trace.retireWidth&&JSON.stringify(slots.filter(s=>s.id!==null).map(s=>s.id))===JSON.stringify(committed.map(o=>o[0]))
                    &&slots.every(s=>s.outlet[0]>s.inlet[0]&&s.outlet[2]===s.inlet[2]);
            });
            const feedMatches=checkpoints.every(t=>{
                sonata.captureAt(t);
                const feed=sonata.instructionFeed;
                const event=sonata.codeRewind;
                return feed.length<=48 && new Set(feed.map(row=>row.layer+':'+row.id)).size===feed.length && feed.every(row=>{
                    const source=trace.ops.find(op=>op[0]===row.id);
                    return source && row.label===source[5] && row.fetch===source[2] && row.position.every(Number.isFinite)
                        && (row.layer==='fetch'?row.fetch>t:event.time!==null)
                        && (!row.canceled || source[4]&&(source[11]??source[3])===event.time);
                });
            });
            const pipes=sonata.executionPipes;
            const links=sonata.connections;
            const linkGeometry=links.every(link=>link.lineCount>0
                &&link.lanes.every(lane=>[...lane.source,...lane.target].every(Number.isFinite)&&lane.target[0]>lane.source[0])
                &&new Set(link.lanes.map(lane=>JSON.stringify(lane))).size===link.lineCount);
            const pipeLinkCounts=trace.structure.executionNodes.every(node=>links.filter(l=>l.from===node.id||l.to===node.id).every(link=>{
                return link.lineCount===node.pipeCount&&link.lanes.every((lane,index)=>{
                    const pipe=pipes.find(p=>p.node===node.id&&p.index===index),port=link.from===node.id?lane.source:lane.target;
                    return port[1]===pipe.inlet[1]&&port[2]===pipe.inlet[2];
                });
            }))&&links.filter(l=>l.from==='rob'&&l.to==='commit'||l.to==='output').every(l=>l.lineCount===trace.retireWidth)
                &&links.filter(l=>l.to==='issue').every(l=>l.lineCount===trace.structure.allocationWidth);
            const schedulerOutputs=links.filter(l=>l.from==='issue').reduce((sum,l)=>sum+l.lineCount,0);
            if(schedulerOutputs!==pipes.length)throw new Error('Scheduler outputs must equal total execution pipes');
            const robTargets=links.filter(l=>l.to==='rob').flatMap(l=>l.lanes.map(p=>JSON.stringify(p.target)));
            if(new Set(robTargets).size!==robTargets.length)throw new Error('Execution pipes merged at a shared ROB input');
            const retireCounts=new Map();for(const op of trace.ops)if(!op[4]&&op[3]>=trace.firstCycle&&op[3]<trace.lastCycle+1){
                const c=Math.floor(op[3]);retireCounts.set(c,(retireCounts.get(c)||0)+1);
            }
            const retireLink=links.find(link=>link.from==='rob'&&link.to==='commit');
            const linkCounts=retireLink.peak===Math.max(...retireCounts.values())
                &&trace.structure.executionNodes.every(node=>{
                    const counts=new Map();for(const op of sonata.ops){
                        const stages=trace.structure.registerRead?op.stages.filter(s=>s.node.startsWith('exec')):[op.stages.find(s=>s.node.startsWith('exec'))];
                        for(const s of stages){
                        if(s?.node===node.id&&s.start<op.end&&s.start>=trace.firstCycle&&s.start<trace.lastCycle+1&&op.allocation!=null){
                            const c=Math.floor(s.start);counts.set(c,(counts.get(c)||0)+1);
                        }}
                    }
                    return links.find(link=>link.from===(trace.evidence?.registers?'register-read':'issue')&&link.to===node.id).peak===Math.max(0,...counts.values());
                });
            const pipeCount=pipes.length===trace.structure.executionNodes.reduce((sum,n)=>sum+n.pipeCount,0);
            const pipeAxes=pipes.every(p=>p.outlet[0]>p.inlet[0] && p.outlet[1]===p.inlet[1] && p.outlet[2]===p.inlet[2]);
            const pipeMotion=trace.structure.executionNodes.every(node=>{
                const op=sonata.ops.find(o=>o.stages.some(s=>s.node===node.id && s.start>=trace.firstCycle && s.end<=trace.lastCycle && s.end>s.start));
                if(!op)return false;
                const stage=op.stages.find(s=>s.node===node.id && s.start>=trace.firstCycle && s.end<=trace.lastCycle && s.end>s.start);
                const lane=pipes.find(p=>p.node===node.id && p.index===op.index%node.pipeCount);
                const positions=[.3,.6,.9].map(f=>{
                    sonata.captureAt(stage.start+(stage.end-stage.start)*f);
                    const particle=sonata.particles.find(p=>p.id===op.id);
                    return particle?.brightness>=1?particle.position:null;
                });
                return positions.every(p=>p && p[0]>=lane.inlet[0] && p[0]<=lane.outlet[0]
                    && Math.abs(p[1]-lane.inlet[1])<1e-6 && Math.abs(p[2]-lane.inlet[2])<1e-6)
                    && positions[0][0]<positions[1][0] && positions[1][0]<positions[2][0];
            });
            const lightContrast=['issue','memory-wait'].every(node=>{
                const op=sonata.ops.find(o=>o.stages.some(s=>s.node===node && s.start>=trace.firstCycle && s.end<=trace.lastCycle && s.end>s.start));
                if(!op)return true;
                const stage=op.stages.find(s=>s.node===node && s.start>=trace.firstCycle && s.end<=trace.lastCycle && s.end>s.start);
                sonata.captureAt((stage.start+stage.end)/2);
                const particle=sonata.particles.find(p=>p.id===op.id);
                return particle?.state==='waiting' && (node==='issue'?particle.brightness>=.4&&particle.brightness<=.6:particle.brightness<.35);
            });
            const sequenceColors=['integer','memory','branch'].every(kind=>{
                const op=sonata.ops.find(o=>o.kind===kind&&o.fetch>trace.firstCycle&&o.end< trace.lastCycle&&o.end>o.fetch+3);
                if(!op)return false;
                const target={integer:[.29,1,.81],memory:[1,.60,.22],branch:[.62,.43,1]}[kind];
                return [op.fetch+.1,Math.min(op.end-.1,op.fetch+3)].every(t=>{
                    sonata.captureAt(t);const p=sonata.particles.find(p=>p.id===op.id);
                    return p&&p.color.every((v,i)=>Math.abs(v-target[i])<1e-9);
                });
            });
            const matrixMatches=checkpoints.every(t=>{
                sonata.captureAt(t);const m=sonata.dependencyMatrix;
                return m.rowCount===trace.structure.queueCapacity&&m.columnCount===m.rowCount&&m.rows.length===sonata.stats.issue&&new Set(m.rows.map(r=>r.slot)).size===m.rows.length
                    &&m.rows.every(r=>r.slot>=0&&r.slot<trace.structure.queueCapacity)
                    &&m.cells.every(cell=>m.rows.some(r=>r.id===cell.producer&&r.slot===cell.column)&&cell.column>=0&&cell.column<m.columnCount&&m.rows.some(r=>r.id===cell.consumer&&r.slot===cell.row)
                        &&trace.evidence.scheduling.ops.find(o=>o.id===cell.consumer)?.dependencies.some(d=>d.id===cell.producer));
            });
            const topDownMatches=checkpoints.every(t=>{
                sonata.captureAt(t);const state=sonata.topDown;
                const hud=document.getElementById('bound-scene'),visual=sonata.topDownVisual;
                if(document.querySelector('.top-down-panel'))return false;
                if(!trace.topDown)return !state.available&&document.getElementById('bound-scene-status').textContent==='Not classified'
                    &&hud.dataset.bound==='unavailable'&&visual.region===null&&visual.rail.length===0&&document.getElementById('bound-scene-bar').hidden;
                return state.available&&state.cycles===8&&state.lastCycle===t&&state.firstCycle===t-8
                    &&Math.abs(Object.values(state.shares).reduce((sum,n)=>sum+n,0)-1)<1e-9
                    &&!document.getElementById('bound-scene-bar').hidden&&hud.dataset.bound===state.dominant
                    &&document.getElementById('bound-scene-share').textContent===(state.dominantShare*100).toFixed(1)+'%'
                    &&visual.rail.every(s=>s.share===state.shares[s.category])
                    &&Math.abs(visual.rail.reduce((sum,s)=>sum+s.share,0)-1)<1e-9;
            });
            sonata.captureAt(trace.demo.screenshotCycle);
            const renameWords=sonata.renameMapWords;
            if(renameWords.length!==32)throw new Error(sonata.trace.key+': rename table disappeared or lost an entry');
            for(const word of renameWords){
                const {start,end}=word.layout;
                if(start[0]!==end[0]||start[1]!==end[1]||end[2]<=start[2])throw new Error(sonata.trace.key+': rename entry is not perpendicular to instruction flow');
            }
            if(trace.evidence.registers.kind==='configuration'&&renameWords.some(w=>w.known||w.active||w.cells.some(c=>c.value!==null)))throw new Error('Unrecorded rename mappings were invented');
            const source = sonata.trace.ops, cycle = sonata.cycle;
            const active = source.filter(o => o[2] <= cycle && (o[4] ? o[11] ?? o[3] : o[3]) > cycle);
            const issue = active.filter(o => o[7] != null && cycle >= o[7] && cycle < (o[8] ?? (o[4] ? o[11] ?? o[3] : o[3])));
            const rob = active.filter(o => o[7] != null && cycle >= o[7]);
            const stats = sonata.stats;
            const fifo=sonata.rob;
            return {key: sonata.trace.key, matching,commitMatches, feedMatches, pipeCount, pipeAxes, pipeMotion, lightContrast, sequenceColors,matrixMatches,topDownMatches, linkGeometry,linkCounts,pipeLinkCounts,
                links:links.map(l=>({from:l.from,to:l.to,peak:l.peak,lines:l.lineCount})),stats, expected: {active: active.length, issue: issue.length, rob: rob.length},
                fifoMatches:fifo.entries.length===rob.length && fifo.entries.every((e,i)=>e.slot===(fifo.head+i)%fifo.capacity),
                simulator:document.getElementById('run-simulator').textContent,workload:document.getElementById('run-workload').textContent,
                labels: document.querySelectorAll('.stage-label').length, error: sonata.renderer.error,
                flushDisabled: document.getElementById('next-flush').disabled, flushes: sonata.flushEvents.length};
        })()`);
        assert.equal(result.stats.active, result.expected.active, `${key}: active occupancy`);
        assert.equal(result.matching,true,`${key}: checkpoint occupancy or particle positions`);
        assert.equal(result.commitMatches,true,`${key}: commit slots must match the actual in-order commit group`);
        assert.equal(result.feedMatches,true,`${key}: incoming stream must use actual upcoming trace instructions`);
        assert.equal(result.pipeCount,true,`${key}: execution pipe count`);
        assert.equal(result.pipeAxes,true,`${key}: pipes must run left to right`);
        assert.equal(result.pipeMotion,true,`${key}: instructions must move forward inside the displayed pipe`);
        assert.equal(result.linkGeometry,true,`${key}: connection lines are duplicated or do not join forward-facing ports`);
        assert.equal(result.linkCounts,true,`${key}: connection widths disagree with observed peak transfers`);
        assert.equal(result.pipeLinkCounts,true,`${key}: pipe label, line count or individual port alignment disagrees`);
        assert.equal(result.lightContrast,true,`${key}: waiting instructions must be dimmer than executing instructions`);
        assert.equal(result.sequenceColors,true,`${key}: instruction type colors must persist from fetch onward`);
        assert.equal(result.matrixMatches,true,`${key}: dependency matrix lost a queue entry or invented a dependency`);
        assert.equal(result.topDownMatches,true,`${key}: Top-down display must match the embedded analysis`);
        assert.equal(result.fifoMatches,true,`${key}: circular FIFO view`);
        if(key!=="memory-tide"){
            assert.match(result.simulator,/gem5 v25\.1\.0\.1/);assert.match(result.workload,/CoreMark/);
        }else{
            assert.match(result.simulator,/RSD processor/);
            assert.match(result.workload,/IntRegImm test/);
        }
        assert.equal(result.stats.issue, result.expected.issue, `${key}: issue occupancy`);
        assert.equal(result.stats.rob, result.expected.rob, `${key}: ROB occupancy`);
        assert.equal(result.error, 0, `${key}: WebGL error`);
        assert.ok(result.labels >= 8);
        assert.equal(result.flushDisabled, result.flushes === 0);
        results.push(result);
        await settle();
        fs.writeFileSync(path.join(screenshots,`sonata-${key}.png`),(await window.webContents.capturePage()).toPNG());
    }
    await js("sonata.loadTrace('branch-storm'); sonata.captureAt(sonata.trace.demo.screenshotCycle)");
    const feedBefore=await js("sonata.instructionFeed");
    assert.ok(feedBefore.length>0,"Incoming instruction ribbon is empty");
    await js("sonata.captureAt(sonata.trace.firstCycle+40); sonata.captureAt(sonata.trace.demo.screenshotCycle)");
    assert.deepEqual(await js("sonata.instructionFeed"),feedBefore,"Instruction stream changed after seeking backward");
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    assert.deepEqual(await js("sonata.instructionFeed"),[],"Instruction stream toggle did not hide the ribbon");
    assert.equal(await js("document.getElementById('instruction-stream-label').hidden"),true);
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    assert.deepEqual(await js("sonata.instructionFeed"),feedBefore,"Instruction stream did not return when enabled");
    await settle();
    fs.writeFileSync(path.join(screenshots, "sonata.png"), (await window.webContents.capturePage()).toPNG());
    const pick = await js(`(() => {
        const particles=sonata.particles;
        const p=particles.find(p=>particles.every(other=>other.id===p.id||Math.hypot(other.screen[0]-p.screen[0],other.screen[1]-p.screen[1])>18));
        const r=document.getElementById('scene').getBoundingClientRect();
        return {id:p.id,x:Math.round(r.left+p.screen[0]),y:Math.round(r.top+p.screen[1])};
    })()`);
    window.webContents.sendInputEvent({type:"mouseDown",x:pick.x,y:pick.y,button:"left",clickCount:1});
    window.webContents.sendInputEvent({type:"mouseUp",x:pick.x,y:pick.y,button:"left",clickCount:1});
    await waitFor(`document.getElementById('op-id').textContent==='#${pick.id}'`,"Particle selection did not reach the UI");
    assert.equal(await js("document.getElementById('op-id').textContent"), `#${pick.id}`, "Particle picking failed");
    assert.equal(await js("document.getElementById('unpin').hidden"), false);
    await js("document.getElementById('unpin').click(); sonata.setPlaying(true)");
    const playbackStart=await js("sonata.cycle");
    await delay(450);
    const playbackEnd=await js("sonata.cycle");
    assert.ok(playbackEnd>playbackStart, "Playback clock did not advance");
    await js("sonata.setPlaying(false)");
    const paused=await js("sonata.cycle");
    await delay(200);
    assert.equal(await js("sonata.cycle"),paused,"Paused clock advanced");
    await js("sonata.captureAt(sonata.trace.firstCycle+3.4)");
    const controls = await js(`(() => {
        const el=id=>document.getElementById(id);
        const first=sonata.trace.firstCycle;
        el('next').click();const next=sonata.cycle;
        el('previous').click();const previous=sonata.cycle;
        el('timeline').value=first+30.25;el('timeline').dispatchEvent(new Event('input'));
        const seek=sonata.cycle;
        el('play').click();const playing=sonata.playing;el('play').click();
        el('show-highlight').click();
        const highlight=sonata.trace.demo.bookmarks.find(b=>b.cycle>first+31.25).cycle;
        const highlightJump=sonata.playing && sonata.cycle===highlight-2;
        sonata.captureAt(sonata.flushEvents[0]+.7);
        const flushVisible=el('flush-alert').classList.contains('visible');
        return {first,next,previous,seek,playing,highlightJump,flushVisible,flushText:el('flush-detail').textContent};
    })()`);
    assert.equal(controls.next, controls.first+4);assert.equal(controls.previous, controls.first+3);
    assert.equal(controls.seek, controls.first+30.25);assert.equal(controls.playing, true);assert.equal(controls.flushVisible, true);
    assert.equal(controls.highlightJump,true,"Scene highlight did not jump and play");
    await settle();
    fs.writeFileSync(path.join(screenshots, "sonata-flush.png"), (await window.webContents.capturePage()).toPNG());
    const rewind=await js(`(() => {
        const t=sonata.flushEvents[0];
        sonata.captureAt(t-.01);const before=sonata.codeRewind.phase;
        sonata.captureAt(t+.2);const early=sonata.instructionFeed;
        sonata.captureAt(t+.6);const later=sonata.instructionFeed,peak=sonata.codeRewind;
        const shared=later.find(row=>row.canceled&&early.some(first=>first.id===row.id));
        const reversed=!!shared&&shared.progress<early.find(row=>row.id===shared.id).progress;
        const canceled=later.filter(row=>row.canceled).length;
        const label=document.getElementById('instruction-stream-label').textContent;
        sonata.captureAt(t+3.1);const refill=sonata.codeRewind.phase;
        sonata.captureAt(t+sonataReplay.codeRewindDuration);const finished=sonata.codeRewind.phase;
        sonata.captureAt(t+.6);const restored=JSON.stringify(sonata.instructionFeed)===JSON.stringify(later);
        return {before,reversed,canceled,label,refill,finished,restored,count:peak.count,cycle:sonata.cycle,time:t};
    })()`);
    assert.equal(rewind.before,"flow");assert.equal(rewind.reversed,true,"Code rows did not scroll backward");
    assert.ok(rewind.canceled>0);assert.match(rewind.label,/CODE REWIND/);
    assert.equal(rewind.refill,"refill");assert.equal(rewind.finished,"flow");assert.equal(rewind.restored,true);
    assert.equal(rewind.cycle,rewind.time+.6,"Visual rewind changed processor time");
    const held=await js("sonata.instructionFeed");await settle();
    assert.deepEqual(await js("sonata.instructionFeed"),held,"Paused code rewind moved");
    fs.writeFileSync(path.join(screenshots,"sonata-code-rewind.png"),(await window.webContents.capturePage()).toPNG());
    const unravel=await js(`sonata.flushEvents.map(t=>{
        sonata.captureAt(t+2.1);
        const glyphs=sonata.codeFragments,ids=new Set(sonata.codeRewind.ids);
        sonata.captureAt(t+1.5);const earlier=sonata.codeFragments;
        const fading=glyphs.every(g=>{const old=earlier.find(e=>e.id===g.id&&e.index===g.index);return !old||g.opacity<old.opacity&&g.travel>old.travel;});
        sonata.captureAt(t+2.1);
        const r=document.getElementById('scene').getBoundingClientRect();
        const visible=glyphs.filter(g=>g.opacity>.2 && g.screen[2]>0
            && g.screen[0]>0 && g.screen[0]<r.width && g.screen[1]>0 && g.screen[1]<r.height
            && Math.hypot(g.screen[0]-g.originScreen[0],g.screen[1]-g.originScreen[1])>15).length;
        return {time:t,glyphs:glyphs.length,visible,fading,correct:glyphs.every(g=>ids.has(g.id)&&g.position.every(Number.isFinite)),
            label:document.getElementById('instruction-stream-label').textContent};
    })`);
    for(const event of unravel){
        assert.equal(event.fading,true,"Detached letters must fade while they travel");
        assert.equal(event.correct,true,"Detached glyphs must come from this flush's actual canceled instructions");
        assert.ok(event.visible>40 && event.visible>event.glyphs*.4,"Canceled glyphs vanished before visibly separating");
        assert.match(event.label,/CODE UNRAVEL/);
    }
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    const fragments=await js("sonata.codeFragments");await settle();
    assert.deepEqual(await js("sonata.codeFragments"),fragments,"Paused unraveling letters moved");
    fs.writeFileSync(path.join(screenshots,"sonata-code-unravel.png"),(await window.webContents.capturePage()).toPNG());
    await js("sonata.captureAt(sonata.flushEvents[0]+sonataReplay.codeRewindDuration)");
    assert.deepEqual(await js("sonata.codeFragments"),[],"Detached letters remained after refill");
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    assert.deepEqual(await js("sonata.codeFragments"),fragments,"Seeking did not restore identical unraveling letters");
    const recovery=await js(`new Promise((resolve,reject)=>{
        const event=sonata.flushEvents[0],frames=[];
        sonata.captureAt(event+3.5);sonata.setPlaying(true);const deadline=performance.now()+12000;
        function frame(){
            const age=sonata.cycle-event;
            frames.push({age,...sonata.playbackStep});
            if(age>=5.55){sonata.setPlaying(false);resolve(frames);}
            else if(performance.now()>deadline)reject(new Error('Flush recovery did not complete'));
            else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    })`);
    const recoveryFrames=recovery.filter(f=>f.age>3.55);
    assert.ok(recoveryFrames.length>=5,'Not enough frames to inspect flush recovery');
    for(let i=1;i<recoveryFrames.length;i++){
        const a=recoveryFrames[i-1],b=recoveryFrames[i];
        assert.ok(b.rate>=a.rate-1e-5&&b.rate<=1.000001,'Recovery speed regressed or overshot');
        assert.ok(b.rate-a.rate<.15,'Flush recovery still has an abrupt speed jump');
        assert.ok(b.cycles<=b.seconds*4+.000001,'A recovery frame jumped over elapsed processor time');
    }
    assert.ok(recoveryFrames.some(f=>f.age>=4&&f.age<4.4&&f.rate<.8),'Speed snapped to normal at the end of code rewind');
    assert.ok(recoveryFrames.at(-1).rate>.98,'Normal speed did not return');
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    assert.deepEqual(await js("sonata.codeFragments"),[],"Stream toggle left detached letters visible");
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    await js("sonata.setCamera('cinema'); sonata.loadTrace('wide-open'); sonata.captureAt(sonata.trace.demo.screenshotCycle)");
    await delay(1100);
    assert.equal(await js("getComputedStyle(document.getElementById('bound-scene')).display!=='none'"),true,"Cinema hid the main Top-down readout");
    fs.writeFileSync(path.join(screenshots, "sonata-cinema.png"), (await window.webContents.capturePage()).toPNG());
    await js("sonata.setCamera('plan')");
    await delay(1100);
    assert.equal(await js("document.querySelector('[data-view=plan]').getAttribute('aria-pressed')"), "true");
    fs.writeFileSync(path.join(screenshots, "sonata-plan.png"), (await window.webContents.capturePage()).toPNG());
    await js("sonata.setCamera('orbit'); sonata.loadTrace('memory-tide'); sonata.captureAt(sonata.trace.demo.screenshotCycle)");
    await delay(1100);
    fs.writeFileSync(path.join(screenshots, "sonata-memory.png"), (await window.webContents.capturePage()).toPNG());
    const notification = await js(`(() => {
        const event=sonata.memoryReturns.find(e=>e.time>sonata.trace.firstCycle+5&&e.time<sonata.trace.lastCycle-5);
        sonata.captureAt(event.time-.01);
        const before=sonata.notifications.some(e=>e.id===event.id);
        sonata.captureAt(event.time+.6);
        const flight=sonata.notifications.find(e=>e.id===event.id)?.phase;
        const notice=!document.getElementById('memory-notice').hidden;
        sonata.captureAt(event.time+1.3);
        const arrived=sonata.notifications.find(e=>e.id===event.id)?.phase;
        sonata.captureAt(event.time+2.9);
        const expired=!sonata.notifications.some(e=>e.id===event.id);
        sonata.captureAt(event.time+.6);
        return {id:event.id,time:event.time,before,flight,arrived,notice,expired};
    })()`);
    assert.equal(notification.before,false);assert.equal(notification.flight,"flight");
    assert.equal(notification.arrived,"arrived");assert.equal(notification.notice,true);assert.equal(notification.expired,true);
    await delay(200);
    fs.writeFileSync(path.join(screenshots,"sonata-memory-return.png"),(await window.webContents.capturePage()).toPNG());
    const rsd=await js(`(()=>{
        const t=sonata.trace,cache=t.demo.events.find(e=>e.kind==='dcache-miss'),branch=t.demo.events.find(e=>e.kind==='branch-mispredict');
        sonata.captureAt(cache.cycle+.4);
        const cacheVisible=document.getElementById('trace-event-notice').textContent.includes('D-CACHE MISS');
        sonata.captureAt(branch.cycle+.4);
        const branchVisible=document.getElementById('trace-event-notice').textContent.includes('BRANCH MISPREDICTION');
        sonata.captureAt(sonata.flushEvents[0]+.6);
        return {cache,branch,cacheVisible,branchVisible,flushVisible:document.getElementById('flush-alert').classList.contains('visible'),
            rewind:sonata.codeRewind.phase,canceled:sonata.instructionFeed.filter(r=>r.canceled).length};
    })()`);
    assert.equal(rsd.cacheVisible,true);assert.equal(rsd.branchVisible,true);assert.equal(rsd.flushVisible,true);
    assert.equal(rsd.rewind,'rewind');assert.ok(rsd.canceled>0);
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-rsd-mispredict.png"),(await window.webContents.capturePage()).toPNG());
    await js("sonata.captureAt(sonata.trace.demo.events.find(e=>e.kind==='dcache-miss').cycle+.4)");
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-rsd-cache-miss.png"),(await window.webContents.capturePage()).toPNG());
    const branchReview=await js(`(()=>{
        return [4066.2,4068.2,4070.2].map(t=>{
            sonata.captureAt(t);const p=sonata.particles.find(p=>p.id===4454),b=sonata.recoveryBranches.find(e=>e.id===4454);
            return {time:t,present:!!p,bright:p?.brightness>=1,inROB:sonata.rob.entries.some(e=>e.id===4454),
                canceled:sonata.codeRewind.ids.includes(4454),recorded:b?.inferred===false,
                marker:document.getElementById('recovery-branch').textContent,visible:!document.getElementById('recovery-branch').hidden};
        });
    })()`);
    for(const b of branchReview){
        assert.ok(b.present&&b.bright&&b.inROB&&b.recorded&&b.visible);
        assert.equal(b.canceled,false);assert.match(b.marker,b.time<4067?/MISPREDICT #4454.*BRANCH.*PRESERVED/:/MISPREDICT #4454.*ROB.*PRESERVED/);
    }
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-branch-preserved.png"),(await window.webContents.capturePage()).toPNG());
    const matrixReview=await js(`(()=>{
        const t=sonata.trace;let best={cycle:t.firstCycle,cells:0,internal:0},issueBest={cycle:t.firstCycle,score:0};
        for(let c=t.firstCycle;c<=t.lastCycle;c++){
            sonata.captureAt(c+.2);const m=sonata.dependencyMatrix;
            if(m.cells.length+m.external.length>best.cells)best={cycle:c+.2,cells:m.cells.length+m.external.length,internal:m.cells.length};
            const columns=m.issues.filter(i=>i.column!==null).length,score=m.cells.length+columns*2;
            if(columns&&score>issueBest.score)issueBest={cycle:c+.42,score};
        }
        sonata.captureAt(best.cycle);const before=JSON.stringify(sonata.dependencyMatrix);
        sonata.captureAt(t.lastCycle);sonata.captureAt(best.cycle);
        return {...best,issueCycle:issueBest.cycle,restored:before===JSON.stringify(sonata.dependencyMatrix)};
    })()`);
    assert.ok(matrixReview.cells>5);assert.equal(matrixReview.restored,true);
    assert.equal(await js("getComputedStyle(document.getElementById('flush-alert')).opacity"),'0','Seeking retained a notice from a future flush');
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-dependency-matrix.png"),(await window.webContents.capturePage()).toPNG());
    const registerReview=await js(`(()=>{
        sonata.captureAt(4067.9);const before=sonata.registers;
        sonata.captureAt(4068.2);const after=sonata.registers;
        sonata.captureAt(4013.9);const pending=sonata.registers.lastWrite;
        sonata.captureAt(4014);const write=sonata.registers.lastWrite;
        sonata.captureAt(4068.2);
        const focus=rows=>rows.filter(r=>[12,13,15].includes(r.logical));
        return {before:focus(before.rows).map(r=>[r.logical,r.physical]),after:focus(after.rows).map(r=>[r.logical,r.physical]),
            changed:focus(after.rows).every(r=>r.event?.type==='restore'),write,pending,restored:JSON.stringify(after)===JSON.stringify(sonata.registers),
            words:sonata.renameMapWords,table:!!document.getElementById('rename-map'),
            physical:after.physical.length,layout:sonata.registerLayout,
            physicalLabels:document.querySelectorAll('.physical-register-id').length,
            robLabel:[...document.querySelectorAll('.stage-label strong')].some(e=>e.textContent==='REORDER BUFFER')};
    })()`);
    assert.notDeepEqual(registerReview.before,registerReview.after);
    assert.deepEqual(registerReview.after,[[12,7],[13,11],[15,8]]);assert.equal(registerReview.changed,true);
    assert.equal(registerReview.restored,true);assert.equal(registerReview.words.length,32);assert.equal(registerReview.table,false);
    assert.ok(registerReview.words.filter(r=>[12,13,15].includes(r.logical)).every(r=>r.restoring&&r.active&&r.progress>0&&r.progress<1));
    assert.equal(registerReview.write.cycle,4014);assert.notEqual(registerReview.pending.cycle,4014);
    assert.equal(registerReview.physical,41);assert.equal(registerReview.physicalLabels,41);
    assert.equal(registerReview.layout.renameNode,'front-4');assert.equal(registerReview.layout.physicalNode,'register-read');
    assert.ok(registerReview.layout.renamePosition[0]<Math.min(...registerReview.layout.cells.map(c=>c.position[0])));
    assert.equal(new Set(registerReview.layout.cells.map(c=>JSON.stringify(c.position))).size,41);
    assert.equal(registerReview.robLabel,true);
    const renameWordReview=await js(`(()=>{
        const result=[];
        for(const key of ['memory-tide','rename-rush','x86-recovery']){
            sonata.loadTrace(key);
            const events=sonata.trace.evidence.registers.events;
            for(const type of ['rename','restore']){
                const e=events.find(e=>e.type===type&&e.previous!==e.physical&&e.cycle<sonata.trace.lastCycle-1);
                sonata.captureAt(e.cycle+.15);const first=sonata.renameMapWords.find(r=>r.logical===e.logical);
                sonata.captureAt(e.cycle+.55);const second=sonata.renameMapWords.find(r=>r.logical===e.logical);
                sonata.captureAt(e.cycle+.85);const settled=sonata.renameMapWords;
                result.push({key,type,first,second,settled,rows:sonata.registers.rows});
            }
        }
        sonata.loadTrace('memory-tide');sonata.captureAt(4068.2);
        return result;
    })()`);
    for(const r of renameWordReview){
        assert.ok(r.first.progress<r.second.progress,'Rename word update should sweep smoothly through the cells');
        for(const word of r.settled){
            const row=r.rows.find(row=>row.logical===word.logical);
            if(word.constant||!word.known)assert.ok(word.cells.every(c=>c.value===null));
            else assert.equal(word.cells.reduce((value,cell)=>(value<<1)|cell.value,0),row.physical,'RAT word does not encode the recorded physical destination');
        }
    }
    const registerReadReview=await js(`(()=>{
        const result=[3990.5,4010.5].map(t=>{
            sonata.captureAt(t);const r=sonata.registerReads.find(r=>r.id===4355),p=sonata.particles.find(p=>p.id===4355);
            return {time:t,sources:r?.sources,state:p?.state,port:r?.port};
        });
        sonata.captureAt(4011.5);const executing=sonata.particles.find(p=>p.id===4355);
        sonata.captureAt(4014.5);const notice=sonata.notifications.find(n=>n.id===4355);
        sonata.captureAt(4068.2);
        return {result,executing:executing?.state,notice};
    })()`);
    for(const read of registerReadReview.result){assert.equal(read.state,'reading');assert.equal(read.sources.length,1);assert.equal(read.sources[0].logical,15);}
    assert.equal(registerReadReview.executing,'executing');
    assert.ok(registerReadReview.notice.target[2]<-1.6,'Memory notification must land outside the matrix, on its wake-up bus');
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-rename-restore.png"),(await window.webContents.capturePage()).toPNG());
    const issueReview=await js(`(()=>{
        sonata.captureAt(${matrixReview.issueCycle});
        const path=sonata.issuePaths.find(p=>p.column!==null);
        if(!path)throw new Error('No visible issue column pulse');
        return path;
    })()`);
    assert.ok(issueReview.exit[0]>issueReview.origin[0]);
    assert.equal(issueReview.origin[2],issueReview.exit[2],'Issued instruction must cross its waiting row');
    assert.deepEqual(issueReview.signal[0],issueReview.exit,'Issue column signal must start at the right-hand exit');
    assert.equal(issueReview.signal[1][0],issueReview.exit[0]);
    assert.ok(issueReview.signal[2][2]>issueReview.signal[3][2],'Issue signal must enter its column from the right-side return path');
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-issue-column.png"),(await window.webContents.capturePage()).toPNG());
    const readColors=await js(`(()=>{
        return ['integer','memory','branch'].map(kind=>{
            const op=sonata.ops.find(o=>o.kind===kind&&o.sourceRegisters.length&&o.reads.some(r=>r.start>=sonata.trace.firstCycle&&r.end<sonata.trace.lastCycle));
            const read=op.reads.find(r=>r.start>=sonata.trace.firstCycle&&r.end<sonata.trace.lastCycle);
            sonata.captureAt(read.start+.5);
            const r=sonata.registerReads.find(r=>r.id===op.id);
            return {kind,color:r.color,cells:sonata.registerReadCells.filter(c=>c.readers[0]===op.id)};
        });
    })()`);
    assert.equal(new Set(readColors.map(r=>JSON.stringify(r.color))).size,3,'Register reads retained a single fixed color');
    for(const read of readColors){assert.ok(read.cells.length);for(const cell of read.cells)assert.deepEqual(cell.color,read.color);}
    const gem5RegisterReview=await js(`(()=>{
        return ['branch-storm','rename-rush','x86-recovery'].map(key=>{
            sonata.loadTrace(key);const data=sonata.trace.evidence.registers;
            const read=data.reads.find(r=>sonata.ops.some(o=>o.id===r.id&&o.end>r.cycle+.1));
            const t=read?read.cycle+.1:sonata.trace.firstCycle;
            sonata.captureAt(t);const before=JSON.stringify(sonata.registers),state=sonata.registers;
            const active=sonata.registerReads;
            sonata.captureAt(sonata.trace.lastCycle);sonata.captureAt(t);
            return {key,kind:data.kind,physical:state.physical.length,known:state.physical.filter(p=>p.value!==null).length,
                read,active,restored:before===JSON.stringify(sonata.registers),write:state.lastWrite,
                cells:new Set(sonata.registerLayout.cells.map(c=>JSON.stringify(c.position))).size,
                label:document.getElementById('register-writeback').textContent,
                allocation:state.allocationCounts,allocationLabel:document.getElementById('register-allocation').textContent,
                allocationCells:sonata.registerAllocationCells};
        });
    })()`);
    for(const r of gem5RegisterReview){
        assert.equal(r.physical,256);assert.equal(r.cells,256);assert.equal(r.restored,true);
        if(r.kind==='configuration'){assert.equal(r.known,0);assert.equal(r.active.length,0);assert.match(r.label,/VALUES NOT LOGGED/);}
        else{assert.ok(r.known>100);assert.ok(r.active.some(a=>a.id===r.read.id&&a.sources.some(s=>s.physical===r.read.physical)));assert.ok(r.write);}
        assert.equal(Object.values(r.allocation).reduce((n,v)=>n+v,0),256);
        assert.ok(r.allocationLabel.includes(`ALLOC ${r.allocation.allocated}`)&&r.allocationLabel.includes(`FREE ${r.allocation.free}`));
        if(r.kind==='configuration')assert.equal(r.allocation.unknown,256);
        else{
            const filled=r.allocationCells.filter(c=>c.state==='allocated'),empty=r.allocationCells.filter(c=>c.state==='free'&&c.fill===0);
            assert.ok(filled.length>0&&empty.length>0);
            assert.ok(filled.every(c=>c.fill>0&&c.outline>empty[0].outline),'Allocated cells need a stronger fill and outline than free cells');
        }
    }
    const bounds=await js(`(()=>{
        sonata.loadTrace('branch-storm');const t=sonata.trace,states=[];
        for(let c=t.firstCycle;c<=t.lastCycle;c++){
            sonata.captureAt(c);const s=sonata.topDown;
            if(!states.some(e=>e.dominant===s.dominant))states.push({cycle:c,dominant:s.dominant,label:document.getElementById('bound-scene-status').textContent});
        }
        const first=states[0];sonata.captureAt(first.cycle);const before=JSON.stringify([sonata.topDown,sonata.topDownVisual]);
        sonata.captureAt(t.lastCycle);sonata.captureAt(first.cycle);
        return {states,restored:before===JSON.stringify([sonata.topDown,sonata.topDownVisual])};
    })()`);
    for(const key of ['backend','frontend','badSpeculation','active'])assert.ok(bounds.states.some(s=>s.dominant===key));
    assert.equal(bounds.restored,true,'Top-down analysis changed after seeking backwards');
    const causalReview=await js(`(()=>{
        sonata.loadTrace('branch-storm');const flush=sonata.flushEvents[0],samples=[];
        for(const t of [flush-.5,flush-.1,flush,flush+.5]){
            sonata.captureAt(t);samples.push({time:t,shares:sonata.topDown.shares,start:sonata.topDown.firstCycle,end:sonata.topDown.lastCycle});
        }
        sonata.captureAt(flush-.1);const rewind=sonata.topDown.shares;
        return {flush,samples,rewind};
    })()`);
    assert.ok(causalReview.samples.slice(0,2).every(s=>s.shares.badSpeculation===0));
    assert.ok(causalReview.samples[2].shares.badSpeculation>0);
    assert.equal(causalReview.rewind.badSpeculation,0,'Seeking backward left future squash evidence visible');
    assert.ok(causalReview.samples.every(s=>s.start===s.time-8&&s.end===s.time));
    for(const phase of ['before','after']){
        await js(`sonata.captureAt(${causalReview.flush+(phase==='before'?-.1:.5)})`);await settle();
        fs.writeFileSync(path.join(screenshots,`sonata-top-down-${phase}-flush.png`),(await window.webContents.capturePage()).toPNG());
    }
    const heldBound=await js("sonata.topDown");await settle();assert.deepEqual(await js("sonata.topDown"),heldBound);
    fs.writeFileSync(path.join(screenshots,"sonata-top-down.png"),(await window.webContents.capturePage()).toPNG());
    for(const state of bounds.states.filter(s=>['backend','frontend','badSpeculation','active'].includes(s.dominant))){
        await js(`sonata.captureAt(${state.cycle})`);await settle();
        const layout=await js(`(()=>{
            const hud=document.getElementById('bound-scene'),r=hud.getBoundingClientRect(),w=document.getElementById('world').getBoundingClientRect();
            const region=sonata.topDownVisual.region;
            return {inside:r.left>=w.left&&r.right<=w.right&&r.top>=w.top&&r.bottom<=w.bottom,
                readable:parseFloat(getComputedStyle(document.getElementById('bound-scene-status')).fontSize)>=20&&parseFloat(getComputedStyle(document.getElementById('bound-scene-status')).fontSize)<=28,
                category:region?.category,bounds:region?.bounds};
        })()`);
        assert.equal(layout.inside,true);assert.equal(layout.readable,true);assert.equal(layout.category,state.dominant);
        if(state.dominant==='frontend')assert.ok(layout.bounds[1]<0,'Frontend emphasis spread into the backend');
        if(state.dominant==='backend')assert.ok(layout.bounds[0]>-6,'Backend emphasis spread into the frontend');
        fs.writeFileSync(path.join(screenshots,`sonata-top-down-${state.dominant}.png`),(await window.webContents.capturePage()).toPNG());
    }
    const boundMotion=await js(`new Promise((resolve,reject)=>{
        const candidate=${bounds.states.find(s=>s.dominant==='active').cycle},samples=[];
        let transition=candidate;
        for(let c=candidate-1;c<=candidate;c+=.02){
            if(sonataReplay.sampleTopDown(sonata.trace.topDown,c).dominant==='active'){transition=c;break;}
        }
        const speed=document.getElementById('speed');speed.value='1';speed.dispatchEvent(new Event('change'));
        sonata.captureAt(transition-.15);const before=sonata.topDownVisual;
        sonata.setPlaying(true);const deadline=performance.now()+10000;
        function frame(){
            const c=sonata.cycle;
            if(c>=transition){
                const actual=sonata.topDown,visual=sonata.topDownVisual;
                samples.push({cycle:c,actual:actual.shares,visual:visual.shares,weights:visual.weights,
                    bar:parseFloat(document.querySelector('#bound-scene-bar [data-bound=inFlight]').style.width)/100});
            }
            if(c>=transition+.7){
                sonata.setPlaying(false);
                setTimeout(()=>resolve({before,samples,settled:{actual:sonata.topDown.shares,visual:sonata.topDownVisual.shares}}),850);
            }else if(performance.now()>deadline)reject(new Error('Top-down animation did not advance'));
            else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    })`);
    assert.ok(boundMotion.samples.length>=3,'Top-down animation had too few frames');
    const intermediate=boundMotion.samples.filter(s=>Math.abs(s.visual.inFlight-s.actual.inFlight)>1e-4
        &&Math.abs(s.visual.inFlight-boundMotion.before.shares.inFlight)>1e-4);
    assert.ok(intermediate.length>=2,'Top-down shares jumped directly to the next analysis result');
    assert.ok(intermediate.some(s=>s.weights.backend>0&&s.weights.active>0),'Region emphasis did not crossfade');
    for(const sample of boundMotion.samples){
        assert.ok(Math.abs(Object.values(sample.visual).reduce((sum,v)=>sum+v,0)-1)<1e-9);
        assert.ok(Math.abs(sample.bar-sample.visual.inFlight)<1e-6,'HUD and board animation diverged');
        for(const key of Object.keys(sample.actual))assert.ok(sample.visual[key]>=Math.min(sample.actual[key],boundMotion.before.shares[key])-1e-4
            &&sample.visual[key]<=Math.max(sample.actual[key],boundMotion.before.shares[key])+1e-4,'Top-down animation overshot the analysis');
    }
    assert.ok(Math.abs(boundMotion.settled.visual.inFlight-boundMotion.settled.actual.inFlight)<.002,'Top-down animation did not settle');
    await js("document.getElementById('speed').value='4';document.getElementById('speed').dispatchEvent(new Event('change'))");
    await js("sonata.loadTrace('memory-tide');sonata.captureAt(sonata.trace.demo.screenshotCycle)");
    await js("document.getElementById('run-details').open=true");
    assert.match(await js("document.getElementById('run-file').textContent"),/mshr\.log/);
    await js("document.getElementById('run-details').open=false");
    const mobile=await require("./check-mobile.cjs")(window,screenshots);
    // 動きを減らす設定を有効にし、CODE SQUASH だけが表示される状態を再現する。
    window.setSize(1440,1000);
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await window.loadFile(entry);
    assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"),true);
    assert.equal(await js("sonata.playing"),false,"Reduced motion must remain the default until explicitly enabled");
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    assert.equal(await js("sonata.codeRewind.phase"),"notice");
    assert.deepEqual(await js("sonata.codeFragments"),[]);
    assert.equal(await js("document.getElementById('motion-notice').hidden"),false);
    const reducedBound=await js(`new Promise(resolve=>{
        sonata.captureAt(sonata.trace.firstCycle+2.95);sonata.setPlaying(true);
        function frame(){if(sonata.cycle>=sonata.trace.firstCycle+3.1){
            sonata.setPlaying(false);resolve({actual:sonata.topDown.shares,visual:sonata.topDownVisual.shares});
        }else requestAnimationFrame(frame);}requestAnimationFrame(frame);
    })`);
    assert.deepEqual(reducedBound.visual,reducedBound.actual,'Reduced motion smoothed Top-down values');
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-reduced-motion.png"),(await window.webContents.capturePage()).toPNG());
    const enable=await js(`(()=>{const button=document.getElementById('enable-animation'),r=button.getBoundingClientRect();
        const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
        return {x,y,reachable:document.elementFromPoint(x,y)===button};})()`);
    assert.equal(enable.reachable,true,"Enable animation button is covered by the scene");
    window.webContents.sendInputEvent({type:"mouseDown",x:enable.x,y:enable.y,button:"left",clickCount:1});
    window.webContents.sendInputEvent({type:"mouseUp",x:enable.x,y:enable.y,button:"left",clickCount:1});
    await waitFor("sonata.playing && document.getElementById('motion-notice').hidden","Enable animation did not resume playback");
    await js(`new Promise((resolve,reject)=>{
        const deadline=performance.now()+15000;
        function frame(){
            if(sonata.codeRewind.phase==='discard' && sonata.codeRewind.age>=2.1){
                sonata.setPlaying(false);sonata.setCycle(sonata.cycle);resolve();
            }else if(performance.now()>deadline)reject(new Error('Enabled animation did not reach unravel'));
            else requestAnimationFrame(frame);
        }
        frame();
    })`);
    const motion=await js(`({systemReduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        enabled:document.getElementById('motion-effects').getAttribute('aria-pressed'),
        phase:sonata.codeRewind.phase,glyphs:sonata.codeFragments.length})`);
    assert.equal(motion.systemReduced,true,"The page must only override its own effects");
    assert.equal(motion.enabled,"true");assert.equal(motion.phase,"discard");assert.ok(motion.glyphs>40);
    await settle();
    fs.writeFileSync(path.join(screenshots,"sonata-motion-enabled.png"),(await window.webContents.capturePage()).toPNG());
    await js("document.getElementById('motion-effects').click()");
    assert.equal(await js("sonata.codeRewind.phase"),"notice");
    assert.deepEqual(await js("sonata.codeFragments"),[],"Disabling motion left unraveling letters visible");
    await js("document.getElementById('motion-effects').click()");
    assert.ok(await js("sonata.codeFragments.length>40"),"Motion toggle did not restore the code animation");
    window.webContents.debugger.detach();
    assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
    assert.deepEqual(unexpectedRequests,[],"The copied HTML tried to fetch another resource");
    console.log(JSON.stringify({samples: results, controls, rewind, unravel,branchReview,matrixReview,registerReview,registerReadReview,recovery:{frames:recoveryFrames.length,rates:recoveryFrames.map(f=>({age:f.age,rate:f.rate}))},notification, rsd, bounds,
        boundMotion:{frames:boundMotion.samples.length,intermediate:intermediate.length,reducedMotionExact:true},motion,particlePicked:pick.id,playbackAdvance:playbackEnd-playbackStart,mobile,errors,standalone:{isolated:true,externalRequests:unexpectedRequests}}, null, 2));
    fs.rmSync(isolated,{recursive:true,force:true});
    app.quit();
}).catch(error => {console.error(error);fs.rmSync(isolated,{recursive:true,force:true});app.exit(1);});

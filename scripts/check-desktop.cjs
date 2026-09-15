"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBrowserTest, waitFor: waitUntil, delay, loadPage } = require("./load-test.cjs")("browser-test.cts");

// 全デモの表示とデスクトップ操作・フラッシュ演出を検査する。
module.exports = async function reviewDesktop(window, screenshots) {
    const js = (source) => window.webContents.executeJavaScript(source);
    const browserTest = createBrowserTest(window);
    const settle = () => browserTest.settle({ finish: true });
    const waitFor = (source, message) => waitUntil(() => js(source), message, { timeout: 5000, interval: 60 });
    assert.equal(await js("typeof sonata"), "object", "WebGL mockup did not initialize");
    assert.equal(
        await js("document.querySelectorAll('script[src],link[rel=stylesheet]').length"),
        0,
        "Deliverable has external code or styles"
    );
    await js("sonata.setPlaying(false); document.getElementById('auto-camera').click();");
    await js("document.getElementById('license-open').click()");
    assert.ok(
        await js(
            "document.getElementById('license-panel').open&&document.getElementById('license-text').textContent.includes('Embedded Microprocessor Benchmark Consortium')"
        ),
        "License notices are not readable from the app"
    );
    await settle();
    fs.writeFileSync(path.join(screenshots, "sonata-licenses.png"), (await window.webContents.capturePage()).toPNG());
    await js("document.querySelector('#license-panel button').click()");
    assert.ok(await js("!document.getElementById('license-panel').open"));
    const results = [];
    const keys = await js("sonataDemoCatalog.map(t => t.key)");
    assert.deepEqual(keys, ["branch-storm", "wide-open", "memory-tide", "rename-rush", "x86-recovery"]);
    for (const key of keys) {
        const result = await js(`(async () => {
            await sonata.loadTrace(${JSON.stringify(key)});
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
                    const preview=trace.feedPreview?.find(op=>op.id===row.id);
                    return (source||preview) && row.label===(source?.[5]??preview.label) && row.fetch===(source?.[2]??preview.fetch) && row.position.every(Number.isFinite)
                        && (row.layer==='fetch'?row.fetch>t:event.time!==null)
                        && (!row.canceled || source && source[4]&&(source[11]??source[3])===event.time);
                });
            });
            const pipes=sonata.executionPipes;
            const links=sonata.connections;
            const linkGeometry=links.every(link=>link.lineCount>0
                &&link.lanes.every(lane=>[...lane.source,...lane.target].every(Number.isFinite)&&lane.target[0]>lane.source[0])
                &&new Set(link.lanes.map(lane=>JSON.stringify(lane))).size===link.lineCount);
            const pipeLinkCounts=sonata.executionNodes.every(node=>links.filter(l=>l.from===node.id||l.to===node.id).every(link=>{
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
                &&sonata.executionNodes.every(node=>{
                    const counts=new Map();for(const op of sonata.ops){
                        const stages=trace.structure.registerRead?op.stages.filter(s=>s.node.startsWith('exec')):[op.stages.find(s=>s.node.startsWith('exec'))];
                        for(const s of stages){
                        if(s?.node===node.id&&s.start<op.end&&s.start>=trace.firstCycle&&s.start<trace.lastCycle+1&&op.allocation!=null){
                            const c=Math.floor(s.start);counts.set(c,(counts.get(c)||0)+1);
                        }}
                    }
                    return links.find(link=>link.from===(trace.evidence?.registers?'register-read':'issue')&&link.to===node.id).peak===Math.max(0,...counts.values());
                });
            const pipeCount=pipes.length===sonata.executionNodes.reduce((sum,n)=>sum+n.pipeCount,0);
            const pipeAxes=pipes.every(p=>p.outlet[0]>p.inlet[0] && p.outlet[1]===p.inlet[1] && p.outlet[2]===p.inlet[2]);
            const pipeMotion=sonata.executionNodes.every(node=>{
                const op=sonata.ops.find(o=>o.stages.some(s=>s.node===node.id && s.start>=trace.firstCycle && s.end<=trace.lastCycle && s.end>s.start));
                // ファイル全体の構造には、この表示窓で使われない管路も残る。
                if(!op)return !sonata.ops.some(o=>o.stages.some(s=>s.node===node.id&&s.start<trace.lastCycle&&s.end>trace.firstCycle));
                const stage=op.stages.find(s=>s.node===node.id && s.start>=trace.firstCycle && s.end<=trace.lastCycle && s.end>s.start);
                const lane=pipes.find(p=>p.node===node.id && p.index===(op.pipeLane??op.index)%node.pipeCount);
                const positions=[.3,.6,.9].map(f=>{
                    sonata.captureAt(stage.start+(stage.end-stage.start)*f);
                    const particle=sonata.particles.find(p=>p.id===op.id);
                    return particle?.brightness>=1?particle.position:null;
                });
                return positions.every(p=>p && p[0]>=lane.inlet[0] && p[0]<=lane.outlet[0]
                    && Math.abs(p[1]-lane.inlet[1])<1e-6 && Math.abs(p[2]-lane.inlet[2])<1e-6)
                    && positions[0][0]<positions[1][0] && positions[1][0]<positions[2][0];
            });
            const lightContrast=['issue','memory-wait','rob'].every(node=>{
                const matches=(s,o)=>s.node===node && (node!=='rob'||o.completion===null||s.end<=o.completion) && s.start>=trace.firstCycle && s.end<=trace.lastCycle && s.end>s.start;
                const op=sonata.ops.find(o=>o.stages.some(s=>matches(s,o)));
                if(!op)return true;
                const stage=op.stages.find(s=>matches(s,op));
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
        assert.equal(result.matching, true, `${key}: checkpoint occupancy or particle positions`);
        assert.equal(result.commitMatches, true, `${key}: commit slots must match the actual in-order commit group`);
        assert.equal(result.feedMatches, true, `${key}: incoming stream must use actual upcoming trace instructions`);
        assert.equal(result.pipeCount, true, `${key}: execution pipe count`);
        assert.equal(result.pipeAxes, true, `${key}: pipes must run left to right`);
        assert.equal(result.pipeMotion, true, `${key}: instructions must move forward inside the displayed pipe`);
        assert.equal(
            result.linkGeometry,
            true,
            `${key}: connection lines are duplicated or do not join forward-facing ports`
        );
        assert.equal(result.linkCounts, true, `${key}: connection widths disagree with observed peak transfers`);
        assert.equal(
            result.pipeLinkCounts,
            true,
            `${key}: pipe label, line count or individual port alignment disagrees`
        );
        assert.equal(
            result.lightContrast,
            true,
            `${key}: waiting instructions must be dimmer than executing instructions`
        );
        assert.equal(result.sequenceColors, true, `${key}: instruction type colors must persist from fetch onward`);
        assert.equal(
            result.matrixMatches,
            true,
            `${key}: dependency matrix lost a queue entry or invented a dependency`
        );
        assert.equal(result.topDownMatches, true, `${key}: Top-down display must match the window analysis`);
        assert.equal(result.fifoMatches, true, `${key}: circular FIFO view`);
        if (key !== "memory-tide") {
            assert.match(result.simulator, /gem5 v25\.1\.0\.1/);
            assert.match(result.workload, /CoreMark/);
        } else {
            assert.match(result.simulator, /RSD processor/);
            assert.match(result.workload, /IntRegImm test/);
        }
        assert.equal(result.stats.issue, result.expected.issue, `${key}: issue occupancy`);
        assert.equal(result.stats.rob, result.expected.rob, `${key}: ROB occupancy`);
        assert.equal(result.error, 0, `${key}: WebGL error`);
        assert.ok(result.labels >= 8);
        assert.equal(result.flushDisabled, result.flushes === 0);
        results.push(result);
        await settle();
        fs.writeFileSync(path.join(screenshots, `sonata-${key}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await js(
        "(async()=>{await sonata.loadTrace('branch-storm'); sonata.captureAt(sonata.trace.demo.screenshotCycle)})()"
    );
    const feedBefore = await js("sonata.instructionFeed");
    assert.ok(feedBefore.length > 0, "Incoming instruction ribbon is empty");
    await js("sonata.captureAt(sonata.trace.firstCycle+40); sonata.captureAt(sonata.trace.demo.screenshotCycle)");
    assert.deepEqual(
        await js("sonata.instructionFeed"),
        feedBefore,
        "Instruction stream changed after seeking backward"
    );
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    assert.deepEqual(await js("sonata.instructionFeed"), [], "Instruction stream toggle did not hide the ribbon");
    assert.equal(await js("document.getElementById('instruction-stream-label').hidden"), true);
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    assert.deepEqual(await js("sonata.instructionFeed"), feedBefore, "Instruction stream did not return when enabled");
    await settle();
    fs.writeFileSync(path.join(screenshots, "sonata.png"), (await window.webContents.capturePage()).toPNG());
    const pick = await js(`(() => {
        const particles=sonata.particles;
        const p=particles.find(p=>particles.every(other=>other.id===p.id||Math.hypot(other.screen[0]-p.screen[0],other.screen[1]-p.screen[1])>18));
        const r=document.getElementById('scene').getBoundingClientRect();
        return {id:p.id,x:Math.round(r.left+p.screen[0]),y:Math.round(r.top+p.screen[1])};
    })()`);
    window.webContents.sendInputEvent({ type: "mouseDown", x: pick.x, y: pick.y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: pick.x, y: pick.y, button: "left", clickCount: 1 });
    await waitFor(
        `document.getElementById('op-id').textContent==='#${pick.id}'`,
        "Particle selection did not reach the UI"
    );
    assert.equal(await js("document.getElementById('op-id').textContent"), `#${pick.id}`, "Particle picking failed");
    assert.equal(await js("document.getElementById('unpin').hidden"), false);
    await js("document.getElementById('unpin').click(); sonata.setPlaying(true)");
    const playbackStart = await js("sonata.cycle");
    await delay(450);
    const playbackEnd = await js("sonata.cycle");
    assert.ok(playbackEnd > playbackStart, "Playback clock did not advance");
    await js("sonata.setPlaying(false)");
    const paused = await js("sonata.cycle");
    await delay(200);
    assert.equal(await js("sonata.cycle"), paused, "Paused clock advanced");
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
    assert.equal(controls.next, controls.first + 4);
    assert.equal(controls.previous, controls.first + 3);
    assert.equal(controls.seek, controls.first + 30.25);
    assert.equal(controls.playing, true);
    assert.equal(controls.flushVisible, true);
    assert.equal(controls.highlightJump, true, "Scene highlight did not jump and play");
    await settle();
    fs.writeFileSync(path.join(screenshots, "sonata-flush.png"), (await window.webContents.capturePage()).toPNG());
    const rewind = await js(`(() => {
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
    assert.equal(rewind.before, "flow");
    assert.equal(rewind.reversed, true, "Code rows did not scroll backward");
    assert.ok(rewind.canceled > 0);
    assert.match(rewind.label, /CODE REWIND/);
    assert.equal(rewind.refill, "refill");
    assert.equal(rewind.finished, "flow");
    assert.equal(rewind.restored, true);
    assert.equal(rewind.cycle, rewind.time + 0.6, "Visual rewind changed processor time");
    const held = await js("sonata.instructionFeed");
    await settle();
    assert.deepEqual(await js("sonata.instructionFeed"), held, "Paused code rewind moved");
    fs.writeFileSync(
        path.join(screenshots, "sonata-code-rewind.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const unravel = await js(`sonata.flushEvents.map(t=>{
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
    for (const event of unravel) {
        assert.equal(event.fading, true, "Detached letters must fade while they travel");
        assert.equal(event.correct, true, "Detached glyphs must come from this flush's actual canceled instructions");
        assert.ok(
            event.visible > 40 && event.visible > event.glyphs * 0.4,
            "Canceled glyphs vanished before visibly separating"
        );
        assert.match(event.label, /CODE UNRAVEL/);
    }
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    const fragments = await js("sonata.codeFragments");
    await settle();
    assert.deepEqual(await js("sonata.codeFragments"), fragments, "Paused unraveling letters moved");
    fs.writeFileSync(
        path.join(screenshots, "sonata-code-unravel.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    await js("sonata.captureAt(sonata.flushEvents[0]+sonataReplay.codeRewindDuration)");
    assert.deepEqual(await js("sonata.codeFragments"), [], "Detached letters remained after refill");
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    assert.deepEqual(
        await js("sonata.codeFragments"),
        fragments,
        "Seeking did not restore identical unraveling letters"
    );
    const recovery = await js(`new Promise((resolve,reject)=>{
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
    const recoveryFrames = recovery.filter((f) => f.age > 3.55);
    assert.ok(recoveryFrames.length >= 5, "Not enough frames to inspect flush recovery");
    for (let i = 1; i < recoveryFrames.length; i++) {
        const a = recoveryFrames[i - 1],
            b = recoveryFrames[i];
        assert.ok(b.rate >= a.rate - 1e-5 && b.rate <= 1.000001, "Recovery speed regressed or overshot");
        assert.ok(b.rate - a.rate < 0.15, "Flush recovery still has an abrupt speed jump");
        assert.ok(b.cycles <= b.seconds * 4 + 0.000001, "A recovery frame jumped over elapsed processor time");
    }
    assert.ok(
        recoveryFrames.some((f) => f.age >= 4 && f.age < 4.4 && f.rate < 0.8),
        "Speed snapped to normal at the end of code rewind"
    );
    assert.ok(recoveryFrames.at(-1).rate > 0.98, "Normal speed did not return");
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    assert.deepEqual(await js("sonata.codeFragments"), [], "Stream toggle left detached letters visible");
    await js("document.getElementById('instruction-stream').click(); sonata.captureAt(sonata.cycle)");
    await js(
        "(async()=>{sonata.setCamera('cinema'); await sonata.loadTrace('wide-open'); sonata.captureAt(sonata.trace.demo.screenshotCycle)})()"
    );
    await delay(1100);
    assert.equal(
        await js("getComputedStyle(document.getElementById('bound-scene')).display!=='none'"),
        true,
        "Cinema hid the main Top-down readout"
    );
    fs.writeFileSync(path.join(screenshots, "sonata-cinema.png"), (await window.webContents.capturePage()).toPNG());
    await js("sonata.setCamera('plan')");
    await delay(1100);
    assert.equal(await js("document.querySelector('[data-view=plan]').getAttribute('aria-pressed')"), "true");
    fs.writeFileSync(path.join(screenshots, "sonata-plan.png"), (await window.webContents.capturePage()).toPNG());
    return {
        samples: results,
        controls,
        rewind,
        unravel,
        recovery: { frames: recoveryFrames.length, rates: recoveryFrames.map(({ age, rate }) => ({ age, rate })) },
        particlePicked: pick.id,
        playbackAdvance: playbackEnd - playbackStart
    };
};

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBrowserTest, waitFor: waitUntil, delay, loadPage } = require("./load-test.cjs")("browser-test.cts");

// 記録された通知・依存・レジスタ・Top-downと画面の対応を検査する。
module.exports = async function reviewEvidence(window, screenshots) {
    const js = (source) => window.webContents.executeJavaScript(source);
    const browserTest = createBrowserTest(window);
    const settle = () => browserTest.settle({ finish: true });
    const waitFor = (source, message) => waitUntil(() => js(source), message, { timeout: 5000, interval: 60 });
    // 全時刻の検査は1フレームずつ進め、長い同期処理と未完了の描画を溜めない。
    const scanCycles = async (sample) => {
        const { firstCycle, lastCycle } = await browserTest.evaluate(({ sonata }) => ({
            firstCycle: sonata.trace.firstCycle,
            lastCycle: sonata.trace.lastCycle
        }));
        const samples = [];
        for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
            samples.push(await browserTest.sampleFrame(() => sample(cycle)));
        }
        return { firstCycle, samples };
    };
    await js(
        "sonata.setPlaying(false); if(document.getElementById('auto-camera').getAttribute('aria-pressed')==='true')document.getElementById('auto-camera').click()"
    );
    await js(
        "(async()=>{sonata.setCamera('orbit'); await sonata.loadTrace('memory-tide'); sonata.captureAt(sonata.trace.demo.screenshotCycle)})()"
    );
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
    assert.equal(notification.before, false);
    assert.equal(notification.flight, "flight");
    assert.equal(notification.arrived, "arrived");
    assert.equal(notification.notice, true);
    assert.equal(notification.expired, true);
    await delay(200);
    fs.writeFileSync(
        path.join(screenshots, "sonata-memory-return.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const rsd = await js(`(()=>{
        const t=sonata.trace,cache=t.demo.events.find(e=>e.kind==='dcache-miss'),branch=t.demo.events.find(e=>e.kind==='branch-mispredict');
        sonata.captureAt(cache.cycle+.4);
        const cacheVisible=document.getElementById('trace-event-notice').textContent.includes('D-CACHE MISS');
        sonata.captureAt(branch.cycle+.4);
        const branchVisible=document.getElementById('trace-event-notice').textContent.includes('BRANCH MISPREDICTION');
        sonata.captureAt(sonata.flushEvents[0]+.6);
        return {cache,branch,cacheVisible,branchVisible,flushVisible:document.getElementById('flush-alert').classList.contains('visible'),
            rewind:sonata.codeRewind.phase,canceled:sonata.instructionFeed.filter(r=>r.canceled).length};
    })()`);
    assert.equal(rsd.cacheVisible, true);
    assert.equal(rsd.branchVisible, true);
    assert.equal(rsd.flushVisible, true);
    assert.equal(rsd.rewind, "rewind");
    assert.ok(rsd.canceled > 0);
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-rsd-mispredict.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    await js("sonata.captureAt(sonata.trace.demo.events.find(e=>e.kind==='dcache-miss').cycle+.4)");
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-rsd-cache-miss.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const branchReview = await js(`(()=>{
        return [4066.2,4068.2,4070.2].map(t=>{
            sonata.captureAt(t);const p=sonata.particles.find(p=>p.id===4454),b=sonata.recoveryBranches.find(e=>e.id===4454);
            return {time:t,present:!!p,bright:p?.brightness>=1,inROB:sonata.rob.entries.some(e=>e.id===4454),
                canceled:sonata.codeRewind.ids.includes(4454),recorded:b?.inferred===false,
                marker:document.getElementById('recovery-branch').textContent,visible:!document.getElementById('recovery-branch').hidden};
        });
    })()`);
    for (const b of branchReview) {
        assert.ok(b.present && b.bright && b.inROB && b.recorded && b.visible);
        assert.equal(b.canceled, false);
        assert.match(
            b.marker,
            b.time < 4067 ? /MISPREDICT #4454.*BRANCH.*PRESERVED/ : /MISPREDICT #4454.*ROB.*PRESERVED/
        );
    }
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-branch-preserved.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const matrixScan = await scanCycles((cycle) =>
        browserTest.evaluate(({ sonata }, cycle) => {
            sonata.captureAt(cycle + 0.2);
            const matrix = sonata.dependencyMatrix;
            const columns = matrix.issues.filter((issue) => issue.column !== null).length;
            return {
                cycle,
                cells: matrix.cells.length + matrix.external.length,
                internal: matrix.cells.length,
                columns,
                score: matrix.cells.length + columns * 2
            };
        }, cycle)
    );
    let bestMatrix = { cycle: matrixScan.firstCycle, cells: 0, internal: 0 };
    let bestIssue = { cycle: matrixScan.firstCycle, score: 0 };
    for (const sample of matrixScan.samples) {
        if (sample.cells > bestMatrix.cells)
            bestMatrix = { cycle: sample.cycle + 0.2, cells: sample.cells, internal: sample.internal };
        if (sample.columns && sample.score > bestIssue.score)
            bestIssue = { cycle: sample.cycle + 0.42, score: sample.score };
    }
    const matrixReview = await browserTest.evaluate(
        ({ sonata }, best, issueCycle) => {
            sonata.captureAt(best.cycle);
            const before = JSON.stringify(sonata.dependencyMatrix);
            sonata.captureAt(sonata.trace.lastCycle);
            sonata.captureAt(best.cycle);
            return { ...best, issueCycle, restored: before === JSON.stringify(sonata.dependencyMatrix) };
        },
        bestMatrix,
        bestIssue.cycle
    );
    assert.ok(matrixReview.cells > 5);
    assert.equal(matrixReview.restored, true);
    assert.equal(
        await js("getComputedStyle(document.getElementById('flush-alert')).opacity"),
        "0",
        "Seeking retained a notice from a future flush"
    );
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-dependency-matrix.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const registerReview = await js(`(()=>{
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
    assert.notDeepEqual(registerReview.before, registerReview.after);
    assert.deepEqual(registerReview.after, [
        [12, 7],
        [13, 11],
        [15, 8]
    ]);
    assert.equal(registerReview.changed, true);
    assert.equal(registerReview.restored, true);
    assert.equal(registerReview.words.length, 32);
    assert.equal(registerReview.table, false);
    assert.ok(
        registerReview.words
            .filter((r) => [12, 13, 15].includes(r.logical))
            .every((r) => r.restoring && r.active && r.progress > 0 && r.progress < 1)
    );
    assert.equal(registerReview.write.cycle, 4014);
    assert.notEqual(registerReview.pending.cycle, 4014);
    assert.equal(registerReview.physical, 41);
    assert.equal(registerReview.physicalLabels, 41);
    assert.equal(registerReview.layout.renameNode, "front-4");
    assert.equal(registerReview.layout.physicalNode, "register-read");
    assert.ok(
        registerReview.layout.renamePosition[0] < Math.min(...registerReview.layout.cells.map((c) => c.position[0]))
    );
    assert.equal(new Set(registerReview.layout.cells.map((c) => JSON.stringify(c.position))).size, 41);
    assert.equal(registerReview.robLabel, true);
    const renameWordReview = await js(`(async()=>{
        const result=[];
        for(const key of ['memory-tide','rename-rush','x86-recovery']){
            await sonata.loadTrace(key);
            const events=sonata.trace.evidence.registers.events;
            for(const type of ['rename','restore']){
                const e=events.find(e=>e.type===type&&e.previous!==e.physical&&e.cycle<sonata.trace.lastCycle-1);
                sonata.captureAt(e.cycle+.15);const first=sonata.renameMapWords.find(r=>r.logical===e.logical);
                sonata.captureAt(e.cycle+.55);const second=sonata.renameMapWords.find(r=>r.logical===e.logical);
                sonata.captureAt(e.cycle+.85);const settled=sonata.renameMapWords;
                result.push({key,type,first,second,settled,rows:sonata.registers.rows});
            }
        }
        await sonata.loadTrace('memory-tide');sonata.captureAt(4068.2);
        return result;
    })()`);
    for (const r of renameWordReview) {
        assert.ok(r.first.progress < r.second.progress, "Rename word update should sweep smoothly through the cells");
        for (const word of r.settled) {
            const row = r.rows.find((row) => row.logical === word.logical);
            if (word.constant || !word.known) assert.ok(word.cells.every((c) => c.value === null));
            else
                assert.equal(
                    word.cells.reduce((value, cell) => (value << 1) | cell.value, 0),
                    row.physical,
                    "RAT word does not encode the recorded physical destination"
                );
        }
    }
    const registerReadReview = await js(`(()=>{
        const result=[3990.5,4010.5].map(t=>{
            sonata.captureAt(t);const r=sonata.registerReads.find(r=>r.id===4355),p=sonata.particles.find(p=>p.id===4355);
            return {time:t,sources:r?.sources,state:p?.state,port:r?.port};
        });
        sonata.captureAt(4011.5);const executing=sonata.particles.find(p=>p.id===4355);
        sonata.captureAt(4014.5);const notice=sonata.notifications.find(n=>n.id===4355);
        sonata.captureAt(4068.2);
        return {result,executing:executing?.state,notice};
    })()`);
    for (const read of registerReadReview.result) {
        assert.equal(read.state, "reading");
        assert.equal(read.sources.length, 1);
        assert.equal(read.sources[0].logical, 15);
    }
    assert.equal(registerReadReview.executing, "executing");
    assert.ok(
        registerReadReview.notice.target[2] < -1.6,
        "Memory notification must land outside the matrix, on its wake-up bus"
    );
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-rename-restore.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const issueReview = await js(`(()=>{
        sonata.captureAt(${matrixReview.issueCycle});
        const path=sonata.issuePaths.find(p=>p.column!==null);
        if(!path)throw new Error('No visible issue column pulse');
        return path;
    })()`);
    assert.ok(issueReview.exit[0] > issueReview.origin[0]);
    assert.equal(issueReview.origin[2], issueReview.exit[2], "Issued instruction must cross its waiting row");
    assert.deepEqual(issueReview.signal[0], issueReview.exit, "Issue column signal must start at the right-hand exit");
    assert.equal(issueReview.signal[1][0], issueReview.exit[0]);
    assert.ok(
        issueReview.signal[2][2] > issueReview.signal[3][2],
        "Issue signal must enter its column from the right-side return path"
    );
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-issue-column.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const readColors = await js(`(()=>{
        return ['integer','memory','branch'].map(kind=>{
            const op=sonata.ops.find(o=>o.kind===kind&&o.sourceRegisters.length&&o.reads.some(r=>r.start>=sonata.trace.firstCycle&&r.end<sonata.trace.lastCycle));
            const read=op.reads.find(r=>r.start>=sonata.trace.firstCycle&&r.end<sonata.trace.lastCycle);
            sonata.captureAt(read.start+.5);
            const r=sonata.registerReads.find(r=>r.id===op.id);
            return {kind,color:r.color,cells:sonata.registerReadCells.filter(c=>c.readers[0]===op.id)};
        });
    })()`);
    assert.equal(
        new Set(readColors.map((r) => JSON.stringify(r.color))).size,
        3,
        "Register reads retained a single fixed color"
    );
    for (const read of readColors) {
        assert.ok(read.cells.length);
        for (const cell of read.cells) assert.deepEqual(cell.color, read.color);
    }
    const gem5RegisterReview = await js(`(async()=>{
        const results=[];
        for(const key of ['branch-storm','rename-rush','x86-recovery']){
            await sonata.loadTrace(key);const data=sonata.trace.evidence.registers;
            const read=data.reads.find(r=>sonata.ops.some(o=>o.id===r.id&&o.end>r.cycle+.1));
            const t=read?read.cycle+.1:sonata.trace.firstCycle;
            sonata.captureAt(t);const before=JSON.stringify(sonata.registers),state=sonata.registers;
            const active=sonata.registerReads;
            sonata.captureAt(sonata.trace.lastCycle);sonata.captureAt(t);
            results.push({key,kind:data.kind,physical:state.physical.length,known:state.physical.filter(p=>p.value!==null).length,
                read,active,restored:before===JSON.stringify(sonata.registers),write:state.lastWrite,
                cells:new Set(sonata.registerLayout.cells.map(c=>JSON.stringify(c.position))).size,
                label:document.getElementById('register-writeback').textContent,
                allocation:state.allocationCounts,allocationLabel:document.getElementById('register-allocation').textContent,
                allocationCells:sonata.registerAllocationCells});
        }
        return results;
    })()`);
    for (const r of gem5RegisterReview) {
        assert.equal(r.physical, 256);
        assert.equal(r.cells, 256);
        assert.equal(r.restored, true);
        if (r.kind === "configuration") {
            assert.equal(r.known, 0);
            assert.equal(r.active.length, 0);
            assert.match(r.label, /VALUES NOT LOGGED/);
        } else {
            assert.ok(r.known > 100);
            assert.ok(
                r.active.some((a) => a.id === r.read.id && a.sources.some((s) => s.physical === r.read.physical))
            );
            assert.ok(r.write);
        }
        assert.equal(
            Object.values(r.allocation).reduce((n, v) => n + v, 0),
            256
        );
        assert.ok(
            r.allocationLabel.includes(`ALLOC ${r.allocation.allocated}`) &&
                r.allocationLabel.includes(`FREE ${r.allocation.free}`)
        );
        if (r.kind === "configuration") assert.equal(r.allocation.unknown, 256);
        else {
            const filled = r.allocationCells.filter((c) => c.state === "allocated"),
                empty = r.allocationCells.filter((c) => c.state === "free" && c.fill === 0);
            assert.ok(filled.length > 0 && empty.length > 0);
            assert.ok(
                filled.every((c) => c.fill > 0 && c.outline > empty[0].outline),
                "Allocated cells need a stronger fill and outline than free cells"
            );
        }
    }
    await js("sonata.loadTrace('branch-storm')");
    const boundScan = await scanCycles((cycle) =>
        browserTest.evaluate(({ sonata, $ }, cycle) => {
            sonata.captureAt(cycle);
            return { cycle, dominant: sonata.topDown.dominant, label: $("bound-scene-status").textContent };
        }, cycle)
    );
    const boundStates = boundScan.samples.filter(
        (sample, index, samples) => samples.findIndex((other) => other.dominant === sample.dominant) === index
    );
    const bounds = await browserTest.evaluate(({ sonata }, states) => {
        sonata.captureAt(states[0].cycle);
        const before = JSON.stringify([sonata.topDown, sonata.topDownVisual]);
        sonata.captureAt(sonata.trace.lastCycle);
        sonata.captureAt(states[0].cycle);
        return { states, restored: before === JSON.stringify([sonata.topDown, sonata.topDownVisual]) };
    }, boundStates);
    for (const key of ["backend", "frontend", "badSpeculation", "active"])
        assert.ok(bounds.states.some((s) => s.dominant === key));
    assert.equal(bounds.restored, true, "Top-down analysis changed after seeking backwards");
    const causalReview = await js(`(async()=>{
        await sonata.loadTrace('branch-storm');const flush=sonata.flushEvents[0],samples=[];
        for(const t of [flush-.5,flush-.1,flush,flush+.5]){
            sonata.captureAt(t);samples.push({time:t,shares:sonata.topDown.shares,start:sonata.topDown.firstCycle,end:sonata.topDown.lastCycle});
        }
        sonata.captureAt(flush-.1);const rewind=sonata.topDown.shares;
        return {flush,samples,rewind};
    })()`);
    assert.ok(causalReview.samples.slice(0, 2).every((s) => s.shares.badSpeculation === 0));
    assert.ok(causalReview.samples[2].shares.badSpeculation > 0);
    assert.equal(causalReview.rewind.badSpeculation, 0, "Seeking backward left future squash evidence visible");
    assert.ok(causalReview.samples.every((s) => s.start === s.time - 8 && s.end === s.time));
    for (const phase of ["before", "after"]) {
        await js(`sonata.captureAt(${causalReview.flush + (phase === "before" ? -0.1 : 0.5)})`);
        await settle();
        fs.writeFileSync(
            path.join(screenshots, `sonata-top-down-${phase}-flush.png`),
            (await window.webContents.capturePage()).toPNG()
        );
    }
    const heldBound = await js("sonata.topDown");
    await settle();
    assert.deepEqual(await js("sonata.topDown"), heldBound);
    fs.writeFileSync(path.join(screenshots, "sonata-top-down.png"), (await window.webContents.capturePage()).toPNG());
    for (const state of bounds.states.filter((s) =>
        ["backend", "frontend", "badSpeculation", "active"].includes(s.dominant)
    )) {
        await js(`sonata.captureAt(${state.cycle})`);
        await settle();
        const layout = await js(`(()=>{
            const hud=document.getElementById('bound-scene'),r=hud.getBoundingClientRect(),w=document.getElementById('world').getBoundingClientRect();
            const region=sonata.topDownVisual.region;
            return {inside:r.left>=w.left&&r.right<=w.right&&r.top>=w.top&&r.bottom<=w.bottom,
                readable:parseFloat(getComputedStyle(document.getElementById('bound-scene-status')).fontSize)>=20&&parseFloat(getComputedStyle(document.getElementById('bound-scene-status')).fontSize)<=28,
                category:region?.category,bounds:region?.bounds};
        })()`);
        assert.equal(layout.inside, true);
        assert.equal(layout.readable, true);
        assert.equal(layout.category, state.dominant);
        if (state.dominant === "frontend") assert.ok(layout.bounds[1] < 0, "Frontend emphasis spread into the backend");
        if (state.dominant === "backend") assert.ok(layout.bounds[0] > -6, "Backend emphasis spread into the frontend");
        fs.writeFileSync(
            path.join(screenshots, `sonata-top-down-${state.dominant}.png`),
            (await window.webContents.capturePage()).toPNG()
        );
    }
    const boundMotion = await js(`new Promise((resolve,reject)=>{
        const candidate=${bounds.states.find((s) => s.dominant === "active").cycle},samples=[];
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
    assert.ok(boundMotion.samples.length >= 3, "Top-down animation had too few frames");
    const intermediate = boundMotion.samples.filter(
        (s) =>
            Math.abs(s.visual.inFlight - s.actual.inFlight) > 1e-4 &&
            Math.abs(s.visual.inFlight - boundMotion.before.shares.inFlight) > 1e-4
    );
    assert.ok(intermediate.length >= 2, "Top-down shares jumped directly to the next analysis result");
    assert.ok(
        intermediate.some((s) => s.weights.backend > 0 && s.weights.active > 0),
        "Region emphasis did not crossfade"
    );
    for (const sample of boundMotion.samples) {
        assert.ok(Math.abs(Object.values(sample.visual).reduce((sum, v) => sum + v, 0) - 1) < 1e-9);
        assert.ok(Math.abs(sample.bar - sample.visual.inFlight) < 1e-6, "HUD and board animation diverged");
        for (const key of Object.keys(sample.actual))
            assert.ok(
                sample.visual[key] >= Math.min(sample.actual[key], boundMotion.before.shares[key]) - 1e-4 &&
                    sample.visual[key] <= Math.max(sample.actual[key], boundMotion.before.shares[key]) + 1e-4,
                "Top-down animation overshot the analysis"
            );
    }
    assert.ok(
        Math.abs(boundMotion.settled.visual.inFlight - boundMotion.settled.actual.inFlight) < 0.002,
        "Top-down animation did not settle"
    );
    await js(
        "document.getElementById('speed').value='4';document.getElementById('speed').dispatchEvent(new Event('change'))"
    );
    await js(
        "(async()=>{await sonata.loadTrace('memory-tide');sonata.captureAt(sonata.trace.demo.screenshotCycle)})()"
    );
    await js("document.getElementById('run-details').open=true");
    assert.match(await js("document.getElementById('run-file').textContent"), /mshr\.log/);
    await js("document.getElementById('run-details').open=false");
    return {
        branchReview,
        matrixReview,
        registerReview,
        registerReadReview,
        notification,
        rsd,
        bounds,
        boundMotion: { frames: boundMotion.samples.length, intermediate: intermediate.length }
    };
};

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBrowserTest, waitFor: waitUntil, delay } = require("./load-test.cjs")("browser-test.cts");

module.exports = async function reviewStyles(window, entry, screenshots) {
    const js = (source) => window.webContents.executeJavaScript(source);
    const { settle } = createBrowserTest(window);
    const waitFor = (source, message, timeout = 10000) =>
        waitUntil(() => js(source), message, {
            timeout,
            diagnostics: () =>
                js(
                    "({camera:globalThis.sonata?.camera,style:globalThis.sonata?.visualStyle,renderer:document.getElementById('renderer-status')?.textContent,hidden:document.hidden})"
                )
        });
    const capture = async (name) => {
        await settle();
        fs.writeFileSync(
            path.join(screenshots, `sonata-style-${name}.png`),
            (await window.webContents.capturePage()).toPNG()
        );
        // 図に重なる操作ボタンの文字を画素差に数えず、WebGL の結果だけを読む。
        const png = await js("sonata.captureAt(sonata.cycle);document.getElementById('scene').toDataURL('image/png')");
        const pixels = require("electron").nativeImage.createFromDataURL(png).toBitmap(),
            background = [pixels[0], pixels[1], pixels[2]];
        let different = 0,
            total = 0;
        for (let i = 0; i < pixels.length; i += 4 * 13) {
            if (
                Math.hypot(pixels[i] - background[0], pixels[i + 1] - background[1], pixels[i + 2] - background[2]) > 30
            )
                different++;
            total++;
        }
        assert.ok(different / total > 0.015, `${name}: canvas is nearly blank`);
        return { background, coverage: different / total };
    };
    await window.loadFile(entry);
    await waitFor("!!globalThis.sonata", "Style test did not initialize");
    assert.equal(await js("sonata.visualStyle"), "neon", "Default style changed");
    assert.equal(
        await js("document.querySelector('#marble-look,#look-toggle')"),
        null,
        "Prototype instruction controls remain visible"
    );
    assert.ok(
        await js(`(()=>{
        const view=document.querySelector('.view-controls').getBoundingClientRect();
        const properties=['fontSize','padding','borderRadius','backgroundColor','color'];
        return [...document.querySelectorAll('[data-style-choice]')].every(el=>{
            const r=el.getBoundingClientRect(),selected=el.getAttribute('aria-pressed')==='true';
            const reference=document.querySelector('[data-view='+(selected?'orbit':'plan')+']'),a=getComputedStyle(el),b=getComputedStyle(reference);
            return r.width>=44&&r.height===reference.getBoundingClientRect().height&&r.top>=view.bottom&&r.bottom<=innerHeight
                &&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el&&properties.every(key=>a[key]===b[key]);
        });})()`),
        "Style buttons do not match the view controls or are unreachable"
    );
    await js(`sonata.setPlaying(false);
        if(document.getElementById('auto-camera').getAttribute('aria-pressed')==='true')document.getElementById('auto-camera').click();
        globalThis.reviewStyle=key=>document.getElementById('style-'+key).click();
        globalThis.reviewState=()=>({trace:sonata.trace.key,cycle:sonata.cycle,playing:sonata.playing,selected:sonata.selectedID,camera:sonata.camera,
            stats:sonata.stats,rob:sonata.rob,registers:sonata.registers,matrix:sonata.dependencyMatrix,topDown:sonata.topDown,
            pipes:sonata.executionPipes,connections:sonata.connections,commit:sonata.commitSlots,
            rewind:sonata.codeRewind,feed:sonata.instructionFeed,fragments:sonata.codeFragments,notifications:sonata.notifications,recovery:sonata.recoveryBranches.map(({position,...state})=>state),
            // 接地により表示の Y と画面位置は変わる。共通経路と実際の X/Z は照合する。
            particles:sonata.particles.map(({id,position,pathPosition,state})=>({id,pathPosition,xz:[position[0],position[2]],state})),
            effects:['trails','auto-camera','motion-effects','instruction-stream'].map(id=>document.getElementById(id).getAttribute('aria-pressed'))});void 0;`);
    const scenes = [];
    let fixedRadius;
    for (const key of await js("embeddedFlowTraces.map(t=>t.key)")) {
        const checkpoints = await js(
            `sonata.loadTrace(${JSON.stringify(key)});[sonata.trace.demo.screenshotCycle,...sonata.trace.demo.bookmarks.map(b=>b.cycle+.4)]`
        );
        const stageLayout = await require("./check-stage-layout.cjs")(window);
        const stageTransfers = await require("./check-stage-transfers.cjs")(window);
        const layout = await js("sonata.instructionLayout"),
            spacing = {};
        for (const name of ["scheduler", "rob", "rename"]) {
            let minimum = Infinity;
            const positions = layout[name];
            for (let i = 0; i < positions.length; i++)
                for (let j = i + 1; j < positions.length; j++)
                    minimum = Math.min(
                        minimum,
                        Math.hypot(positions[i][0] - positions[j][0], positions[i][2] - positions[j][2])
                    );
            assert.ok(minimum > layout.radius * 2, `${key}: ${name} slots overlap fixed-size instructions`);
            spacing[name] = minimum;
        }
        for (const cycle of checkpoints) {
            const result = await js(`(()=>{
                reviewStyle('neon');sonata.captureAt(${cycle});const before=reviewState(),trace=sonata.trace;
                reviewStyle('blocks');const blocks=reviewState(),pieces=sonata.renderer.pieceVertices,shape=sonata.renderer.instructionShape,radii=[...new Set(sonata.pieces.map(p=>p.radius))];
                reviewStyle('neon');return {before,blocks,shape,after:reviewState(),sameTrace:trace===sonata.trace,pieces,radii,error:sonata.renderer.error};
            })()`);
            if (fixedRadius === undefined) fixedRadius = result.radii[0];
            assert.deepEqual(
                result.radii,
                [fixedRadius],
                `${key} @ ${cycle}: instruction size changed with stage or state`
            );
            assert.deepEqual(result.blocks, result.before, `${key} @ ${cycle}: Blocks changed replay or camera state`);
            assert.deepEqual(result.after, result.before, `${key} @ ${cycle}: Neon restoration changed state`);
            assert.ok(result.sameTrace && result.pieces > 0);
            assert.equal(result.error, 0);
            assert.equal(result.shape, "cut-crystal", `${key} @ ${cycle}: instruction shape changed`);
        }
        await js(
            `sonata.captureAt(sonata.trace.demo.screenshotCycle);document.querySelector('.telemetry').scrollTop=0`
        );
        const neon = await capture(`${key}-neon`);
        await js("reviewStyle('blocks')");
        const blocks = await capture(`${key}-blocks`);
        assert.ok(
            blocks.background.reduce((s, v) => s + v, 0) > neon.background.reduce((s, v) => s + v, 0) + 300,
            "Style did not change the rendered canvas"
        );
        scenes.push({ key, checkpoints: checkpoints.length, neon, blocks, spacing, stageLayout, stageTransfers });
    }
    // 実入力で駒をピン留めし、カメラの補間途中でも同期的な切り替えが状態を変えないことを確認。
    await js("sonata.loadTrace('rename-rush');sonata.captureAt(sonata.trace.demo.screenshotCycle)");
    assert.equal(await js("sonata.visualStyle"), "blocks", "Changing demos reset the style");
    // 実際の長い scheduler 待機・pipe 内の移動・commit と squash 後の経路を確認する。
    const rolling = await js(`(()=>{
        const sample=t=>{sonata.captureAt(t);return sonata.pieces.find(p=>p.id===761);};
        const waiting=[sample(448),sample(455)],moving=[sample(459.4),sample(460.4)];
        const original=sonata.pieces;
        sonata.captureAt(466.2);const retired=sonata.pieces.find(p=>p.id===761);
        sonata.captureAt(459.7);sonata.captureAt(460.4);const rewind=sonata.pieces;
        reviewStyle('neon');reviewStyle('blocks');const style=sonata.pieces;
        sonata.loadTrace('wide-open');sonata.loadTrace('rename-rush');sonata.captureAt(460.4);const reloaded=sonata.pieces;
        sonata.captureAt(528.4);const squashed=sonata.pieces.filter(p=>sonata.ops.find(o=>o.id===p.id)?.flush);
        sonata.captureAt(459.4);
        return {waiting,moving,retired,rewound:JSON.stringify(original)===JSON.stringify(rewind),
            stylePreserved:JSON.stringify(original)===JSON.stringify(style),reloaded:JSON.stringify(original)===JSON.stringify(reloaded),
            squashed:squashed.length,normalized:[...original,...squashed,retired].every(p=>p&&p.rotation.every(Number.isFinite)&&Math.abs(Math.hypot(...p.rotation)-1)<1e-9)};
    })()`);
    assert.deepEqual(rolling.waiting[0].position, rolling.waiting[1].position, "Waiting fixture moved");
    assert.deepEqual(rolling.waiting[0].rotation, rolling.waiting[1].rotation, "Waiting instruction kept rolling");
    assert.ok(
        Math.hypot(...rolling.moving[0].position.map((v, i) => v - rolling.moving[1].position[i])) > 0.1,
        "Moving fixture did not move"
    );
    assert.ok(
        Math.hypot(...rolling.moving[0].rotation.map((v, i) => v - rolling.moving[1].rotation[i])) > 0.1,
        "Moving instruction did not roll"
    );
    assert.ok(
        rolling.rewound && rolling.stylePreserved && rolling.reloaded && rolling.normalized && rolling.squashed > 0,
        "Rolling lost deterministic, finite poses"
    );
    const pausedPieces = await js("sonata.pieces");
    await settle();
    assert.deepEqual(await js("sonata.pieces"), pausedPieces, "Paused pieces kept rolling with the decorative clock");
    const pick = await js(`(()=>{const r=document.getElementById('scene').getBoundingClientRect();
        const p=sonata.particles.filter(p=>p.screen[0]>r.width*.2&&p.screen[0]<r.width*.7&&p.screen[1]>r.height*.25&&p.screen[1]<r.height*.7)
            .sort((a,b)=>Math.abs(a.screen[0]-r.width*.45)-Math.abs(b.screen[0]-r.width*.45))[0];
        return {x:Math.round(r.x+p.screen[0]),y:Math.round(r.y+p.screen[1])};})()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...pick, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...pick, button: "left", clickCount: 1 });
    await waitFor("sonata.selectedID!==null", "Blocks instruction could not be picked");
    const selected = await js(`(()=>{document.getElementById('zoom-in').click();const before=reviewState();
        for(let i=0;i<8;i++){reviewStyle('neon');reviewStyle('blocks');}
        return {before,after:reviewState()};})()`);
    assert.deepEqual(selected.after, selected.before, "Repeated switching lost the selection or camera target");
    await js("sonata.setCamera('plan')");
    // 補間に使う dt は1フレーム75msまで。低速な描画でも、精度を保って実際の収束を待つ。
    await waitFor("Math.abs(sonata.camera.elevation-1.49)<.001", "Top view did not settle", 30000);
    await capture("blocks-top");
    const cameraShadowUpdates = await js("sonata.renderer.pieceShadows.updates");
    // 全体表示と最大拡大の間で、丸い角・部品の重なり・レジスタ表面を比較できる画像を残す。
    await js("sonata.setCamera('orbit');for(let i=0;i<4;i++)document.getElementById('zoom-in').click()");
    await waitFor(
        "Math.abs(sonata.camera.radius-sonata.camera.targetRadius)<.01&&Math.abs(sonata.camera.elevation-.73)<.001",
        "Material close-up did not settle",
        30000
    );
    await capture("blocks-materials");
    assert.equal(
        await js("sonata.renderer.pieceShadows.updates"),
        cameraShadowUpdates,
        "Camera movement unnecessarily regenerated instruction shadows"
    );
    const pieceShadows = await require("./check-piece-shadows.cjs")(window);
    const grounding = await require("./check-grounded-pieces.cjs")(window);
    // 同じ駒を同じ位置で読み取り、回転が実際の Cut crystal の面に反映されることを検査する。
    const posePixels = await js(`(()=>{
        const read=()=>{
            sonata.captureAt(459.4);
            const p=sonata.particles.find(p=>p.id===761),m=sonata.pieces.find(p=>p.id===761);
            const gl=document.getElementById('scene').getContext('webgl2'),dpr=sonata.renderer.pixelRatio;
            const radius=m.radius*gl.drawingBufferHeight/(2*Math.tan(.33)*p.screen[2]);
            const size=Math.max(4,Math.floor(radius)),x=Math.round(p.screen[0]*dpr-size/2),y=Math.round(gl.drawingBufferHeight-p.screen[1]*dpr-size/2);
            const pixels=new Uint8Array(size*size*4);
            gl.readPixels(x,y,size,size,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return {pixels,pose:m.rotation,error:gl.getError()};
        };
        const before=read();document.getElementById('motion-effects').click();const fixed=read();
        document.getElementById('motion-effects').click();const restored=read();
        let changed=0;for(let i=0;i<before.pixels.length;i+=4)if(Math.max(...[0,1,2].map(k=>Math.abs(before.pixels[i+k]-fixed.pixels[i+k])))>8)changed++;
        return {changed,fixed:fixed.pose,restored:JSON.stringify(before.pose)===JSON.stringify(restored.pose),errors:[before.error,fixed.error,restored.error]};
    })()`);
    assert.ok(posePixels.changed > 5, "Rotation did not change the rendered crystal");
    assert.deepEqual(posePixels.fixed, [0, 0, 0, 1], "Motion effects OFF left rotation enabled");
    assert.ok(posePixels.restored, "Motion effects ON did not restore the trace-derived orientation");
    assert.deepEqual(posePixels.errors, [0, 0, 0]);
    await js("sonata.setCamera('orbit');for(let i=0;i<30;i++)document.getElementById('zoom-in').click()");
    await waitFor(
        "sonata.camera.radius<3.01&&Math.abs(sonata.camera.elevation-.73)<.001",
        "Blocks detail zoom did not settle",
        30000
    );
    await capture("blocks-detail");
    await js("sonata.setCamera('orbit');sonata.captureAt(sonata.trace.firstCycle+2);sonata.setPlaying(true)");
    const running = await js(
        `(()=>{const before=reviewState();reviewStyle('neon');return {before,after:reviewState()};})()`
    );
    assert.deepEqual(running.after, running.before, "Switching stopped or restarted playback");
    await waitFor(`sonata.cycle>${running.after.cycle + 0.2}`, "Playback did not continue after switching");
    await js(
        "document.getElementById('bloom').value='123';document.getElementById('bloom').dispatchEvent(new Event('input'))"
    );
    await js("sonata.setPlaying(false);reviewStyle('blocks')");
    assert.equal(
        await js("document.getElementById('bloom').disabled"),
        true,
        "Blocks left an ineffective bloom slider enabled"
    );
    await js("reviewStyle('neon')");
    assert.equal(
        await js(
            "!document.getElementById('bloom').disabled&&document.getElementById('bloom').value==='123'&&document.getElementById('bloom-value').textContent==='123%'"
        ),
        true,
        "Neon lost the user's bloom setting"
    );
    const mobile = await require("./check-mobile.cjs")(window, screenshots, "blocks");
    assert.equal(await js("sonata.visualStyle"), "blocks", "Mobile layout restoration reset the style");
    await js("reviewStyle('neon')");
    assert.equal(await js("sonata.renderer.pieceShadows.size"), 0, "Neon retained the instruction shadow target");
    return {
        scenes,
        fixedRadius,
        pieceShadows,
        grounding,
        rolling: { ...rolling, paused: true, pixels: posePixels },
        selectionPreserved: true,
        playingPreserved: true,
        mobile
    };
};

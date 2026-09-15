"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBrowserTest, waitFor: waitUntil, loadPage } = require("./load-test.cjs")("browser-test.cts");

module.exports = async function reviewStyles(window, entry, screenshots) {
    const js = (source) => window.webContents.executeJavaScript(source);
    const { evaluate, sampleFrame, settle } = createBrowserTest(window);
    const matteStyles = ["aluminum", "paper"];
    const timings = [];
    const timed = async (name, run) => {
        const started = performance.now();
        const result = await run();
        const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
        timings.push({ name, seconds });
        console.log(`[styles] ${name}: passed (${seconds}s)`);
        return result;
    };
    const waitFor = (source, message, timeout = 10000) =>
        waitUntil(() => js(source), message, {
            timeout,
            diagnostics: () =>
                js(
                    "({camera:globalThis.sonata?.camera,style:globalThis.sonata?.visualStyle,renderer:document.getElementById('renderer-status')?.textContent,hidden:document.hidden})"
                )
        });
    const capture = async (name, reference) => {
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
        let changed = 0;
        if (reference) {
            assert.equal(pixels.length, reference.length, "Comparing styles changed the canvas size");
            for (let i = 0; i < pixels.length; i += 4 * 13)
                if (Math.max(...[0, 1, 2].map((k) => Math.abs(pixels[i + k] - reference[i + k]))) > 8) changed++;
            assert.ok(changed / total > 0.015, `${name}: materials did not visibly change`);
        }
        return { pixels, metrics: { background, coverage: different / total, changed: changed / total } };
    };
    await loadPage(window, entry);
    await waitFor("globalThis.sonata?.hasTrace && sonata.trace.key === 'rename-rush'", "Style test did not initialize");
    assert.equal(await js("sonata.visualStyle"), "neon", "Default style changed");
    assert.deepEqual(
        await js("[...document.querySelectorAll('[data-style-choice]')].map(el=>el.dataset.styleChoice)"),
        ["neon", ...matteStyles],
        "Style controls contain removed styles or changed order"
    );
    assert.equal(
        await js("document.querySelector('#marble-look,#look-toggle')"),
        null,
        "Prototype instruction controls remain visible"
    );
    assert.ok(
        await js(`(()=>{
        const view=document.querySelector('.view-controls').getBoundingClientRect();
        const properties=['fontSize','padding','borderRadius','backgroundColor','color'];
        const rowTop=document.querySelector('[data-style-choice]').getBoundingClientRect().top;
        return [...document.querySelectorAll('[data-style-choice]')].every(el=>{
            const r=el.getBoundingClientRect(),selected=el.getAttribute('aria-pressed')==='true';
            const reference=document.querySelector('[data-view='+(selected?'orbit':'plan')+']'),a=getComputedStyle(el),b=getComputedStyle(reference);
            return r.width>=44&&r.height===reference.getBoundingClientRect().height&&r.top===rowTop&&r.top>=view.bottom&&r.bottom<=innerHeight
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
    const { scenes, fixedRadius } = await timed("scenes", () => require("./check-style-scenes.cjs")(window, capture));
    // 実入力で駒をピン留めし、カメラの補間途中でも同期的な切り替えが状態を変えないことを確認。
    await js(
        "(async()=>{await sonata.loadTrace('rename-rush');return sonata.captureAt(sonata.trace.demo.screenshotCycle);})()"
    );
    assert.equal(await js("sonata.visualStyle"), matteStyles.at(-1), "Changing demos reset the style");
    await js("reviewStyle('aluminum')");
    // 実際の長い scheduler 待機・pipe 内の移動・commit と squash 後の経路を確認する。
    const sliding = {};
    for (const style of matteStyles) {
        const result = await sampleFrame(() =>
            js(`(async()=>{
            reviewStyle(${JSON.stringify(style)});
            const sample=t=>{sonata.captureAt(t);return sonata.pieces.find(p=>p.id===761);};
            const waiting=[sample(448),sample(455)],moving=[sample(459.4),sample(460.4)];
            const original=sonata.pieces;
            sonata.captureAt(466.2);const retired=sonata.pieces.find(p=>p.id===761);
            sonata.captureAt(459.7);sonata.captureAt(460.4);const rewind=sonata.pieces;
            reviewStyle('neon');reviewStyle(${JSON.stringify(style)});const restoredStyle=sonata.pieces;
            await sonata.loadTrace('wide-open');await sonata.loadTrace('rename-rush');sonata.captureAt(460.4);const reloaded=sonata.pieces;
            sonata.captureAt(528.4);const squashed=sonata.pieces.filter(p=>sonata.ops.find(o=>o.id===p.id)?.flush);
            sonata.captureAt(459.4);
            return {waiting,moving,retired,rewound:JSON.stringify(original)===JSON.stringify(rewind),
                stylePreserved:JSON.stringify(original)===JSON.stringify(restoredStyle),reloaded:JSON.stringify(original)===JSON.stringify(reloaded),
                upright:[...original,...squashed,retired,...waiting,...moving].every(p=>p&&JSON.stringify(p.rotation)==='[0,0,0,1]'),
                squashed:squashed.length,normalized:[...original,...squashed,retired].every(p=>p&&p.rotation.every(Number.isFinite)&&Math.abs(Math.hypot(...p.rotation)-1)<1e-9)};
        })()`)
        );
        assert.deepEqual(result.waiting[0].position, result.waiting[1].position, "Waiting fixture moved");
        assert.deepEqual(
            result.waiting[0].rotation,
            result.waiting[1].rotation,
            "Waiting instruction changed orientation"
        );
        assert.ok(
            Math.hypot(...result.moving[0].position.map((v, i) => v - result.moving[1].position[i])) > 0.1,
            "Moving fixture did not move"
        );
        assert.ok(result.upright, `${style}: instructions rotated while waiting, moving, retiring or being squashed`);
        assert.deepEqual(
            result.moving[0].rotation,
            result.moving[1].rotation,
            `${style}: moving instruction changed orientation`
        );
        assert.ok(
            result.rewound && result.stylePreserved && result.reloaded && result.normalized && result.squashed > 0,
            "Sliding lost deterministic, finite poses"
        );
        sliding[style] = result;
    }
    await js("reviewStyle('aluminum')");
    await settle();
    const pick = await js(`(()=>{const r=document.getElementById('scene').getBoundingClientRect();
        const p=sonata.particles.filter(p=>p.screen[0]>r.width*.2&&p.screen[0]<r.width*.7&&p.screen[1]>r.height*.25&&p.screen[1]<r.height*.7)
            .sort((a,b)=>Math.abs(a.screen[0]-r.width*.45)-Math.abs(b.screen[0]-r.width*.45))[0];
        return {x:Math.round(r.x+p.screen[0]),y:Math.round(r.y+p.screen[1])};})()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...pick, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...pick, button: "left", clickCount: 1 });
    await waitFor("sonata.selectedID!==null", "Aluminum instruction could not be picked");
    await js("document.getElementById('zoom-in').click()");
    for (let i = 0; i < 8; i++) {
        for (const style of ["neon", ...matteStyles]) {
            const selected = await sampleFrame(() =>
                js(`(()=>{
                    const before=reviewState();
                    reviewStyle(${JSON.stringify(style)});
                    return {before,after:reviewState()};
                })()`)
            );
            assert.deepEqual(selected.after, selected.before, "Repeated switching lost the selection or camera target");
        }
    }
    await js("reviewStyle('aluminum')");
    await js("sonata.setCamera('plan')");
    // 補間に使う dt は1フレーム75msまで。低速な描画でも、精度を保って実際の収束を待つ。
    await waitFor("Math.abs(sonata.camera.elevation-1.49)<.001", "Top view did not settle", 30000);
    await capture("aluminum-top");
    const cameraShadowUpdates = await js("sonata.renderer.pieceShadows.updates");
    // 全体表示と最大拡大の間で、丸い角・部品の重なり・レジスタ表面を比較できる画像を残す。
    await js("sonata.setCamera('orbit');for(let i=0;i<4;i++)document.getElementById('zoom-in').click()");
    await waitFor(
        "Math.abs(sonata.camera.radius-sonata.camera.targetRadius)<.01&&Math.abs(sonata.camera.elevation-.73)<.001",
        "Material close-up did not settle",
        30000
    );
    await capture("aluminum-materials");
    assert.equal(
        await js("sonata.renderer.pieceShadows.updates"),
        cameraShadowUpdates,
        "Camera movement unnecessarily regenerated instruction shadows"
    );
    const materialChecks = {};
    for (const style of matteStyles) {
        await js(`reviewStyle(${JSON.stringify(style)})`);
        const pausedPieces = await js("sonata.pieces");
        await settle();
        assert.deepEqual(
            await js("sonata.pieces"),
            pausedPieces,
            `${style}: paused pieces changed with the decorative clock`
        );
        if (style !== "aluminum") await capture(`${style}-materials`);
        const pieceShadows = await timed(`${style} shadows`, () => require("./check-piece-shadows.cjs")(window));
        await settle();
        const grounding = await timed(`${style} grounding`, () => require("./check-grounded-pieces.cjs")(window));
        // 同時刻でMotion effectsを切り替え、紙箱と金属パックの姿勢と描画が変わらないことを検査する。
        const posePixels = await js(`(()=>{
            const read=()=>{
                sonata.captureAt(459.4);
                const p=sonata.particles.find(p=>p.id===761),m=sonata.pieces.find(p=>p.id===761);
                const gl=document.getElementById('scene').getContext('webgl2'),dpr=sonata.renderer.pixelRatio;
                const radius=m.radius*gl.drawingBufferHeight/(2*Math.tan(.33)*p.screen[2]);
                // 固定姿勢の駒は内側に絞り、周囲の装飾のON/OFFを画素差へ含めない。
                const size=Math.max(2,Math.floor(radius*.5));
                const x=Math.round(p.screen[0]*dpr-size/2),y=Math.round(gl.drawingBufferHeight-p.screen[1]*dpr-size/2);
                const pixels=new Uint8Array(size*size*4);
                gl.readPixels(x,y,size,size,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return {pixels,pose:m.rotation,error:gl.getError()};
            };
            const before=read();document.getElementById('motion-effects').click();const fixed=read();
            document.getElementById('motion-effects').click();const restored=read();
            return {
                original:before.pose,fixed:fixed.pose,
                fixedPixels:[...before.pixels].every((v,i)=>v===fixed.pixels[i]),
                restoredPixels:[...before.pixels].every((v,i)=>v===restored.pixels[i]),
                restored:JSON.stringify(before.pose)===JSON.stringify(restored.pose),errors:[before.error,fixed.error,restored.error]
            };
        })()`);
        assert.deepEqual(posePixels.original, [0, 0, 0, 1], `${style}: Motion effects ON rotated the instruction`);
        assert.ok(
            posePixels.fixedPixels && posePixels.restoredPixels,
            `${style}: Motion effects changed sliding instruction pixels`
        );
        assert.deepEqual(posePixels.fixed, [0, 0, 0, 1], "Motion effects OFF left rotation enabled");
        assert.ok(posePixels.restored, "Motion effects ON did not restore the trace-derived orientation");
        assert.deepEqual(posePixels.errors, [0, 0, 0]);
        materialChecks[style] = { pieceShadows, grounding, posePixels };
    }
    const opacity = await timed("opacity", () => require("./load-test.cjs")("check-browser.cts").pieceOpacity(window));
    for (const frame of opacity) materialChecks[frame.style].opacity = frame;
    await js("sonata.setCamera('orbit');for(let i=0;i<30;i++)document.getElementById('zoom-in').click()");
    await waitFor(
        "sonata.camera.radius<3.01&&Math.abs(sonata.camera.elevation-.73)<.001",
        "Material detail zoom did not settle",
        30000
    );
    for (const style of matteStyles) {
        await js(`reviewStyle(${JSON.stringify(style)})`);
        await capture(`${style}-detail`);
    }
    await js("sonata.setCamera('orbit');sonata.captureAt(sonata.trace.firstCycle+2);sonata.setPlaying(true)");
    for (const style of ["neon", ...matteStyles]) {
        const running = await sampleFrame(() =>
            js(`(()=>{
                const before=reviewState();
                reviewStyle(${JSON.stringify(style)});
                return {before,after:reviewState()};
            })()`)
        );
        assert.deepEqual(running.after, running.before, "Switching stopped or restarted playback");
        await waitFor(`sonata.cycle>${running.after.cycle + 0.2}`, "Playback did not continue after switching");
    }
    await js(
        "document.getElementById('bloom').value='123';document.getElementById('bloom').dispatchEvent(new Event('input'))"
    );
    await js("sonata.setPlaying(false)");
    for (const style of matteStyles) {
        await sampleFrame(() => evaluate(({ $ }, key) => $("style-" + key).click(), style));
        assert.equal(
            await js("document.getElementById('bloom').disabled"),
            true,
            `${style}: an ineffective bloom slider remained enabled`
        );
    }
    await js("reviewStyle('neon')");
    assert.equal(
        await js(
            "!document.getElementById('bloom').disabled&&document.getElementById('bloom').value==='123'&&document.getElementById('bloom-value').textContent==='123%'"
        ),
        true,
        "Neon lost the user's bloom setting"
    );
    const mobile = await timed("mobile materials", () => require("./check-style-mobile.cjs")(window, capture));
    await js("reviewStyle('neon')");
    assert.equal(await js("sonata.renderer.pieceShadows.size"), 0, "Neon retained the instruction shadow target");
    return {
        scenes,
        fixedRadius,
        materialChecks,
        sliding: { ...sliding, paused: true },
        selectionPreserved: true,
        playingPreserved: true,
        mobile,
        timings
    };
};

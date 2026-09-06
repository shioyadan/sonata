"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// 実ブラウザへの入力、故障の注入、状態を待ってからの検査を組み合わせる。
// 別リポジトリや元ログに依存せず、コピー済みの配布 HTML を使う。
module.exports=async function reviewBrowser(window,entry,screenshots){
    const js=source=>window.webContents.executeJavaScript(source);
    const settle=()=>js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const waitFor=async(source,message)=>{
        const deadline=Date.now()+10000;
        do{
            if(await js(source))return;
            await delay(50);
        }while(Date.now()<deadline);
        const state=await js(`({ready:document.readyState,focus:document.activeElement?.id,
            status:document.getElementById('renderer-status')?.textContent,
            fallback:document.getElementById('fallback')?.hidden,playing:globalThis.sonata?.playing})`);
        assert.fail(`${message}: ${JSON.stringify(state)}`);
    };
    const ready=()=>waitFor("!!globalThis.sonata&&sonata.renderer.error===0&&document.getElementById('fallback').hidden","Renderer did not initialize");
    const press=async(keyCode,modifiers=[])=>{
        // main process からの入力配送を keyup と2フレームで確認し、否定条件も送信後に判定する。
        await js("globalThis.reviewKeyReleased=false;document.addEventListener('keyup',()=>globalThis.reviewKeyReleased=true,{once:true,capture:true})");
        window.webContents.sendInputEvent({type:"keyDown",keyCode,modifiers});
        if(keyCode==="Space"||keyCode.length===1)window.webContents.sendInputEvent({type:"char",keyCode:keyCode==="Space"?" ":keyCode,modifiers});
        window.webContents.sendInputEvent({type:"keyUp",keyCode,modifiers});
        await waitFor("globalThis.reviewKeyReleased","Keyboard input was not delivered");
        await settle();
    };

    await window.loadFile(entry);await ready();window.focus();
    const first=await js("sonata.setPlaying(false);sonata.setCycle(sonata.trace.firstCycle);document.getElementById('scene').focus();sonata.cycle");
    await press("Right");assert.equal(await js("sonata.cycle"),first+1,"Right arrow did not step one cycle");
    await press("Left");assert.equal(await js("sonata.cycle"),first,"Left arrow did not step back");
    await press("Left");assert.equal(await js("sonata.cycle"),first,"Left arrow escaped the trace start");
    await js("sonata.setCycle(sonata.trace.lastCycle)");
    await press("Right");assert.equal(await js("sonata.cycle===sonata.trace.lastCycle"),true,"Right arrow escaped the trace end");
    await js("sonata.setCycle(sonata.trace.firstCycle)");
    await press("Space");assert.equal(await js("sonata.playing"),true,"Space did not start playback");
    await press("Space");assert.equal(await js("sonata.playing"),false,"Space did not pause playback");
    await press("C");assert.equal(await js("sonata.camera.mode"),"cinema","C did not open Cinema");
    await press("Escape");assert.equal(await js("sonata.camera.mode"),"orbit","Escape did not leave Cinema");

    // 入力欄の矢印操作は、その値だけを変える。全体の1サイクル移動と混同しない。
    const cycle=await js("sonata.setCycle(sonata.trace.firstCycle+10);document.getElementById('bloom').value='100';document.getElementById('bloom').focus();sonata.cycle");
    await press("Right");
    assert.equal(await js("document.getElementById('bloom').value"),"101","Focused range did not receive the arrow key");
    assert.equal(await js("sonata.cycle"),cycle,"A focused range also stepped playback");
    await js("document.getElementById('timeline').focus()");await press("Right");
    assert.ok(Math.abs(await js("sonata.cycle")-cycle-.01)<1e-7,"Timeline key also triggered the global cycle shortcut");
    await js("document.getElementById('speed').focus()");await press("C");
    assert.equal(await js("sonata.camera.mode"),"orbit","A focused select activated Cinema");

    // button の Space はブラウザ標準の click を一度だけ発生させる。
    await js("sonata.setPlaying(false);document.getElementById('play').focus()");await press("Space");
    assert.equal(await js("sonata.playing"),true,"Focused play button toggled playback twice");
    await press("Space");assert.equal(await js("sonata.playing"),false);
    await js("document.getElementById('license-open').focus()");await press("Space");
    assert.equal(await js("document.getElementById('license-panel').open&&document.getElementById('license-panel').contains(document.activeElement)"),true,"Keyboard did not open and focus Licenses");
    await press("Tab");
    assert.equal(await js("document.getElementById('license-panel').contains(document.activeElement)"),true,"Tab escaped the modal");
    await press("C");assert.equal(await js("sonata.camera.mode"),"orbit","Modal key activated the global shortcut");
    await press("Escape");
    assert.equal(await js("!document.getElementById('license-panel').open&&document.activeElement.id==='license-open'"),true,"Escape did not close Licenses and restore focus");

    // 実際の右ボタン入力で、回転や選択に干渉せずズームできることを確認する。
    await js("sonata.captureAt(sonata.trace.demo.screenshotCycle);if(document.getElementById('auto-camera').getAttribute('aria-pressed')==='true')document.getElementById('auto-camera').click();document.getElementById('zoom-fit').click()");
    await waitFor("Math.abs(sonata.camera.radius-32.5)<.01&&Math.abs(sonata.camera.azimuth-.2)<.001","Fit did not settle before zoom input");
    const cameraBefore=await js("sonata.camera");
    const area=await js("(()=>{const r=document.getElementById('scene').getBoundingClientRect();return {x:Math.round(r.left+r.width*.5),top:Math.round(r.top+r.height*.15),bottom:Math.round(r.top+r.height*.85)};})()");
    const drag=async(from,to,button="right")=>{
        await js("globalThis.reviewPointerReleased=false;document.getElementById('scene').addEventListener('pointerup',()=>globalThis.reviewPointerReleased=true,{once:true})");
        window.webContents.sendInputEvent({type:"mouseDown",x:area.x,y:from,button,clickCount:1});
        for(let i=1;i<=6;i++)window.webContents.sendInputEvent({type:"mouseMove",x:area.x,y:Math.round(from+(to-from)*i/6),button});
        window.webContents.sendInputEvent({type:"mouseUp",x:area.x,y:to,button,clickCount:1});
        await waitFor("globalThis.reviewPointerReleased","Zoom drag did not release its pointer");await settle();
        return js("sonata.camera");
    };
    const close=await drag(area.bottom,area.top);
    assert.equal(close.targetRadius,3,"Right drag did not reach the detailed zoom limit");
    assert.ok(Math.abs(close.azimuth-cameraBefore.azimuth)<.002&&Math.abs(close.elevation-cameraBefore.elevation)<.002,"Right drag also orbited the camera");
    assert.equal(close.pointers,0,"Right drag left a captured pointer");
    await waitFor("sonata.camera.radius<3.01","Detailed zoom did not settle");
    if(screenshots)fs.writeFileSync(path.join(screenshots,"sonata-detail-zoom.png"),(await window.webContents.capturePage()).toPNG());
    const far=await drag(area.top,area.bottom);
    assert.equal(far.targetRadius,62,"Downward right drag did not zoom back out");
    await js("document.getElementById('zoom-fit').click()");
    const left=await drag(area.bottom,area.bottom-60,"left");
    assert.equal(left.targetRadius,32.5,"Left drag also zoomed the camera");
    assert.ok(Math.abs(left.elevation-close.elevation)>.02,"Left drag no longer orbits");
    await js("document.getElementById('zoom-fit').click();for(let i=0;i<20;i++)document.getElementById('zoom-in').click()");
    assert.equal(await js("sonata.camera.targetRadius"),3,"Zoom button kept the old limit");
    await js("for(let i=0;i<30;i++)document.getElementById('zoom-out').click()");
    assert.equal(await js("sonata.camera.targetRadius"),62,"Zoom-out button escaped the far limit");
    await js("document.getElementById('zoom-fit').click();globalThis.reviewWheelReceived=false;document.getElementById('scene').addEventListener('wheel',()=>globalThis.reviewWheelReceived=true,{once:true})");
    window.webContents.sendInputEvent({type:"mouseWheel",x:area.x,y:Math.round((area.top+area.bottom)/2),deltaY:5000});
    await waitFor("globalThis.reviewWheelReceived","Wheel zoom was not delivered");
    assert.equal(await js("sonata.camera.targetRadius"),3,"Wheel zoom kept the old limit");
    await js("document.getElementById('zoom-fit').click()");
    assert.equal(await js("sonata.camera.targetRadius"),32.5,"Fit did not leave detailed zoom");

    // 初期化失敗時にもユーザー向けの案内と権利表示を開けることを確認する。
    const debuggerAPI=window.webContents.debugger;debuggerAPI.attach("1.3");
    let injected;
    try{
        await debuggerAPI.sendCommand("Page.enable");
        injected=await debuggerAPI.sendCommand("Page.addScriptToEvaluateOnNewDocument",{source:`
            const original=HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext=function(type,...args){
                return type==='webgl2'?null:Reflect.apply(original,this,[type,...args]);
            };`});
        await window.loadFile(entry);
        assert.equal(await js("document.getElementById('fallback').hidden"),false,"Missing WebGL did not show the fallback");
        assert.equal(await js("document.getElementById('renderer-status').textContent"),"WebGL 2 unavailable");
        assert.equal(await js("typeof sonata"),"undefined","Fault injection did not disable WebGL initialization");
        await js("document.getElementById('license-open').focus()");await press("Space");
        assert.equal(await js("document.getElementById('license-panel').open&&document.getElementById('license-text').textContent.includes('Embedded Microprocessor Benchmark Consortium')"),true,"WebGL failure made license notices inaccessible");
        await press("Escape");assert.equal(await js("document.getElementById('license-panel').open"),false);
    }finally{
        try{if(injected)await debuggerAPI.sendCommand("Page.removeScriptToEvaluateOnNewDocument",{identifier:injected.identifier});}
        finally{debuggerAPI.detach();}
    }
    await window.loadFile(entry);await ready();

    // 実際に context を失わせ、案内・停止・復旧後の描画と再生を検査する。
    const available=await js(`(()=>{
        globalThis.reviewContext=document.getElementById('scene').getContext('webgl2').getExtension('WEBGL_lose_context');
        if(!reviewContext)return false;
        reviewContext.loseContext();return true;
    })()`);
    assert.equal(available,true,"The context-loss extension is unavailable");
    await waitFor("document.getElementById('renderer-status').textContent==='Graphics context lost'","Context loss was not reported");
    assert.equal(await js("document.getElementById('fallback').hidden"),false);
    const stopped=await js("sonata.cycle");await settle();
    assert.equal(await js("sonata.cycle"),stopped,"The playback clock advanced while graphics were lost");
    await js("reviewContext.restoreContext()");
    await waitFor("!!globalThis.sonata&&document.getElementById('fallback').hidden&&!document.getElementById('scene').getContext('webgl2').isContextLost()","Restored graphics did not recover the app");
    await ready();
    const resumed=await js("sonata.setPlaying(true);sonata.cycle");
    await waitFor(`sonata.cycle>${resumed}`,"Playback did not resume after graphics recovery");
    const frame=await js(`(()=>{
        sonata.captureAt(sonata.trace.demo.screenshotCycle);
        const gl=document.getElementById('scene').getContext('webgl2');
        const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
        gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let colored=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(...pixels.subarray(i,i+3))-Math.min(...pixels.subarray(i,i+3))>40)colored++;
        return {colored,error:gl.getError(),particles:sonata.particles.length};
    })()`);
    assert.equal(frame.error,0,"Restored graphics returned a WebGL error");
    assert.ok(frame.colored>1000&&frame.particles>0,`Restored graphics left an empty frame: ${JSON.stringify(frame)}`);
    return {keyboard:{stepping:true,bounds:true,playback:true,cinema:true,focusedControls:true,modalFocus:true},
        camera:{rightDrag:true,leftOrbit:true,buttons:true,wheel:true,fit:true,minRadius:3,maxRadius:62},
        unavailable:{fallback:true,licenses:true},contextRecovery:{clockPaused:true,playbackResumed:true,...frame}};
};

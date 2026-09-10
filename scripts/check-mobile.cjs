"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

module.exports=async function reviewMobile(window,screenshots,visualStyle="neon"){
    const js=source=>window.webContents.executeJavaScript(source);
    const debuggerAPI=window.webContents.debugger;
    debuggerAPI.attach("1.3");
    const command=(method,args={})=>debuggerAPI.sendCommand(method,args);
    const capture=async name=>fs.writeFileSync(path.join(screenshots,`sonata-mobile${visualStyle==="neon"?"":"-"+visualStyle}${name}.png`),(await window.webContents.capturePage()).toPNG());
    const settle=()=>js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const layouts=[];
    let result;
    try{
        await command("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:2});
        await js(`document.getElementById('style-'+${JSON.stringify(visualStyle)}).click()`);
        await js(`sonata.loadTrace('rename-rush');sonata.captureAt(sonata.trace.demo.screenshotCycle);
            if(document.getElementById('auto-camera').getAttribute('aria-pressed')==='true')document.getElementById('auto-camera').click();
            document.querySelector('[data-view=orbit]').click();`);
        for(const [width,height,name] of [[320,568,"-small"],[390,844,""],[430,932,"-large"],[932,430,"-landscape"]]){
            window.setContentSize(width,height);
            await command("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:2,mobile:true});
            await delay(850);await settle();
            const layout=await js(`(()=>{
                const rect=id=>document.getElementById(id).getBoundingClientRect();
                const w=rect('world'),b=rect('bound-scene'),transport=document.querySelector('.transport').getBoundingClientRect();
                const fits=r=>r.left>=0&&r.right<=innerWidth+.1&&r.top>=0&&r.bottom<=innerHeight+.1;
                const ids=['play','previous','next','reset','speed','timeline','next-flush','mobile-details','style-neon','style-blocks','zoom-in','zoom-fit','zoom-out'];
                return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
                    controls:ids.map(id=>{const r=rect(id);return {id,width:r.width,height:r.height,visible:fits(r),reachable:document.getElementById(id).contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};}),
                    styleBelowView:rect('style-neon').top>=document.querySelector('.view-controls').getBoundingClientRect().bottom,
                    compact:sonata.camera.compact,transportVisible:fits(transport),error:sonata.renderer.error,
                    boundVisible:b.width>0&&b.left>=w.left&&b.right<=w.right&&b.top>=w.top&&b.bottom<=w.bottom,
                    telemetryInPanel:document.getElementById('mobile-panel').contains(document.querySelector('.telemetry'))};
            })()`);
            assert.ok(layout.scrollWidth<=width,`Horizontal overflow at ${width} px`);
            assert.ok(layout.scrollHeight<=height,`Playback requires scrolling at ${width} px`);
            assert.ok(layout.compact&&layout.telemetryInPanel&&layout.transportVisible&&layout.boundVisible);
            assert.ok(layout.controls.every(c=>c.visible&&c.reachable&&c.width>=44&&c.height>=44),JSON.stringify(layout.controls));
            assert.ok(layout.styleBelowView,"Appearance controls did not fit below the view controls");
            assert.equal(layout.error,0);layouts.push(layout);await capture(name);
            // 実際のタッチで両方を選び、再生時刻を保ったまま選択表示が切り替わる。
            const cycle=await js("sonata.cycle");
            for(const key of [visualStyle==="blocks"?"neon":"blocks",visualStyle]){
                const point=await js(`(()=>{const r=document.getElementById('style-'+${JSON.stringify(key)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
                await command("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{...point,id:9}]});
                await command("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});await settle();
                assert.equal(await js("sonata.visualStyle"),key,"Style button did not receive touch input");
                assert.equal(await js("sonata.cycle"),cycle,"Touching a style changed the trace cycle");
                assert.ok(await js(`document.querySelectorAll('[data-style-choice][aria-pressed=true]').length===1&&document.getElementById('style-'+${JSON.stringify(key)}).getAttribute('aria-pressed')==='true'`),"Style buttons lost their selection state");
            }
        }
        window.setContentSize(390,844);
        await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
        await delay(600);
        const center=await js(`(()=>{const r=document.getElementById('scene').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
        const point=(id,x,y)=>({id,x,y,radiusX:5,radiusY:5,force:1});
        const pair=(half,dx=0,dy=0)=>[point(1,center.x-half+dx,center.y+dy),point(2,center.x+half+dx,center.y+dy)];
        const touch=(type,touchPoints)=>command("Input.dispatchTouchEvent",{type,touchPoints});
        const before=await js("sonata.camera");
        await touch("touchStart",pair(40));
        for(let i=1;i<=5;i++){await touch("touchMove",pair(40+i*8));await settle();}
        const pinched=await js("sonata.camera");
        assert.ok(pinched.targetRadius<before.targetRadius*.7,"Pinch did not enlarge the pipeline");
        // 表示角は直前のカメラ補間で微小に変わり得る。ピンチが回転の目標を動かさないことを検査する。
        assert.equal(pinched.targetAzimuth,before.targetAzimuth,"Pinch accidentally orbited the camera");
        assert.equal(pinched.targetElevation,before.targetElevation,"Pinch accidentally tilted the camera");
        for(let i=1;i<=4;i++){await touch("touchMove",pair(80,i*8,0));await settle();}
        const panned=await js("sonata.camera");
        assert.ok(Math.hypot(...panned.targetFocus.map((v,i)=>v-pinched.targetFocus[i]))>.5,"Two-finger movement did not pan");
        assert.ok(Math.abs(panned.targetRadius-pinched.targetRadius)<.001,"A parallel pan changed zoom");
        await touch("touchEnd",[pair(80,32)[1]]);
        await touch("touchEnd",[]);
        await delay(1100);await settle();
        assert.equal(await js("sonata.camera.pointers"),0,"Lifting touch points left a stale gesture");
        await capture("-zoom");
        const angle=await js("sonata.camera.azimuth");
        await touch("touchStart",[point(3,center.x,center.y)]);
        await touch("touchMove",[point(3,center.x+25,center.y+10)]);
        await touch("touchCancel",[]);await delay(600);
        assert.ok(Math.abs(await js("sonata.camera.azimuth")-angle)>.03,"One-finger orbit did not work after pinch");
        assert.equal(await js("sonata.camera.pointers"),0,"Canceled touch left a stale gesture");
        await js("document.getElementById('zoom-fit').click()");await delay(900);
        assert.deepEqual(await js("sonata.camera.targetFocus"),[0,0,0]);
        assert.equal(await js("sonata.camera.targetRadius"),32.5);

        // 細部まで近づける新しい上限を、実際のピンチ操作でも確認する。
        await touch("touchStart",pair(8));
        for(let i=1;i<=6;i++){await touch("touchMove",pair(8+i*20));await settle();}
        assert.equal(await js("sonata.camera.targetRadius"),3,"Pinch kept the old zoom limit");
        await touch("touchEnd",[]);
        await js("document.getElementById('zoom-fit').click()");
        assert.equal(await js("sonata.camera.targetRadius"),32.5,"Fit did not reset detailed pinch zoom");

        const cycle=await js("sonata.cycle"),playing=await js("sonata.playing");
        // ネイティブ button の Space 入力で切り替え、再生ショートカットとの干渉を検出する。
        for(const key of [visualStyle==="blocks"?"neon":"blocks",visualStyle]){
            await js(`document.getElementById('style-'+${JSON.stringify(key)}).focus()`);
            window.webContents.sendInputEvent({type:"keyDown",keyCode:"Space"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Space"});
            const deadline=Date.now()+5000;
            while(await js("sonata.visualStyle")!==key&&Date.now()<deadline)await delay(50);
            assert.equal(await js("sonata.visualStyle"),key,"Style button did not receive keyboard input");
            assert.equal(await js("sonata.cycle"),cycle,"Style button also stepped the trace");
            assert.equal(await js("sonata.playing"),playing,"Style button also toggled playback");
        }
        await js("document.getElementById('mobile-details').click()");
        assert.ok(await js("document.getElementById('mobile-panel').open&&document.getElementById('mobile-panel').contains(document.activeElement)"));
        await js("document.getElementById('license-open').scrollIntoView();document.getElementById('license-open').click()");
        assert.ok(await js(`(()=>{const panel=document.getElementById('license-panel'),r=panel.getBoundingClientRect();return panel.open&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&panel.scrollWidth<=panel.clientWidth;})()`),"License notices overflow the phone viewport");
        await settle();await capture("-licenses");
        await js("document.querySelector('#license-panel button').click();document.getElementById('mobile-panel').scrollTop=0");
        assert.ok(await js("!document.getElementById('license-panel').open&&document.getElementById('mobile-panel').open"));
        const keys=await js("embeddedFlowTraces.map(t=>t.key)");
        for(const key of keys){
            await js(`(()=>{const select=document.getElementById('trace-select');select.value=${JSON.stringify(key)};select.dispatchEvent(new Event('change'));})()`);
            assert.ok(await js(`document.getElementById('mobile-demo').textContent===sonata.trace.label
                &&document.getElementById('mobile-simulator').textContent===sonata.trace.demo.provenance.simulator
                &&document.getElementById('mobile-workload').textContent===sonata.trace.demo.provenance.workload`));
        }
        await js("sonata.loadTrace('memory-tide');sonata.captureAt(4068.6);document.getElementById('run-details').open=true");
        await settle();await capture("-settings");
        assert.ok(await js("document.getElementById('mobile-panel').scrollWidth<=document.getElementById('mobile-panel').clientWidth"),"Run details overflow the sheet");
        await js("document.getElementById('run-details').open=false;document.getElementById('mobile-close').click()");
        assert.ok(await js("!document.getElementById('mobile-panel').open"));
        await settle();await capture("-flush");
        await js("document.querySelector('[data-view=cinema]').click()");await delay(500);
        assert.ok(await js("document.getElementById('play').getBoundingClientRect().bottom<=innerHeight"),"Cinema lost playback controls");
        await js("document.getElementById('mobile-details').click();document.getElementById('show-highlight').click()");
        assert.ok(await js("!document.getElementById('mobile-panel').open&&sonata.playing"),"Highlight stayed hidden behind the sheet");
        await js("sonata.setPlaying(false);document.querySelector('[data-view=orbit]').click()");
        // パネルを開いたままデスクトップへ戻す場合も、表示とフォーカスが取り残されない。
        await js("document.getElementById('mobile-details').click()");
        assert.ok(await js("document.getElementById('mobile-panel').open"));
        result={layouts,touch:{pinch:true,detailZoom:true,pan:true,orbit:true,cancel:true,fit:true},demos:keys.length};
    }finally{
        try{
            window.setContentSize(1440,1000);
            await command("Emulation.clearDeviceMetricsOverride");
            await command("Emulation.setTouchEmulationEnabled",{enabled:false});
        }finally{
            debuggerAPI.detach();
        }
    }
    // ネイティブウィンドウ、viewport、media query の反映を実状態で待つ。
    // 本体の検査が失敗した場合はここへ進まず、後始末の assertion で原因を隠さない。
    const deadline=Date.now()+5000;
    let desktop;
    do{
        desktop=await js(`({width:innerWidth,height:innerHeight,compact:sonata.camera.compact,
            sidebarInMain:document.querySelector('main').contains(document.querySelector('.telemetry')),
            panelOpen:document.getElementById('mobile-panel').open,
            focusInClosedPanel:document.getElementById('mobile-panel').contains(document.activeElement)})`);
        if(desktop.width===1440&&desktop.height===1000&&!desktop.compact&&desktop.sidebarInMain&&!desktop.panelOpen&&!desktop.focusInClosedPanel){
            return {...result,desktopRestore:desktop};
        }
        await delay(60);
    }while(Date.now()<deadline);
    assert.fail(`Desktop sidebar did not return after rotation / resize: ${JSON.stringify(desktop)}`);
};

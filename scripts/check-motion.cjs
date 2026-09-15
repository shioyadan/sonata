"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBrowserTest, waitFor: waitUntil, delay, loadPage } = require("./load-test.cjs")("browser-test.cts");

// OS設定と明示的な演出の切替え・再読込みを検査する。
module.exports = async function reviewMotion(window, entry, screenshots) {
    const js = (source) => window.webContents.executeJavaScript(source);
    const browserTest = createBrowserTest(window);
    const settle = () => browserTest.settle({ finish: true });
    const waitFor = (source, message) => waitUntil(() => js(source), message, { timeout: 5000, interval: 60 });
    // OS が動きを減らす設定でも、操作なしで再生・演出が始まることを確認する。
    window.setSize(1440, 1000);
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await loadPage(window, entry);
    await waitUntil(
        () => js("!!globalThis.sonata?.hasTrace && sonata.trace.key==='rename-rush'"),
        "The initial sample did not load"
    );
    assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
    assert.equal(await js("sonata.playing"), true, "Playback must start without an enable action");
    assert.equal(
        await js("document.getElementById('motion-effects').getAttribute('aria-pressed')"),
        "true",
        "Motion effects must start enabled"
    );
    assert.equal(
        await js("document.getElementById('auto-camera').getAttribute('aria-pressed')"),
        "true",
        "Auto orbit must start enabled"
    );
    assert.equal(
        await js("document.getElementById('motion-notice').hidden"),
        true,
        "Default playback displayed an enable prompt"
    );
    const automaticStart = await js("sonata.cycle");
    await waitFor(`sonata.cycle>${automaticStart}`, "Default playback clock did not advance");
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    assert.ok(await js("sonata.codeFragments.length>40"), "Default motion did not animate code unraveling");
    // ユーザーが手動で OFF にした場合は、従来どおり CODE SQUASH に留める。
    await js("document.getElementById('motion-effects').click()");
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    assert.equal(await js("sonata.codeRewind.phase"), "notice");
    assert.deepEqual(await js("sonata.codeFragments"), []);
    assert.equal(await js("document.getElementById('motion-notice').hidden"), false);
    const reducedBound = await browserTest.sampleFrame(() =>
        js(`new Promise(resolve=>{
        sonata.captureAt(sonata.trace.firstCycle+2.95);sonata.setPlaying(true);
        function frame(){if(sonata.cycle>=sonata.trace.firstCycle+3.1){
            sonata.setPlaying(false);resolve({actual:sonata.topDown.shares,visual:sonata.topDownVisual.shares});
        }else requestAnimationFrame(frame);}requestAnimationFrame(frame);
    })`)
    );
    assert.deepEqual(reducedBound.visual, reducedBound.actual, "Reduced motion smoothed Top-down values");
    await js("sonata.captureAt(sonata.flushEvents[0]+2.1)");
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-reduced-motion.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    const enable =
        await js(`(()=>{const button=document.getElementById('enable-animation'),r=button.getBoundingClientRect();
        const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
        return {x,y,reachable:document.elementFromPoint(x,y)===button};})()`);
    assert.equal(enable.reachable, true, "Enable animation button is covered by the scene");
    window.webContents.sendInputEvent({
        type: "mouseDown",
        x: enable.x,
        y: enable.y,
        button: "left",
        clickCount: 1
    });
    window.webContents.sendInputEvent({ type: "mouseUp", x: enable.x, y: enable.y, button: "left", clickCount: 1 });
    await waitFor(
        "sonata.playing && document.getElementById('motion-notice').hidden",
        "Enable animation did not resume playback"
    );
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
    const motion = await js(`({systemReduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        enabled:document.getElementById('motion-effects').getAttribute('aria-pressed'),
        phase:sonata.codeRewind.phase,glyphs:sonata.codeFragments.length})`);
    assert.equal(motion.systemReduced, true, "The page must only override its own effects");
    assert.equal(motion.enabled, "true");
    assert.equal(motion.phase, "discard");
    assert.ok(motion.glyphs > 40);
    await settle();
    fs.writeFileSync(
        path.join(screenshots, "sonata-motion-enabled.png"),
        (await window.webContents.capturePage()).toPNG()
    );
    await js("document.getElementById('motion-effects').click()");
    assert.equal(await js("sonata.codeRewind.phase"), "notice");
    assert.deepEqual(await js("sonata.codeFragments"), [], "Disabling motion left unraveling letters visible");
    await js("document.getElementById('motion-effects').click()");
    assert.ok(await js("sonata.codeFragments.length>40"), "Motion toggle did not restore the code animation");
    await js("document.getElementById('motion-effects').click()");
    await loadPage(window, entry);
    await waitUntil(
        () => js("!!globalThis.sonata?.hasTrace && sonata.trace.key==='rename-rush'"),
        "The initial sample did not load"
    );
    assert.equal(
        await js(
            "sonata.playing&&document.getElementById('motion-effects').getAttribute('aria-pressed')==='true'&&document.getElementById('motion-notice').hidden"
        ),
        true,
        "Reload did not restore the default animation and playback"
    );
    window.webContents.debugger.detach();
    return { ...motion, reducedMotionExact: true };
};

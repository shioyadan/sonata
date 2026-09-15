"use strict";
// ビルド済み HTML とサンプルを HTTP で開き、Jump to flush 後の通常再生を撮影する。
// xvfb-run -a -s '-screen 0 1600x1100x24' node_modules/.bin/electron --no-sandbox scripts/capture-flush.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createServer } = require("./serve.cjs");
const { waitFor } = require("./load-test.cjs")("browser-test.cts");
const root = path.resolve(__dirname, "..");
const htmlPath = path.join(root, "dist/sonata.html");
const output = path.join(root, "artifacts/screenshots/flush-capture");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.whenReady()
    .then(async () => {
        fs.mkdirSync(output, { recursive: true });
        const server = createServer(htmlPath);
        let window;
        try {
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const entry = `http://127.0.0.1:${server.address().port}/sonata.html#demo=branch-storm`;
            window = new BrowserWindow({
                width: 1440,
                height: 1000,
                show: true,
                webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
            });
            const js = (source) => window.webContents.executeJavaScript(source);
            await window.loadURL(entry);
            await waitFor(
                () => js("globalThis.sonata?.hasTrace && sonata.trace.key === 'branch-storm'"),
                "Flush capture demo did not initialize"
            );
            const settings = await js(`({reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
        instructionStream:document.getElementById('instruction-stream').getAttribute('aria-pressed'),
        autoOrbit:document.getElementById('auto-camera').getAttribute('aria-pressed')})`);
            await js("document.getElementById('next-flush').click()");
            const captures = [];
            for (const [name, age] of [
                ["rewind", 0.6],
                ["unravel", 2.1]
            ]) {
                await js(`new Promise((resolve,reject)=>{
            const deadline=performance.now()+30000;
            function frame(){
                if(sonata.codeRewind.time!==null && sonata.codeRewind.age>=${age}){
                    sonata.setPlaying(false);sonata.setCycle(sonata.cycle);resolve();
                }else if(performance.now()>deadline)reject(new Error('Playback did not reach the capture point'));
                else requestAnimationFrame(frame);
            }
            frame();
        })`);
                await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
                await js("document.getElementById('scene').getContext('webgl2').finish()");
                fs.writeFileSync(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
                if (name === "unravel") {
                    const rect = await js(`(()=>{const r=document.getElementById('scene').getBoundingClientRect();
                return {x:Math.round(r.left),y:Math.round(r.top+165),width:440,height:470};})()`);
                    fs.writeFileSync(
                        path.join(output, "unravel-detail.png"),
                        (await window.webContents.capturePage(rect)).toPNG()
                    );
                }
                captures.push(
                    await js(`({name:${JSON.stringify(name)},cycle:sonata.cycle,phase:sonata.codeRewind.phase,
            canceledRows:sonata.instructionFeed.filter(r=>r.canceled).length,glyphs:sonata.codeFragments.length,
            label:document.getElementById('instruction-stream-label').textContent,error:sonata.renderer.error})`)
                );
                if (name === "rewind") await js("document.getElementById('play').click()");
            }
            const report = {
                entry,
                sha256: createHash("sha256").update(fs.readFileSync(htmlPath)).digest("hex"),
                settings,
                captures
            };
            fs.writeFileSync(path.join(output, "capture.json"), JSON.stringify(report, null, 2) + "\n");
            console.log(JSON.stringify(report, null, 2));
        } finally {
            if (window && !window.isDestroyed()) window.destroy();
            if (server.listening)
                await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
        app.quit();
    })
    .catch((error) => {
        console.error(error);
        app.exit(1);
    });

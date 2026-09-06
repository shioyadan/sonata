/* Sonata — an independent, dependency-free WebGL 2 processor trace visualizer.
 * Trace stages and occupancy come from ../data/traces.js.
 * Geometry, light trails, orbital motion and shockwaves are illustrative.
 */
(() => {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const canvas = $("scene");
    // Antialias the offscreen scene; the canvas itself only receives a full-screen composite.
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) {
        $("fallback").hidden = false;
        $("renderer-status").textContent = "WebGL 2 unavailable";
        return;
    }
    const colorSamples=gl.getInternalformatParameter(gl.RENDERBUFFER,gl.RGBA8,gl.SAMPLES);
    const depthSamples=gl.getInternalformatParameter(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,gl.SAMPLES);
    const msaaSamples=Math.max(0,...Array.from(colorSamples).filter(n=>n<=4&&depthSamples.includes(n)));
    const maxRenderSide=Math.min(8192,gl.getParameter(gl.MAX_TEXTURE_SIZE),gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    const C = { integer: [0.29, 1, 0.81], memory: [1, 0.60, 0.22], branch: [0.62, 0.43, 1], red: [1, 0.19, 0.36], blue: [0.30, 0.64, 1], floor: [0.08, 0.19, 0.24] };
    const boundStyles = {
        active: { label:"Pipeline active",color:"#71f5db",context:"Recent allocations in flight or already committed",region:[-12.7,12.6,-6.1,6.8] },
        retiring: { label:"Retiring",color:"#71f5db",context:"Allocation slots with commit already observed",region:[-12.7,12.6,-6.1,6.8] },
        inFlight: { label:"In flight",color:"#53b7af",context:"Allocated work whose outcome is not yet known" },
        badSpeculation: { label:"Bad speculation",color:"#ff6277",context:"Wrong-path allocation + recovery bubbles",region:[-12.7,8.5,-6.1,6.8] },
        frontend: { label:"Frontend bound",color:"#80b7ff",context:"Frontend delivery limits allocation",region:[-12.7,-5.5,-2.2,2.2] },
        backend: { label:"Backend bound",color:"#ffbb65",context:"Backend capacity limits allocation",region:[-5.5,8.5,-6.1,6.8] },
        unresolved: { label:"Unresolved",color:"#8aa9b9",context:"Allocation slots with incomplete trace evidence" },
        mixed: { label:"Mixed",color:"#b0bfc8",context:"Several categories share the largest allocation share" },
        unavailable: { label:"Not classified",color:"#76838f",context:"Top-down classification is unavailable for this trace" }
    };
    const boundKeys = ["retiring","inFlight","badSpeculation","frontend","backend","unresolved"];
    const boundRGB = key => boundStyles[key].color.slice(1).match(/../g).map(v=>parseInt(v,16)/255);
    const TAU = Math.PI * 2;
    const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
    const mix = (a, b, t) => a + (b - a) * t;
    const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
    const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
    const samples = globalThis.embeddedFlowTraces;
    let reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let trace, ops = [], nodes = new Map(), connections = [], flushEvents = [], activity = [],commitGroups=new Map();
    let transferProfile=new Map(),lastPlayback={seconds:0,cycles:0,rate:1};
    let robReplay, memoryEvents = [], activeNotifications = [], branchRecoveries = [], activeBranches = [];
    let dependencyReplay,matrixState,registerReplay,registerState,physicalElements=new Map(),registerTags=[],registerReads=[],renameWords=[];
    let feedOps = [], fetchGroups = [], feedVisible = [], codeFragments = [], instructionStream = true, feedReplay, feedState;
    const feedRows = 24, feedLead = .7;
    const wakeFlightCycles = 1.2, wakeEffectCycles = 2.8;
    let cycle = 0, playing = !reducedMotion, speed = 4, bloom = 1.7, trails = true, autoOrbit = !reducedMotion;
    let selectedID = null, currentStats = {}, visibleParticles = [], contextLost = false;
    let renderWidth = 0, renderHeight = 0, cssWidth = 0, cssHeight = 0, pixelRatio = 1;
    let cameraMode = "orbit", azimuth = 0.20, elevation = 0.73, radius = 32.5;
    let targetAzimuth = azimuth, targetElevation = elevation, targetRadius = radius;
    let focus=[0,0,0],targetFocus=[0,0,0];
    const compactMedia=matchMedia("(max-width:760px), (max-width:1000px) and (max-height:600px)");
    let lastTime = performance.now(), artTime = 0, frameCount = 0, fpsTime = lastTime, fps = 0, nextUI = 0;
    let viewProjection = new Float32Array(16), eye = [0, 20, 30];
    let sceneTarget, sceneMultisample, bloomA, bloomB, staticTriangles, staticLines, staticStars;
    let animationID;
    let sceneTopDown={available:false},topDownRegion=null,topDownRail=[];
    let boundDisplay={trace:null,shares:null,weights:{},color:boundRGB("unavailable")};

    // Small column-major matrix toolkit keeps the experiment usable offline.
    const normalize = (a) => { const n = Math.hypot(...a) || 1; return a.map((v) => v / n); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
    function multiply(a, b) {
        const out = new Float32Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
        }
        return out;
    }
    function perspective(aspect) {
        const f = 1 / Math.tan(0.66 / 2), near = 0.1, far = 600;
        return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
    }
    function lookAt(from, target) {
        const z = normalize(from.map((v, i) => v - target[i]));
        const x = normalize(cross([0, 1, 0], z));
        const y = cross(z, x);
        return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, from), -dot(y, from), -dot(z, from), 1]);
    }
    function project(p) {
        const m = viewProjection;
        const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        return [(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w * cssWidth / 2 + cssWidth / 2,
            -(m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w * cssHeight / 2 + cssHeight / 2, w];
    }

    function program(vertex, fragment) {
        const shaders = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            return shader;
        });
        const p = gl.createProgram();
        shaders.forEach((s) => gl.attachShader(p, s)); gl.linkProgram(p);
        shaders.forEach((s) => gl.deleteShader(s));
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const uniforms = new Map();
        return { p, u(name) { if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(p, name)); return uniforms.get(name); } };
    }
    const solidProgram = program(`#version 300 es
        layout(location=0) in vec3 aPosition;
        layout(location=1) in vec4 aColor;
        uniform mat4 uMatrix;
        out vec4 vColor;
        void main(){gl_Position=uMatrix*vec4(aPosition,1.);vColor=aColor;}`, `#version 300 es
        precision highp float;
        in vec4 vColor;out vec4 frag;
        void main(){frag=vColor;}`);
    const pointProgram = program(`#version 300 es
        layout(location=0) in vec3 aPosition;
        layout(location=1) in vec4 aColor;
        layout(location=2) in float aSize;
        uniform mat4 uMatrix;uniform float uScale;
        out vec4 vColor;out float vSize;
        void main(){gl_Position=uMatrix*vec4(aPosition,1.);vSize=clamp(aSize*uScale/gl_Position.w,2.,256.);gl_PointSize=vSize;vColor=aColor;}`, `#version 300 es
        precision highp float;
        in vec4 vColor;in float vSize;out vec4 frag;
        void main(){vec2 p=gl_PointCoord*2.-1.;float d=length(p);
            float footprint=2./vSize,k=48./(1.+48.*footprint*footprint/6.);
            float glow=exp(-d*d*6.)*.30,core=exp(-d*d*k)*k/48.;
            float edge=1.-smoothstep(1.-footprint,1.,d);
            frag=vec4(vColor.rgb+core*.35,(glow+core*.85)*vColor.a*edge);}`);
    const typeProgram = program(`#version 300 es
        layout(location=0) in vec3 aPosition;layout(location=1) in vec4 aColor;layout(location=2) in vec2 aUV;
        uniform mat4 uMatrix;out vec4 vColor;out vec2 vUV;
        void main(){gl_Position=uMatrix*vec4(aPosition,1.);vColor=aColor;vUV=aUV;}`, `#version 300 es
        precision highp float;in vec4 vColor;in vec2 vUV;uniform sampler2D uGlyphs;out vec4 frag;
        void main(){float ink=texture(uGlyphs,vUV).a;frag=vec4(vColor.rgb,vColor.a*ink);}`);
    const screenVertex = `#version 300 es
        out vec2 vUV;
        void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);vUV=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
    const blurProgram = program(screenVertex, `#version 300 es
        precision highp float;in vec2 vUV;out vec4 frag;
        uniform sampler2D uTexture;uniform vec2 uDirection;uniform float uExtract;
        vec3 sampleLight(vec2 uv){vec3 c=texture(uTexture,uv).rgb;return mix(c,max(c-vec3(.12),vec3(0.)),uExtract);}
        void main(){vec3 c=sampleLight(vUV)*.227027;
            c+=(sampleLight(vUV+uDirection*1.384615)+sampleLight(vUV-uDirection*1.384615))*.316216;
            c+=(sampleLight(vUV+uDirection*3.230769)+sampleLight(vUV-uDirection*3.230769))*.070270;
            frag=vec4(c,1.);}`);
    const compositeProgram = program(screenVertex, `#version 300 es
        precision highp float;in vec2 vUV;out vec4 frag;
        uniform sampler2D uScene;uniform sampler2D uBloom;uniform float uBloomAmount;
        uniform float uTime;uniform float uShock;uniform vec2 uResolution;uniform float uPixelRatio;
        float noise(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
        void main(){vec2 uv=vUV;vec2 q=uv-.5;float r=length(q);
            float wave=sin(r*65.-uShock*15.)*.0016*uShock;
            uv+=normalize(q+vec2(.0001))*wave;
            vec2 aberration=q*uShock*1.4*uPixelRatio/uResolution;
            vec3 c=vec3(texture(uScene,uv+aberration).r,texture(uScene,uv).g,texture(uScene,uv-aberration).b);
            vec3 light=texture(uBloom,uv).rgb*uBloomAmount;
            c+=light*1.18;
            vec3 haze=vec3(.01,.046,.055)*exp(-length((uv-vec2(.48,.45))*vec2(1.,1.4))*3.);
            float mist=sin(uv.x*8.+sin(uv.y*6.+uTime*.04))*sin(uv.y*4.-uTime*.03)*.5+.5;
            haze+=mix(vec3(.006,.028,.04),vec3(.028,.009,.048),uv.x)*mist*exp(-r*2.5);
            c+=haze;c*=1.-smoothstep(.2,.82,r)*.42;
            c=vec3(1.)-exp(-c*1.25);c=pow(c,vec3(.9));
            c+=(noise(gl_FragCoord.xy+floor(uTime*17.))-.5)*.0015;
            c+=vec3(.15,.012,.032)*uShock*.16;
            frag=vec4(c,1.);}`);

    function buffer(data, points = false, dynamic = false) {
        const vao = gl.createVertexArray(), vbo = gl.createBuffer();
        gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        const stride = points ? 8 : 7;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride * 4, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride * 4, 12);
        if (points) { gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride * 4, 28); }
        return { vao, vbo, count: data.length / stride, stride };
    }
    function upload(b, data) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
        b.count = data.length / b.stride;
    }
    function deleteBuffer(b) { if (b) { gl.deleteBuffer(b.vbo); gl.deleteVertexArray(b.vao); } }
    const movingLines = buffer([], false, true), particles = buffer([], true, true);
    const analysisSurface = buffer([], false, true),registerSurface = buffer([], false, true);
    // A high-resolution atlas with mipmaps preserves glyph coverage as the ribbon shrinks.
    const glyphCanvas=document.createElement("canvas");glyphCanvas.width=1536;glyphCanvas.height=960;
    const glyphContext=glyphCanvas.getContext("2d");
    glyphContext.font="bold 128px monospace";glyphContext.fillStyle="white";glyphContext.textBaseline="middle";glyphContext.textAlign="center";
    for(let i=0;i<95;i++)glyphContext.fillText(String.fromCharCode(i+32),(i%16)*96+48,Math.floor(i/16)*160+80);
    const glyphTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,glyphTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,glyphCanvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    const feedType={vao:gl.createVertexArray(),vbo:gl.createBuffer(),count:0,stride:9};
    const unravelType={vao:gl.createVertexArray(),vbo:gl.createBuffer(),count:0,stride:9};
    for(const b of [feedType,unravelType]){
        gl.bindVertexArray(b.vao);gl.bindBuffer(gl.ARRAY_BUFFER,b.vbo);
        for(const [location,size,offset] of [[0,3,0],[1,4,12],[2,2,28]]){
            gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,36,offset);
        }
    }
    function target(w, h, depth = false) {
        const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        let depthBuffer;
        if (depth) {
            depthBuffer = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        }
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Unable to allocate render target.");
        return { texture, fbo, depthBuffer, w, h };
    }
    function destroyTarget(t) {
        if (!t) return;
        if(t.texture)gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.fbo);
        if (t.depthBuffer) gl.deleteRenderbuffer(t.depthBuffer);
        if (t.colorBuffer) gl.deleteRenderbuffer(t.colorBuffer);
    }
    function multisampleTarget(w,h) {
        const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
        const colorBuffer=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,colorBuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER,msaaSamples,gl.RGBA8,w,h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,colorBuffer);
        const depthBuffer=gl.createRenderbuffer();gl.bindRenderbuffer(gl.RENDERBUFFER,depthBuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER,msaaSamples,gl.DEPTH_COMPONENT16,w,h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depthBuffer);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error("Unable to allocate multisample render target.");
        return {fbo,colorBuffer,depthBuffer,w,h};
    }
    function resize() {
        cssWidth = Math.max(1, canvas.clientWidth); cssHeight = Math.max(1, canvas.clientHeight);
        pixelRatio = Math.min(devicePixelRatio || 1, 2.5, Math.sqrt(8388608/(cssWidth*cssHeight)), maxRenderSide/cssWidth, maxRenderSide/cssHeight);
        const w = Math.round(cssWidth * pixelRatio), h = Math.round(cssHeight * pixelRatio);
        if (w === renderWidth && h === renderHeight) return;
        renderWidth = canvas.width = w; renderHeight = canvas.height = h;
        [sceneTarget, sceneMultisample, bloomA, bloomB].forEach(destroyTarget);
        sceneTarget = target(w, h, true);
        sceneMultisample = msaaSamples?multisampleTarget(w,h):null;
        bloomA = target(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
        bloomB = target(bloomA.w, bloomA.h);
        drawTimeline();
    }

    function vertex(out, p, color, alpha = 1) { out.push(...p, ...color, alpha); }
    function line(out, a, b, color, alpha = 1) { vertex(out, a, color, alpha); vertex(out, b, color, alpha); }
    function point(out, p, color, size, alpha = 1) { out.push(...p, ...color, alpha, size); }
    function ring(out, x, y, z, radius, color, alpha = 1, start = 0, end = TAU, segments = 80) {
        for (let i = 0; i < segments; i++) {
            const a = mix(start, end, i / segments), b = mix(start, end, (i + 1) / segments);
            line(out, [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius], [x + Math.cos(b) * radius, y, z + Math.sin(b) * radius], color, alpha);
        }
    }
    function box(tris, lines, x, y, z, w, h, d, color, glow = .55) {
        const p = [[x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y,z+d/2],[x-w/2,y,z+d/2],
            [x-w/2,y+h,z-d/2],[x+w/2,y+h,z-d/2],[x+w/2,y+h,z+d/2],[x-w/2,y+h,z+d/2]];
        const faces = [[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7],[3,2,1,0]];
        faces.forEach((f, i) => {
            const shade = i === 4 ? .11 : .035 + i * .006;
            const c = color.map((v, axis) => v * shade + [.009, .018, .024][axis]);
            for (const j of [0,1,2,0,2,3]) vertex(tris, p[f[j]], c);
        });
        for (const [a,b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) line(lines, p[a], p[b], color, glow);
    }
    function housing(tris, lines, x, y, z, w, h, d, color, glow=.4) {
        const bevel=Math.min(.12,h*.3),cut=Math.min(.22,w*.13,d*.13);
        const rim=(inset,height)=>{
            const a=w/2-inset,b=d/2-inset,c=cut*.7;
            return [[-a+c,-b],[a-c,-b],[a,-b+c],[a,b-c],[a-c,b],[-a+c,b],[-a,b-c],[-a,-b+c]].map(([dx,dz])=>[x+dx,height,z+dz]);
        };
        const bottom=rim(0,y),shoulder=rim(0,y+h-bevel),top=rim(bevel,y+h);
        const face=(p,c)=>{for(const k of [0,1,2,0,2,3])vertex(tris,p[k],c);};
        for(let i=0;i<8;i++){
            const j=(i+1)%8,side=color.map((v,k)=>[.016,.027,.034][k]+v*(i%2?.035:.022));
            face([bottom[i],bottom[j],shoulder[j],shoulder[i]],side);
            face([shoulder[i],shoulder[j],top[j],top[i]],color.map((v,k)=>[.025,.038,.045][k]+v*.09));
            for(const p of [[x,y+h,z],top[i],top[j]])vertex(tris,p,color.map((v,k)=>[.023,.036,.044][k]+v*.035));
            line(lines,top[i],top[j],color,glow);
            line(lines,bottom[i],bottom[j],color,glow*.3);
            if(i%2===0)line(lines,bottom[i],shoulder[i],color,glow*.35);
        }
    }
    // Geometry, light guides and actual instruction positions share these lane endpoints.
    // The lane assignment is illustrative: the excerpts do not identify physical pipes.
    function executionLane(node, index) {
        const pitch=Math.min(.72,(node.d-.65)/node.pipeCount),z=node.z+(index-(node.pipeCount-1)/2)*pitch;
        const y=node.h+.34,half=(node.w-.78)/2;
        return {inlet:[node.x-half,y,z],outlet:[node.x+half,y,z],radius:Math.min(.19,pitch*.31)};
    }
    function nodePort(node, output) {
        return node.pipeCount?[node.x+(output?1:-1)*(node.w/2+.12),node.h+.34,node.z]:[node.x,node.h+.26,node.z];
    }
    function linkPort(id,output,lane,count) {
        const n=nodes.get(id),offset=lane-(count-1)/2;
        if(!n)return [id==="input"?-15.6:15.8,.8,offset*.3];
        if(id==="commit"){const p=commitSlot(lane)[output?"outlet":"inlet"];return [n.x+(output?1:-1)*(n.w/2+.01),p[1],p[2]];}
        if(n.pipeCount){
            const position=count===1?(n.pipeCount-1)/2:lane*(n.pipeCount-1)/(count-1);
            const pipe=count>n.pipeCount?position:Math.round(position);
            const p=executionLane(n,pipe)[output?"outlet":"inlet"];
            return [n.x+(output?1:-1)*(n.w/2+.12),p[1],p[2]];
        }
        return [n.x+(output?1:-1)*(n.w/2+.01),n.h+.26,n.z+offset*Math.min(.3,(n.d-.6)/Math.max(1,count-1))];
    }
    function addConnection(from,to,color) {
        const peak=(transferProfile.get(`${from}>${to}`)??(from==="register-read"?transferProfile.get(`issue>${to}`):null))?.peak??0;
        // Capacity has the same source as the labels on the modules. An excerpt
        // can exercise fewer lanes; that observed peak is a separate diagnostic.
        const execution=nodes.get(from)?.pipeCount??nodes.get(to)?.pipeCount;
        const memoryPath=from==="memory-wait"||to==="memory-wait";
        const retiring=from==="commit"||to==="commit";
        const count=from==="issue"&&to==="register-read"?trace.structure.executionNodes.reduce((sum,n)=>sum+n.pipeCount,0):execution??(memoryPath?nodes.get("exec-memory").pipeCount:retiring?trace.retireWidth:to==="issue"?trace.structure.allocationWidth:trace.fetchWidth);
        const lanes=Array.from({length:count},(_,index)=>{
            const source=linkPort(from,true,index,count),target=linkPort(to,false,index,count);
            if(from==="register-read"&&nodes.get(to)?.pipeCount){source[1]=target[1];source[2]=target[2];}
            if(from==="issue"&&to==="register-read"){
                const ports=[...nodes.values()].filter(n=>n.pipeCount).flatMap(n=>Array.from({length:n.pipeCount},(_,i)=>executionLane(n,i).inlet)).sort((a,b)=>a[2]-b[2]);
                target[1]=ports[index][1];target[2]=ports[index][2];
            }
            return {source,target};
        });
        connections.push({from,to,color,peak,lanes});
    }
    function pipeCollar(lines,x,y,z,r,color,alpha) {
        for(let i=0;i<12;i++){
            const a=i/12*TAU,b=(i+1)/12*TAU;
            line(lines,[x,y+Math.sin(a)*r,z+Math.cos(a)*r],[x,y+Math.sin(b)*r,z+Math.cos(b)*r],color,alpha);
        }
    }
    function flowChevron(lines,x,y,z,size,color,alpha) {
        line(lines,[x-size*.6,y,z-size*.55],[x+size*.4,y,z],color,alpha);
        line(lines,[x+size*.4,y,z],[x-size*.6,y,z+size*.55],color,alpha);
    }
    function executionModule(tris,lines,node) {
        const {x,z,w,d,h,color}=node;
        housing(tris,lines,x,-.25,z,w+.2,.16,d+.2,color,.2);
        housing(tris,lines,x,-.05,z,w,h+.05,d,color,.23);
        // Recessed parallel conduits have an open upper shell, exposing their light cores.
        for(let k=0;k<node.pipeCount;k++){
            const {inlet:a,outlet:b,radius:r}=executionLane(node,k);
            housing(tris,lines,x,h+.01,a[2],b[0]-a[0]+.16,.09,r*2.5,color,.16);
            for(let j=6;j<12;j++){
                const u=j/12*TAU,v=(j+1)/12*TAU;
                const p=[[a[0],a[1]+Math.sin(u)*r,a[2]+Math.cos(u)*r],[b[0],b[1]+Math.sin(u)*r,b[2]+Math.cos(u)*r],
                    [b[0],b[1]+Math.sin(v)*r,b[2]+Math.cos(v)*r],[a[0],a[1]+Math.sin(v)*r,a[2]+Math.cos(v)*r]];
                for(const i of [0,1,2,0,2,3])vertex(tris,p[i],color.map((c,i)=>[.014,.025,.032][i]+c*.045));
            }
            for(const side of [-1,1])line(lines,[a[0],a[1],a[2]+side*r],[b[0],b[1],b[2]+side*r],color,.12);
            line(lines,a,b,color,.05);
            for(const t of node.compact?[0,1]:[0,.33,.67,1])pipeCollar(lines,mix(a[0],b[0],t),a[1],a[2],r,color,t===0||t===1?.23:.12);
            for(const t of node.compact?[.5]:[.28,.72])flowChevron(lines,mix(a[0],b[0],t),a[1]-.01,a[2],r*.7,color,.16);
            // Keep each connection aligned with its own pipe through both ports.
            const intake=[nodePort(node,false)[0],a[1],a[2]],outlet=[nodePort(node,true)[0],b[1],b[2]];
            for(const [from,to] of [[intake,a],[b,outlet]])
                for(let j=0;j<16;j++)line(lines,route(from,to,j/16),route(from,to,(j+1)/16),color,.09);
        }
        for(const side of [-1,1]){
            const railZ=z+side*(d/2-.13);
            housing(tris,lines,x,h+.015,railZ,w-.7,.12,.12,color,.16);
            for(const dx of [-w*.36,w*.36]){
                line(lines,[x+dx,-.12,z+side*d/2],[x+dx,-.12,z+side*(d/2+.25)],color,.28);
                flowChevron(lines,x+dx,h+.17,railZ,.2,color,.25);
            }
        }
    }
    function route(a, b, t) {
        // Cubic arcs join stage centres; their paths are visual, not physical wiring.
        const bend = Math.min(2, Math.abs(b[0] - a[0]) * .48), q = 1 - t;
        const c = [a[0] + bend, a[1] + .22, a[2]], d = [b[0] - bend, b[1] + .22, b[2]];
        return a.map((v, i) => q*q*q*v + 3*q*q*t*c[i] + 3*q*t*t*d[i] + t*t*t*b[i]);
    }
    function makeNode(id, label, x, z, w, d, h, color, detail) {
        const node = { id, label, x, z, w, d, h, color, detail };
        nodes.set(id, node);
        return node;
    }
    function matrixPosition(row,column=-1) {
        const n=nodes.get("issue"),columns=dependencyReplay.columnCount;
        return [n.x+(column<0?-.44:-.28+(column+.5)*.68/columns)*n.w,n.h+.23,
            n.z-n.w*.34+(row+.5)*n.w*.68/trace.structure.queueCapacity];
    }
    function crossesDependencyGrid(a,b=a) {
        const n=nodes.get("issue"),low=[n.x-n.w*.30,n.h+.06,n.z-n.w*.36],high=[n.x+n.w*.42,n.h+1.2,n.z+n.w*.36];
        return crossesBox(a,b,low,high);
    }
    function crossesMapWords(a,b=a){
        const n=renameNode();
        return n?.mapWords&&crossesBox(a,b,[n.x-n.w*.48,n.h+.06,n.z-n.d*.46],[n.x+n.w*.48,n.h+1.2,n.z+n.d*.46]);
    }
    function crossesBox(a,b,low,high){
        let enter=0,leave=1;
        for(let axis=0;axis<3;axis++){
            const delta=b[axis]-a[axis];
            if(Math.abs(delta)<1e-8){if(a[axis]<low[axis]||a[axis]>high[axis])return false;continue;}
            const t0=(low[axis]-a[axis])/delta,t1=(high[axis]-a[axis])/delta;
            enter=Math.max(enter,Math.min(t0,t1));leave=Math.min(leave,Math.max(t0,t1));
            if(enter>leave)return false;
        }
        return true;
    }
    function matrixModule(tris,lines,n) {
        housing(tris,lines,n.x,-.25,n.z,n.w+.2,.16,n.d+.2,C.blue,.22);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,C.blue,.3);
        const y=n.h+.08,x0=n.x-n.w*.28,x1=n.x+n.w*.40,z0=n.z-n.w*.34,z1=n.z+n.w*.34;
        for(let r=0;r<=trace.structure.queueCapacity;r++){
            const z=mix(z0,z1,r/trace.structure.queueCapacity);
            line(lines,[x0,y,z],[x1,y,z],C.blue,r%4===0?.15:.06);
        }
        for(let c=0;c<=dependencyReplay.columnCount;c++){
            const x=mix(x0,x1,c/dependencyReplay.columnCount);
            line(lines,[x,y,z0],[x,y,z1],C.blue,c%4===0?.15:.06);
        }
        for(const x of [x0,x1])line(lines,[x,y,z0],[x,y,z1],C.blue,.5);
        for(const z of [z0,z1])line(lines,[x0,y,z],[x1,y,z],C.blue,.5);
    }
    function drawDependencyMatrix(lines,points) {
        const n=nodes.get("issue"),byID=new Map(ops.map(op=>[op.id,op]));
        for(const row of matrixState.rows){
            const p=matrixPosition(row.slot),right=matrixPosition(row.slot,dependencyReplay.columnCount-1);
            const color=byID.get(row.id)?C[byID.get(row.id).kind]:C.blue;
            line(lines,p,right,color,row.ready?.15:.075);
            point(points,[right[0]+.14,right[1],right[2]],row.known?color:C.blue,5,row.ready?.85:.25);
        }
        for(const cell of matrixState.cells){
            const p=matrixPosition(cell.row,cell.column),color=C[byID.get(cell.consumer).kind];
            point(points,p,color,cell.waiting?7:11,cell.alpha*(cell.waiting?.8:1.2));
            const dx=Math.min(.045,n.w*.24/dependencyReplay.columnCount);
            line(lines,[p[0]-dx,p[1],p[2]],[p[0]+dx,p[1],p[2]],color,cell.alpha);
        }
        for(const dep of matrixState.external){
            const p=matrixPosition(dep.row),color=C[byID.get(dep.consumer).kind];
            point(points,[p[0]-.13,p[1],p[2]],color,dep.waiting?6:12,dep.alpha*(dep.waiting?.65:1.15));
        }
        for(const issue of matrixState.issues){
            const op=byID.get(issue.id),color=C[op.kind],fade=1-issue.progress;
            const path=issuePath(issue),rowProgress=clamp(issue.progress/.18);
            const head=path.origin.map((v,i)=>mix(v,path.exit[i],smooth(rowProgress)));
            // A short, quiet dash crosses the cells. Bloom belongs at the outlet.
            if(rowProgress<1)line(lines,[Math.max(path.origin[0],head[0]-.12),head[1],head[2]],head,color,fade*.24);
            else{
                point(points,path.exit,color,10,fade*.7);
                point(points,route(path.exit,path.port,smooth((issue.progress-.18)/.82)),color,16,fade*.85);
            }
            if(issue.column!==null){
                // The selected row leaves to the right; its selection signal wraps
                // around that edge and rises through the matching entry column.
                const progress=issue.progress<.3?clamp((issue.progress-.12)/.18)*2:2+clamp((issue.progress-.3)/.4);
                const columnGlow=smooth((issue.progress-.3)/.10)*(1-smooth((issue.progress-.68)/.32));
                for(let k=0;k<path.signal.length-1&&k<progress;k++){
                    const a=path.signal[k],b=path.signal[k+1],end=a.map((v,i)=>mix(v,b[i],clamp(progress-k)));
                    const inColumn=k===path.signal.length-2;
                    line(lines,a,end,color,inColumn?columnGlow*.75:fade*.55);
                    point(points,end,color,inColumn?8:10,inColumn?columnGlow*.85:fade*.75);
                }
                if(columnGlow>0){
                    const bottom=matrixPosition(trace.structure.queueCapacity-1,issue.column),top=matrixPosition(0,issue.column);
                    // Keep the selected column legible as one bright, thin stroke.
                    line(lines,bottom,top,color,columnGlow*.85);
                    for(const target of issue.targets)point(points,matrixPosition(target.row,issue.column),C[byID.get(target.id).kind],8,columnGlow*.95);
                }
            }
        }
        for(const event of matrixState.broadcasts){
            if(event.column!==null){
                const top=wakeColumnHead(event.column),bottom=matrixPosition(trace.structure.queueCapacity-1,event.column);
                const head=top.map((v,i)=>mix(v,bottom[i],smooth(event.progress)));
                line(lines,wakeBusEntry(),top,C.integer,(1-event.progress)*.8);
                line(lines,top,head,C.integer,(1-event.progress)*.65);point(points,head,C.integer,15,(1-event.progress)*.8);
            }else for(const row of event.rows){
                const p=matrixPosition(row),entry=[p[0]-.13,p[1],p[2]],bus=wakeBusEntry();
                line(lines,bus,[bus[0],entry[1],entry[2]],C.integer,(1-event.progress)*.5);
                line(lines,[bus[0],entry[1],entry[2]],entry,C.integer,(1-event.progress)*.8);
            }
        }
    }

    function renameNode(){return [...nodes.values()].find(n=>n.names?.includes("Rn"));}
    function renameWordLayout(index){
        const n=renameNode(),banks=Math.ceil(n.mapWords/8),bank=Math.floor(index/8),column=index%8;
        const pitch=n.d*.84/banks,z=n.z-n.d*.42+(bank+.5)*pitch;
        const bits=Math.max(1,Math.ceil(Math.log2((trace.evidence.registers.capacity??registerTags.at(-1)+1))));
        const x=n.x+(column-3.5)*n.w*.095,y=n.h+.23+bank*.018;
        // Word bars run along Z, perpendicular to instruction flow along X.
        return {bits,bank,start:[x,y,z-pitch*.32],end:[x,y,z+pitch*.32],halfWidth:n.w*.031};
    }
    function renameModule(tris,lines,n){
        housing(tris,lines,n.x,-.25,n.z,n.w+.18,.16,n.d+.16,C.blue,.25);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,C.blue,.35);
        const banks=Math.ceil(n.mapWords/8),pitch=n.d*.84/banks;
        // Four stacked groups of eight words form a physical RAT array on Rn.
        // The small cells hold the physical destination's binary address.
        for(let bank=0;bank<banks;bank++){
            const z=n.z-n.d*.42+(bank+.5)*pitch,y=n.h+.065+bank*.018;
            housing(tris,lines,n.x,y,z,n.w*.87,.14,pitch*.87,C.blue,.22);
            line(lines,[n.x-n.w*.40,y+.16,z-pitch*.40],[n.x+n.w*.40,y+.16,z-pitch*.40],C.blue,.3);
        }
        for(let index=0;index<n.mapWords;index++){
            const row=renameWordLayout(index);
            const [x,y,z0]=row.start,z1=row.end[2];
            const rim=[[x-row.halfWidth,y,z0],[x+row.halfWidth,y,z0],[x+row.halfWidth,y,z1],[x-row.halfWidth,y,z1]];
            for(let i=0;i<4;i++)line(lines,rim[i],rim[(i+1)%4],C.blue,.22);
        }
    }
    function drawRenameWords(tris,lines,points){
        renameWords=[];
        if(!renameNode()?.mapWords)return;
        const n=renameNode();
        registerState.rows.forEach((row,index)=>{
            const layout=renameWordLayout(index),{start,end,halfWidth,bits}=layout;
            const [x,y,z0]=start,z1=end[2];
            const restoring=row.event?.type==="restore",color=restoring&&row.pulse>0?C.red:C.blue;
            const previous=row.event?(restoring?row.event.physical:row.event.previous):row.physical;
            const progress=reducedMotion?1:row.event?smooth((cycle-row.event.cycle)/.8):1;
            const known=row.physical!==null,active=row.pulse>0&&!row.constant&&previous!==row.physical;
            const sweep=mix(z0,z1,restoring?1-progress:progress),cells=[];
            // A single bar is one logical register. Address bits are quiet marks
            // inside it, without individual boxes that resemble extra registers.
            const bar=[[x-halfWidth,y+.005,z0],[x+halfWidth,y+.005,z0],[x+halfWidth,y+.005,z1],[x-halfWidth,y+.005,z1]];
            for(const i of [0,1,2,0,2,3])vertex(tris,bar[i],color,known?.10:.012);
            for(let bit=0;bit<bits;bit++){
                const z=mix(z0,z1,(bit+.5)/bits),halfDepth=(z1-z0)/bits*.34;
                const replaced=progress>=1||(restoring?z>=sweep:z<=sweep);
                const physical=active&&!replaced?previous:row.physical;
                const value=physical==null||row.constant?null:(physical>>(bits-bit-1))&1;
                const fill=value===1?.17+(active&&replaced?row.pulse*.15:0):0;
                const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx,dz])=>[x+dx*halfWidth*.78,y+.012,z+dz*halfDepth]);
                for(const i of [0,1,2,0,2,3])vertex(tris,corners[i],color,fill);
                cells.push({bit:bits-bit-1,value,position:[x,y+.012,z]});
            }
            const inlet=[x,y+.018,z0-.075];
            line(lines,inlet,[x,y+.018,z0-.02],color,known||row.constant?.5:.12);
            if(row.constant)line(lines,[x,y+.025,z0],[x,y+.025,z1],C.blue,.28);
            if(active){
                line(lines,[x-halfWidth,y+.022,z0],[x-halfWidth,y+.022,z1],color,row.pulse*.6);
                if(progress<1){
                    line(lines,[x-halfWidth,y+.025,sweep],[x+halfWidth,y+.025,sweep],color,.95);
                    point(points,[x,y+.03,sweep],color,6,row.pulse*.5);
                }
                point(points,inlet,color,6,row.pulse*.6);
            }
            renameWords.push({logical:row.logical,physical:row.physical,constant:row.constant,known,active,progress,restoring,layout,cells});
        });
    }
    function physicalColumns(){return Math.max(3,Math.ceil(Math.sqrt(registerTags.length*2.2/11.3)));}
    function physicalTagPosition(physical) {
        const n=nodes.get("register-read"),index=registerTags.indexOf(physical),columns=physicalColumns(),rows=Math.ceil(registerTags.length/columns);
        return [n.x-n.w*.44+(index%columns+.5)*n.w*.88/columns,n.h+.18,n.z-n.d*.44+(Math.floor(index/columns)+.5)*n.d*.88/rows];
    }
    function registerReadPort(op) {
        const n=nodes.get("register-read"),execution=nodes.get(op.execution),lane=executionLane(execution,op.index%execution.pipeCount);
        return [n.x+n.w*.5+.03,lane.inlet[1],lane.inlet[2]];
    }
    function registerReaders(physical){return registerReads.filter(r=>r.sources.some(s=>s.physical===physical));}
    function registerCellColor(cell){
        const readers=registerReaders(cell.physical);
        return readers.length?C[readers[0].op.kind]:cell.event?.type==="restore"&&cell.pulse>0?C.red:C.blue;
    }
    function registerCellAppearance(cell){
        const reading=registerReaders(cell.physical).length>0,allocated=cell.allocation==="allocated";
        const presence=allocated?1:cell.allocation==="free"?cell.allocationPulse:0;
        return {fill:reading?.48:presence*.23,outline:reading?1:allocated?.62:cell.allocation==="free"?.16:.075,
            valueAlpha:reading?.95:presence*.6,unknown:cell.allocation==="unknown"};
    }
    function registerModule(tris,lines,n){
        housing(tris,lines,n.x,-.25,n.z,n.w+.24,.16,n.d+.24,C.blue,.25);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,C.blue,.35);
        const depth=n.d*.70/Math.ceil(registerTags.length/physicalColumns());
        for(const tag of registerTags){
            const p=physicalTagPosition(tag);
            housing(tris,lines,p[0],n.h+.04,p[2],n.w*.70/physicalColumns(),.055,depth,C.blue.map(v=>v*.35),.14);
        }
        for(const execution of [...nodes.values()].filter(n=>n.pipeCount))for(let lane=0;lane<execution.pipeCount;lane++){
            const p=executionLane(execution,lane).inlet;
            line(lines,[n.x+n.w*.46,p[1],p[2]],[n.x+n.w*.5+.05,p[1],p[2]],execution.color,.55);
        }
    }
    function drawRegisters(lines,points) {
        const triangles=[];
        if(!registerState.available){upload(registerSurface,triangles);return;}
        const n=nodes.get("register-read");
        const readIDs=new Set(registerReads.flatMap(r=>r.sources.map(s=>s.physical)));
        const halfWidth=n.w*.34/physicalColumns(),halfDepth=n.d*.34/Math.ceil(registerTags.length/physicalColumns());
        drawRenameWords(triangles,lines,points);
        for(const cell of registerState.physical){
            const p=physicalTagPosition(cell.physical),reading=readIDs.has(cell.physical),color=registerCellColor(cell),appearance=registerCellAppearance(cell);
            const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,z])=>[p[0]+x*halfWidth,p[1]-.025,p[2]+z*halfDepth]);
            for(const i of [0,1,2,0,2,3])vertex(triangles,corners[i],color,appearance.fill);
            for(let i=0;i<4;i++)line(lines,corners[i],corners[(i+1)%4],color,appearance.outline);
            if(appearance.unknown)line(lines,corners[0],corners[2],[.47,.52,.56],.16);
            if(cell.value!==null&&appearance.valueAlpha>0){
                const bits=BigInt(cell.value),chunk=(trace.evidence.registers.wordBits??32)/8,mask=(1n<<BigInt(chunk))-1n;
                for(let bit=0;bit<8;bit++){
                    const value=Number(bits>>BigInt((7-bit)*chunk)&mask),x=p[0]+(bit-3.5)*n.w*.072/physicalColumns();
                    line(lines,[x,p[1],p[2]+halfDepth*.12],[x,p[1],p[2]+halfDepth*.78],color,appearance.valueAlpha*(.1+value/Number(mask)*.8));
                }
            }
            if(reading||cell.pulse>0)point(points,p,color,reading?15:10,reading?.85:cell.pulse*.55);
            registerReaders(cell.physical).slice(1).forEach((read,index)=>point(points,[p[0]+.06*(index+1),p[1]+.04,p[2]],C[read.op.kind],10,.9));
        }
        for(const read of registerReads){
            const port=registerReadPort(read.op),color=C[read.op.kind];
            for(const source of read.sources){
                if(!registerTags.includes(source.physical))continue;
                const p=physicalTagPosition(source.physical);
                for(let k=0;k<16;k++)line(lines,route(p,port,k/16),route(p,port,(k+1)/16),color,.7);
                point(points,route(p,port,smooth(read.progress)),color,14,.9);
            }
            point(points,port,color,16,1);
        }
        upload(registerSurface,triangles);
    }
    function robCell(slot, lift = 0) {
        const n=nodes.get("rob"), rows=Math.ceil(trace.structure.robCapacity/4);
        const column=Math.floor(slot/rows), offset=slot%rows;
        const row=column%2?rows-1-offset:offset;
        return [n.x+(column-1.5)*.49,n.h+.15+lift,n.z+(row-(rows-1)/2)*6.65/Math.max(1,rows-1)];
    }
    function commitSlot(index){
        const n=nodes.get("commit"),pitch=n.d*.8/trace.retireWidth,z=n.z+(index-(trace.retireWidth-1)/2)*pitch,y=n.h+.20;
        return {inlet:[n.x-n.w*.35,y,z],outlet:[n.x+n.w*.35,y,z],depth:pitch*.65};
    }
    function commitModule(tris,lines,n){
        housing(tris,lines,n.x,-.25,n.z,n.w+.24,.16,n.d+.24,C.blue,.25);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,C.blue,.35);
        for(let i=0;i<trace.retireWidth;i++){
            const slot=commitSlot(i),a=slot.inlet,b=slot.outlet;
            housing(tris,lines,n.x,n.h+.05,a[2],n.w*.74,.07,slot.depth,C.blue,.38);
            line(lines,a,b,C.blue,.20);
            for(const p of [a,b])line(lines,[p[0],p[1],p[2]-slot.depth*.4],[p[0],p[1],p[2]+slot.depth*.4],C.blue,.45);
            line(lines,[b[0]-.14,b[1],b[2]-slot.depth*.25],b,C.blue,.4);
            line(lines,[b[0]-.14,b[1],b[2]+slot.depth*.25],b,C.blue,.4);
        }
    }
    function drawCommit(lines,points){
        const group=commitGroups.get(Math.floor(cycle))??[];
        for(const op of group){
            if(cycle<op.end)continue;
            const slot=commitSlot(op.commitSlot),color=C[op.kind],phase=cycle-op.end;
            const strength=.42+.58*Math.sin(clamp(phase/.95)*Math.PI);
            line(lines,slot.inlet,slot.outlet,color,strength);
            for(const side of [-1,1])line(lines,[slot.inlet[0],slot.inlet[1],slot.inlet[2]+side*slot.depth*.4],
                [slot.outlet[0],slot.outlet[1],slot.outlet[2]+side*slot.depth*.4],color,strength*.45);
            point(points,slot.outlet,color,9,strength*.8);
        }
    }
    function wakeBusEntry(){const n=nodes.get("issue");return [n.x-n.w*.50,n.h+.3,n.z-n.d*.5-.22];}
    function wakeColumnHead(column){const n=nodes.get("issue"),p=matrixPosition(0,column);return [p[0],n.h+.3,n.z-n.d*.5-.22];}
    function issueRowExit(slot){const n=nodes.get("issue"),p=matrixPosition(slot);return [n.x+n.w*.5+.06,p[1],p[2]];}
    function issuePath(issue){
        const n=nodes.get("issue"),op=ops.find(o=>o.id===issue.id),origin=matrixPosition(issue.slot),exit=issueRowExit(issue.slot);
        const connection=connections.find(c=>c.from==="issue"&&c.to===op.execution)??connections.find(c=>c.from==="issue");
        const unit=nodes.get(op.execution),z=executionLane(unit,op.index%unit.pipeCount).inlet[2];
        const lane=connection.lanes.find(l=>l.target[2]===z)??connection.lanes[op.index%connection.lanes.length];
        const signal=issue.column===null?[]:[exit,[exit[0],exit[1],n.z+n.d*.5+.18],
            [matrixPosition(0,issue.column)[0],exit[1],n.z+n.d*.5+.18],matrixPosition(0,issue.column)];
        return {id:issue.id,column:issue.column,origin,exit,port:lane.target,signal};
    }
    function wakePath(source, progress,producerID) {
        const scheduler=nodes.get("issue");
        const target=wakeBusEntry();
        const a=[source[0]-1.2,2.5,7.0], b=[scheduler.x-1.0,2.8,5.8];
        const t=clamp(progress),q=1-t;
        return source.map((v,i)=>q*q*q*v+3*q*q*t*a[i]+3*q*t*t*b[i]+t*t*t*target[i]);
    }
    function feedPath(u) {
        const a=[-7.4,1.1,9.4],b=[-8.2,1.25,7.4],c=[-13.2,1.0,2.0],d=[-15.5,.8,0],q=1-u;
        return a.map((v,i)=>q*q*q*v+3*q*q*u*b[i]+3*q*u*u*c[i]+u*u*u*d[i]);
    }
    function drawInstructionStream(lines,points) {
        feedVisible=[];codeFragments=[];
        feedState=feedReplay.stateAt(cycle,reducedMotion);
        const type=[],unravel=[];
        if(!instructionStream){upload(feedType,type);upload(unravelType,unravel);return;}
        const right=normalize(cross([0,1,0],eye)),up=normalize(cross(eye,right));
        const offset=(p,x,y)=>p.map((v,i)=>v+right[i]*x+up[i]*y);
        const canceledIDs=new Set(feedState.ids),layers=[];
        if(feedState.cancelAlpha>0)layers.push({kind:"rewind",cursor:feedState.cursor,alpha:feedState.cancelAlpha,shift:0});
        if(feedState.flowAlpha>0)layers.push({kind:"fetch",cursor:feedState.normalCursor,alpha:feedState.flowAlpha,shift:(1-feedState.recovery)*.25});
        // The incoming ribbon is a preview of recorded fetch order, not another queue.
        // During flush, actual canceled rows reappear as a separate historical layer.
        for(const layer of layers)for(let index=Math.floor(layer.cursor);index<Math.min(feedOps.length,Math.ceil(layer.cursor)+feedRows);index++){
            const distance=(index+.5-layer.cursor)/feedRows+layer.shift;if(distance<=0||distance>=1)continue;
            const op=feedOps[index],canceled=layer.kind==="rewind"&&canceledIDs.has(op.id);
            if(layer.kind==="rewind"&&feedState.phase!=="rewind"&&!canceled)continue;
            const u=1-distance,dissolve=canceled?feedState.dissolve:0;
            const p=feedPath(u),screen=project(p);
            const worldPerPixel=2*screen[2]*Math.tan(.66/2)/cssHeight;
            const scale=smooth(distance/.30),alpha=smooth((1-distance)/.15)*(.32+.68*u)*layer.alpha;
            const color=canceled?C.red:instructionColor(op,cycle),text=op.feedText,cell=.146*scale,height=.38*scale;
            // Align every instruction to the same left edge of the tapered ribbon.
            const left=-3.0*scale,rightEdge=left+text.length*cell;
            for(let j=0;j<text.length;j++){
                const code=text.charCodeAt(j)-32;if(code<=0||code>=95)continue;
                const x=left+j*cell,col=code%16,row=Math.floor(code/16);
                const origin=offset(p,x+cell/2,0);
                // Peel actual canceled glyphs from the retained ribbon. Travel is in
                // CSS pixels so separation survives camera distance and high DPI.
                const stagger=hash(op.id+j*17)*.18,travel=smooth((dissolve-stagger)/(1-stagger));
                let fragment=origin,rotation=0,glyphWidth=cell,glyphHeight=height,opacity=(canceled?layer.alpha*(.7+.3*u):alpha)*(j<8?.5:1);
                if(canceled&&travel>0){
                    const home=project(origin),spread=clamp(cssWidth*.065,35,75);
                    // A gentle shared drift replaces the wide, explosive scatter.
                    const drift=(.2+hash(op.id+31)*.4+(hash(op.id+j*31)-.5)*.5)*spread;
                    const targetX=clamp(home[0]+drift,16,cssWidth-16);
                    const targetY=clamp(home[1]-12-hash(op.id+j*43)*38,cssWidth<700?120:175,cssHeight-60);
                    fragment=offset(origin,(targetX-home[0])*worldPerPixel*travel,(home[1]-targetY)*worldPerPixel*travel);
                    rotation=(hash(op.id+j*59)-.5)*1.0*travel;
                    const lift=smooth(travel/.3);
                    glyphWidth=mix(cell,Math.max(cell,.146*.85),lift);
                    glyphHeight=mix(height,Math.max(height,.38*.85),lift);
                    codeFragments.push({id:op.id,index:j,character:text[j],origin,position:fragment,opacity,rotation,travel});
                }
                const cos=Math.cos(rotation),sin=Math.sin(rotation);
                const corners=[[-.5,.5],[.5,.5],[.5,-.5],[-.5,-.5]].map(([dx,dy])=>
                    offset(fragment,dx*glyphWidth*cos-dy*glyphHeight*sin,dx*glyphWidth*sin+dy*glyphHeight*cos));
                const uv=[[col/16,row/6],[(col+1)/16,row/6],[(col+1)/16,(row+1)/6],[col/16,(row+1)/6]];
                const vertices=canceled&&travel>0?unravel:type;
                for(const k of [0,1,2,0,2,3])vertices.push(...corners[k],...color,opacity,...uv[k]);
            }
            const intact=1-smooth(dissolve/.25);
            line(lines,offset(p,left-.17,0),offset(p,left-.08,0),color,alpha*.8*intact);
            if(canceled){
                line(lines,offset(p,left,0),offset(p,rightEdge,0),C.red,alpha*.45*intact);
            }
            point(points,p,color,scale<.5?6:2,alpha*.45*intact);
            feedVisible.push({id:op.id,fetch:op.fetch,label:op.label,position:p,progress:u,layer:layer.kind,canceled});
        }
        // Rows condense at the inlet, then the existing fetch particles take over.
        const recent=fetchGroups.find(g=>cycle>=g.time-feedLead&&cycle<g.time+.3);
        if(recent&&feedState.flowAlpha>0){
            const glow=Math.sin(clamp((cycle-recent.time+feedLead)/(feedLead+.3))*Math.PI);
            point(points,feedPath(1),C.integer,22,glow*.85*feedState.flowAlpha);
        }
        const rewinding=feedState.phase==="rewind"||feedState.phase==="discard";
        // The red pulse moves out of fetch along the same ribbon as the reversed code.
        if(feedState.time!==null&&!reducedMotion){
            const pulse=1-clamp(feedState.age/1.3),strength=(1-smooth(feedState.age/2.2));
            point(points,feedPath(pulse),C.red,26,strength*.9);
            if(trails)for(let k=1;k<=12;k++){
                const u=pulse+k*.018;if(u>=1)break;
                line(lines,feedPath(u-.018),feedPath(u),C.red,(1-k/13)*strength*.65);
            }
        }
        for(let k=0;k<60;k++){
            const u=k/60,v=(k+1)/60;
            for(const side of [-1,1]){
                const a=offset(feedPath(u),side*3.3*smooth((1-u)/.30),0),b=offset(feedPath(v),side*3.3*smooth((1-v)/.30),0);
                line(lines,a,b,rewinding?C.red:C.blue,(rewinding?.38:.10)*Math.sin(u*Math.PI));
            }
        }
        upload(feedType,type);upload(unravelType,unravel);
    }
    function buildWorld() {
        nodes = new Map(); connections = [];
        const front = trace.structure.frontNodes;
        transferProfile=sonataReplay.measureTransfers(ops,{firstCycle:trace.firstCycle,lastCycle:trace.lastCycle,frontNodes:front});
        const hasRegisters=!!trace.evidence?.registers;
        front.forEach((n, i) => {const node=makeNode(n.id, n.names.join(" / "), mix(hasRegisters?-12.5:-11.4, hasRegisters?-7.8:-6.7, i / Math.max(1, front.length - 1)), 0, Math.min(1.65, 4.4 / Math.max(1, front.length - 1)), 2.7, .6 + i * .10, C.integer, i === 0 ? "FETCH" : "FRONT END");node.names=n.names;});
        const rn=renameNode();
        if(rn&&trace.evidence?.registers?.rows.length){
            rn.mapWords=trace.evidence.registers.rows.length;rn.d=3.6;rn.color=C.blue;
            rn.detail=trace.evidence.registers.logicalNames?.[0]==="RAX"?"16 ARCH + 16 TEMP":`${rn.mapWords} LOGICAL REGS`;
            if(trace.evidence.registers.kind==="configuration")rn.detail=`${rn.mapWords} LOGICAL · MAP NOT LOGGED`;
        }
        makeNode("issue", "SCHEDULER", hasRegisters?-5.2:-3.7, 0, hasRegisters?3.2:3.6, hasRegisters?3.2:3.6, .65, C.blue,
            `${trace.structure.queueCapacity} ROWS × ${dependencyReplay.columnCount} COLS · ${trace.evidence?.scheduling.kind==="recorded"?"RECORDED":"RAW ESTIMATE"}`);
        for (const n of trace.structure.executionNodes) {
            const z = { integer: -4.2, branch: 0, memory: 4.2 }[n.kind];
            const compact=n.kind!=="memory";
            const node=makeNode(n.id, {integer:"INTEGER",branch:"BRANCH",memory:"LOAD / STORE"}[n.kind], hasRegisters?2.1:.9, z, compact?1.95:3.65, 3.05, .65, C[n.kind], `${n.pipeCount} ${n.pipeCount === 1 ? "PIPE" : "PIPES"} · →`);
            node.pipeCount=n.pipeCount;node.compact=compact;
        }
        if (trace.structure.memoryWait) makeNode("memory-wait", "MEMORY WAIT", hasRegisters?4.8:4.1, 5.5, hasRegisters?1.3:1.55, 1.6, .5, C.memory, "OBSERVED WAIT");
        makeNode("rob", trace.machineOrder === "in-order" ? "COMPLETION FIFO" : "REORDER BUFFER", 6.8, 0, 2.45, 8.0, .65, C.blue, `${trace.structure.robCapacity} ENTRIES · HEAD → COMMIT`);
        makeNode("commit", "COMMIT", 11.1, 0, 2.15, 3.0, .65, C.integer, `${trace.retireWidth} SLOTS / CYCLE`);
        if(hasRegisters)makeNode("register-read","PHYSICAL REGISTERS",-1.65,0,2.2,11.3,.4,C.blue,trace.evidence.registers.origin==="gem5"?`${registerTags.length} INT · ${trace.evidence.registers.kind==="configuration"?"CONFIG ONLY":"RECORDED ACCESSES"}`:`${registerTags.length} OBSERVED · READ AT Rr`);
        front.slice(1).forEach((n, i) => addConnection(front[i].id,n.id,nodes.get(front[i].id).color));
        addConnection(front.at(-1).id,"issue",C.integer);
        if(hasRegisters)addConnection("issue","register-read",C.blue);
        for (const n of trace.structure.executionNodes){addConnection(hasRegisters?"register-read":"issue",n.id,C[n.kind]);addConnection(n.id,"rob",C[n.kind]);}
        if (nodes.has("memory-wait")){addConnection("exec-memory","memory-wait",C.memory);addConnection("memory-wait","rob",C.memory);}
        addConnection("rob","commit",C.integer);
        addConnection("input",front[0].id,C.integer);addConnection("commit","output",C.integer);
        const robNode=nodes.get("rob"),robInputs=connections.filter(c=>c.to==="rob").flatMap(c=>c.lanes);
        robInputs.sort((a,b)=>a.source[2]-b.source[2]);
        robInputs.forEach((lane,index)=>{lane.target[2]=robNode.z+(index-(robInputs.length-1)/2)*robNode.d*.82/Math.max(1,robInputs.length-1);});
        const tris = [], lines = [], stars = [];
        box(tris, lines, 0, -.65, .4, 28.8, .36, 14.4, C.floor, .5);
        box(tris, lines, 0, -.81, .4, 29.4, .1, 15, C.floor, .22);
        for (let x = -28; x <= 28; x += 1) line(lines, [x,-.84,-22], [x,-.84,22], C.floor, x % 4 === 0 ? .27 : .12);
        for (let z = -22; z <= 22; z += 1) line(lines, [-28,-.84,z], [28,-.84,z], C.floor, z % 4 === 0 ? .27 : .12);
        for (let i = 0; i < 130; i++) {
            const x = -14 + hash(i+41) * 28, z = -6.2 + hash(i+77) * 13;
            const y = -.26, len = .25 + hash(i) * 1.5, c = i % 8 === 0 ? C.integer : C.floor;
            line(lines, [x,y,z], [x+len,y,z], c, i % 8 === 0 ? .28 : .38);
            line(lines, [x+len,y,z], [x+len+.27,y,z+.27], c, .25);
            if (i % 4 === 0) point(stars, [x,y,z], c, 3, .6);
        }
        for (let i = 0; i < 310; i++) point(stars, [(hash(i+910)-.5)*70, hash(i+830)*17-3, (hash(i+920)-.5)*55], i%6 ? [.22,.42,.55] : C.integer, .8+hash(i+940)*2.1, .2+hash(i)*.5);
        for (const node of nodes.values()) {
            const {x,z,w,d,h,color,id} = node;
            if(node.pipeCount){executionModule(tris,lines,node);continue;}
            if(id==="issue"){matrixModule(tris,lines,node);continue;}
            if(id==="register-read"){registerModule(tris,lines,node);continue;}
            if(id==="commit"){commitModule(tris,lines,node);continue;}
            if(node.mapWords){renameModule(tris,lines,node);continue;}
            box(tris, lines, x, -.25, z, w+.25, .16, d+.25, color, .22);
            box(tris, lines, x, -.05, z, w, h, d, color, .52);
            // Fine etched top surface and side fins give the light a physical substrate.
            for (let k = 0; k < 8; k++) {
                const dz = z-d*.38 + k*d*.76/7;
                line(lines, [x-w*.38,h-.04,dz], [x+w*.38,h-.04,dz], color, .16);
                line(lines, [x-w/2-.01,.06,dz], [x-w/2-.01,h*.65,dz], color, .23);
            }
            for (let side = -1; side <= 1; side += 2) {
                line(lines, [x-w*.34,h+.012,z+side*d/2], [x+w*.34,h+.012,z+side*d/2], color, .95);
                for (let k = 0; k < 6; k++) {
                    const xx=x-w*.34+k*w*.68/5;
                    line(lines,[xx,-.2,z+side*(d/2+.15)],[xx,-.2,z+side*(d/2+.42)],color,.38);
                }
            }
        }
        // Consecutive physical addresses form one serpentine circular FIFO.
        for(let slot=0;slot<trace.structure.robCapacity-1;slot++)line(lines,robCell(slot,-.09),robCell(slot+1,-.09),C.blue,.28);
        const first=robCell(0,-.09),last=robCell(trace.structure.robCapacity-1,-.09);
        const wrap=[last,[last[0]+.32,last[1],last[2]-.26],[first[0]-.32,first[1],first[2]-.26],first];
        for(let i=0;i<wrap.length-1;i++)line(lines,wrap[i],wrap[i+1],C.blue,.22);
        if(nodes.has("memory-wait")){
            const n=nodes.get("memory-wait"),source=[n.x,n.h+.34,n.z];
            for(let i=0;i<80;i++)line(lines,wakePath(source,i/80),wakePath(source,(i+1)/80),C.memory,.12);
        }
        for (const {color,lanes} of connections) {
            // The conductor count matches each module's displayed parallel width.
            // Ports line up with the execution pipes without extra decorative rails.
            for(const {source,target} of lanes){
                for(let k=0;k<48;k++)line(lines,route(source,target,k/48),route(source,target,(k+1)/48),color,.32);
                for(const p of [source,target])point(stars,p,color,3,.4);
            }
        }
        [staticTriangles, staticLines, staticStars].forEach(deleteBuffer);
        staticTriangles=buffer(tris);staticLines=buffer(lines);staticStars=buffer(stars,true);
        $("labels").replaceChildren();
        $("register-readouts").replaceChildren();physicalElements=new Map();renameWords=[];
        for(const tag of registerTags){
            const el=document.createElement("span");el.className="physical-register-id";el.textContent=`p${tag}`;
            $("register-readouts").append(el);physicalElements.set(tag,el);
        }
        $("register-writeback").hidden=!hasRegisters;
        let number=0;
        for (const n of nodes.values()) {
            const el=document.createElement("div");el.className=`stage-label${n.id.startsWith("front")?" front-label":""}${n.id.startsWith("exec")?" execution-label":""}`;el.style.setProperty("--stage-color",rgb(n.color));
            const index=document.createElement("span");index.className="stage-index";index.textContent=String(++number).padStart(2,"0");
            const label=document.createElement("strong");label.textContent=n.label;
            el.dataset.compactLabel="";
            label.dataset.label=({"register-read":"REG FILE","rob":"ROB","memory-wait":"MEM WAIT"})[n.id]??n.label;
            const detail=document.createElement("small");detail.textContent=n.id.startsWith("front")&&!n.mapWords?"":n.detail;
            if(n.mapWords){el.classList.add("rename-label");el.title=trace.evidence.registers.kind==="configuration"?"Rename table is present; mappings were not recorded in this trace. All entries remain unobserved.":"Rename map: one bar per logical register, perpendicular to instruction flow. Blue writes a new mapping; red restores an older mapping.";}
            if(n.id==="commit")el.title="One slot per instruction in this cycle's in-order commit group. Unused slots stay dark.";
            el.append(index,label,detail);
            if(n.id==="register-read"){
                const allocation=document.createElement("div");allocation.id="register-allocation";allocation.className="register-allocation";
                allocation.title=trace.evidence.registers.allocation?.label??"Allocation state not recorded in this trace.";
                for(const state of ["allocated","free","unknown"]){
                    const item=document.createElement("span");item.dataset.state=state;
                    item.append(document.createElement("i"),document.createElement("b"));allocation.append(item);
                }
                el.append(allocation);
                if(trace.evidence.registers.allocation?.kind==="inferred")detail.textContent=`${registerTags.length} OBSERVED · RELEASE ≈`;
            }
            $("labels").append(el);n.element=el;
        }
    }

    function instructionKind(label) {
        const mnemonic=label.replace(/^(?:0x)?[0-9a-f]+:\s*/i,"").trim().replace(/^[A-Z0-9_]+\s*:\s*/,"").split(/\s+/)[0].toLowerCase();
        if (/^(b|bl|br|bx|cbz|cbnz|tbz|tbnz|jal|jalr|jr|ret|wrip)/.test(mnemonic)) return "branch";
        if (/^(ld|ldr|ldp|lw|lh|lb|sd|st|sw|sh|sb|load|store)/.test(mnemonic)) return "memory";
        return "integer";
    }
    function allocateSlots(start, end, field) {
        const ends=[];
        for (const op of [...ops].filter((o)=>start(o)!=null).sort((a,b)=>start(a)-start(b)||a.id-b.id)) {
            let slot=ends.findIndex((e)=>e<=start(op));
            if(slot<0)slot=ends.length;
            op[field]=slot;ends[slot]=end(op);
        }
    }
    function loadTrace(key) {
        trace=samples.find((s)=>s.key===key)||samples[0];
        $("trace-select").value=trace.key;selectedID=null;
        ops=trace.ops.map((t,index)=>{
            const [id,rid,fetch,retired,flush,label,source,allocation,issue,completion,execution,flushCycle]=t;
            const end=flush?(flushCycle??retired):retired;
            const stages=[];
            for(const [name,node,start,finish] of source){
                if(stages.at(-1)?.node===node){stages.at(-1).end=Math.max(finish,stages.at(-1).end);stages.at(-1).names.push(name);}
                else stages.push({names:[name],node,start,end:finish});
            }
            if(stages.length&&end>stages.at(-1).end)stages.at(-1).end=end;
            return {id,rid,index,fetch,end,flush:!!flush,label,stages,allocation,issue,completion,execution,kind:instructionKind(label),
                reads:trace.evidence?.registers?.origin==="gem5"?[...new Set((trace.evidence.registers.reads??[]).filter(r=>r.id===id).map(r=>r.cycle))].map(time=>({start:time,end:time+.7,sources:trace.evidence.registers.reads.filter(r=>r.id===id&&r.cycle===time).map(r=>({physical:r.physical,hex:r.hex}))})):source.filter(s=>s[0]==="Rr").map(s=>({start:s[2],end:s[3]})),
                sourceRegisters:trace.evidence?.scheduling.ops.find(o=>o.id===id)?.sources??[]};
        });
        commitGroups=new Map();
        for(const op of ops.filter(o=>!o.flush).sort((a,b)=>a.end-b.end||a.rid-b.rid||a.id-b.id)){
            const time=Math.floor(op.end),group=commitGroups.get(time)??[];
            op.commitSlot=group.length;group.push(op);commitGroups.set(time,group);
        }
        feedOps=[...ops].sort((a,b)=>a.fetch-b.fetch||a.id-b.id);fetchGroups=[];
        feedOps.forEach((op,index)=>{
            op.feedText=`${String(op.id).padStart(6,"0")}  ${op.label.trim().replace(/\s+/g," ")}`.slice(0,42);
            if(fetchGroups.at(-1)?.time===op.fetch)fetchGroups.at(-1).count++;
            else fetchGroups.push({time:op.fetch,start:index,count:1});
        });
        feedReplay=sonataReplay.createFeedReplay(feedOps,{firstCycle:trace.firstCycle,lastCycle:trace.lastCycle,rows:feedRows,lead:feedLead});
        allocateSlots(o=>o.allocation,o=>o.issue??o.end,"issueSlot");
        dependencyReplay=sonataReplay.createDependencyReplay(ops,trace.evidence?.scheduling,trace.structure.queueCapacity);
        registerReplay=sonataReplay.createRegisterReplay(trace.evidence?.registers);
        const regs=trace.evidence?.registers;
        registerTags=regs?[...new Set([...regs.initial.owners.map(([p])=>p),...regs.initial.mapping.map(([,p])=>p),
            ...(regs.allocation?.initial??[]).map(([p])=>p),...(regs.allocation?.events??[]).map(e=>e.physical),
            ...regs.events.flatMap(e=>[e.physical,...(e.previous===undefined?[]:[e.previous])])])].sort((a,b)=>a-b):[];
        robReplay=sonataReplay.createRobReplay(ops,trace.structure.robCapacity);
        for(const op of ops)op.robSlot=robReplay.slots.get(op.id);
        allocateSlots(o=>o.stages.find(s=>s.node==="memory-wait")?.start,o=>o.stages.find(s=>s.node==="memory-wait")?.end,"memorySlot");
        memoryEvents=sonataReplay.memoryCompletions(ops);
        flushEvents=[...new Set(ops.filter(o=>o.flush&&o.end>=trace.firstCycle&&o.end<=trace.lastCycle).map(o=>o.end))].sort((a,b)=>a-b);
        branchRecoveries=sonataReplay.findRecoveryBranches(ops,trace.demo.events,flushEvents,trace.parser.startsWith("gem5"));
        buildWorld();
        cycle=trace.initialCycle;
        $("timeline").min=trace.firstCycle;$("timeline").max=trace.lastCycle;
        const provenance=trace.demo.provenance;
        $("run-simulator").textContent=provenance.simulator;
        $("mobile-demo").textContent=trace.label;
        $("mobile-simulator").textContent=provenance.simulator;
        $("mobile-workload").textContent=provenance.workload;
        $("run-workload").textContent=provenance.workload;
        $("run-workload").classList.toggle("unconfirmed",!provenance.workloadKnown);
        $("run-processor").textContent=provenance.processor;
        $("run-configuration").textContent=provenance.configuration;
        $("run-note").textContent=provenance.note;
        $("matrix-source").textContent=trace.evidence?.scheduling.kind==="recorded"?"MATRIX · RECORDED DEPS":"MATRIX · RAW ESTIMATE";
        $("matrix-source").title=`${trace.evidence?.scheduling.label??"Dependency information unavailable"}. Rows and columns are the same scheduler entries. Dependencies on issued instructions remain on the external wake-up bus. Cell colors follow the consumer row; brightness marks dependency release. Register map / values: ${trace.evidence?.registers?"recorded RSD annotations":"not recorded in this trace"}.`;
        $("run-file").textContent=trace.fileName;
        $("run-excerpt").textContent=`${ops.length.toLocaleString()} excerpt ops · cycles ${trace.firstCycle.toLocaleString()}–${trace.lastCycle.toLocaleString()}`;
        $("cinema-source").textContent=`${provenance.simulator} / ${provenance.workload}`;
        $("scene-theme").textContent=trace.demo.theme;
        $("show-highlight").disabled=trace.demo.bookmarks.length===0;
        $("show-highlight").title=trace.demo.bookmarks.map(b=>`${b.label} · cycle ${b.cycle.toLocaleString()}`).join("\n");
        $("architecture").textContent=trace.machineOrder.toUpperCase();
        $("width-value").textContent=`${trace.fetchWidth}-WIDE FETCH`;
        $("queue-label").textContent=trace.machineOrder==="in-order"?"Schedule queue":"Scheduler";
        $("rob-label").textContent=trace.machineOrder==="in-order"?"Completion buffer":"Reorder buffer";
        $("next-flush").disabled=flushEvents.length===0;
        $("next-flush").title=flushEvents.length?`Jump to the next squash event (F) · timing ${trace.parser.startsWith("gem5")?"inferred":"recorded"}`:"This excerpt contains no flush events";
        $("range-label").textContent=`${trace.lastCycle-trace.firstCycle+1} CYCLES`;
        $("first-cycle").textContent=trace.firstCycle.toLocaleString();$("last-cycle").textContent=trace.lastCycle.toLocaleString();
        for(const id of ["issue-meter","rob-meter"]){$(id).replaceChildren(...Array.from({length:24},()=>document.createElement("i")));}
        activity=Array.from({length:trace.lastCycle-trace.firstCycle+1},(_,i)=>{
            const t=trace.firstCycle+i;
            return {active:ops.filter(o=>o.fetch<=t&&o.end>t).length,retired:ops.filter(o=>!o.flush&&o.end>=t&&o.end<t+1).length};
        });
        const markers=flushEvents.map(t=>{
            const marker=document.createElement("span");marker.className="event-marker";
            marker.style.left=`${(t-trace.firstCycle)/(trace.lastCycle-trace.firstCycle)*100}%`;return marker;
        });
        for(const bookmark of trace.demo.bookmarks.filter(b=>b.type!=="flush")){
            const marker=document.createElement("span");marker.className="event-marker highlight-marker";
            marker.style.left=`${(bookmark.cycle-trace.firstCycle)/(trace.lastCycle-trace.firstCycle)*100}%`;markers.push(marker);
        }
        $("event-markers").replaceChildren(...markers);
        drawTimeline();nextUI=0;
    }

    function stageAt(op,t){
        if(t<op.fetch||t>=op.end)return null;
        let last=null;
        for(const stage of op.stages){if(stage.start>t)break;last=stage;if(t<stage.end)return stage;}
        return last;
    }
    function stageTransition(stage) {
        const duration=Math.max(.001,stage.end-stage.start);
        return stage.node.startsWith("exec")?Math.min(.35,duration*.22):Math.min(.82,Math.max(.08,duration));
    }
    function location(op,stage,t) {
        const n=nodes.get(stage.node)||nodes.get("issue");
        let x=n.x,y=n.h+.34,z=n.z;
        if(n.id==="issue") {
            return matrixPosition(op.issueSlot??0);
        } else if(n.id==="register-read") {
            const p=registerReadPort(op),arrival=stageTransition(stage),progress=smooth((t-stage.start-arrival)/Math.max(.001,stage.end-stage.start-arrival));
            return [mix(n.x-n.w*.44,p[0],progress),p[1],p[2]];
        } else if(n.id==="rob" || n.id==="commit" && op.robSlot!==undefined) {
            return robCell(op.robSlot??0,.19);
        } else if(n.id==="memory-wait") {
            x+=((op.memorySlot??0)%3-1)*.3;z+=(Math.floor((op.memorySlot??0)/3)%4-1.5)*.25;
        } else if(n.id.startsWith("exec")) {
            const lane=executionLane(n,op.index%n.pipeCount),arrival=stageTransition(stage);
            const progress=smooth((t-stage.start-arrival)/Math.max(.001,stage.end-stage.start-arrival));
            return lane.inlet.map((v,i)=>mix(v,lane.outlet[i],progress));
        } else {
            z+=((op.index%Math.max(2,trace.fetchWidth))-(Math.max(2,trace.fetchWidth)-1)/2)*.38;
        }
        return [x,y,z];
    }
    function positionAt(op,t) {
        if(t<op.fetch||t>=op.end+(op.flush?2.2:2))return null;
        if(t>=op.end) {
            if(op.flush){
                const p=positionAt(op,op.end-.001);if(!p)return null;
                const age=t-op.end,a=hash(op.id)*TAU,v=1.4+hash(op.id+1)*3.2;
                return [p[0]+Math.cos(a)*age*v,p[1]+age*(2+hash(op.id+2)*3)-age*age*.55,p[2]+Math.sin(a)*age*v];
            }
            const age=t-op.end;
            const p=op.robSlot===undefined?location(op,op.stages.at(-1)??{node:"commit"},op.end-.001):robCell(op.robSlot,.19);
            const slot=commitSlot(op.commitSlot);
            return age<.45?route(p,slot.inlet,smooth(age/.45)):age<.95?slot.inlet.map((v,i)=>mix(v,slot.outlet[i],smooth((age-.45)/.5))):
                route(slot.outlet,[16.8,slot.outlet[1]+.25,slot.outlet[2]],smooth((age-.95)/1.05));
        }
        const stage=stageAt(op,t);if(!stage)return null;
        const target=location(op,stage,t);
        const transition=stageTransition(stage);
        const progress=(t-stage.start)/transition;
        if(progress>=1)return target;
        const index=op.stages.indexOf(stage),previous=op.stages[index-1];
        const source=previous?location(op,previous,previous.end-.001):[-15.5,.8,target[2]];
        if(previous?.node==="issue"){
            const exit=issueRowExit(op.issueSlot??0),port=nodes.has("register-read")&&stage.node.startsWith("exec")?registerReadPort(op):target;
            if(progress<.48)return source.map((v,i)=>mix(v,exit[i],smooth(progress/.48)));
            if(port===target)return route(exit,target,smooth((progress-.48)/.52));
            return progress<.8?route(exit,port,smooth((progress-.48)/.32)):route(port,target,smooth((progress-.8)/.2));
        }
        if(nodes.has("register-read")&&stage.node.startsWith("exec")&&previous?.node!=="register-read"){
            const port=registerReadPort(op);
            return progress<.65?route(source,port,smooth(progress/.65)):route(port,target,smooth((progress-.65)/.35));
        }
        if(stage.node==="rob"&&previous){
            const connection=connections.find(c=>c.from===previous.node&&c.to==="rob");
            if(connection){
                const port=connection.lanes[op.index%connection.lanes.length].target;
                return progress<.7?route(source,port,smooth(progress/.7)):route(port,target,smooth((progress-.7)/.3));
            }
        }
        return route(source,target,smooth(progress));
    }
    function occupancy(t) {
        const active=ops.filter(o=>o.fetch<=t&&o.end>t);
        const issued=active.filter(o=>o.allocation!=null&&t>=o.allocation&&t<(o.issue??o.end));
        const rob=active.filter(o=>o.allocation!=null&&t>=o.allocation);
        const windowStart=Math.max(trace.firstCycle,t-16),elapsed=t-windowStart;
        const ipc=elapsed>0?ops.filter(o=>!o.flush&&o.end>windowStart&&o.end<=t).length/elapsed:0;
        return {active,issued,rob,ipc};
    }
    function instructionLight(op,t) {
        if(t>=op.end)return {state:op.flush?"squashed":"retiring",brightness:1.2,size:28};
        const node=stageAt(op,t)?.node;
        if(node==="register-read")return {state:"reading",brightness:1.05,size:25};
        if(node==="issue")return {state:"waiting",brightness:.48,size:20};
        if(node==="memory-wait")return {state:"waiting",brightness:.22,size:14};
        if(node==="rob"||node==="commit"){
            const ready=op.completion!=null&&t>=op.completion;
            const completion=ready?1-smooth((t-op.completion)/.7):0;
            return {state:ready?"ready":"waiting",brightness:ready?.42+completion*.85:.22,size:ready?19+completion*10:14};
        }
        return {state:node?.startsWith("exec")?"executing":"flowing",brightness:node?.startsWith("exec")?1.3:.85,size:28};
    }
    function instructionColor(op,t) {
        return C[op.kind];
    }

    function drawTopDown(lines,dt) {
        // A ground overlay conveys aggregate allocation evidence. It never changes
        // instruction brightness, stage timing or individual unit activity.
        sceneTopDown=sonataReplay.sampleTopDown(trace.topDown,cycle);
        const triangles=[];topDownRegion=null;topDownRail=[];
        const snap=!dt||reducedMotion||boundDisplay.trace!==trace||!boundDisplay.shares;
        const follow=snap?1:1-Math.exp(-dt/0.11);
        const category=sceneTopDown.available?sceneTopDown.dominant:"unavailable";
        const converge=(from,to)=>Math.abs(from-to)<1e-5?to:mix(from,to,follow);
        const shares=Object.fromEntries(boundKeys.map(key=>[key,converge(boundDisplay.shares?.[key]??0,sceneTopDown.shares?.[key]??0)]));
        if(sceneTopDown.available&&!snap){
            const total=Object.values(shares).reduce((sum,v)=>sum+v,0);
            for(const key of boundKeys)shares[key]/=total;
        }
        const weights=Object.fromEntries(Object.keys(boundStyles).map(key=>[key,converge(boundDisplay.weights[key]??0,key===category?1:0)]));
        const color=[0,1,2].map(i=>Object.keys(weights).reduce((sum,key)=>sum+boundRGB(key)[i]*weights[key],0));
        boundDisplay={trace,shares,weights,color};
        const quad=(x0,x1,z0,z1,y,color,alpha)=>{
            const p=[[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]];
            for(const i of [0,1,2,0,2,3])vertex(triangles,p[i],color,alpha);
        };
        if(sceneTopDown.available){
            const {dominant,dominantShare}=sceneTopDown;
            const targetRegion=boundStyles[dominant].region;
            topDownRegion=targetRegion?{category:dominant,bounds:[...targetRegion]}:null;
            for(const [key,weight] of Object.entries(weights)){
                const style=boundStyles[key],color=boundRGB(key);
                if(!style.region||weight<.001)continue;
                const [x0,x1,z0,z1]=style.region,y=-.255,cut=.45;
                quad(x0,x1,z0,z1,y,color,(.035+dominantShare*.045)*weight);
                const rim=[[x0+cut,y,z0],[x1-cut,y,z0],[x1,y,z0+cut],[x1,y,z1-cut],
                    [x1-cut,y,z1],[x0+cut,y,z1],[x0,y,z1-cut],[x0,y,z0+cut]];
                for(let i=0;i<rim.length;i++)line(lines,rim[i],rim[(i+1)%rim.length],color,(.4+dominantShare*.45)*weight);
                for(const x of [x0,x1])for(const z of [z0,z1]){
                    const sx=x===x0?1:-1,sz=z===z0?1:-1;
                    line(lines,[x+sx*.08,y+.015,z+sz*.6],[x+sx*.08,y+.015,z+sz*1.15],color,weight);
                    line(lines,[x+sx*.6,y+.015,z+sz*.08],[x+sx*1.15,y+.015,z+sz*.08],color,weight);
                }
            }
            // The board's front edge is a stacked bar in scene coordinates.
            // Lengths represent the exact same shares as the readable HUD.
            let x=-13.6;
            for(const key of boundKeys){
                const share=shares[key],next=x+27.2*share,col=boundRGB(key);
                if(share>0){
                    quad(x,next,7.14,7.31,-.245,col,.6);
                    line(lines,[x,-.24,7.14],[next,-.24,7.14],col,.95);
                    line(lines,[x,-.24,7.31],[next,-.24,7.31],col,.65);
                    topDownRail.push({category:key,share,start:x,end:next});
                }
                x=next;
            }
        }
        upload(analysisSurface,triangles);
    }

    function drawDynamic(dt) {
        const lines=[],points=[];
        drawTopDown(lines,dt);
        drawInstructionStream(lines,points);
        currentStats=occupancy(cycle);visibleParticles=[];
        activeBranches=branchRecoveries.filter(e=>cycle>=e.cycle&&cycle<e.until&&positionAt(e.op,cycle));
        matrixState=dependencyReplay.stateAt(cycle);registerState=registerReplay.stateAt(cycle);
        registerReads=registerState.available?ops.flatMap(op=>op.reads.filter(r=>cycle>=r.start&&cycle<Math.min(r.end,op.end)).map(r=>({op,id:op.id,sources:r.sources??op.sourceRegisters,progress:(cycle-r.start)/(r.end-r.start)}))):[];
        drawDependencyMatrix(lines,points);drawRegisters(lines,points);drawCommit(lines,points);
        const activeNodes=new Map(),activeLanes=new Map();
        for(const op of currentStats.active){
            const s=stageAt(op,cycle);if(!s)continue;
            activeNodes.set(s.node,(activeNodes.get(s.node)||0)+1);
            const n=nodes.get(s.node);
            if(n?.pipeCount){const key=`${n.id}:${op.index%n.pipeCount}`;activeLanes.set(key,(activeLanes.get(key)||0)+1);}
        }
        for(const n of nodes.values()){
            const color=n.color;
            if(n.pipeCount){
                for(let k=0;k<n.pipeCount;k++){
                    const lane=executionLane(n,k),busy=activeLanes.has(`${n.id}:${k}`);
                    line(lines,lane.inlet,lane.outlet,color,busy?.75:.025);
                    point(points,lane.inlet,color,busy?14:4,busy?.9:.08);
                    point(points,lane.outlet,color,busy?12:4,busy?.8:.06);
                    if(busy){
                        for(const side of [-1,1])line(lines,[lane.inlet[0],lane.inlet[1],lane.inlet[2]+side*lane.radius],
                            [lane.outlet[0],lane.outlet[1],lane.outlet[2]+side*lane.radius],color,.4);
                        for(const p of [lane.inlet,lane.outlet])pipeCollar(lines,...p,lane.radius,color,.48);
                        const t=(artTime*.4+k/n.pipeCount)%1,x=mix(lane.inlet[0],lane.outlet[0],t);
                        pipeCollar(lines,x,lane.inlet[1],lane.inlet[2],lane.radius*1.07,color,.38);
                        if(trails)line(lines,[Math.max(lane.inlet[0],x-.32),lane.inlet[1],lane.inlet[2]],[x,lane.inlet[1],lane.inlet[2]],color,.6);
                    }
                }
                continue;
            }

        }
        // Faint carrier pulses illuminate the wiring without adding trace operations.
        for(const {from,to,color,lanes} of connections){
            if(!activeNodes.has(from)&&!activeNodes.has(to))continue;
            for(let k=0;k<lanes.length;k++){
                const t=(artTime*.18+k/Math.max(1,lanes.length)+hash(lanes[k].source[0]))%1;
                point(points,route(lanes[k].source,lanes[k].target,t),color,4,.24);
            }
        }
        // Physical slots never move on completion; tail allocates and head retires.
        const fifo=robReplay.stateAt(cycle),occupied=new Map(fifo.entries.map(entry=>[entry.slot,entry.op]));
        for(let slot=0;slot<trace.structure.robCapacity;slot++){
            const p=robCell(slot),op=occupied.get(slot);
            const col=op?instructionColor(op,cycle):C.blue;
            const ready=op?.completion!=null&&cycle>=op.completion;
            const completion=ready?1-smooth((cycle-op.completion)/.7):0;
            point(points,p,col,op?(ready?6+completion*4:4):2.5,op?(ready?.38+completion*.55:.16):.07);
            if(ready)line(lines,[p[0]-.10,p[1],p[2]-.04],[p[0]+.10,p[1],p[2]-.04],col,.3+completion*.5);
        }
        const head=robCell(fifo.head,.10),tail=robCell(fifo.tail,.10),oldest=fifo.entries[0]?.op;
        const headColor=oldest?.completion!=null&&cycle>=oldest.completion?C.integer:C.memory;
        ring(lines,...[head[0],head[1],head[2]],.21,headColor,.95,0,TAU,24);
        line(lines,head,[head[0],head[1]+.55,head[2]],headColor,.75);
        ring(lines,tail[0],tail[1]+.03,tail[2],.15,C.blue,.8,0,TAU,20);
        line(lines,tail,[tail[0],tail[1]+.4,tail[2]],C.blue,.65);
        // A completion broadcasts back to the scheduler. Trace issue times stay intact.
        activeNotifications=memoryEvents.filter(event=>cycle>=event.time&&cycle<event.time+wakeEffectCycles);
        for(const event of activeNotifications){
            const age=cycle-event.time,source=location(event.op,event.wait,event.time-.001);
            if(age<wakeFlightCycles){
                const u=age/wakeFlightCycles,p=wakePath(source,u,event.id);
                const col=C.memory.map((v,i)=>mix(v,C.integer[i],u));
                point(points,p,col,42,1.4);
                if(trails)for(let k=1;k<=22;k++){
                    const a=u-k*.018,b=u-(k-1)*.018;if(a<0)break;
                    line(lines,wakePath(source,a,event.id),wakePath(source,b,event.id),col,(1-k/23)*.95);
                    if(k%3===0)point(points,wakePath(source,a,event.id),col,20-k*.4,(1-k/23)*.5);
                }
                ring(lines,source[0],source[1],source[2],.18+age*.28,C.memory,1-age/wakeFlightCycles,0,TAU,24);
            }else{
                const arrival=(age-wakeFlightCycles)/(wakeEffectCycles-wakeFlightCycles),p=wakeBusEntry();
                const column=dependencyReplay.columnAt(event.id,cycle);
                ring(lines,p[0],p[1],p[2],.10+arrival*.15,C.integer,(1-arrival)*.8,0,TAU,32);
                point(points,p,C.integer,25,(1-arrival)*.65);
                if(column!==null){
                    const target=wakeColumnHead(column);
                    line(lines,p,target,C.integer,(1-arrival)*.65);
                    point(points,route(p,target,smooth(arrival/.5)),C.integer,14,(1-arrival)*.8);
                }
            }
        }
        for(const op of ops){
            const p=positionAt(op,cycle);if(!p)continue;
            const squashed=op.flush&&cycle>=op.end,leaving=cycle>=op.end;
            const alpha=leaving?clamp(1-(cycle-op.end)/(op.flush?2.2:2)):1;
            const color=squashed?C.red:instructionColor(op,cycle);
            const selected=op.id===selectedID;
            const recoveryBranch=activeBranches.find(e=>e.id===op.id);
            const light=instructionLight(op,cycle);
            if(recoveryBranch){light.brightness=Math.max(light.brightness,1.1);light.size=Math.max(light.size,32);}
            const overMatrix=crossesDependencyGrid(p)||crossesMapWords(p);
            if(trails){
                let previous=p;
                for(let k=1;k<=15;k++){
                    const old=positionAt(op,cycle-k*.045);if(!old)break;
                    const fade=(1-k/16)*alpha*light.brightness/1.2;
                    if(!crossesDependencyGrid(previous,old)&&!crossesMapWords(previous,old)&&Math.hypot(...old.map((v,i)=>v-previous[i]))>.003){
                        const trailColor=squashed?C.red:instructionColor(op,cycle-k*.045);
                        line(lines,previous,old,trailColor,fade*.88);
                        if(k%2===0)point(points,old,trailColor,Math.max(3,15-k*.7),fade*.5);
                    }
                    previous=old;
                }
            }
            point(points,p,color,overMatrix?(selected?7:4):selected?43:squashed?31:light.size,alpha*(overMatrix?.28:selected?1.6:light.brightness));
            if(!leaving)visibleParticles.push({op,position:p,screen:project(p),state:light.state,brightness:light.brightness,color});
            if(recoveryBranch){
                ring(lines,p[0],p[1]+.015,p[2],.26,C.branch,.85,0,TAU,36);
                line(lines,p,[p[0],p[1]+.65,p[2]],C.branch,.65);
            }
            if(selected&&!overMatrix){
                ring(lines,p[0],p[1]-.06,p[2],.34+.04*Math.sin(artTime*3),color,.9);
                line(lines,[p[0],p[1]-.2,p[2]],[p[0],-.15,p[2]],color,.28);
            }

        }
        let shock=0;
        const currentEvents=flushEvents.filter(t=>cycle>=t&&cycle<t+2.8);
        for(const event of currentEvents){
            const age=cycle-event,fade=clamp(1-age/2.8);
            const origin=nodes.get("exec-branch")||nodes.get("issue");
            shock=Math.max(shock,Math.sin(clamp(age/.5)*Math.PI/2)*fade);
            for(let r=0;r<3;r++)ring(lines,origin.x,.2+r*.12,origin.z,age*(4.5+r*.4)+.35,C.red,fade*(.9-r*.22),0,TAU,150);
            point(points,[origin.x,origin.h+.6,origin.z],C.red,100,fade*.8);
            for(let k=0;k<50;k++){
                const a=hash(k+event)*TAU,dist=age*(3+hash(k+9)*5);
                point(points,[origin.x+Math.cos(a)*dist,.3+Math.sin(hash(k)*Math.PI)*age*2,origin.z+Math.sin(a)*dist],C.red,5+hash(k)*8,fade*.8);
            }
        }
        upload(movingLines,lines);upload(particles,points);
        return shock;
    }

    function drawBuffer(b,mode,p) {
        gl.useProgram(p.p);gl.uniformMatrix4fv(p.u("uMatrix"),false,viewProjection);
        if(p===pointProgram)gl.uniform1f(p.u("uScale"),renderHeight*.042);
        gl.bindVertexArray(b.vao);gl.drawArrays(mode,0,b.count);
    }
    function blur(source,destination,dx,dy,extract) {
        gl.bindFramebuffer(gl.FRAMEBUFFER,destination.fbo);gl.viewport(0,0,destination.w,destination.h);
        gl.useProgram(blurProgram.p);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,source.texture);
        gl.uniform1i(blurProgram.u("uTexture"),0);gl.uniform2f(blurProgram.u("uDirection"),dx,dy);gl.uniform1f(blurProgram.u("uExtract"),extract);
        gl.bindVertexArray(null);gl.drawArrays(gl.TRIANGLES,0,3);
    }
    function render(dt=0) {
        if(contextLost)return;
        resize();
        const ease=1-Math.exp(-dt*5);
        azimuth=mix(azimuth,targetAzimuth,ease);elevation=mix(elevation,targetElevation,ease);radius=mix(radius,targetRadius,ease);
        focus=focus.map((value,i)=>mix(value,targetFocus[i],ease));
        $("world").classList.toggle("zoomed",radius<24);
        const drift=autoOrbit&&cameraMode!=="plan"?Math.sin(artTime*.12)*.16:0;
        const a=azimuth+drift;
        // Fit the complete processor on portrait screens too.
        const distance=radius*Math.max(1,1.48/(cssWidth/cssHeight));
        eye=[Math.sin(a)*Math.cos(elevation)*distance,Math.sin(elevation)*distance,Math.cos(a)*Math.cos(elevation)*distance].map((value,i)=>value+focus[i]);
        viewProjection=multiply(perspective(cssWidth/cssHeight),lookAt(eye,focus));
        const shock=drawDynamic(dt);
        gl.bindFramebuffer(gl.FRAMEBUFFER,(sceneMultisample??sceneTarget).fbo);gl.viewport(0,0,renderWidth,renderHeight);
        gl.depthMask(true);gl.clearColor(.012,.022,.035,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);
        drawBuffer(staticTriangles,gl.TRIANGLES,solidProgram);
        gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
        gl.depthFunc(gl.LEQUAL);drawBuffer(analysisSurface,gl.TRIANGLES,solidProgram);
        drawBuffer(registerSurface,gl.TRIANGLES,solidProgram);
        drawBuffer(staticLines,gl.LINES,solidProgram);
        drawBuffer(staticStars,gl.POINTS,pointProgram);
        drawBuffer(movingLines,gl.LINES,solidProgram);
        drawBuffer(particles,gl.POINTS,pointProgram);
        gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
        if(sceneMultisample){
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER,sceneMultisample.fbo);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,sceneTarget.fbo);
            gl.blitFramebuffer(0,0,renderWidth,renderHeight,0,0,renderWidth,renderHeight,gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT,gl.NEAREST);
        }
        blur(sceneTarget,bloomA,1/renderWidth,0,1);
        blur(bloomA,bloomB,0,1/bloomA.h,0);
        blur(bloomB,bloomA,2/bloomA.w,0,0);
        blur(bloomA,bloomB,0,2/bloomA.h,0);
        // Keep the glyph cores crisp: text uses the scene depth but does not feed bloom.
        gl.bindFramebuffer(gl.FRAMEBUFFER,sceneTarget.fbo);gl.viewport(0,0,renderWidth,renderHeight);
        gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
        gl.useProgram(typeProgram.p);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,glyphTexture);gl.uniform1i(typeProgram.u("uGlyphs"),0);
        drawBuffer(feedType,gl.TRIANGLES,typeProgram);
        // Detached historical letters stay in front of the chip while they unravel.
        gl.disable(gl.DEPTH_TEST);drawBuffer(unravelType,gl.TRIANGLES,typeProgram);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,renderWidth,renderHeight);
        gl.useProgram(compositeProgram.p);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,sceneTarget.texture);gl.uniform1i(compositeProgram.u("uScene"),0);
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,bloomB.texture);gl.uniform1i(compositeProgram.u("uBloom"),1);
        gl.uniform1f(compositeProgram.u("uBloomAmount"),bloom);gl.uniform1f(compositeProgram.u("uTime"),artTime);
        gl.uniform1f(compositeProgram.u("uShock"),reducedMotion?0:shock);gl.uniform2f(compositeProgram.u("uResolution"),renderWidth,renderHeight);
        gl.uniform1f(compositeProgram.u("uPixelRatio"),pixelRatio);
        gl.bindVertexArray(null);gl.drawArrays(gl.TRIANGLES,0,3);
        for(const n of nodes.values()){
            const side=n.id.startsWith("exec"),below=n.id==="memory-wait";
            const p=project(below?[n.x,n.h,n.z+n.d*.7]:side?[n.x+n.w/2+.5,n.h+.6,n.z]:[n.x,n.h+.7,n.z-n.d*.52]);
            n.element.style.transform=`translate(${p[0].toFixed(1)}px,${p[1].toFixed(1)}px) translate(${below?"-50%,8px":side?"0,-50%":"-50%,-100%"})`;
            n.element.classList.toggle("below-label",below);
            n.element.style.display=p[2]<0?"none":"";
        }
        const committed=(commitGroups.get(Math.floor(cycle))??[]).filter(op=>cycle>=op.end).length;
        nodes.get("commit").element.querySelector("small").textContent=`${committed} / ${trace.retireWidth} THIS CYCLE`;
        if(registerState.available){
            for(const cell of registerState.physical){
                const p=physicalTagPosition(cell.physical),screen=project([p[0],p[1]+.06,p[2]-.02]),el=physicalElements.get(cell.physical);
                const reading=registerReads.some(r=>r.sources.some(s=>s.physical===cell.physical));
                el.style.transform=`translate(${screen[0]}px,${screen[1]}px) translate(-50%,-100%)`;
                el.hidden=registerTags.length>64&&!reading&&cell.pulse<.01;
                el.style.color=rgb(registerCellColor(cell));
                el.style.opacity=String(reading?1:cell.allocation==="allocated"?.85:cell.allocation==="free"?.30:.2);
                el.dataset.allocation=cell.allocation;
            }
            for(const [state,count] of Object.entries(registerState.allocationCounts)){
                const item=$("register-allocation").querySelector(`[data-state="${state}"]`);
                item.lastElementChild.textContent=`${state==="allocated"?"ALLOC":state==="free"?"FREE":"?"} ${count}`;
                item.title=state==="unknown"?"Allocation state not observed":state==="allocated"?"Allocated, including older versions held until reclamation":"Free physical registers";
            }
            const n=nodes.get("register-read"),write=registerState.lastWrite,screen=project([n.x,n.h+.35,n.z+n.d*.53]);
            const label=$("register-writeback");label.style.transform=`translate(${screen[0]}px,${screen[1]+12}px) translateX(-50%)`;
            label.textContent=write?`WB p${write.physical} ← ${write.hex}`:trace.evidence.registers.kind==="configuration"?"VALUES NOT LOGGED":"WRITEBACK · —";
        }
        const marker=$("recovery-branch"),branch=activeBranches.at(-1);
        marker.hidden=!branch;
        if(branch){
            const p=project(positionAt(branch.op,cycle)),retiring=cycle>=branch.op.end;
            const location=retiring?"COMMIT":stageAt(branch.op,cycle)?.node==="rob"?"ROB":nodes.get(stageAt(branch.op,cycle)?.node)?.label??"IN FLIGHT";
            marker.firstElementChild.textContent=`${branch.inferred?"RECOVERY BRANCH ≈":"MISPREDICT"} #${branch.id}`;
            marker.lastElementChild.textContent=`${location} · ${retiring?"COMMITTED":"PRESERVED"}`;
            marker.style.transform=`translate(${clamp(p[0]-8,4,cssWidth-235)}px,${clamp(p[1]-72,4,cssHeight-45)}px)`;
            marker.style.opacity=String(1-smooth((cycle-(branch.until-.7))/.7));
            marker.title=branch.inferred?"Candidate: branch immediately before the squashed instruction sequence; cause inferred from O3PipeView.":"Recorded branch misprediction. Only younger wrong-path instructions are squashed.";
        }
        const fifo=robReplay.stateAt(cycle),oldest=fifo.entries[0]?.op;
        const headPoint=project(robCell(fifo.head,.72)),tailPoint=project(robCell(fifo.tail,.62));
        const headLabel=$("rob-head-label"),tailLabel=$("rob-tail-label");
        const ready=oldest?.completion!=null&&cycle>=oldest.completion;
        headLabel.textContent=oldest?`HEAD #${oldest.id} · ${ready?"READY":"WAIT"}`:"HEAD · EMPTY";
        headLabel.style.color=rgb(ready?C.integer:C.memory);
        tailLabel.textContent=`TAIL ${fifo.entries.length===trace.structure.robCapacity?"· FULL":`→ ${fifo.tail}`}`;
        headLabel.style.transform=`translate(${headPoint[0]+13}px,${headPoint[1]}px)`;
        const separation=Math.abs(tailPoint[1]-headPoint[1])<23?24:0;
        tailLabel.style.transform=`translate(${tailPoint[0]+13}px,${tailPoint[1]+separation}px)`;
        const feedLabel=$("instruction-stream-label"),feedAnchor=project(feedPath(0));
        feedLabel.hidden=!instructionStream||feedAnchor[2]<0;
        feedLabel.style.transform=`translate(${feedAnchor[0]+(cameraMode==="plan"?135:0)}px,${feedAnchor[1]+(cameraMode==="plan"?-28:24)}px) translateX(-50%)`;
        updateTopDownUI(dt>0&&!reducedMotion);
        // Keep readable stage names in the overview; progressively expose detail
        // while zooming. Do not let projected labels cover controls or each other.
        if(compactMedia.matches){
            const bounds=canvas.getBoundingClientRect();
            const occupied=[...document.querySelectorAll('.view-controls,.mobile-run,.mobile-cycle,.touch-camera,.bound-scene')].map(el=>el.getBoundingClientRect());
            const priority=n=>({issue:0,"register-read":1,rob:2})[n.id]??3;
            const candidates=[...nodes.values()].sort((a,b)=>priority(a)-priority(b)).map(n=>({el:n.element,rect:n.element.getBoundingClientRect()}));
            for(const {el,rect} of candidates){
                const fits=rect.left>=bounds.left+3&&rect.right<=bounds.right-3&&rect.top>=bounds.top+3&&rect.bottom<=bounds.bottom-3;
                const overlaps=occupied.some(r=>rect.left<r.right+3&&rect.right>r.left-3&&rect.top<r.bottom+3&&rect.bottom>r.top-3);
                el.style.visibility=fits&&!overlaps?"":"hidden";
                if(fits&&!overlaps)occupied.push(rect);
            }
        }else for(const n of nodes.values())n.element.style.visibility="";
    }

    function drawTimeline() {
        if(!activity.length)return;
        const el=$("activity"),w=el.clientWidth,h=el.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
        el.width=Math.max(1,Math.round(w*dpr));el.height=Math.max(1,Math.round(h*dpr));
        const ctx=el.getContext("2d");ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
        const peak=Math.max(...activity.map(a=>a.active),1),retirePeak=Math.max(...activity.map(a=>a.retired),1);
        const bar=w/activity.length;
        for(let i=0;i<activity.length;i++){
            const a=activity[i],x=i*bar;
            const ah=a.active/peak*(h-6),rh=a.retired/retirePeak*(h-10);
            ctx.fillStyle="#1d3946";ctx.fillRect(x,h-ah,Math.max(1,bar-.7),ah);
            ctx.fillStyle="#59bba9";ctx.globalAlpha=.55+a.retired/retirePeak*.25;
            ctx.fillRect(x,h-rh,Math.max(1,bar-.7),rh);ctx.globalAlpha=1;
        }
        ctx.fillStyle="#31525e";ctx.fillRect(0,h-1,w,1);
    }
    function updateTopDownUI(animateLabels) {
        const topDown=sceneTopDown;
        const category=topDown.available?topDown.dominant:"unavailable",boundStyle=boundStyles[category];
        const boundLabel=boundStyle.label,boundColor=rgb(boundDisplay.color),shares=boundDisplay.shares;
        const dominantShare=category==="active"?shares.retiring+shares.inFlight:category==="mixed"?Math.max(shares.retiring+shares.inFlight,shares.badSpeculation,shares.frontend,shares.backend,shares.unresolved):shares[category];
        const text=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
        for(const id of ["bound-scene-status"]){
            const el=$(id),changed=el.textContent!==boundLabel;
            if(changed||!animateLabels)el.getAnimations().forEach(a=>a.cancel());
            if(changed){
                el.textContent=boundLabel;
                if(animateLabels)el.animate([{opacity:.2,transform:"translateY(4px)"},{opacity:1,transform:"translateY(0)"}],{duration:260,easing:"ease-out"});
            }
        }
        const sceneBound=$("bound-scene");sceneBound.dataset.bound=category;
        sceneBound.title=topDown.available?`${trace.topDown.method} · cycles ${topDown.firstCycle}–${topDown.lastCycle} · ${topDown.totalSlots} allocation slots`:"Stage evidence did not establish a Top-down classification.";
        sceneBound.style.setProperty("--bound-color",boundColor);
        text("bound-scene-value",topDown.available?(dominantShare*100).toFixed(1):"");
        $("bound-scene-share").hidden=!topDown.available;
        $("bound-scene-window").textContent=topDown.available?`PAST ${Number(topDown.cycles.toFixed(1))} CYC → NOW · ESTIMATE`:"UNAVAILABLE";
        $("bound-scene-context").textContent=boundStyle.context;
        $("bound-scene-bar").hidden=$("bound-scene-key").hidden=!topDown.available;
        for(const el of $("bound-scene-bar").children)el.style.width=`${shares[el.dataset.bound]*100}%`;
        for(const el of $("bound-scene-key").children){
            el.querySelector("b").textContent=`${Math.round(shares[el.dataset.bound]*100)}%`;
            if(el.dataset.bound==="unresolved")el.hidden=shares.unresolved<.0001;
            if(el.dataset.bound==="inFlight")el.hidden=shares.inFlight<.0001;
        }
    }
    function updateUI() {
        const integer=Math.floor(cycle),fraction=Math.floor((cycle-integer)*100+1e-6);
        $("cycle-value").replaceChildren(document.createTextNode(integer.toLocaleString("en-US")),Object.assign(document.createElement("span"),{textContent:`.${String(fraction).padStart(2,"0")}`}));
        $("mobile-cycle-value").textContent=`${integer.toLocaleString("en-US")}.${String(fraction).padStart(2,"0")}`;
        $("timeline").value=cycle;
        $("playhead").style.left=`${clamp((cycle-trace.firstCycle)/(trace.lastCycle-trace.firstCycle))*100}%`;
        $("active-count").textContent=currentStats.active.length;$("ipc-value").textContent=currentStats.ipc.toFixed(2);
        const traceEvents=(trace.demo.events??[]).filter(e=>cycle>=e.cycle&&cycle<e.endCycle);
        const notice=$("trace-event-notice"),signature=traceEvents.map(e=>`${e.kind}:${e.id}:${e.cycle}`).join(",");
        notice.hidden=traceEvents.length===0;
        if(notice.dataset.events!==signature){
            notice.dataset.events=signature;
            notice.replaceChildren(...traceEvents.map(e=>{
                const row=document.createElement("div"),label=document.createElement("strong"),detail=document.createElement("small");
                label.textContent={"branch-mispredict":"BRANCH MISPREDICTION","dcache-miss":"D-CACHE MISS","icache-miss":"I-CACHE MISS"}[e.kind];
                detail.textContent=`#${e.id} · cycle ${e.cycle.toLocaleString()} · recorded`;
                row.style.setProperty("--event-color",e.kind==="branch-mispredict"?"#ff6277":"#ffbb65");row.append(label,detail);return row;
            }));
        }
        const feedLabel=$("instruction-stream-label"),feedTitle=feedLabel.querySelector("span"),feedDetail=feedLabel.querySelector("small");
        const feedPhase=feedState.phase,rewinding=feedPhase==="rewind"||feedPhase==="discard"||feedPhase==="notice";
        $("motion-notice").hidden=!reducedMotion;
        $("motion-effects").setAttribute("aria-pressed",String(!reducedMotion));
        $("motion-effects").lastElementChild.textContent=reducedMotion?"OFF":"ON";
        feedLabel.classList.toggle("rewinding",rewinding);feedLabel.classList.toggle("recovering",feedPhase==="refill");
        feedTitle.textContent=rewinding?(reducedMotion?"CODE SQUASH":feedPhase==="discard"?"CODE UNRAVEL":"↶ CODE REWIND"):feedPhase==="refill"?"↗ FETCH RESUMES":"INSTRUCTION STREAM";
        feedDetail.textContent=feedState.time!==null?`${feedState.count} SQUASHED · ${feedPhase==="refill"?"RESUMING FLOW":"WRONG PATH"}`:"TRACE SEQUENCE ↗ FETCH";
        $("memory-notice").hidden=activeNotifications.length===0;
        $("memory-notice-detail").textContent=activeNotifications.length===1?`#${activeNotifications[0].id} → scheduler · completion broadcast`:`${activeNotifications.length} completions → scheduler`;
        $("ipc-value").title="Committed instructions / elapsed cycle over the previous 16 cycles in this excerpt";
        for(const [name,count,capacity] of [["issue",currentStats.issued.length,trace.structure.queueCapacity],["rob",currentStats.rob.length,trace.structure.robCapacity]]){
            $(`${name}-count`).textContent=`${count} / ${capacity}`;
            [...$(`${name}-meter`).children].forEach((el,i)=>el.classList.toggle("on",i<Math.ceil(count/capacity*24)));
        }
        const currentEvent=flushEvents.findLast(t=>cycle>=t&&cycle<t+2.8);
        $("flush-alert").classList.toggle("visible",currentEvent!==undefined);
        if(currentEvent!==undefined)$("flush-detail").textContent=`${ops.filter(o=>o.flush&&o.end===currentEvent).length} instructions squashed · ${trace.parser.startsWith("gem5")?"≈ ":""}cycle ${currentEvent.toLocaleString()}`;
        const selected=selectedID!==null?ops.find(o=>o.id===selectedID):null;
        const candidates=currentStats.active.filter(o=>stageAt(o,cycle)?.node.startsWith("exec"));
        const op=selected||candidates[Math.floor(cycle/5)%Math.max(1,candidates.length)]||currentStats.active.at(-1);
        $("unpin").hidden=selectedID===null;
        if(op){
            const stage=stageAt(op,cycle),stageIndex=op.stages.indexOf(stage);
            $("op-id").textContent=`#${op.id}`;$("op-code").textContent=op.label;$("op-code").title=op.label;
            $("op-stage").textContent=cycle<op.fetch?"PENDING":cycle>=op.end?(op.flush?"SQUASHED":"COMMITTED"):nodes.get(stage?.node)?.label||"IN FLIGHT";
            $("op-state").textContent=selected?"Pinned instruction":"Click a particle to pin";
            $("spotlight").style.borderLeftColor=rgb(op.flush&&cycle>=op.end?C.red:instructionColor(op,cycle));
            $("op-progress").replaceChildren(...op.stages.map((s,i)=>{
                const el=document.createElement("i");el.className=i===stageIndex?"current":cycle>=s.end?"done":"";el.title=`${s.names.join(" / ")}: ${s.start}–${s.end}`;return el;
            }));
        }else{
            $("op-id").textContent="—";$("op-code").textContent="No instructions in flight";$("op-stage").textContent="IDLE";
            $("op-state").textContent="Seek the timeline to explore";$("op-progress").replaceChildren();
        }
    }
    function setPlaying(value){
        playing=value;$("play").textContent=playing?"Ⅱ":"▶";
        $("play").setAttribute("aria-label",playing?"Pause":"Play");$("play").title=playing?"Pause (Space)":"Play (Space)";
        $("play-status").textContent=playing?"LIVE":"PAUSED";
    }
    function setCycle(value){
        if(!Number.isFinite(value))return;
        cycle=clamp(value,trace.firstCycle,trace.lastCycle);render();updateUI();
        // Seeking displays the new cycle immediately, including the flush notice.
        $("flush-alert").getAnimations().forEach(animation=>animation.finish());
    }
    function step(delta){setPlaying(false);setCycle(Math.floor(cycle)+delta);}
    function nextFlush(){
        if(!flushEvents.length)return;
        const t=flushEvents.find(t=>t>cycle+.1)??flushEvents[0];
        setCycle(Math.max(trace.firstCycle,t-.65));setPlaying(true);
    }
    function setCamera(mode){
        cameraMode=mode;document.body.classList.toggle("cinema",mode==="cinema");
        targetFocus=[0,0,0];
        if(mode==="plan"){targetElevation=1.49;targetAzimuth=0;targetRadius=33;}
        else if(mode==="cinema"){targetElevation=.55;targetAzimuth=.38;targetRadius=30.5;}
        else {targetElevation=.73;targetAzimuth=.20;targetRadius=32.5;}
        document.querySelectorAll("[data-view]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.view===mode)));
        resize();
    }
    function toggleAuto(value=!autoOrbit){autoOrbit=value;$("auto-camera").setAttribute("aria-pressed",String(autoOrbit));$("auto-camera").lastElementChild.textContent=autoOrbit?"ON":"OFF";}
    function animate(now){
        if(contextLost)return;
        const dt=Math.min(.075,Math.max(0,(now-lastTime)/1000));lastTime=now;
        if(!document.hidden){
            if(!reducedMotion)artTime+=dt;
            if(playing){
                const duration=instructionStream?sonataReplay.codeRewindDuration:2.5;
                const next=sonataReplay.advancePlayback(cycle,dt,speed,flushEvents,{duration,reducedMotion});
                lastPlayback={seconds:dt,cycles:next-cycle,rate:dt>0?(next-cycle)/(dt*speed):1};
                cycle=next>trace.lastCycle?trace.firstCycle:next;
            }
            render(dt);
            if(now>=nextUI){updateUI();nextUI=now+80;}
            frameCount++;
            if(now-fpsTime>=1200){fps=Math.round(frameCount*1000/(now-fpsTime));frameCount=0;fpsTime=now;$("renderer-status").textContent=`WebGL 2 · ${fps} fps · ${msaaSamples?`${msaaSamples}× MSAA + `:""}smooth light`;
            }
        }
        animationID=requestAnimationFrame(animate);
    }

    for(const sample of samples){const option=document.createElement("option");option.value=sample.key;option.textContent=sample.label;$("trace-select").append(option);}
    $("trace-select").addEventListener("change",()=>{loadTrace($("trace-select").value);render();updateUI();});
    $("play").addEventListener("click",()=>setPlaying(!playing));
    $("previous").addEventListener("click",()=>step(-1));$("next").addEventListener("click",()=>step(1));
    $("reset").addEventListener("click",()=>{selectedID=null;setCycle(trace.firstCycle);});
    $("timeline").addEventListener("input",()=>{setPlaying(false);setCycle(Number($("timeline").value));});
    $("speed").addEventListener("change",()=>{speed=Number($("speed").value);document.querySelector(".speed-unit").textContent=`${speed} cycles / sec`;});
    $("next-flush").addEventListener("click",nextFlush);
    $("show-highlight").addEventListener("click",()=>{
        const bookmarks=trace.demo.bookmarks;
        const bookmark=bookmarks.find(b=>b.cycle>cycle+1)??bookmarks[0];
        if(bookmark){setCycle(bookmark.cycle-2);setPlaying(true);}
        if($("mobile-panel").open)$("mobile-panel").close();
    });
    $("bloom").addEventListener("input",()=>{bloom=Number($("bloom").value)/100;$("bloom-value").textContent=`${Math.round(bloom*100)}%`;});
    $("trails").addEventListener("click",()=>{trails=!trails;$("trails").setAttribute("aria-pressed",String(trails));$("trails").lastElementChild.textContent=trails?"ON":"OFF";});
    $("instruction-stream").addEventListener("click",()=>{instructionStream=!instructionStream;$("instruction-stream").setAttribute("aria-pressed",String(instructionStream));$("instruction-stream").lastElementChild.textContent=instructionStream?"ON":"OFF";});
    $("motion-effects").addEventListener("click",()=>{reducedMotion=!reducedMotion;render();updateUI();});
    $("enable-animation").addEventListener("click",()=>{
        reducedMotion=false;instructionStream=true;
        $("instruction-stream").setAttribute("aria-pressed","true");$("instruction-stream").lastElementChild.textContent="ON";
        if(flushEvents.length)nextFlush();
        else {setPlaying(true);render();updateUI();}
    });
    $("auto-camera").addEventListener("click",()=>toggleAuto());
    $("unpin").addEventListener("click",()=>{selectedID=null;nextUI=0;});
    document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>setCamera(b.dataset.view)));
    $("fullscreen").addEventListener("click",async()=>{
        try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
        catch{ $("fullscreen").title="Fullscreen is unavailable in this browser window"; }
    });
    document.addEventListener("fullscreenchange",()=>{$("fullscreen").firstChild.textContent=document.fullscreenElement?"Exit fullscreen ":"Fullscreen ";});
    document.addEventListener("keydown",event=>{
        if(event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLButtonElement||event.target instanceof HTMLAnchorElement||event.ctrlKey||event.metaKey||event.altKey)return;
        if(event.code==="Space"){event.preventDefault();setPlaying(!playing);}
        else if(event.key==="ArrowLeft"){event.preventDefault();step(-1);}
        else if(event.key==="ArrowRight"){event.preventDefault();step(1);}
        else if(event.key.toLowerCase()==="f")nextFlush();
        else if(event.key.toLowerCase()==="c")setCamera(cameraMode==="cinema"?"orbit":"cinema");
        else if(event.key==="Escape"){selectedID=null;if(cameraMode==="cinema")setCamera("orbit");}
    });
    const telemetry=document.querySelector(".telemetry"),mobilePanel=$("mobile-panel");
    function syncCompactLayout(){
        if(mobilePanel.open)mobilePanel.close();
        (compactMedia.matches?mobilePanel:document.querySelector("main")).append(telemetry);
        resize();
    }
    compactMedia.addEventListener("change",syncCompactLayout);syncCompactLayout();
    $("mobile-details").addEventListener("click",()=>{mobilePanel.scrollTop=0;mobilePanel.showModal();});
    $("mobile-close").addEventListener("click",()=>mobilePanel.close());
    mobilePanel.addEventListener("click",event=>{
        const rect=mobilePanel.getBoundingClientRect();
        if(event.target===mobilePanel&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))mobilePanel.close();
    });
    mobilePanel.addEventListener("keydown",event=>event.stopPropagation());
    $("zoom-fit").addEventListener("click",()=>setCamera(cameraMode));
    $("zoom-in").addEventListener("click",()=>{toggleAuto(false);targetRadius=clamp(targetRadius/1.3,10,62);});
    $("zoom-out").addEventListener("click",()=>{toggleAuto(false);targetRadius=clamp(targetRadius*1.3,10,62);});
    // Two touch points control both zoom and translation. The world point under
    // their midpoint stays anchored, including when one finger lifts first.
    const pointers=new Map();let pinch=null;
    function touchPair(){
        const [a,b]=[...pointers.values()];
        return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};
    }
    function moveFocus(dx,dy,units){
        const a=targetAzimuth,e=targetElevation,right=[Math.cos(a),0,-Math.sin(a)],up=[-Math.sin(a)*Math.sin(e),Math.cos(e),-Math.cos(a)*Math.sin(e)];
        targetFocus=targetFocus.map((v,i)=>clamp(v+(right[i]*dx-up[i]*dy)*units,-[20,12,14][i],[20,12,14][i]));
    }
    canvas.addEventListener("pointerdown",event=>{
        if(event.button!==0||pointers.size>=2)return;
        pointers.set(event.pointerId,{x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false});canvas.setPointerCapture(event.pointerId);
        if(pointers.size===2){for(const p of pointers.values())p.moved=true;pinch=touchPair();toggleAuto(false);}
    });
    canvas.addEventListener("pointermove",event=>{
        const drag=pointers.get(event.pointerId);if(!drag)return;
        const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
        if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>4)drag.moved=true;
        drag.x=event.clientX;drag.y=event.clientY;
        if(pointers.size===2){
            const next=touchPair(),oldRadius=targetRadius,rect=canvas.getBoundingClientRect();
            targetRadius=clamp(oldRadius*pinch.distance/next.distance,10,62);
            const scale=targetRadius/oldRadius,units=2*Math.tan(.66/2)*oldRadius*Math.max(1,1.48/(cssWidth/cssHeight))/cssHeight;
            moveFocus((pinch.x-rect.left-rect.width/2)*(1-scale)-(next.x-pinch.x)*scale,
                (pinch.y-rect.top-rect.height/2)*(1-scale)-(next.y-pinch.y)*scale,units);
            pinch=next;
        }else if(drag.moved){toggleAuto(false);targetAzimuth-=dx*.006;targetElevation=clamp(targetElevation+dy*.005,.24,1.50);}
    });
    function endPointer(event){
        const drag=pointers.get(event.pointerId);if(!drag)return;
        if(event.type==="pointerup"&&!drag.moved){
            const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
            const closest=visibleParticles.map(p=>({p,d:Math.hypot(p.screen[0]-x,p.screen[1]-y)})).sort((a,b)=>a.d-b.d)[0];
            selectedID=closest&&closest.d<22?closest.p.op.id:null;nextUI=0;
        }
        pointers.delete(event.pointerId);pinch=null;
        if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    }
    for(const type of ["pointerup","pointercancel","lostpointercapture"])canvas.addEventListener(type,endPointer);
    canvas.addEventListener("wheel",event=>{event.preventDefault();targetRadius=clamp(targetRadius*Math.exp(event.deltaY*.001),10,62);},{passive:false});
    canvas.addEventListener("dblclick",()=>setCamera("orbit"));
    canvas.addEventListener("webglcontextlost",event=>{
        event.preventDefault();contextLost=true;cancelAnimationFrame(animationID);$("fallback").hidden=false;
        $("fallback").firstElementChild.textContent="Graphics context interrupted.";
        $("fallback").querySelector("p").textContent="Restoring the light field…";
        $("renderer-status").textContent="Graphics context lost";
    });
    canvas.addEventListener("webglcontextrestored",()=>globalThis.location.reload());
    document.addEventListener("visibilitychange",()=>{lastTime=performance.now();});
    new ResizeObserver(()=>{if(!contextLost)resize();}).observe($("world"));
    window.addEventListener("resize",drawTimeline);
    loadTrace(samples.find(s=>s.key==="rename-rush")?.key??samples[0].key);toggleAuto(autoOrbit);setPlaying(playing);render();updateUI();
    // Read-only diagnostics plus deterministic seek make visual review reproducible.
    globalThis.sonata={
        get camera(){return {mode:cameraMode,radius,targetRadius,azimuth,elevation,focus:[...focus],targetFocus:[...targetFocus],pointers:pointers.size,compact:compactMedia.matches};},
        get trace(){return trace;},get cycle(){return cycle;},get playing(){return playing;},get ops(){return ops;},get flushEvents(){return [...flushEvents];},
        get stats(){return {active:currentStats.active.length,issue:currentStats.issued.length,rob:currentStats.rob.length,ipc:currentStats.ipc};},
        get topDown(){return sonataReplay.sampleTopDown(trace.topDown,cycle);},
        get topDownVisual(){return {region:topDownRegion?{...topDownRegion,bounds:[...topDownRegion.bounds]}:null,rail:topDownRail.map(s=>({...s})),
            shares:{...boundDisplay.shares},weights:{...boundDisplay.weights},color:[...boundDisplay.color]};},
        get particles(){return visibleParticles.map(p=>({id:p.op.id,screen:p.screen,position:p.position,state:p.state,brightness:p.brightness,color:[...p.color]}));},
        get executionPipes(){return [...nodes.values()].filter(n=>n.pipeCount).flatMap(n=>Array.from({length:n.pipeCount},(_,index)=>({node:n.id,index,...executionLane(n,index)})));},
        get connections(){return connections.map(c=>({from:c.from,to:c.to,peak:c.peak,lineCount:c.lanes.length,
            lanes:c.lanes.map(l=>({source:[...l.source],target:[...l.target]}))}));},
        get playbackStep(){return {...lastPlayback};},
        get dependencyMatrix(){return dependencyReplay.stateAt(cycle);},
        get issuePaths(){return matrixState.issues.map(issuePath);},
        get registers(){return registerReplay.stateAt(cycle);},
        get commitSlots(){const group=commitGroups.get(Math.floor(cycle))??[];return Array.from({length:trace.retireWidth},(_,index)=>{const op=group[index];return {index,...commitSlot(index),id:op&&cycle>=op.end?op.id:null};});},
        get registerReads(){return registerReads.map(r=>({id:r.id,kind:r.op.kind,color:[...C[r.op.kind]],sources:r.sources,port:registerReadPort(r.op)}));},
        get registerReadCells(){return registerState.available?registerState.physical.filter(c=>registerReaders(c.physical).length).map(c=>({physical:c.physical,color:[...registerCellColor(c)],readers:registerReaders(c.physical).map(r=>r.id)})):[];},
        get registerAllocationCells(){return registerState.available?registerState.physical.map(c=>({physical:c.physical,state:c.allocation,...registerCellAppearance(c)})):[];},
        get renameMapWords(){return renameWords;},
        get registerLayout(){return registerState.available?{renameNode:renameNode().id,renamePosition:[renameNode().x,renameNode().z],
            mapWords:renameWords.length,physicalNode:"register-read",cells:registerTags.map(id=>({id,position:physicalTagPosition(id)}))}:null;},
        get recoveryBranches(){return activeBranches.map(e=>({id:e.id,cycle:e.cycle,until:e.until,inferred:e.inferred,position:positionAt(e.op,cycle)}));},
        get instructionFeed(){return feedVisible.map(row=>({...row,position:[...row.position]}));},
        get codeFragments(){return codeFragments.map(g=>({...g,origin:[...g.origin],position:[...g.position],screen:project(g.position),originScreen:project(g.origin)}));},
        get codeRewind(){return {...feedState,ids:[...feedState.ids],visible:instructionStream};},
        get rob(){const s=robReplay.stateAt(cycle);return {head:s.head,tail:s.tail,capacity:robReplay.capacity,entries:s.entries.map(e=>({id:e.op.id,slot:e.slot,ready:e.op.completion!=null&&cycle>=e.op.completion}))};},
        get memoryReturns(){return memoryEvents.map(e=>({id:e.id,time:e.time}));},
        get notifications(){return activeNotifications.map(e=>({id:e.id,time:e.time,phase:cycle-e.time<wakeFlightCycles?"flight":"arrived",target:wakeBusEntry(),column:dependencyReplay.columnAt(e.id,cycle)}));},
        get renderer(){return {width:renderWidth,height:renderHeight,pixelRatio,msaaSamples,fps,contextLost,error:gl.getError()};},
        setCycle,setPlaying,loadTrace,setCamera,
        captureAt(t){setPlaying(false);setCycle(t);return {cycle,active:currentStats.active.length};}
    };
    animationID=requestAnimationFrame(animate);
})();

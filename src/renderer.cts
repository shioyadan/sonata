"use strict";
// WebGL 資源と描画順。材質ごとのシェーダーは shaders.cts で定義する。
import geometry = require("./geometry.cts");
import shaders = require("./shaders.cts");
const { createSurfaceShaders, createCrystalShaders, createEffectShaders } = shaders;
const { TAU, mix, smooth, hash, multiply, lookAt, normalize } = geometry;
type Vec3 = geometry.Vector;
interface VertexBuffer {
    vao: WebGLVertexArrayObject | null;
    vbo: WebGLBuffer | null;
    count: number;
    stride: number;
    instances?: false;
    vertices?: never;
}
interface InstanceBuffer extends Omit<VertexBuffer, "instances" | "vertices"> {
    instances: true;
    vertices: number;
}
type DrawBuffer = VertexBuffer | InstanceBuffer;
interface GpuProgram {
    p: WebGLProgram;
    u(name: string): WebGLUniformLocation | null;
}
interface DisposableTarget {
    fbo: WebGLFramebuffer | null;
    texture?: WebGLTexture | null;
    coverage?: WebGLTexture | null;
    depthBuffer?: WebGLRenderbuffer | null;
    colorBuffer?: WebGLRenderbuffer | null;
    w: number;
    h: number;
}
interface RenderTarget extends DisposableTarget {
    texture: WebGLTexture | null;
}
interface MultisampleTarget extends DisposableTarget {
    depthBuffer: WebGLRenderbuffer | null;
    colorBuffer: WebGLRenderbuffer | null;
}
interface GpuState {
    gl: WebGL2RenderingContext;
    canvas: HTMLCanvasElement;
    renderWidth: number;
    renderHeight: number;
    cssWidth: number;
    cssHeight: number;
    pixelRatio: number;
    contextLost: boolean;
    sceneTarget: RenderTarget | null;
    sceneMultisample: MultisampleTarget | null;
    bloomA: RenderTarget | null;
    bloomB: RenderTarget | null;
    staticTriangles: VertexBuffer | null;
    staticLines: VertexBuffer | null;
    staticStars: VertexBuffer | null;
    staticShadows: VertexBuffer | null;
    staticMaterials: InstanceBuffer | null;
    msaaSamples: number;
    maxRenderSide: number;
}
interface SurfaceStyle {
    light: Vec3;
    roughness: number;
    grain: number;
    pieceShadow: number;
}
type RenderStyle = { background: Vec3 } & (
    | { matte: false; surface?: undefined }
    | { matte: true; surface: SurfaceStyle }
);
interface RenderSession {
    cycle: number;
    reducedMotion: boolean;
    bloom: number;
    style: RenderStyle;
}
interface RenderCamera {
    eye: Vec3;
    viewProjection: Float32Array<ArrayBuffer>;
    update(dt: number, artTime: number): void;
}
interface ShadowPass {
    surfaceTexture: WebGLTexture | null;
    materialShadow: RenderTarget | null;
    lightProjection: Float32Array<ArrayBuffer> | null;
    pieceShadow: RenderTarget | null;
    pieceShadowKey: string;
    pieceShadowUpdates: number;
}
const crystalTransmission = 0.4;

// 起動側で有効な WebGL 2 を取得してから資源を作る。取得失敗・context loss は起動側が扱う。
function createGpu({
    gl,
    canvas,
    onResize
}: {
    gl: WebGL2RenderingContext;
    canvas: HTMLCanvasElement;
    onResize(): void;
}) {
    function program(vertex: string, fragment: string): GpuProgram {
        const shaders = (
            [
                [gl.VERTEX_SHADER, vertex],
                [gl.FRAGMENT_SHADER, fragment]
            ] as const
        ).map(([type, source]) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
            return shader;
        });
        const p = gl.createProgram()!;
        shaders.forEach((s) => gl.attachShader(p, s));
        gl.linkProgram(p);
        shaders.forEach((s) => gl.deleteShader(s));
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
        const uniforms = new Map<string, WebGLUniformLocation | null>();
        return {
            p,
            u(name: string) {
                if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(p, name));
                return uniforms.get(name)!;
            }
        };
    }

    const surfaces = createSurfaceShaders(program);
    const crystal = createCrystalShaders(program, surfaces.surfaceLighting, crystalTransmission);
    const effects = createEffectShaders(program);
    const programs = { ...surfaces, ...crystal, ...effects };

    const colorSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES) as Int32Array;
    const depthSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) as Int32Array;
    const gpu: GpuState = {
        gl,
        canvas,
        renderWidth: 0,
        renderHeight: 0,
        cssWidth: 0,
        cssHeight: 0,
        pixelRatio: 1,
        contextLost: false,
        sceneTarget: null,
        sceneMultisample: null,
        bloomA: null,
        bloomB: null,
        staticTriangles: null,
        staticLines: null,
        staticStars: null,
        staticShadows: null,
        staticMaterials: null,
        msaaSamples: Math.max(0, ...Array.from(colorSamples).filter((n) => n <= 4 && depthSamples.includes(n))),
        maxRenderSide: Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))
    };
    function buffer(data: readonly number[], points = false, dynamic = false): VertexBuffer {
        const vao = gl.createVertexArray(),
            vbo = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        const stride = points ? 8 : 7;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride * 4, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride * 4, 12);
        if (points) {
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride * 4, 28);
        }
        return { vao, vbo, count: data.length / stride, stride };
    }

    function upload(b: DrawBuffer, data: readonly number[]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
        b.count = data.length / b.stride;
    }

    function deleteBuffer(b: DrawBuffer | null) {
        if (b) {
            gl.deleteBuffer(b.vbo);
            gl.deleteVertexArray(b.vao);
        }
    }

    // 六面の輪郭を内側の直方体と丸みの法線へ分解する。寸法が変わっても丸みはつぶさない。
    const roundedGeometry: number[] = [];
    for (let axis = 0; axis < 3; axis++)
        for (const sign of [-1, 1]) {
            const u = (axis + 1) % 3,
                v = (axis + 2) % 3,
                grid = [-1, -0.5, 0.5, 1];
            for (let i = 0; i < 3; i++)
                for (let j = 0; j < 3; j++) {
                    const corners = [
                        [i, j],
                        [i + 1, j],
                        [i + 1, j + 1],
                        [i, j + 1]
                    ].map(([a, b]) => {
                        const p: Vec3 = [0, 0, 0];
                        p[axis] = sign;
                        p[u] = grid[a];
                        p[v] = grid[b];
                        return [
                            ...p.map(Math.sign),
                            ...normalize(p.map((c) => (Math.abs(c) > 0.75 ? Math.sign(c) : 0)) as Vec3)
                        ];
                    });
                    for (const k of [0, 1, 2, 0, 2, 3]) roundedGeometry.push(...corners[k]);
                }
        }
    const roundedVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, roundedVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(roundedGeometry), gl.STATIC_DRAW);
    function materialBuffer(data: readonly number[], dynamic = false): InstanceBuffer {
        const vao = gl.createVertexArray(),
            vbo = gl.createBuffer(),
            stride = 12;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, roundedVBO);
        for (let i = 0; i < 2; i++) {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 24, i * 12);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        for (const [location, size, offset] of [
            [2, 3, 0],
            [3, 3, 12],
            [4, 4, 24],
            [5, 2, 40]
        ]) {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride * 4, offset);
            gl.vertexAttribDivisor(location, 1);
        }
        return { vao, vbo, stride, count: data.length / stride, instances: true, vertices: roundedGeometry.length / 6 };
    }
    function pieceBuffer(): InstanceBuffer {
        const vao = gl.createVertexArray(),
            vbo = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
        for (let i = 0; i < 3; i++) {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 48, i * 16);
            gl.vertexAttribDivisor(i, 1);
        }
        return { vao, vbo, stride: 12, count: 0, instances: true, vertices: 6 };
    }

    const movingLines = buffer([], false, true),
        particles = buffer([], true, true);
    const analysisSurface = buffer([], false, true),
        registerSurface = buffer([], false, true);
    const instructionPieces = pieceBuffer();

    // 高解像度アトラスと mipmap により、命令列の縮小時も文字の輪郭を保つ。
    const glyphCanvas = document.createElement("canvas");
    glyphCanvas.width = 1536;
    glyphCanvas.height = 960;
    const glyphContext = glyphCanvas.getContext("2d")!;
    glyphContext.font = "bold 128px monospace";
    glyphContext.fillStyle = "white";
    glyphContext.textBaseline = "middle";
    glyphContext.textAlign = "center";
    for (let i = 0; i < 95; i++)
        glyphContext.fillText(String.fromCharCode(i + 32), (i % 16) * 96 + 48, Math.floor(i / 16) * 160 + 80);
    const glyphTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glyphCanvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const feedType = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), count: 0, stride: 9 };
    const unravelType = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), count: 0, stride: 9 };
    for (const b of [feedType, unravelType]) {
        gl.bindVertexArray(b.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, b.vbo);
        for (const [location, size, offset] of [
            [0, 3, 0],
            [1, 4, 12],
            [2, 2, 28]
        ]) {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, 36, offset);
        }
    }

    function target(w: number, h: number, depth = false): RenderTarget {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        let depthBuffer: WebGLRenderbuffer | null | undefined;
        if (depth) {
            depthBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        }
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error("Unable to allocate render target.");
        return { texture, fbo, depthBuffer, w, h };
    }

    function destroyTarget(t: DisposableTarget | null) {
        if (!t) return;
        if (t.texture) gl.deleteTexture(t.texture);
        gl.deleteFramebuffer(t.fbo);
        if (t.coverage) gl.deleteTexture(t.coverage);
        if (t.depthBuffer) gl.deleteRenderbuffer(t.depthBuffer);
        if (t.colorBuffer) gl.deleteRenderbuffer(t.colorBuffer);
    }

    function multisampleTarget(w: number, h: number): MultisampleTarget {
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        const colorBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, colorBuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, gpu.msaaSamples, gl.RGBA8, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorBuffer);
        const depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, gpu.msaaSamples, gl.DEPTH_COMPONENT24, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error("Unable to allocate multisample render target.");
        return { fbo, colorBuffer, depthBuffer, w, h };
    }

    function resize() {
        gpu.cssWidth = Math.max(1, canvas.clientWidth);
        gpu.cssHeight = Math.max(1, canvas.clientHeight);
        gpu.pixelRatio = Math.min(
            devicePixelRatio || 1,
            2.5,
            Math.sqrt(8388608 / (gpu.cssWidth * gpu.cssHeight)),
            gpu.maxRenderSide / gpu.cssWidth,
            gpu.maxRenderSide / gpu.cssHeight
        );
        const w = Math.round(gpu.cssWidth * gpu.pixelRatio),
            h = Math.round(gpu.cssHeight * gpu.pixelRatio);
        if (w === gpu.renderWidth && h === gpu.renderHeight) return;
        gpu.renderWidth = canvas.width = w;
        gpu.renderHeight = canvas.height = h;
        [gpu.sceneTarget, gpu.sceneMultisample, gpu.bloomA, gpu.bloomB].forEach(destroyTarget);
        gpu.sceneTarget = target(w, h, true);
        gpu.sceneMultisample = gpu.msaaSamples ? multisampleTarget(w, h) : null;
        gpu.bloomA = target(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
        gpu.bloomB = target(gpu.bloomA.w, gpu.bloomA.h);
        onResize();
    }
    return Object.assign(gpu, {
        programs,
        buffer,
        upload,
        deleteBuffer,
        destroyTarget,
        resize,
        materialBuffer,
        roundedGeometry,
        movingLines,
        particles,
        analysisSurface,
        registerSurface,
        instructionPieces,
        glyphTexture,
        feedType,
        unravelType
    });
}

// 固定バッファは buildWorld、描画先は resize、Blocks の影は buildMaterialShadow 後に利用する。
// 以下の非 null 参照はこの初期化順に対応し、未初期化の状態は公開する GPU の型にも残す。
function createRenderer({
    activity,
    camera,
    clock,
    gpu,
    session
}: {
    activity: { drawDynamic(dt: number): number };
    camera: RenderCamera;
    clock: { artTime: number };
    gpu: ReturnType<typeof createGpu>;
    session: RenderSession;
}) {
    const { programs } = gpu;
    const shadowPass: ShadowPass = {
        surfaceTexture: null,
        materialShadow: null,
        lightProjection: null,
        pieceShadow: null,
        pieceShadowKey: "",
        pieceShadowUpdates: 0
    };
    const { gl } = gpu;
    function createSurfaceTexture() {
        // 木目2層と塗膜の粒を初期化時に生成し、毎画素でのノイズ計算を省く。
        // 周期的な格子を使い、繰り返し境界と縮小表示の継ぎ目をなくす。
        const width = 256,
            height = 512,
            data = new Uint8Array(width * height * 4);
        const grid = (columns: number, rows: number, seed: number) => {
            const values = Array.from({ length: columns * rows }, (_, i) => hash(i + seed));
            return (x: number, y: number) => {
                const ix = Math.floor(x),
                    iy = Math.floor(y),
                    fx = smooth(x - ix),
                    fy = smooth(y - iy);
                const sample = (a: number, b: number) =>
                    values[(((b % rows) + rows) % rows) * columns + (((a % columns) + columns) % columns)];
                return mix(
                    mix(sample(ix, iy), sample(ix + 1, iy), fx),
                    mix(sample(ix, iy + 1), sample(ix + 1, iy + 1), fx),
                    fy
                );
            };
        };
        const grain = grid(4, 28, 310),
            fiber = grid(8, 192, 520),
            paint = grid(64, 64, 730);
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const u = x / width,
                    v = y / height,
                    warp = Math.sin(u * TAU) * 0.15 + Math.sin(u * TAU * 3 + v * TAU) * 0.035,
                    i = (y * width + x) * 4;
                data[i] = Math.round(grain(u * 4, (v + warp) * 28) * 255);
                data[i + 1] = Math.round(fiber(u * 8, (v + warp) * 192) * 255);
                data[i + 2] = Math.round(paint(u * 64, v * 64) * 255);
                data[i + 3] = 255;
            }
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, axis, gl.REPEAT);
        return texture;
    }

    function shadowTarget(withCoverage = false): RenderTarget {
        const size = Math.min(2048, gpu.maxRenderSide),
            texture = gl.createTexture(),
            fbo = gl.createFramebuffer();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
            gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE);
        for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
            gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
        let coverage: WebGLTexture | null | undefined;
        if (withCoverage) {
            coverage = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, coverage);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, null);
            for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
                gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE);
            for (const filter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
                gl.texParameteri(gl.TEXTURE_2D, filter, gl.LINEAR);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, coverage, 0);
        }
        gl.drawBuffers([withCoverage ? gl.COLOR_ATTACHMENT0 : gl.NONE]);
        gl.readBuffer(withCoverage ? gl.COLOR_ATTACHMENT0 : gl.NONE);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error("Unable to allocate material shadows.");
        return { texture, coverage, fbo, w: size, h: size };
    }

    function buildMaterialShadow() {
        shadowPass.pieceShadowKey = "";
        if (!session.style.matte) {
            gpu.destroyTarget(shadowPass.materialShadow);
            gpu.destroyTarget(shadowPass.pieceShadow);
            shadowPass.materialShadow = shadowPass.pieceShadow = null;
            return;
        }
        shadowPass.surfaceTexture ??= createSurfaceTexture();
        shadowPass.materialShadow ??= shadowTarget();
        // 固定した部品の影は組み立て時だけ描く。カメラ操作や毎フレームの再生で再生成しない。
        const f = 1 / Math.tan(0.85),
            near = 1,
            far = 70;
        const projection = new Float32Array([
            f,
            0,
            0,
            0,
            0,
            f,
            0,
            0,
            0,
            0,
            (far + near) / (near - far),
            -1,
            0,
            0,
            (2 * far * near) / (near - far),
            0
        ]);
        shadowPass.lightProjection = multiply(
            projection,
            lookAt(session.style.surface.light.map((v) => v * 26) as Vec3, [0, 0, 0])
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadowPass.materialShadow.fbo);
        gl.viewport(0, 0, shadowPass.materialShadow.w, shadowPass.materialShadow.h);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1.2, 2);
        gl.useProgram(programs.shadowProgram.p);
        gl.uniformMatrix4fv(programs.shadowProgram.u("uMatrix"), false, shadowPass.lightProjection);
        gl.bindVertexArray(gpu.staticMaterials!.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, gpu.roundedGeometry.length / 6, gpu.staticMaterials!.count);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function updatePieceShadow() {
        // カメラ操作と一時停止中は再利用。シーク・外観・演出の変更時だけ描き直す。
        const key = `${session.cycle}/${session.reducedMotion}`;
        if (shadowPass.pieceShadowKey === key) return;
        shadowPass.pieceShadow ??= shadowTarget(true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadowPass.pieceShadow.fbo);
        gl.viewport(0, 0, shadowPass.pieceShadow.w, shadowPass.pieceShadow.h);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(programs.pieceShadowProgram.p);
        gl.uniformMatrix4fv(programs.pieceShadowProgram.u("uMatrix"), false, shadowPass.lightProjection!);
        gl.uniform3fv(
            programs.pieceShadowProgram.u("uEye"),
            session.style.surface!.light.map((v) => v * 26)
        );
        gl.bindVertexArray(gpu.instructionPieces.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, gpu.instructionPieces.vertices, gpu.instructionPieces.count);
        shadowPass.pieceShadowKey = key;
        shadowPass.pieceShadowUpdates++;
    }

    function drawBuffer(b: DrawBuffer, mode: number, p: GpuProgram) {
        if (!b.count) return;
        gl.useProgram(p.p);
        gl.uniformMatrix4fv(p.u("uMatrix"), false, camera.viewProjection);
        if (p === programs.materialProgram || p === programs.pieceReceiverProgram) {
            gl.uniformMatrix4fv(p.u("uLightMatrix"), false, shadowPass.lightProjection!);
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, shadowPass.pieceShadow!.texture);
            gl.uniform1i(p.u("uPieceDepth"), 4);
            gl.activeTexture(gl.TEXTURE5);
            gl.bindTexture(gl.TEXTURE_2D, shadowPass.pieceShadow!.coverage!);
            gl.uniform1i(p.u("uPieceCoverage"), 5);
            gl.uniform1f(p.u("uPieceStrength"), session.style.surface!.pieceShadow * (1 - crystalTransmission * 0.5));
        }
        if (p === programs.materialProgram || p === programs.pieceProgram) {
            gl.uniform3fv(p.u("uEye"), camera.eye);
            gl.uniform3fv(p.u("uLight"), session.style.surface!.light);
            gl.uniform1f(p.u("uRoughness"), session.style.surface!.roughness);
            gl.uniform1f(p.u("uGrain"), session.style.surface!.grain);
            gl.uniformMatrix4fv(p.u("uLightMatrix"), false, shadowPass.lightProjection!);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, shadowPass.materialShadow!.texture);
            gl.uniform1i(p.u("uShadow"), 2);
            gl.uniform1f(p.u("uShadowTexel"), 1 / shadowPass.materialShadow!.w);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, shadowPass.surfaceTexture);
            gl.uniform1i(p.u("uSurfaceTexture"), 3);
        }
        if (p === programs.pieceProgram) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, gpu.bloomA!.texture);
            gl.uniform1i(p.u("uBackground"), 0);
            gl.uniform1f(p.u("uScale"), gpu.renderHeight / (2 * Math.tan(0.33)));
        }
        if (p === programs.pointProgram) {
            gl.uniform1f(p.u("uScale"), gpu.renderHeight * 0.042);
            gl.uniform1i(p.u("uMatte"), session.style.matte ? 1 : 0);
        }
        gl.bindVertexArray(b.vao);
        if (b.instances) gl.drawArraysInstanced(mode, 0, b.vertices, b.count);
        else gl.drawArrays(mode, 0, b.count);
    }

    function blur(source: RenderTarget, destination: RenderTarget, dx: number, dy: number, extract: number) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, destination.fbo);
        gl.viewport(0, 0, destination.w, destination.h);
        gl.useProgram(programs.blurProgram.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source.texture);
        gl.uniform1i(programs.blurProgram.u("uTexture"), 0);
        gl.uniform2f(programs.blurProgram.u("uDirection"), dx, dy);
        gl.uniform1f(programs.blurProgram.u("uExtract"), extract);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function render(dt = 0) {
        if (gpu.contextLost) return;
        gpu.resize();
        camera.update(dt, clock.artTime);
        const shock = activity.drawDynamic(dt);
        if (session.style.matte) updatePieceShadow();
        gl.bindFramebuffer(gl.FRAMEBUFFER, (gpu.sceneMultisample ?? gpu.sceneTarget!).fbo);
        gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
        gl.depthMask(true);
        gl.clearColor(...session.style.background, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        // 影の更新・再利用のどちらから来ても、不透明面の深度条件を同じにする。
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
        const receiver = session.style.matte ? programs.pieceReceiverProgram : programs.solidProgram;
        drawBuffer(gpu.staticTriangles!, gl.TRIANGLES, receiver);
        if (session.style.matte) drawBuffer(gpu.staticMaterials!, gl.TRIANGLES, programs.materialProgram);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, session.style.matte ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
        gl.depthFunc(gl.LEQUAL);
        if (session.style.matte) drawBuffer(gpu.staticShadows!, gl.TRIANGLES, programs.solidProgram);
        drawBuffer(gpu.analysisSurface, gl.TRIANGLES, receiver);
        drawBuffer(gpu.registerSurface, gl.TRIANGLES, receiver);
        drawBuffer(gpu.staticLines!, gl.LINES, programs.solidProgram);
        drawBuffer(gpu.staticStars!, gl.POINTS, programs.pointProgram);
        drawBuffer(gpu.movingLines, gl.LINES, programs.solidProgram);
        drawBuffer(gpu.particles, gl.POINTS, programs.pointProgram);
        if (session.style.matte && gpu.instructionPieces.count) {
            // 玉を描く前の背景を半解像度で保存する。MSAA の解決と縮小は別々に行う。
            if (gpu.sceneMultisample) {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.sceneMultisample.fbo);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, gpu.sceneTarget!.fbo);
                gl.blitFramebuffer(
                    0,
                    0,
                    gpu.renderWidth,
                    gpu.renderHeight,
                    0,
                    0,
                    gpu.renderWidth,
                    gpu.renderHeight,
                    gl.COLOR_BUFFER_BIT,
                    gl.NEAREST
                );
            }
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.sceneTarget!.fbo);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, gpu.bloomA!.fbo);
            gl.blitFramebuffer(
                0,
                0,
                gpu.renderWidth,
                gpu.renderHeight,
                0,
                0,
                gpu.bloomA!.w,
                gpu.bloomA!.h,
                gl.COLOR_BUFFER_BIT,
                gl.LINEAR
            );
            gl.bindFramebuffer(gl.FRAMEBUFFER, (gpu.sceneMultisample ?? gpu.sceneTarget!).fbo);
            gl.depthMask(true);
            drawBuffer(gpu.instructionPieces, gl.TRIANGLES, programs.pieceProgram);
            gl.depthMask(false);
        }
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        if (gpu.sceneMultisample) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.sceneMultisample.fbo);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, gpu.sceneTarget!.fbo);
            gl.blitFramebuffer(
                0,
                0,
                gpu.renderWidth,
                gpu.renderHeight,
                0,
                0,
                gpu.renderWidth,
                gpu.renderHeight,
                gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT,
                gl.NEAREST
            );
        }
        if (!session.style.matte) {
            blur(gpu.sceneTarget!, gpu.bloomA!, 1 / gpu.renderWidth, 0, 1);
            blur(gpu.bloomA!, gpu.bloomB!, 0, 1 / gpu.bloomA!.h, 0);
            blur(gpu.bloomB!, gpu.bloomA!, 2 / gpu.bloomA!.w, 0, 0);
            blur(gpu.bloomA!, gpu.bloomB!, 0, 2 / gpu.bloomA!.h, 0);
        }
        // 文字はシーンの奥行きを使いつつブルームの入力から外し、輪郭を鮮明に保つ。
        gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.sceneTarget!.fbo);
        gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, session.style.matte ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
        gl.useProgram(programs.typeProgram.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, gpu.glyphTexture);
        gl.uniform1i(programs.typeProgram.u("uGlyphs"), 0);
        drawBuffer(gpu.feedType, gl.TRIANGLES, programs.typeProgram);
        // 履歴から剥がれた文字は、ほどけている間はチップの手前に表示する。
        gl.disable(gl.DEPTH_TEST);
        drawBuffer(gpu.unravelType, gl.TRIANGLES, programs.typeProgram);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gpu.renderWidth, gpu.renderHeight);
        gl.useProgram(programs.compositeProgram.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, gpu.sceneTarget!.texture);
        gl.uniform1i(programs.compositeProgram.u("uScene"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, gpu.bloomB!.texture);
        gl.uniform1i(programs.compositeProgram.u("uBloom"), 1);
        gl.uniform1i(programs.compositeProgram.u("uMatte"), session.style.matte ? 1 : 0);
        gl.uniform1f(programs.compositeProgram.u("uBloomAmount"), session.bloom);
        gl.uniform1f(programs.compositeProgram.u("uTime"), clock.artTime);
        gl.uniform1f(programs.compositeProgram.u("uShock"), session.reducedMotion ? 0 : shock);
        gl.uniform2f(programs.compositeProgram.u("uResolution"), gpu.renderWidth, gpu.renderHeight);
        gl.uniform1f(programs.compositeProgram.u("uPixelRatio"), gpu.pixelRatio);
        gl.bindVertexArray(null);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    return {
        render,
        buildMaterialShadow,
        get pieceShadows() {
            return {
                size: shadowPass.pieceShadow?.w ?? 0,
                instances: session.style.matte ? gpu.instructionPieces.count : 0,
                updates: shadowPass.pieceShadowUpdates
            };
        }
    };
}

const renderer = { createGpu, createRenderer };
namespace renderer {
    export type Gpu = ReturnType<typeof createGpu>;
    export type Renderer = ReturnType<typeof createRenderer>;
    export type Buffer = VertexBuffer;
    export type InstancedBuffer = InstanceBuffer;
    export type Program = GpuProgram;
    export type Style = RenderStyle;
}
export = renderer;

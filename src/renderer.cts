"use strict";
// WebGL 資源と描画順。シェーダーは末尾の材質別生成関数で定義する。
import geometry = require("./geometry.cts");
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
type ProgramFactory = (vertex: string, fragment: string) => GpuProgram;
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

// 固定面・木の材質と影を受ける面。
function createSurfaceShaders(program: ProgramFactory) {
    const solidProgram = program(
        `#version 300 es
        layout(location = 0) in vec3 aPosition;
        layout(location = 1) in vec4 aColor;
        uniform mat4 uMatrix;
        out vec4 vColor;

        void main() {
            gl_Position = uMatrix * vec4(aPosition, 1.);
            vColor = aColor;
        }
        `,
        `#version 300 es
        precision highp float;
        in vec4 vColor;
        out vec4 frag;

        void main() {
            frag = vColor;
        }
        `
    );
    // 塗装面とガラスで色空間と光源の影を共有する。
    const surfaceLighting = `
        uniform vec3 uEye;
        uniform vec3 uLight;
        uniform highp sampler2DShadow uShadow;
        uniform float uShadowTexel;
        uniform sampler2D uSurfaceTexture;

        vec3 toLinear(vec3 c) {
            return mix(pow((c + .055) / 1.055, vec3(2.4)), c / 12.92, lessThanEqual(c, vec3(.04045)));
        }

        vec3 toSRGB(vec3 c) {
            return mix(1.055 * pow(c, vec3(1. / 2.4)) - .055, c * 12.92, lessThanEqual(c, vec3(.0031308)));
        }

        float visibility(vec4 shadow, float diffuse) {
            vec3 p = shadow.xyz / shadow.w * .5 + .5;
            if (any(lessThan(p, vec3(0.))) || any(greaterThan(p, vec3(1.))))
                return 1.;
            p.z -= .00006 + .00012 * (1. - diffuse);
            vec2 d = vec2(uShadowTexel * 1.6);
            return (texture(uShadow, p + vec3(-d.x, -d.y, 0.)) + texture(uShadow, p + vec3(d.x, -d.y, 0.))
                    + texture(uShadow, p + vec3(-d.x, d.y, 0.)) + texture(uShadow, p + vec3(d.x, d.y, 0.)))
                   * .25;
        }
    `;
    // 動く駒の影は奥行きと被覆率を分けて保存し、重なっても暗さを加算しない。
    const pieceLighting = `
        uniform highp sampler2DShadow uPieceDepth;
        uniform sampler2D uPieceCoverage;
        uniform float uPieceStrength;

        float pieceVisibility(vec4 shadow) {
            if (uPieceStrength <= 0.)
                return 1.;
            vec3 p = shadow.xyz / shadow.w * .5 + .5;
            if (any(lessThan(p, vec3(0.))) || any(greaterThan(p, vec3(1.))))
                return 1.;
            p.z -= .00004;
            // depth の比較フィルターと被覆率の補間で境界を和らげ、参照を2回に抑える。
            return 1. - uPieceStrength * (1. - texture(uPieceDepth, p)) * texture(uPieceCoverage, p.xy).r;
        }
    `;
    const pieceReceiverProgram = program(
        `#version 300 es
        layout(location = 0) in vec3 aPosition;
        layout(location = 1) in vec4 aColor;
        uniform mat4 uMatrix;
        uniform mat4 uLightMatrix;
        out vec4 vColor;
        out vec4 vShadow;

        void main() {
            gl_Position = uMatrix * vec4(aPosition, 1.);
            vShadow = uLightMatrix * vec4(aPosition, 1.);
            vColor = aColor;
        }
        `,
        `#version 300 es
        precision highp float;
        in vec4 vColor;
        in vec4 vShadow;
        out vec4 frag;

        ${surfaceLighting}
        ${pieceLighting}
        void main() {
            frag = vec4(toSRGB(toLinear(vColor.rgb) * pieceVisibility(vShadow)), vColor.a);
        }
        `
    );
    // 角の丸い形状を共有し、部品は位置・寸法・塗料だけをインスタンスごとに送る。
    const materialProgram = program(
        `#version 300 es
        layout(location = 0) in vec3 aAnchor;
        layout(location = 1) in vec3 aNormal;
        layout(location = 2) in vec3 aCenter;
        layout(location = 3) in vec3 aHalfSize;
        layout(location = 4) in vec4 aColor;
        layout(location = 5) in vec2 aSurface;
        uniform mat4 uMatrix;
        uniform mat4 uLightMatrix;
        out vec3 vPosition;
        out vec3 vNormal;
        out vec3 vLocal;
        out vec4 vColor;
        out float vSeat;
        flat out float vMaterial;
        out vec4 vShadow;

        void main() {
            vLocal = aAnchor * (aHalfSize - vec3(aSurface.x)) + aNormal * aSurface.x;
            vPosition = aCenter + vLocal;
            vNormal = aNormal;
            vColor = aColor;
            vMaterial = aSurface.y;
            vSeat = clamp((vLocal.y / aHalfSize.y + 1.) * .5, 0., 1.);
            gl_Position = uMatrix * vec4(vPosition, 1.);
            vShadow = uLightMatrix * vec4(vPosition, 1.);
        }
        `,
        `#version 300 es
        precision highp float;
        in vec3 vPosition;
        in vec3 vNormal;
        in vec3 vLocal;
        in vec4 vColor;
        in float vSeat;
        flat in float vMaterial;
        in vec4 vShadow;
        uniform float uRoughness;
        uniform float uGrain;
        out vec4 frag;

        // sRGB の区分関数で塗料を線形化し、照明計算後に表示用の値へ戻す。
        ${surfaceLighting}
        ${pieceLighting}
        void main() {
            vec3 n = normalize(vNormal), view = normalize(uEye - vPosition),
                 light = normalize(uLight * 26. - vPosition);
            vec3 color = vColor.rgb;
            float rough = uRoughness;
            if (vMaterial > .5) {
                // 長手方向へうねる木目。細い筋の縮小はテクスチャの mipmap に任せる。
                vec2 uv = vec2(vLocal.x, mix(vLocal.z, vLocal.y * 2., abs(n.z)));
                vec2 grain = texture(uSurfaceTexture, uv * vec2(.07, .25)).rg - .5;
                color *= 1. + grain.x * uGrain + grain.y * .024;
                rough += .10;
            } else {
                // 微細な塗膜のむらは物体の座標に固定し、動く駒でも模様を滑らせない。
                vec2 uv = abs(n.y) > .5 ? vLocal.xz : abs(n.x) > .5 ? vLocal.zy : vLocal.xy;
                float pores = texture(uSurfaceTexture, uv * 2.).b - .5;
                color *= 1. + pores * .028;
                rough += pores * .08;
            }
            float diffuse = max(dot(n, light), 0.), fill = max(dot(n, normalize(vec3(.65, .35, .6))), 0.);
            float lit = visibility(vShadow, diffuse);
            float seat = .84 + .16 * smoothstep(0., .65, vSeat);
            vec3 illumination = vec3(.66, .68, .70) + vec3(1., .99, .97) * diffuse * lit * .68 + fill * .15;
            vec3 halfway = normalize(light + view);
            float sheen = pow(max(dot(n, halfway), 0.), mix(100., 22., rough));
            float fresnel = .04 + .35 * pow(1. - max(dot(n, view), 0.), 5.);
            vec3 linear = toLinear(max(color, vec3(0.))) * illumination * seat;
            linear += vec3(1., .96, .89) * sheen * (.14 + fresnel) * diffuse * lit * seat;
            // 明るい反射だけを緩やかに圧縮し、通常の塗料の色と暗部は保つ。
            float peak = max(linear.r, max(linear.g, linear.b));
            if (peak > .8)
                linear *= (.8 + .2 * (1. - exp(-(peak - .8) / .2))) / peak;
            frag = vec4(toSRGB(max(linear, vec3(0.)) * pieceVisibility(vShadow)), vColor.a);
        }
        `
    );

    return { solidProgram, surfaceLighting, pieceReceiverProgram, materialProgram };
}

// Cut crystal の交点・反射・透過と投影影。
function createCrystalShaders(program: ProgramFactory, surfaceLighting: string, crystalTransmission: number) {
    // 命令は六頂点の外接領域内で視線とカット面の交点を求め、輪郭と深度を描く。
    const pieceVertex = `#version 300 es
        layout(location = 0) in vec4 aSphere;
        layout(location = 1) in vec4 aColor;
        layout(location = 2) in vec4 aRotation;
        uniform mat4 uMatrix;
        uniform vec3 uEye;
        uniform float uScale;
        out vec3 vPlane;
        flat out vec4 vSphere;
        flat out vec4 vColor;
        flat out float vPixelRadius;
        flat out vec4 vRotation;

        void main() {
            vec2 corners[6] =
                vec2[6](vec2(-1., -1.), vec2(1., -1.), vec2(1., 1.), vec2(-1., -1.), vec2(1., 1.), vec2(-1., 1.));
            vec3 facing = normalize(uEye - aSphere.xyz), right = normalize(cross(vec3(0., 1., 0.), facing)),
                 up = cross(facing, right);
            float distance = length(uEye - aSphere.xyz),
                  bound = aSphere.w * distance / sqrt(max(distance * distance - aSphere.w * aSphere.w, .0001));
            vec2 corner = corners[gl_VertexID];
            vPlane = aSphere.xyz + (right * corner.x + up * corner.y) * bound;
            vSphere = aSphere;
            vColor = aColor;
            vRotation = aRotation;
            vec4 center = uMatrix * vec4(aSphere.xyz, 1.);
            vPixelRadius = aSphere.w * uScale / center.w;
            gl_Position = uMatrix * vec4(vPlane, 1.);
        }
    `;
    const pieceFragment = `#version 300 es
        precision highp float;
        in vec3 vPlane;
        flat in vec4 vSphere;
        flat in vec4 vColor;
        flat in float vPixelRadius;
        flat in vec4 vRotation;
        uniform mat4 uMatrix;
        uniform mat4 uLightMatrix;
        uniform sampler2D uBackground;
        out vec4 frag;

        ${surfaceLighting}
        vec3 background(vec2 uv) {
            return toLinear(texture(uBackground, uv).rgb);
        }

        // 外部画像を使わず、卓上と窓のある室内の映り込みを方向から作る。
        vec3 glassEnvironment(vec3 direction, float footprint) {
            vec3 room = mix(vec3(.075, .065, .055), vec3(.63, .73, .84), smoothstep(-.15, .65, direction.y));
            float horizon = (direction.y + .02) / .12;
            room *= 1. - .55 * exp(-horizon * horizon);
            vec3 windowDirection = normalize(vec3(-.55, .85, -.4));
            vec3 right = normalize(cross(vec3(0., 1., 0.), windowDirection)), up = cross(windowDirection, right);
            float front = dot(direction, windowDirection), soft = .025 + footprint * 2.;
            vec2 p = vec2(dot(direction, right), dot(direction, up)) / max(front, .001);
            float window = (1. - smoothstep(.29 - soft, .29 + soft, abs(p.x)))
                           * (1. - smoothstep(.43 - soft, .43 + soft, abs(p.y)));
            room += vec3(8., 7.8, 7.3) * window * smoothstep(0., .1, front);
            float strip = pow(max(dot(direction, normalize(vec3(.7, .25, .6))), 0.), 24.);
            return room + vec3(.42, .58, .75) * strip;
        }

        vec3 pieceLocal(vec3 v) {
            vec4 q = vec4(-vRotation.xyz, vRotation.w);
            return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v);
        }

        vec3 pieceWorld(vec3 v) {
            return v + 2. * cross(vRotation.xyz, cross(vRotation.xyz, v) + vRotation.w * v);
        }

        void clipPiece(vec3 start, vec3 direction, vec3 normal, float limit, inout vec2 interval, inout vec3 face) {
            float slope = dot(direction, normal), gap = limit - dot(start, normal);
            if (abs(slope) < .000001) {
                if (gap < 0.)
                    interval = vec2(1., -1.);
                return;
            }
            float t = gap / slope;
            if (slope < 0.) {
                if (t > interval.x) {
                    interval.x = t;
                    face = normalize(normal);
                }
            } else
                interval.y = min(interval.y, t);
        }

        // Cut crystal の軸に垂直な6面と、角を切る8面で視線を切り詰める。
        float pieceIntersection(vec3 start, vec3 direction, out vec3 normal, out float coverage) {
            normal = vec3(0., 1., 0.);
            vec2 interval = vec2(-100., 100.);
            for (int x = -1; x <= 1; x++)
                for (int y = -1; y <= 1; y++)
                    for (int z = -1; z <= 1; z++) {
                        int axes = abs(x) + abs(y) + abs(z);
                        if (axes == 0 || axes == 2)
                            continue;
                        float limit = axes == 1 ? .88 : 1.20;
                        clipPiece(start, direction, vec3(float(x), float(y), float(z)), limit, interval, normal);
                    }
            float span = interval.y - interval.x;
            coverage = smoothstep(0., max(fwidth(span), .00001), span);
            return span > 0. && interval.x >= 0. ? interval.x : -1.;
        }

        void main() {
            vec3 ray = normalize(vPlane - uEye), offset = uEye - vSphere.xyz, perpendicular = cross(offset, ray);
            // 大きな距離の二乗同士を引かず、遠い俯瞰の小さな球でも交点の精度を保つ。
            float hit = vSphere.w * vSphere.w - dot(perpendicular, perpendicular);
            float edge = smoothstep(0., max(fwidth(hit), .00000001), hit);
            if (hit <= 0.)
                discard;
            float distance = -dot(offset, ray) - sqrt(hit);
            if (distance <= 0.)
                discard;
            vec3 position = uEye + ray * distance, n = normalize(position - vSphere.xyz), view = -ray;
            vec3 start = pieceLocal(n) * 1.0001, direction = pieceLocal(ray), localNormal;
            float coverage, t = pieceIntersection(start, direction, localNormal, coverage);
            if (t < 0.)
                discard;
            vec3 localPosition = start + direction * t;
            position = vSphere.xyz + pieceWorld(localPosition) * vSphere.w;
            n = pieceWorld(localNormal);
            edge = coverage;
            vec4 clip = uMatrix * vec4(position, 1.);
            float depth = clip.z / clip.w * .5 + .5;
            if (depth < 0. || depth > 1.)
                discard;
            gl_FragDepth = depth;
        #ifdef SHADOW_PASS
            frag = vec4(clamp(vColor.a, 0., 1.) * edge);
            return;
        #else
            vec3 light = normalize(uLight * 26. - position);
            float diffuse = max(dot(n, light), 0.), lit = visibility(uLightMatrix * vec4(position, 1.), diffuse);
            float facing = max(dot(n, view), 0.);
            // 色相を保った顔料と、面ごとの屈折・反射で Cut crystal を描く。
            float peak = max(vColor.r, max(vColor.g, vColor.b));
            vec3 pigment = pow(clamp(vColor.rgb * .98 / max(peak, .001), 0., 1.), vec3(1.15));
            vec3 tint = toLinear(pigment);
            float footprint = 1. / max(vPixelRadius, 1.);
            vec3 reflected = glassEnvironment(reflect(ray, n), footprint);
            vec4 projected = uMatrix * vec4(position + refract(ray, n, 1. / 1.5) * vSphere.w * 2., 1.);
            vec2 uv = clamp(projected.xy / max(projected.w, .001) * .5 + .5, vec2(0.), vec2(1.));
            vec3 through = background(uv) * mix(vec3(1.), tint, .65);
            vec3 linear = mix(tint * (.24 + .85 * diffuse * lit), through, ${crystalTransmission});
            linear += reflected * (.10 + .45 * pow(1. - facing, 4.));
            frag = vec4(toSRGB(clamp(linear, vec3(0.), vec3(1.))), vColor.a * edge);
        #endif
        }
    `;
    const pieceProgram = program(pieceVertex, pieceFragment);
    // 同じ交点・姿勢の計算を光源からも使い、影だけ別の形になるのを防ぐ。
    const pieceShadowProgram = program(
        pieceVertex,
        pieceFragment.replace("#version 300 es", "#version 300 es\n#define SHADOW_PASS")
    );
    const shadowProgram = program(
        `#version 300 es
        layout(location = 0) in vec3 aAnchor;
        layout(location = 1) in vec3 aNormal;
        layout(location = 2) in vec3 aCenter;
        layout(location = 3) in vec3 aHalfSize;
        layout(location = 5) in vec2 aSurface;
        uniform mat4 uMatrix;

        void main() {
            vec3 local = aAnchor * (aHalfSize - vec3(aSurface.x)) + aNormal * aSurface.x;
            gl_Position = uMatrix * vec4(aCenter + local, 1.);
        }
        `,
        `#version 300 es
        precision highp float;
        out vec4 frag;

        void main() {
            frag = vec4(0.);
        }
        `
    );

    return { pieceProgram, pieceShadowProgram, shadowProgram };
}

// 光点・文字・ブルームと最終合成。
function createEffectShaders(program: ProgramFactory) {
    const pointProgram = program(
        `#version 300 es
        layout(location = 0) in vec3 aPosition;
        layout(location = 1) in vec4 aColor;
        layout(location = 2) in float aSize;
        uniform mat4 uMatrix;
        uniform float uScale;
        out vec4 vColor;
        out float vSize;

        void main() {
            gl_Position = uMatrix * vec4(aPosition, 1.);
            vSize = clamp(aSize * uScale / gl_Position.w, 2., 256.);
            gl_PointSize = vSize;
            vColor = aColor;
        }
        `,
        `#version 300 es
        precision highp float;
        in vec4 vColor;
        in float vSize;
        out vec4 frag;
        uniform bool uMatte;

        void main() {
            vec2 p = gl_PointCoord * 2. - 1.;
            float d = length(p);
            float footprint = 2. / vSize, k = 48. / (1. + 48. * footprint * footprint / 6.);
            if (uMatte) {
                float edge = 1. - smoothstep(.42, .42 + footprint, d);
                frag = vec4(vColor.rgb, edge * min(1., vColor.a));
                return;
            }
            float glow = exp(-d * d * 6.) * .30, core = exp(-d * d * k) * k / 48.;
            float edge = 1. - smoothstep(1. - footprint, 1., d);
            frag = vec4(vColor.rgb + core * .35, (glow + core * .85) * vColor.a * edge);
        }
        `
    );
    const typeProgram = program(
        `#version 300 es
        layout(location = 0) in vec3 aPosition;
        layout(location = 1) in vec4 aColor;
        layout(location = 2) in vec2 aUV;
        uniform mat4 uMatrix;
        out vec4 vColor;
        out vec2 vUV;

        void main() {
            gl_Position = uMatrix * vec4(aPosition, 1.);
            vColor = aColor;
            vUV = aUV;
        }
        `,
        `#version 300 es
        precision highp float;
        in vec4 vColor;
        in vec2 vUV;
        uniform sampler2D uGlyphs;
        out vec4 frag;

        void main() {
            float ink = texture(uGlyphs, vUV).a;
            frag = vec4(vColor.rgb, vColor.a * ink);
        }
        `
    );
    const screenVertex = `#version 300 es
        out vec2 vUV;

        void main() {
            vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
            vUV = p;
            gl_Position = vec4(p * 2. - 1., 0., 1.);
        }
    `;
    const blurProgram = program(
        screenVertex,
        `#version 300 es
        precision highp float;
        in vec2 vUV;
        out vec4 frag;
        uniform sampler2D uTexture;
        uniform vec2 uDirection;
        uniform float uExtract;

        vec3 sampleLight(vec2 uv) {
            vec3 c = texture(uTexture, uv).rgb;
            return mix(c, max(c - vec3(.12), vec3(0.)), uExtract);
        }

        void main() {
            vec3 c = sampleLight(vUV) * .227027;
            c += (sampleLight(vUV + uDirection * 1.384615) + sampleLight(vUV - uDirection * 1.384615)) * .316216;
            c += (sampleLight(vUV + uDirection * 3.230769) + sampleLight(vUV - uDirection * 3.230769)) * .070270;
            frag = vec4(c, 1.);
        }
        `
    );
    const compositeProgram = program(
        screenVertex,
        `#version 300 es
        precision highp float;
        in vec2 vUV;
        out vec4 frag;
        uniform sampler2D uScene;
        uniform sampler2D uBloom;
        uniform float uBloomAmount;
        uniform bool uMatte;
        uniform float uTime;
        uniform float uShock;
        uniform vec2 uResolution;
        uniform float uPixelRatio;

        float noise(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            if (uMatte) {
                frag = vec4(texture(uScene, vUV).rgb, 1.);
                return;
            }
            vec2 uv = vUV;
            vec2 q = uv - .5;
            float r = length(q);
            float wave = sin(r * 65. - uShock * 15.) * .0016 * uShock;
            uv += normalize(q + vec2(.0001)) * wave;
            vec2 aberration = q * uShock * 1.4 * uPixelRatio / uResolution;
            vec3 c =
                vec3(texture(uScene, uv + aberration).r, texture(uScene, uv).g, texture(uScene, uv - aberration).b);
            vec3 light = texture(uBloom, uv).rgb * uBloomAmount;
            c += light * 1.18;
            vec3 haze = vec3(.01, .046, .055) * exp(-length((uv - vec2(.48, .45)) * vec2(1., 1.4)) * 3.);
            float mist = sin(uv.x * 8. + sin(uv.y * 6. + uTime * .04)) * sin(uv.y * 4. - uTime * .03) * .5 + .5;
            haze += mix(vec3(.006, .028, .04), vec3(.028, .009, .048), uv.x) * mist * exp(-r * 2.5);
            c += haze;
            c *= 1. - smoothstep(.2, .82, r) * .42;
            c = vec3(1.) - exp(-c * 1.25);
            c = pow(c, vec3(.9));
            c += (noise(gl_FragCoord.xy + floor(uTime * 17.)) - .5) * .0015;
            c += vec3(.15, .012, .032) * uShock * .16;
            frag = vec4(c, 1.);
        }
        `
    );

    return { pointProgram, typeProgram, blurProgram, compositeProgram };
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

"use strict";
// 材質ごとの GLSL。プログラムの生成は呼び出し元へ委ね、GPU 資源を所有しない。
type ProgramFactory<Program> = (vertex: string, fragment: string) => Program;

// 固定面・木の材質と影を受ける面。
function createSurfaceShaders<Program>(program: ProgramFactory<Program>) {
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
function createCrystalShaders<Program>(
    program: ProgramFactory<Program>,
    surfaceLighting: string,
    crystalTransmission: number
) {
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
function createEffectShaders<Program>(program: ProgramFactory<Program>) {
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

const shaders = { createSurfaceShaders, createCrystalShaders, createEffectShaders };
export = shaders;

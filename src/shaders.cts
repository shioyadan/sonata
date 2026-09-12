"use strict";
import geometry = require("./geometry.cts");
const { paperBoxHalfExtent, metalPuck, metalPuckPlanes } = geometry;
// 材質ごとの GLSL。プログラムの生成は呼び出し元へ委ね、GPU 資源を所有しない。
type ProgramFactory<Program> = (vertex: string, fragment: string) => Program;

// 固定面・紙とアルミの材質と影を受ける面。
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
    // 固定部品と命令で色空間と光源の影を共有する。
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
        out float vTopDepth;
        flat out vec3 vHalfSize;
        flat out float vMaterial;
        out vec4 vShadow;

        void main() {
            vLocal = aAnchor * (aHalfSize - vec3(aSurface.x)) + aNormal * aSurface.x;
            vPosition = aCenter + vLocal;
            vNormal = aNormal;
            vColor = aColor;
            vMaterial = aSurface.y;
            vSeat = clamp((vLocal.y / aHalfSize.y + 1.) * .5, 0., 1.);
            vTopDepth = aHalfSize.y - vLocal.y;
            vHalfSize = aHalfSize;
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
        in float vTopDepth;
        flat in vec3 vHalfSize;
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
            bool paper = vMaterial > .5 && vMaterial < 3.5, aluminum = vMaterial > 3.5;
            // サンプリングの分岐は部品単位に揃え、上面と側面の境界でも mipmap の微分を保つ。
            if (aluminum) {
                // 長手方向へ伸ばした研磨筋。面を切り替える前の微分を投影し、角のLODを保つ。
                vec3 dx = dFdx(vLocal), dy = dFdy(vLocal);
                bool sideX = abs(n.x) > .5, top = abs(n.y) > .5;
                vec2 uv = top ? vLocal.xz : sideX ? vLocal.zy : vLocal.xy;
                vec2 ux = top ? dx.xz : sideX ? dx.zy : dx.xy;
                vec2 uy = top ? dy.xz : sideX ? dy.zy : dy.xy;
                vec2 scale = vec2(.025, 2.);
                float brush = textureGrad(uSurfaceTexture, uv * scale, ux * scale, uy * scale).g - .5;
                color *= 1. + brush * uGrain;
                rough += brush * .04;
            } else if (paper) {
                // 紙面の粒と繊維も既存テクスチャを使い、縮小時は mipmap で平均する。
                vec2 uv = abs(n.y) > .5 ? vLocal.xz : abs(n.x) > .5 ? vLocal.zy : vLocal.xy;
                vec2 fiber = texture(uSurfaceTexture, uv * vec2(.65, 1.8)).bg - .5;
                color *= 1. + fiber.x * .04 + fiber.y * .014;
                float side = 1. - smoothstep(.7, .95, abs(n.y));
                if (vMaterial < 1.5) {
                    // 台と台座は厚紙の積層。線が画素より細くなると平均色へ戻し、ちらつきを防ぐ。
                    float layer = vTopDepth / .045;
                    float resolved = 1. - smoothstep(.35, .8, fwidth(layer));
                    color *= 1. - side * (.045 + .035 * cos(layer * 6.2831853) * resolved);
                } else if (vMaterial < 2.5) {
                    // 本体は折った厚紙。角の内側に一本の折り筋を付け、実際の経路は変えない。
                    vec2 inset = vHalfSize.xz - abs(vLocal.xz);
                    float edge = abs(n.y) > .5 ? min(inset.x, inset.y)
                        : abs(n.x) > .5 ? inset.y : inset.x;
                    float aa = max(fwidth(edge), .002);
                    float crease = 1. - smoothstep(.003, .007 + aa, abs(edge - .075));
                    color *= 1. - crease * .095 - side * .025;
                }
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
            linear += vec3(1., .96, .89) * sheen * (.14 + fresnel) * diffuse * lit * seat * (paper ? .06 : 1.);
            if (aluminum) {
                // 広い明暗の映り込みを解析的に近似し、追加の環境画像や描画パスを使わない。
                vec3 reflected = reflect(-view, n);
                float sky = smoothstep(-.3, .8, reflected.y);
                float softbox = pow(max(dot(reflected, normalize(vec3(-.5, .8, -.35))), 0.), 6.);
                vec3 environment = mix(vec3(.19, .23, .28), vec3(.83, .87, .91), sky);
                // 研磨方向に沿って広がる反射。平面と面取りで明暗を分ける。
                vec3 axis = abs(n.y) <= .5 && abs(n.x) > .5 ? vec3(0., 0., 1.) : vec3(1., 0., 0.);
                vec3 tangent = normalize(axis - n * dot(axis, n));
                vec3 bitangent = cross(n, tangent);
                float along = dot(halfway, tangent), across = dot(halfway, bitangent);
                float highlight = exp(-(along * along * 14. + across * across * 90.) / max(rough, .15))
                    * max(dot(n, halfway), 0.);
                linear = toLinear(color) * (environment + softbox * .35 + illumination * .12
                    + highlight * lit * .7) * seat;
            }
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

// 命令の紙箱・金属パックの材質と投影影。
function createPieceShaders<Program>(program: ProgramFactory<Program>, surfaceLighting: string) {
    // 命令は六頂点の外接領域内で視線と面の交点を求め、輪郭と深度を描く。
    const pieceVertex = `#version 300 es
        layout(location = 0) in vec4 aSphere;
        layout(location = 1) in vec4 aColor;
        layout(location = 2) in vec4 aRotation;
        uniform mat4 uMatrix;
        uniform vec3 uEye;
        out vec3 vPlane;
        flat out vec4 vSphere;
        flat out vec4 vColor;
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
            gl_Position = uMatrix * vec4(vPlane, 1.);
        }
    `;
    const pieceFragment = `#version 300 es
        precision highp float;
        in vec3 vPlane;
        flat in vec4 vSphere;
        flat in vec4 vColor;
        flat in vec4 vRotation;
        uniform mat4 uMatrix;
        uniform mat4 uLightMatrix;
        uniform bool uPuck;
        out vec4 frag;

        ${surfaceLighting}
        vec3 pieceLocal(vec3 v) {
            vec4 q = vec4(-vRotation.xyz, vRotation.w);
            return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v);
        }

        vec3 pieceWorld(vec3 v) {
            return v + 2. * cross(vRotation.xyz, cross(vRotation.xyz, v) + vRotation.w * v);
        }

        vec2 paperUV(vec3 position, vec3 face) {
            return (position.zy * face.x + position.xz * face.y + position.xy * face.z) / ${paperBoxHalfExtent};
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

        // パックの面はCPU接地と共用し、紙箱も本体と影で同じ交点を使う。
        float pieceIntersection(vec3 start, vec3 direction, out vec3 normal, out float coverage) {
            normal = vec3(0., 1., 0.);
            vec2 interval = vec2(-100., 100.);
            if (uPuck) {
                const vec4 planes[${metalPuckPlanes.length}] = vec4[](
                    ${metalPuckPlanes.map(({ n, d }) => `vec4(${[...n, d].map((v) => v.toFixed(12)).join(", ")})`).join(",\n                    ")}
                );
                for (int i = 0; i < ${metalPuckPlanes.length}; i++)
                    clipPiece(start, direction, planes[i].xyz, planes[i].w, interval, normal);
            } else {
                for (int x = -1; x <= 1; x++)
                    for (int y = -1; y <= 1; y++)
                        for (int z = -1; z <= 1; z++) {
                            int axes = abs(x) + abs(y) + abs(z);
                            if (axes != 1)
                                continue;
                            clipPiece(start, direction, vec3(float(x), float(y), float(z)),
                                ${paperBoxHalfExtent}, interval, normal);
                        }
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
            if (uPuck) {
                // 面取り円盤の側面は滑らかにし、上面の広い色と細い銀縁を区別する。
                float radial = length(localPosition.xz);
                vec2 outward = localPosition.xz / max(radial, .0001);
                vec3 smoothNormal = vec3(outward.x * length(localNormal.xz), localNormal.y,
                    outward.y * length(localNormal.xz));
                n = pieceWorld(smoothNormal);
                diffuse = max(dot(n, light), 0.);
                vec3 reflected = reflect(ray, n), halfway = normalize(light + view);
                float aa = max(fwidth(radial), .002);
                float inset = ${metalPuck.radius - metalPuck.bevel - 0.035};
                float colored = smoothstep(.75, .95, localNormal.y)
                    * (1. - smoothstep(inset - aa, inset + aa, radial));
                // 縮小時に研磨筋を平均し、顔料の色を広い反射で白く飛ばさない。
                vec2 uv = localPosition.xz * vec2(.06, 1.6);
                float brush = texture(uSurfaceTexture, uv).g - .5;
                float fill = max(dot(n, normalize(vec3(.65, .35, .6))), 0.);
                float sheen = pow(max(dot(n, halfway), 0.), 28.);
                vec3 pigment = toLinear(vColor.rgb) * (.72 + .48 * diffuse * lit + .12 * fill);
                pigment *= 1. + brush * .04;
                pigment += vec3(.06) * sheen * lit;
                float sky = smoothstep(-.3, .8, reflected.y);
                vec3 silver = mix(vec3(.18, .23, .29), vec3(.74, .8, .86), sky);
                silver = silver * (.9 + brush * .06) + vec3(.3) * sheen * lit;
                vec3 linear = mix(silver, pigment, colored);
                frag = vec4(toSRGB(clamp(linear, vec3(0.), vec3(1.))), vColor.a * edge);
                return;
            }
            // ふたの継ぎ目・折り返し・白い断面を紙面に固定し、縮小時は模様を薄める。
            vec3 face = abs(localNormal);
            // 面の境界でUVが飛んでも、同じ面へ投影した座標の微分で線幅とmipmapを求める。
            vec2 uv = paperUV(localPosition, face),
                dx = paperUV(dFdx(localPosition), face),
                dy = paperUV(dFdy(localPosition), face);
            vec2 footprint = abs(dx) + abs(dy);
            float aa = max(max(footprint.x, footprint.y), .002);
            float detail = 1. - smoothstep(.12, .45, aa);
            float fold = face.y > .5 ? min(abs(uv.x), abs(abs(uv.x) + abs(uv.y) - 1.4)) : abs(uv.y - .72);
            float crease = 1. - smoothstep(.008, .025 + aa, fold);
            float rim = 1. - smoothstep(.018, .055 + aa, 1. - max(abs(uv.x), abs(uv.y)));
            vec2 scale = vec2(.32, .9);
            vec2 fiber = textureGrad(uSurfaceTexture, uv * scale, dx * scale, dy * scale).bg - .5;
            float pigment = 1. + fiber.x * .05 + fiber.y * .018 - detail * .085 * crease;
            vec3 paper = mix(vColor.rgb * pigment, vec3(.94, .91, .84), detail * rim * .45);
            float fill = max(dot(n, normalize(vec3(.65, .35, .6))), 0.);
            vec3 linear = toLinear(clamp(paper, 0., 1.)) * (.62 + .62 * diffuse * lit + .14 * fill);
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

const shaders = { createSurfaceShaders, createPieceShaders, createEffectShaders };
export = shaders;

// 実行しない型の回帰検査。公開関数が any に退化すると expect-error が失敗する。
import geometry = require("../src/geometry.cts");
import replay = require("../src/replay-model.cts");
import renderer = require("../src/renderer.cts");
import scene = require("../src/scene.cts");
import camera = require("../src/camera.cts");
import shaders = require("../src/shaders.cts");
import browserTest = require("./browser-test.cts");

const clamped: number = geometry.clamp(0.5);
const rotation: geometry.Quaternion = [0, 0, 0, 1];
const rotated: geometry.Vector = geometry.rotate([1, 0, 0], rotation);
const rob = replay.createRobReplay([], 4);
const head: number = rob.stateAt(0).head;
const speed: number = replay.flushPlaybackRate(1, [0]);
const source = replay.createReplay({ samples: [] });
// @ts-expect-error 読込み元は準備済みの描画状態ではない。
const unloaded: geometry.Replay = source;
// @ts-expect-error current は初回の読込み前には null。
const pending: replay.Replay = source.current;
const ready = source.loadTrace("demo");
const pathReplay: geometry.Replay = ready;
const readyTrace: replay.Trace = ready.trace;
const readyRob: number = ready.robReplay.stateAt(0).head;
void [unloaded, pending, readyTrace, readyRob];

// @ts-expect-error 座標・時刻へ文字列を渡せない。
geometry.clamp(".5");
// @ts-expect-error 3次元の座標には3要素が必要。
geometry.lookAt([0, 0], [0, 0, 0]);
// @ts-expect-error 回転対象の座標は数値で指定する。
geometry.rotate([1, "0", 0], rotation);
// @ts-expect-error 再生時刻は数値。
rob.stateAt("0");
// @ts-expect-error 観測イベントの時刻は数値。
replay.flushPlaybackRate(1, ["0"]);
// @ts-expect-error ROB 容量は数値。
replay.createRobReplay([], "4");
// @ts-expect-error 接触点がない場合の null を無視してはならない。
const lower: number = geometry.lowerAt(2, 2, [0, 0, 0, 1]);
const paperLower: number | null = geometry.lowerAt(0, 0, [0, 0, 0, 1], "paper-box");
const puckLower: number | null = geometry.lowerAt(0, 0, [0, 0, 0, 1], "metal-puck");
const puckNormal: geometry.Vector = geometry.metalPuckPlanes[0].n;
// @ts-expect-error 接地の形状指定は外接球か既知の命令形状に限る。
geometry.lowerAt(0, 0, [0, 0, 0, 1], "unknown");
// @ts-expect-error 形状は真偽値ではなく名前で指定する。
geometry.support([0, -1, 0], true);

const topDown = replay.sampleTopDown(null, 1);
if (topDown.available) {
    const retiring: number = topDown.shares.retiring;
    const category: replay.Bound = topDown.dominant;
    void [retiring, category];
} else {
    // @ts-expect-error 未観測の場合には分類値が存在しない。
    topDown.shares.retiring;
}
const registers = replay.createRegisterReplay(null).stateAt(0);
if (registers.available) {
    // @ts-expect-error レジスタが存在しても値を観測できているとは限らない。
    const observed: string = registers.rows[0].value;
    void observed;
}

void [clamped, rotation, rotated, head, speed, pathReplay, lower, paperLower, puckLower, puckNormal];

// 型の境界をまたいでも、命令やステージの詳しい記録を保持する。
declare const paths: geometry.Paths<replay.Operation>;
const operation: replay.Operation = paths.occupancy(0).active[0];
const names: string[] | undefined = paths.stageAt(operation, 0)?.names;
const wait: replay.Stage = replay.memoryCompletions([operation])[0].wait;
paths.setGround(null);
const layout = scene.createScene({
    replay: ready,
    session: { style: scene.styles.neon }
});
const placement: geometry.Scene = layout;
void placement;
void [names, wait];

declare const gpu: renderer.Gpu;
const buffer: renderer.Buffer = gpu.buffer([]);
// @ts-expect-error 描画先は resize 前にはまだ存在しない。
gpu.sceneTarget.fbo;
// @ts-expect-error インスタンス描画には頂点数が必要。
const incomplete: renderer.InstancedBuffer = { ...buffer, instances: true };
// @ts-expect-error 接地する材質には表面の設定が必要。
const material: renderer.Style = { matte: true, background: [0, 0, 0] };
// @ts-expect-error WebGL 未対応時の null で GPU を初期化してはならない。
renderer.createGpu({ gl: null, canvas: document.createElement("canvas"), onResize() {} });
void [incomplete, material];

if (globalThis.sonata) {
    const selected: number | null = globalThis.sonata.selectedID;
    globalThis.sonata.setCamera("plan");
    // @ts-expect-error 再生APIは文字列の時刻を受け取らない。
    globalThis.sonata.captureAt("1");
    // @ts-expect-error 未定義のカメラモードを指定できない。
    globalThis.sonata.setCamera("unknown");
    // @ts-expect-error 再生/停止には真偽値を渡す。
    globalThis.sonata.setPlaying(1);
    void selected;
} else {
    // @ts-expect-error WebGL未対応時には診断APIも未生成。
    globalThis.sonata.setPlaying(true);
}

// カメラとシェーダーは GPU 資源の全体を受け取らずに利用できる。
const detachedCamera = camera.createCamera({
    viewport: { canvas: document.createElement("canvas"), cssWidth: 100, cssHeight: 100, resize() {} },
    world: document.createElement("div"),
    autoCamera: document.createElement("button"),
    onPick(x: number, y: number) {
        void [x, y];
    }
});
detachedCamera.setCamera("plan");
// @ts-expect-error カメラ単独の入口でも未知のモードを拒否する。
detachedCamera.setCamera("unknown");
const sourcePrograms = shaders.createSurfaceShaders((vertex, fragment) => ({ vertex, fragment }));
const fragment: string = sourcePrograms.solidProgram.fragment;
void fragment;

// Electron に渡す関数の本体・引数・戻り値も型を保つ。
declare const browserWindow: import("electron").BrowserWindow;
const { evaluate } = browserTest.createBrowserTest(browserWindow);
const cameraRadius: Promise<number> = evaluate(({ sonata }) => sonata.camera.radius);
evaluate(({ sonata, $ }, cycle: number) => {
    sonata.captureAt(cycle);
    $("license-panel").showModal();
}, 1);
// @ts-expect-error ページ内の検査からも誤った再生時刻を渡せない。
evaluate(({ sonata }) => sonata.captureAt("1"));
// @ts-expect-error ページ内の検査からも未知のカメラモードを指定できない。
evaluate(({ sonata }) => sonata.setCamera("unknown"));
// @ts-expect-error ブラウザへ渡す引数もコールバックの型と一致する必要がある。
evaluate((_, cycle: number) => cycle, "1");
// @ts-expect-error 戻り値の型は境界を通っても維持される。
const wrongRadius: Promise<string> = evaluate(({ sonata }) => sonata.camera.radius);
void [cameraRadius, wrongRadius];

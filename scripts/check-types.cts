// 実行しない型の回帰検査。公開関数が any に退化すると expect-error が失敗する。
import geometry = require("../src/geometry.cts");
import replay = require("../src/replay-model.cts");
import renderer = require("../src/renderer.cts");

const clamped: number=geometry.clamp(.5);
const rolling=geometry.createRollingTrack(time=>[time,0,0],[0,1]);
const rotation: number[]=rolling.rotationAt(.5);
const rob=replay.createRobReplay([],4);
const head: number=rob.stateAt(0).head;
const speed: number=replay.flushPlaybackRate(1,[0]);
const pathReplay: geometry.Replay=replay.createReplay({samples:[]});

// @ts-expect-error 座標・時刻へ文字列を渡せない。
geometry.clamp(".5");
// @ts-expect-error 3次元の座標には3要素が必要。
geometry.lookAt([0,0],[0,0,0]);
// @ts-expect-error 回転する経路は数値の座標を返す必要がある。
geometry.createRollingTrack(time=>[time,"0",0],[0,1]);
// @ts-expect-error 再生時刻は数値。
rob.stateAt("0");
// @ts-expect-error 観測イベントの時刻は数値。
replay.flushPlaybackRate(1,["0"]);
// @ts-expect-error ROB 容量は数値。
replay.createRobReplay([],"4");
// @ts-expect-error 接触点がない場合の null を無視してはならない。
const lower: number=geometry.lowerAt(2,2,[0,0,0,1]);

const topDown=replay.sampleTopDown(null,1);
if(topDown.available){
    const retiring: number=topDown.shares.retiring;
    const category: replay.Bound=topDown.dominant;
    void [retiring,category];
}else{
    // @ts-expect-error 未観測の場合には分類値が存在しない。
    topDown.shares.retiring;
}
const registers=replay.createRegisterReplay(null).stateAt(0);
if(registers.available){
    // @ts-expect-error レジスタが存在しても値を観測できているとは限らない。
    const observed: string=registers.rows[0].value;
    void observed;
}

void [clamped,rotation,head,speed,pathReplay,lower];

// 型の境界をまたいでも、命令やステージの詳しい記録を保持する。
declare const paths: geometry.Paths<replay.Operation>;
const operation: replay.Operation=paths.occupancy(0).active[0];
const names: string[]|undefined=paths.stageAt(operation,0)?.names;
const wait: replay.Stage=replay.memoryCompletions([operation])[0].wait;
void [names,wait];

declare const gpu: renderer.Gpu;
const buffer: renderer.Buffer=gpu.buffer([]);
// @ts-expect-error 描画先は resize 前にはまだ存在しない。
gpu.sceneTarget.fbo;
// @ts-expect-error インスタンス描画には頂点数が必要。
const incomplete: renderer.InstancedBuffer={...buffer,instances:true};
// @ts-expect-error Blocks の材質には表面の設定が必要。
const material: renderer.Style={matte:true,background:[0,0,0]};
// @ts-expect-error WebGL 未対応時の null で GPU を初期化してはならない。
renderer.createGpu({gl:null,canvas:document.createElement("canvas"),onResize(){}});
void [incomplete,material];

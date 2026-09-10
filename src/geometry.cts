"use strict";
// 表示用の数値・行列・経路演算。DOM と WebGL に依存しない。

// 配列の要素数と、経路計算が利用するモデル・配置の境界をここで定義する。
type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type Triangle = [Vec3, Vec3, Vec3];
interface PathStage { node: string; start: number; end: number; displaySlot?: number }
interface PathOperation {
    id: number; index: number; kind: string; execution: string; fetch: number; end: number; stages: PathStage[];
    flush?: boolean; allocation?: number | null; issue?: number | null; completion?: number | null;
    issueSlot?: number; robSlot?: number; memorySlot?: number; commitSlot?: number;
}
interface PathNode { id: string; x: number; h: number; z: number; w: number; d: number; pipeCount?: number; names?: string[] }
interface Lane { inlet: Vec3; outlet: Vec3 }
interface PathScene {
    nodes: Map<string, PathNode>;
    connections: { from: string; to: string; lanes: { target: Vec3 }[] }[];
    matrixPosition(index: number): Vec3;
    registerReadPort(op: PathOperation): Vec3;
    robCell(index: number, height: number): Vec3;
    executionLane(node: PathNode, index: number): Lane;
    renameInstructionPosition(index: number): Vec3;
    commitSlot(index: number | undefined): Lane;
    issueRowExit(index: number): Vec3;
}
interface PathReplay<T extends PathOperation=PathOperation> { ops: T[]; trace: { firstCycle: number; fetchWidth: number } | null }
interface PathSession { style: { palette: Record<string, Vec3> }; reducedMotion?: boolean }
interface Seat { position: Vec3; contact: Vec3 }
type InstructionState = "squashed" | "retiring" | "reading" | "waiting" | "ready" | "executing" | "flowing";
interface Transfer { from: Vec3; to: Vec3; progress: number; start: number; end: number }
interface PiecePose {
    id: number; position: Vec3; pathPosition: Vec3; contact: Vec3 | null;
    transfer: Transfer | null; radius: number; rotation: Quat;
}
type PoseCache = Map<string, PiecePose> & {
    poseKey?: string; seat?: Seat; bridgeKey?: string; bridgeSeats?: Seat[];
    bridgeProfileKey?: string; bridgeSurfaces?: { progress: number; height: number }[]; bridgeThreshold?: number;
};
interface Surface { vertices: Triangle; n: Vec3; d: number; bounds: [number, number, number, number] }

const TAU = Math.PI * 2;
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => { t = clamp(t); return t * t * (3 - 2 * t); };
const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const rgb = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;


const normalize = (a: Vec3): Vec3 => { const n = Math.hypot(...a) || 1; return a.map((v) => v / n) as Vec3; };
const cross = (a: Vec3 | Quat, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
function multiply(a: ArrayLike<number>, b: ArrayLike<number>) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    }
    return out;
}
function perspective(aspect: number, distance: number) {
    // 遠い俯瞰でも薄い面が干渉しないよう、24 bit depth と距離に応じた near を使う。
    const f = 1 / Math.tan(0.66 / 2), near = Math.max(.1,distance*.01), far = 600;
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
}
function lookAt(from: Vec3, target: Vec3) {
    const z = normalize(from.map((v, i) => v - target[i]) as Vec3);
    const x = normalize(cross([0, 1, 0], z));
    const y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, from), -dot(y, from), -dot(z, from), 1]);
}


function route(a: Vec3, b: Vec3, t: number): Vec3 {
    // 三次曲線でステージ中心を結ぶ。経路は表示用であり、実配線の再現ではない。
    const bend = Math.min(2, Math.abs(b[0] - a[0]) * .48), q = 1 - t;
    const c = [a[0] + bend, a[1] + .22, a[2]], d = [b[0] - bend, b[1] + .22, b[2]];
    return a.map((v, i) => q*q*q*v + 3*q*q*t*c[i] + 3*q*t*t*d[i] + t*t*t*b[i]) as Vec3;
}

function crossesBox(a: Vec3,b: Vec3,low: Vec3,high: Vec3){
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

// 経路に沿う回転。フレーム時計に依存しない。
const identity: Quat=[0,0,0,1];
function advance(rotation: Quat,from: Vec3 | null,to: Vec3 | null,distancePerRadian: number): Quat{
    if(!from||!to)return [...rotation];
    const dx=to[0]-from[0],dz=to[2]-from[2],distance=Math.hypot(dx,dz);
    if(distance<1e-10)return [...rotation];
    // 上向き法線と進行方向の外積。接地点が進行方向と逆へ回る向きにする。
    const half=distance/distancePerRadian/2,s=Math.sin(half)/distance;
    const x=dz*s,z=-dx*s,w=Math.cos(half),[a,b,c,d]=rotation;
    const q=[w*a+x*d-z*b,w*b+z*a-x*c,w*c+z*d+x*b,w*d-x*a-z*c];
    const length=Math.hypot(...q);
    return q.map(v=>v/length) as Quat;
}
function createRollingTrack(positionAt: (time: number) => Vec3 | null,breakpoints: Iterable<number>,{distancePerRadian=.85}={}){
    // ステージの境界・曲がり角を区切りに採取し、待機時間が長くても標本を増やさない。
    const times=[...new Set(breakpoints)].sort((a,b)=>a-b),samples: {time: number; position: Vec3 | null; rotation: Quat}[]=[];
    let previous: Vec3 | null=null,rotation: Quat=[...identity];
    const sample=(time: number)=>{
        const position=positionAt(time);
        rotation=advance(rotation,previous,position,distancePerRadian);
        if(!samples.length||!position||!previous||position.some((v,i)=>Math.abs(v-previous![i])>1e-10)){
            samples.push({time,position,rotation});
        }
        previous=position;
    };
    if(times.length)sample(times[0]);
    for(let i=1;i<times.length;i++)for(let step=1;step<=16;step++)sample(times[i-1]+(times[i]-times[i-1])*step/16);
    const previousAt=(time: number)=>{
        let lo=0,hi=samples.length;
        while(lo<hi){const mid=(lo+hi)>>1;if(samples[mid].time<=time)lo=mid+1;else hi=mid;}
        return samples[lo-1];
    };
    return {
        rotationAt(time: number,position=positionAt(time)): Quat{
            // 直前までの姿勢に現在位置までの回転を加える。呼出順や fps に依存しない。
            const before=previousAt(time);
            return before?advance(before.rotation,before.position,position,distancePerRadian):[...identity];
        }
    };
}

// Cut crystal の支持点と、描画する面に対する接地。
const dot3=(a: Vec3,b: Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a: Vec3,b: Vec3)=>a.map((v,i)=>v-b[i]) as Vec3;
const rotate=(v: Vec3,q: Quat): Vec3=>{
    const t=cross(q,v).map(x=>x*2) as Vec3,u=cross(q,t);
    return v.map((x,i)=>x+q[3]*t[i]+u[i]) as Vec3;
};
// シェーダーと同じ凸多面体の面。支持点は面同士の交点から求める。
function polyhedron(){
    const planes: {n: Vec3; d: number}[]=[],vertices: Vec3[]=[];
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
        const axes=Math.abs(x)+Math.abs(y)+Math.abs(z);
        if(!axes||axes===2)continue;
        planes.push({n:[x,y,z],d:axes===1?.88:1.20});
    }
    for(let i=0;i<planes.length;i++)for(let j=i+1;j<planes.length;j++)for(let k=j+1;k<planes.length;k++){
        const [a,b,c]=[planes[i],planes[j],planes[k]],bc=cross(b.n,c.n),det=dot3(a.n,bc);
        if(Math.abs(det)<1e-8)continue;
        const ca=cross(c.n,a.n),ab=cross(a.n,b.n),p=bc.map((v,l)=>(v*a.d+ca[l]*b.d+ab[l]*c.d)/det) as Vec3;
        if(planes.every(f=>dot3(f.n,p)<=f.d+1e-8)&&!vertices.some(v=>Math.hypot(...sub(v,p))<1e-8))vertices.push(p);
    }
    return {planes,vertices};
}
const crystal=polyhedron();
function support(direction: Vec3,boundingSphere=false): Vec3{
    if(boundingSphere){const length=Math.hypot(...direction);return direction.map(v=>v/length) as Vec3;}
    return crystal.vertices.reduce((best,p)=>dot3(p,direction)>dot3(best,direction)?p:best);
}
// 世界の垂直線に沿う Cut crystal の下端。外接球は移動経路の障害物判定専用。
function lowerAt(x: number,z: number,inverse: Quat,boundingSphere=false){
    if(boundingSphere){const d=1-x*x-z*z;return d>=0?-Math.sqrt(d):null;}
    const start=rotate([x,-2,z],inverse),direction=rotate([0,1,0],inverse);
    let lo=-Infinity,hi=Infinity;
    for(const {n,d} of crystal.planes){
        const slope=dot3(n,direction),gap=d-dot3(n,start);
        if(Math.abs(slope)<1e-10){if(gap<0)return null;continue;}
        if(slope<0)lo=Math.max(lo,gap/slope);else hi=Math.min(hi,gap/slope);
    }
    return lo<=hi?-2+lo:null;
}
function createGround(triangles: Iterable<Triangle>,floor=-.87){
    const cells=new Map<string,Surface[]>(),cellSize=.5;
    const cell=(v: number)=>Math.floor(v/cellSize),key=(x: number,z: number)=>`${x}/${z}`;
    for(const vertices of triangles){
        let n=cross(sub(vertices[1],vertices[0]),sub(vertices[2],vertices[0]));
        if(Math.abs(n[1])<1e-10)continue;
        if(n[1]<0)n=n.map(v=>-v) as Vec3;
        const xs=vertices.map(p=>p[0]),zs=vertices.map(p=>p[2]);
        const bounds: Surface["bounds"]=[Math.min(...xs),Math.max(...xs),Math.min(...zs),Math.max(...zs)];
        const triangle={vertices,n,d:dot3(n,vertices[0]),bounds};
        for(let x=cell(bounds[0]);x<=cell(bounds[1]);x++)for(let z=cell(bounds[2]);z<=cell(bounds[3]);z++){
            const id=key(x,z);if(!cells.has(id))cells.set(id,[]);cells.get(id)!.push(triangle);
        }
    }
    const inside=(x: number,z: number,{vertices:[a,b,c]}: Surface)=>{
        const signs=[[a,b],[b,c],[c,a]].map(([p,q])=>(q[0]-p[0])*(z-p[2])-(q[2]-p[2])*(x-p[0]));
        return signs.every(v=>v>=-1e-9)||signs.every(v=>v<=1e-9);
    };
    return {
        seat(position: Vec3,radius: number,q: Quat,boundingSphere=false): Seat{
            const inverse: Quat=[-q[0],-q[1],-q[2],q[3]],x=position[0],z=position[2];
            const lowest=rotate(support(rotate([0,-1,0],inverse),boundingSphere),q);
            let y=floor-lowest[1]*radius,contact: Vec3=[x+lowest[0]*radius,floor,z+lowest[2]*radius];
            const nearby=new Set<Surface>();
            for(let a=cell(x-radius);a<=cell(x+radius);a++)for(let b=cell(z-radius);b<=cell(z+radius);b++)for(const t of cells.get(key(a,b))??[])nearby.add(t);
            for(const triangle of nearby){
                const {vertices,n,d,bounds}=triangle;
                if(x+radius<bounds[0]||x-radius>bounds[1]||z+radius<bounds[2]||z-radius>bounds[3])continue;
                const low=(n[0]===0&&n[2]===0?lowest:rotate(support(rotate(n.map(v=>-v) as Vec3,inverse),boundingSphere),q)).map(v=>v*radius) as Vec3;
                const limit=(d-n[0]*x-n[2]*z-dot3(n,low))/n[1];
                if(limit<=y+1e-9)continue;
                if(inside(x+low[0],z+low[2],triangle)){
                    y=limit;contact=[x+low[0],y+low[1],z+low[2]];continue;
                }
                // 支持点が面の外なら、輪郭上で接する場所を探す。段差や溝の縁も対象にする。
                for(let i=0;i<3;i++){
                    const a=vertices[i],b=vertices[(i+1)%3],dx=b[0]-a[0],dz=b[2]-a[2],length=dx*dx+dz*dz;
                    if(length<1e-14)continue;
                    const center=((x-a[0])*dx+(z-a[2])*dz)/length;
                    const distance=(a[0]+center*dx-x)**2+(a[2]+center*dz-z)**2;
                    if(distance>radius*radius)continue;
                    const half=Math.sqrt((radius*radius-distance)/length),lo=Math.max(0,center-half),hi=Math.min(1,center+half);
                    if(lo>hi)continue;
                    const at=(t: number)=>{
                        const px=a[0]+t*dx,pz=a[2]+t*dz,bottom=lowerAt((px-x)/radius,(pz-z)/radius,inverse,boundingSphere);
                        if(bottom===null)return -Infinity;
                        const py=a[1]+t*(b[1]-a[1]),height=py-bottom*radius;
                        if(height>y){y=height;contact=[px,py,pz];}return height;
                    };
                    let best=lo,value=-Infinity;
                    for(let k=0;k<=8;k++){const t=lo+(hi-lo)*k/8,v=at(t);if(v>value){value=v;best=t;}}
                    if(value===-Infinity)continue;
                    let left=Math.max(lo,best-(hi-lo)/8),right=Math.min(hi,best+(hi-lo)/8);
                    for(let k=0;k<16;k++){
                        const a=left+(right-left)/3,b=right-(right-left)/3;
                        if(at(a)<at(b))left=a;else right=b;
                    }
                }
            }
            return {position:[x,y,z],contact};
        }
    };
}

// 命令の経路・ステージ補間と姿勢キャッシュ。
const instructionRadius=.12;
function stageAt<T extends PathOperation>(op: T,t: number): T["stages"][number] | null {
    if(t<op.fetch||t>=op.end)return null;
    let last=null;
    for(const stage of op.stages){if(stage.start>t)break;last=stage;if(t<stage.end)return stage;}
    return last;
}
function stageTransition(stage: Pick<PathStage,"node" | "start" | "end">) {
    const duration=Math.max(.001,stage.end-stage.start);
    return stage.node.startsWith("exec")?Math.min(.35,duration*.22):Math.min(.82,Math.max(.08,duration));
}
// 生成は loadTrace 前でもよい。経路の参照前にトレースと配置、接地計算前に setGround を準備する。
function createPaths<T extends PathOperation>({scene,replay,session}: {scene: PathScene; replay: PathReplay<T>; session: PathSession}) {

    function location(op: PathOperation,stage: PathStage,t: number): Vec3 {
        const n=scene.nodes.get(stage.node)||scene.nodes.get("issue")!;
        let x=n.x,y=n.h+.34,z=n.z;
        if(n.id==="issue") {
            return scene.matrixPosition(op.issueSlot??0);
        } else if(n.id==="register-read") {
            const p=scene.registerReadPort(op),arrival=stageTransition(stage),progress=smooth((t-stage.start-arrival)/Math.max(.001,stage.end-stage.start-arrival));
            return [mix(n.x-n.w*.44,p[0],progress),p[1],p[2]];
        } else if(n.id==="rob" || n.id==="commit" && op.robSlot!==undefined) {
            return scene.robCell(op.robSlot??0,.19);
        } else if(n.id==="memory-wait") {
            x+=((op.memorySlot??0)%3-1)*.3;z+=(Math.floor((op.memorySlot??0)/3)%4-1.5)*.25;
        } else if(n.id.startsWith("exec")) {
            const lane=scene.executionLane(n,op.index%n.pipeCount!),arrival=stageTransition(stage);
            const progress=smooth((t-stage.start-arrival)/Math.max(.001,stage.end-stage.start-arrival));
            return lane.inlet.map((v,i)=>mix(v,lane.outlet[i],progress)) as Vec3;
        } else if(n.names?.includes("Rn")) {
            return scene.renameInstructionPosition(stage.displaySlot??0);
        } else {
            z+=((op.index%Math.max(2,replay.trace!.fetchWidth))-(Math.max(2,replay.trace!.fetchWidth)-1)/2)*.38;
        }
        return [x,y,z];
    }

    function positionAt(op: PathOperation,t: number): Vec3 | null {
        if(t<op.fetch||t>=op.end+(op.flush?2.2:2))return null;
        if(t>=op.end) {
            if(op.flush){
                const p=positionAt(op,op.end-.001);if(!p)return null;
                const age=t-op.end,a=hash(op.id)*TAU,v=1.4+hash(op.id+1)*3.2;
                return [p[0]+Math.cos(a)*age*v,p[1]+age*(2+hash(op.id+2)*3)-age*age*.55,p[2]+Math.sin(a)*age*v];
            }
            const age=t-op.end;
            const p=op.robSlot===undefined?location(op,op.stages.at(-1)??{node:"commit",start:op.end,end:op.end},op.end-.001):scene.robCell(op.robSlot,.19);
            const slot=scene.commitSlot(op.commitSlot);
            return age<.45?route(p,slot.inlet,smooth(age/.45)):age<.95?slot.inlet.map((v,i)=>mix(v,slot.outlet[i],smooth((age-.45)/.5))) as Vec3:
                route(slot.outlet,[16.8,slot.outlet[1]+.25,slot.outlet[2]],smooth((age-.95)/1.05));
        }
        const stage=stageAt(op,t);if(!stage)return null;
        const target=location(op,stage,t);
        const transition=stageTransition(stage);
        const progress=(t-stage.start)/transition;
        if(progress>=1)return target;
        const index=op.stages.indexOf(stage),previous=op.stages[index-1];
        const source: Vec3=previous?location(op,previous,previous.end-.001):[-15.5,.8,target[2]];
        if(previous?.node==="issue"){
            const exit=scene.issueRowExit(op.issueSlot??0),port=scene.nodes.has("register-read")&&stage.node.startsWith("exec")?scene.registerReadPort(op):target;
            if(progress<.48)return source.map((v,i)=>mix(v,exit[i],smooth(progress/.48))) as Vec3;
            if(port===target)return route(exit,target,smooth((progress-.48)/.52));
            return progress<.8?route(exit,port,smooth((progress-.48)/.32)):route(port,target,smooth((progress-.8)/.2));
        }
        if(scene.nodes.has("register-read")&&stage.node.startsWith("exec")&&previous?.node!=="register-read"){
            const port=scene.registerReadPort(op);
            return progress<.65?route(source,port,smooth(progress/.65)):route(port,target,smooth((progress-.65)/.35));
        }
        if(stage.node==="rob"&&previous){
            const connection=scene.connections.find(c=>c.from===previous.node&&c.to==="rob");
            if(connection){
                const port=connection.lanes[op.index%connection.lanes.length].target;
                return progress<.7?route(source,port,smooth(progress/.7)):route(port,target,smooth((progress-.7)/.3));
            }
        }
        return route(source,target,smooth(progress));
    }

    function occupancy(t: number) {
        const active=replay.ops.filter(o=>o.fetch<=t&&o.end>t);
        const issued=active.filter(o=>o.allocation!=null&&t>=o.allocation&&t<(o.issue??o.end));
        const rob=active.filter(o=>o.allocation!=null&&t>=o.allocation);
        const windowStart=Math.max(replay.trace!.firstCycle,t-16),elapsed=t-windowStart;
        const ipc=elapsed>0?replay.ops.filter(o=>!o.flush&&o.end>windowStart&&o.end<=t).length/elapsed:0;
        return {active,issued,rob,ipc};
    }

    function instructionLight(op: PathOperation,t: number): {state: InstructionState; brightness: number; size: number} {
        if(t>=op.end)return {state:op.flush?"squashed":"retiring",brightness:1.2,size:28};
        const node=stageAt(op,t)?.node;
        if(node==="register-read")return {state:"reading",brightness:1.05,size:25};
        if(node==="issue")return {state:"waiting",brightness:.48,size:20};
        if(node==="memory-wait")return {state:"waiting",brightness:.22,size:14};
        if(node==="rob"||node==="commit"){
            const ready=op.completion!=null&&t>=op.completion;
            const completion=ready?1-smooth((t-op.completion!)/.7):0;
            return {state:ready?"ready":"waiting",brightness:ready?.42+completion*.85:.22,size:ready?19+completion*10:14};
        }
        return {state:node?.startsWith("exec")?"executing":"flowing",brightness:node?.startsWith("exec")?1.3:.85,size:28};
    }

    function instructionColor(op: PathOperation,t: number) {
        return session.style.palette[op.kind];
    }

    const poses: {pieceTracks: WeakMap<PathOperation,ReturnType<typeof createRollingTrack>>; pieceGround: ReturnType<typeof createGround> | null; piecePoseCache: WeakMap<PathOperation,PoseCache>}={pieceTracks:new WeakMap(),pieceGround:null,piecePoseCache:new WeakMap()};
    function pieceRotation(op: PathOperation,t: number,position: Vec3): Quat{
        if(session.reducedMotion)return [0,0,0,1];
        let track=poses.pieceTracks.get(op);
        if(!track){
            const end=op.end+(op.flush?2.2:2)-.000001,times=[op.fetch,op.end,end];
            for(const stage of op.stages){
                times.push(stage.start,stage.end);
                for(const fraction of [.48,.65,.7,.8,1])times.push(stage.start+stageTransition(stage)*fraction);
            }
            if(!op.flush)times.push(op.end+.45,op.end+.95);
            // 命令の実際の表示経路を使い、視点・スタイル切替では姿勢のキャッシュを捨てない。
            track=createRollingTrack(time=>positionAt(op,time),times.filter(time=>time>=op.fetch&&time<=end));
            poses.pieceTracks.set(op,track);
        }
        return track.rotationAt(t,position);
    }

    function pieceTransfer(op: PathOperation,t: number): Transfer | null{
        if(t>=op.end){
            if(op.flush)return null;
            const age=t-op.end,slot=scene.commitSlot(op.commitSlot);
            if(age<.45)return {from:op.robSlot===undefined?location(op,op.stages.at(-1)??{node:"commit",start:op.end,end:op.end},op.end-.001):scene.robCell(op.robSlot,.19),to:slot.inlet,progress:smooth(age/.45),start:op.end,end:op.end+.45};
            // COMMIT を出た後は、消えるまで出口の高さを保つ。
            return age>=.95?{from:slot.outlet,to:slot.outlet,progress:1,start:op.end+.95,end:op.end+2}:null;
        }
        const stage=stageAt(op,t);if(!stage)return null;
        const progress=(t-stage.start)/stageTransition(stage);if(progress>=1)return null;
        const previous=op.stages[op.stages.indexOf(stage)-1],to=location(op,stage,t);
        // 入場には最初のステージの高さを使う。途中の土台を経由させない。
        return {from:previous?location(op,previous,previous.end-.001):to,to,progress:smooth(clamp(progress)),start:stage.start,end:stage.start+stageTransition(stage)};
    }

    function groundedPiece(op: PathOperation,t: number,path=positionAt(op,t)): PiecePose | null{
        if(!path)return null;
        let cache=poses.piecePoseCache.get(op);if(!cache){cache=new Map();poses.piecePoseCache.set(op,cache);}
        const key=`${t}/${session.reducedMotion}`;if(cache.has(key))return cache.get(key)!;
        // 場所や待機・実行・退場で大きさを変えず、同じ命令の形を保つ。
        const radius=instructionRadius;
        const rotation=pieceRotation(op,t,path);
        const poseKey=JSON.stringify([path[0],path[2],radius,rotation]);
        if(cache.poseKey!==poseKey){cache.poseKey=poseKey;cache.seat=poses.pieceGround!.seat(path,radius,rotation);}
        let {position}=cache.seat!;let contact: Vec3 | null=cache.seat!.contact;
        const transfer=pieceTransfer(op,t);
        if(transfer){
            const {from,to,progress}=transfer,bridgeKey=JSON.stringify([from,to,radius,rotation]);
            if(cache.bridgeKey!==bridgeKey){
                cache.bridgeKey=bridgeKey;
                cache.bridgeSeats=[from,to].map(p=>poses.pieceGround!.seat(p,radius,rotation));
            }
            const profileKey=`${transfer.start}/${transfer.end}`;
            if(cache.bridgeProfileKey!==profileKey){
                cache.bridgeProfileKey=profileKey;cache.bridgeSurfaces=[];
                cache.bridgeThreshold=Math.max(...[from,to].map(p=>poses.pieceGround!.seat(p,radius,[0,0,0,1],true).contact[1]))+.05;
                for(let i=1;i<16;i++){
                    const p=positionAt(op,mix(transfer.start,transfer.end,i/16));
                    if(p)cache.bridgeSurfaces.push({progress:smooth(i/16),height:poses.pieceGround!.seat(p,radius,[0,0,0,1],true).contact[1]});
                }
            }
            // 両端を直接渡る。途中にそれより高い部品があれば、手前から滑らかに越える。
            const [a,b]=cache.bridgeSeats!;let arch=0;
            for(const sample of cache.bridgeSurfaces!){
                if(sample.height<=cache.bridgeThreshold!)continue;
                const u=sample.progress;
                arch=Math.max(arch,(sample.height+radius-mix(a.position[1],b.position[1],u))/(4*u*(1-u)));
            }
            const height=mix(a.position[1],b.position[1],progress)+arch*4*progress*(1-progress);
            if(height>position[1]+1e-9){position=[path[0],height,path[2]];contact=null;}
        }
        const piece={id:op.id,position,pathPosition:path,contact,transfer,radius,rotation};
        if(cache.size>=16)cache.delete(cache.keys().next().value!);cache.set(key,piece);return piece;
    }

    function resetTrace(){poses.pieceTracks=new WeakMap();}
    function setGround(ground: ReturnType<typeof createGround> | null){poses.pieceGround=ground;poses.piecePoseCache=new WeakMap();}
    return {stageAt,stageTransition,location,positionAt,occupancy,instructionLight,instructionColor,groundedPiece,resetTrace,setGround};
}

const geometry={TAU,clamp,mix,smooth,hash,rgb,normalize,cross,dot,multiply,perspective,lookAt,route,crossesBox,instructionRadius,createRollingTrack,createGround,support,lowerAt,rotate,createPaths,stageTransition};
globalThis.sonataPieceMotion={createRollingTrack};
globalThis.sonataPieceGrounding={createGround,support,lowerAt,rotate};

namespace geometry {
    export type Vector = Vec3;
    export type Quaternion = Quat;
    export type Ground = ReturnType<typeof createGround>;
    export type GroundSeat = Seat;
    export type GroundTriangle = Triangle;
    export type RollingTrack = ReturnType<typeof createRollingTrack>;
    export type Paths<T extends PathOperation=PathOperation> = ReturnType<typeof createPaths<T>>;
    export type Stage = PathStage;
    export type Operation = PathOperation;
    export type Scene = PathScene;
    export type Node = PathNode;
    export type Replay = PathReplay;
    export type Session = PathSession;
    export type Pose = PiecePose;
    export type Light = ReturnType<Paths["instructionLight"]>;
}
declare global {
    var sonataPieceMotion: Pick<typeof geometry,"createRollingTrack">;
    var sonataPieceGrounding: Pick<typeof geometry,"createGround" | "support" | "lowerAt" | "rotate">;
}
export = geometry;

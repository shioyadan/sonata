"use strict";
// 共通の座標・接続と、固定部品の外観を組み立てる。
const {TAU,clamp,mix,smooth,hash,rgb,route,crossesBox,createGround}=require("./geometry.js");
const sonataReplay=require("./replay-model.js");
const $=id=>document.getElementById(id);

/* 外観だけのプリセット。命令の配置、再生時刻、記録値は再生モデルと共通にする。 */
const styles = {
    neon: {
        label: "Neon", matte: false,
        palette: { integer:[.29,1,.81], memory:[1,.60,.22], branch:[.62,.43,1], red:[1,.19,.36], blue:[.30,.64,1], floor:[.08,.19,.24] },
        background: [.012,.022,.035],
        bounds: { active:"#71f5db",retiring:"#71f5db",inFlight:"#53b7af",badSpeculation:"#ff6277",frontend:"#80b7ff",backend:"#ffbb65",unresolved:"#8aa9b9",mixed:"#b0bfc8",unavailable:"#76838f" },
        timeline: ["#1d3946","#59bba9","#31525e"]
    },
    blocks: {
        label: "Blocks", matte: true,
        palette: { integer:[.16,.72,.48], memory:[.95,.64,.28], branch:[.69,.51,.93], red:[.94,.28,.34], blue:[.36,.65,.89], floor:[.84,.72,.52] },
        background: [.955,.936,.896],
        bounds: { active:"#287b60",retiring:"#287b60",inFlight:"#48877c",badSpeculation:"#bf3948",frontend:"#386d9c",backend:"#a3601c",unresolved:"#65716e",mixed:"#66645e",unavailable:"#716c63" },
        timeline: ["#c8d2ce","#43836b","#9aaca4"],
        // 大きな面は生成りと木肌、線と溝は茶灰色にし、活動の色を引き立てる。
        structure: { body:[.88,.845,.77], base:[.73,.64,.51], rail:[.91,.86,.75], recess:[.70,.645,.55], wire:[.48,.41,.33], ink:[.38,.32,.26] },
        surface: { wood:[.86,.76,.62], roughness:.60, grain:.06, light:[-.55,.85,-.4], pieceShadow:.44 }
    }
};
globalThis.sonataStyles=styles;

function createScene({gpu,replay,session}) {
    const scene={nodes:new Map(),connections:[],transferProfile:new Map()};
    function executionLane(node, index) {
        const pitch=Math.min(.72,(node.d-.65)/node.pipeCount),z=node.z+(index-(node.pipeCount-1)/2)*pitch;
        const y=node.h+.34,half=(node.w-.78)/2;
        return {inlet:[node.x-half,y,z],outlet:[node.x+half,y,z],radius:Math.min(.19,pitch*.31)};
    }

    function nodePort(node, output) {
        return node.pipeCount?[node.x+(output?1:-1)*(node.w/2+.12),node.h+.34,node.z]:[node.x,node.h+.26,node.z];
    }

    function linkPort(id,output,lane,count) {
        const n=scene.nodes.get(id),offset=lane-(count-1)/2;
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
        const peak=(scene.transferProfile.get(`${from}>${to}`)??(from==="register-read"?scene.transferProfile.get(`issue>${to}`):null))?.peak??0;
        // 並列幅はモジュールのラベルと同じ情報から決める。抜粋内で実際に使う
        // 管路はこれより少ない場合があるため、観測ピークは別の診断値に保持する。
        const execution=scene.nodes.get(from)?.pipeCount??scene.nodes.get(to)?.pipeCount;
        const memoryPath=from==="memory-wait"||to==="memory-wait";
        const retiring=from==="commit"||to==="commit";
        const count=from==="issue"&&to==="register-read"?replay.trace.structure.executionNodes.reduce((sum,n)=>sum+n.pipeCount,0):execution??(memoryPath?scene.nodes.get("exec-memory").pipeCount:retiring?replay.trace.retireWidth:to==="issue"?replay.trace.structure.allocationWidth:replay.trace.fetchWidth);
        const lanes=Array.from({length:count},(_,index)=>{
            const source=linkPort(from,true,index,count),target=linkPort(to,false,index,count);
            if(from==="register-read"&&scene.nodes.get(to)?.pipeCount){source[1]=target[1];source[2]=target[2];}
            if(from==="issue"&&to==="register-read"){
                const ports=[...scene.nodes.values()].filter(n=>n.pipeCount).flatMap(n=>Array.from({length:n.pipeCount},(_,i)=>executionLane(n,i).inlet)).sort((a,b)=>a[2]-b[2]);
                target[1]=ports[index][1];target[2]=ports[index][2];
            }
            return {source,target};
        });
        scene.connections.push({from,to,color,peak,lanes});
    }

    function makeNode(id, label, x, z, w, d, h, color, detail) {
        const node = { id, label, x, z, w, d, h, color, detail };
        scene.nodes.set(id, node);
        return node;
    }

    function matrixPosition(row,column=-1) {
        const n=scene.nodes.get("issue"),columns=replay.dependencyReplay.columnCount;
        return [n.x+(column<0?-.44*n.w+(row%2)*.28:(-.28+(column+.5)*.68/columns)*n.w),n.h+.23,
            n.z-n.matrixDepth/2+(row+.5)*n.matrixDepth/replay.trace.structure.queueCapacity];
    }

    function crossesDependencyGrid(a,b=a) {
        const n=scene.nodes.get("issue"),low=[n.x-n.w*.30,n.h+.06,n.z-n.matrixDepth/2-.06],high=[n.x+n.w*.42,n.h+1.2,n.z+n.matrixDepth/2+.06];
        return crossesBox(a,b,low,high);
    }

    function crossesMapWords(a,b=a){
        const n=renameNode();
        return n?.mapWords&&crossesBox(a,b,[n.x-n.w*.48,n.h+.06,n.z-n.d*.46],[n.x+n.w*.48,n.h+1.2,n.z+n.d*.46]);
    }

    function renameNode(){return [...scene.nodes.values()].find(n=>n.names?.includes("Rn"));}

    function renameInstructionPosition(slot){
        const n=renameNode(),rows=Math.max(2,replay.trace.fetchWidth),columns=Math.ceil(n.instructionSlots/rows);
        return [n.x+(Math.floor(slot/rows)-(columns-1)/2)*.32,n.h+.34,n.z+(slot%rows-(rows-1)/2)*.38];
    }

    function renameWordLayout(index){
        const n=renameNode(),banks=Math.ceil(n.mapWords/8),bank=Math.floor(index/8),column=index%8;
        const pitch=n.d*.84/banks,z=n.z-n.d*.42+(bank+.5)*pitch;
        const bits=Math.max(1,Math.ceil(Math.log2((replay.trace.evidence.registers.capacity??replay.registerTags.at(-1)+1))));
        const x=n.x+(column-3.5)*n.w*.095,y=n.h+.23+bank*.018;
        // レジスタを表すバーは Z 軸方向に向け、X 軸方向の命令の流れと直交させる。
        return {bits,bank,start:[x,y,z-pitch*.32],end:[x,y,z+pitch*.32],halfWidth:n.w*.031};
    }

    function physicalColumns(){return Math.max(3,Math.ceil(Math.sqrt(replay.registerTags.length*2.2/11.3)));}

    function physicalTagPosition(physical) {
        const n=scene.nodes.get("register-read"),index=replay.registerTags.indexOf(physical),columns=physicalColumns(),rows=Math.ceil(replay.registerTags.length/columns);
        return [n.x-n.w*.44+(index%columns+.5)*n.w*.88/columns,n.h+.18,n.z-n.d*.44+(Math.floor(index/columns)+.5)*n.d*.88/rows];
    }

    function registerReadPort(op) {
        const n=scene.nodes.get("register-read"),execution=scene.nodes.get(op.execution),lane=executionLane(execution,op.index%execution.pipeCount);
        return [n.x+n.w*.5+.03,lane.inlet[1],lane.inlet[2]];
    }

    function robCell(slot, lift = 0) {
        const n=scene.nodes.get("rob"),columns=replay.trace.structure.robCapacity>96?8:4,rows=Math.ceil(replay.trace.structure.robCapacity/columns);
        const column=Math.floor(slot/rows), offset=slot%rows;
        const row=column%2?rows-1-offset:offset;
        return [n.x+(column-(columns-1)/2)*n.w*.8/columns,n.h+.15+lift,n.z+(row-(rows-1)/2)*6.65/Math.max(1,rows-1)];
    }

    function commitSlot(index){
        const n=scene.nodes.get("commit"),pitch=n.d*.8/replay.trace.retireWidth,z=n.z+(index-(replay.trace.retireWidth-1)/2)*pitch,y=n.h+.20;
        return {inlet:[n.x-n.w*.35,y,z],outlet:[n.x+n.w*.35,y,z],depth:pitch*.65};
    }

    function wakeBusEntry(){const n=scene.nodes.get("issue");return [n.x-n.w*.50,n.h+.3,n.z-n.d*.5-.22];}

    function wakeColumnHead(column){const n=scene.nodes.get("issue"),p=matrixPosition(0,column);return [p[0],n.h+.3,n.z-n.d*.5-.22];}

    function issueRowExit(slot){const n=scene.nodes.get("issue"),p=matrixPosition(slot);return [n.x+n.w*.5+.06,p[1],p[2]];}

    function issuePath(issue){
        const n=scene.nodes.get("issue"),op=replay.ops.find(o=>o.id===issue.id),origin=matrixPosition(issue.slot),exit=issueRowExit(issue.slot);
        const connection=scene.connections.find(c=>c.from==="issue"&&c.to===op.execution)??scene.connections.find(c=>c.from==="issue");
        const unit=scene.nodes.get(op.execution),z=executionLane(unit,op.index%unit.pipeCount).inlet[2];
        const lane=connection.lanes.find(l=>l.target[2]===z)??connection.lanes[op.index%connection.lanes.length];
        const signal=issue.column===null?[]:[exit,[exit[0],exit[1],n.z+n.d*.5+.18],
            [matrixPosition(0,issue.column)[0],exit[1],n.z+n.d*.5+.18],matrixPosition(0,issue.column)];
        return {id:issue.id,column:issue.column,origin,exit,port:lane.target,signal};
    }

    function wakePath(source, progress,producerID) {
        const scheduler=scene.nodes.get("issue");
        const target=wakeBusEntry();
        const a=[source[0]-1.2,2.5,7.0], b=[scheduler.x-1.0,2.8,5.8];
        const t=clamp(progress),q=1-t;
        return source.map((v,i)=>q*q*q*v+3*q*q*t*a[i]+3*q*t*t*b[i]+t*t*t*target[i]);
    }

    function buildLayout() {
        scene.nodes = new Map(); scene.connections = [];
        const front = replay.trace.structure.frontNodes;
        scene.transferProfile=sonataReplay.measureTransfers(replay.ops,{firstCycle:replay.trace.firstCycle,lastCycle:replay.trace.lastCycle,frontNodes:front});
        const hasRegisters=!!replay.trace.evidence?.registers;
        front.forEach((n, i) => {const node=makeNode(n.id, n.names.join(" / "), mix(hasRegisters?-12.5:-11.4, hasRegisters?-7.8:-6.7, i / Math.max(1, front.length - 1)), 0, Math.min(1.65, 4.4 / Math.max(1, front.length - 1)), 2.7, .6 + i * .10, session.style.palette.integer, i === 0 ? "FETCH" : "FRONT END");node.names=n.names;});
        const rn=renameNode();
        if(rn&&replay.trace.evidence?.registers?.rows.length){
            rn.mapWords=replay.trace.evidence.registers.rows.length;rn.d=3.6;rn.color=session.style.palette.blue;
            rn.detail=replay.trace.evidence.registers.logicalNames?.[0]==="RAX"?"16 ARCH + 16 TEMP":`${rn.mapWords} LOGICAL REGS`;
            if(replay.trace.evidence.registers.kind==="configuration")rn.detail=`${rn.mapWords} LOGICAL · MAP NOT LOGGED`;
        }
        if(rn)rn.instructionSlots=Math.max(1,...replay.ops.flatMap(op=>op.stages.filter(s=>s.names.includes("Rn")).map(s=>(s.displaySlot??0)+1)));
        const scheduler=makeNode("issue", "SCHEDULER", hasRegisters?-5.2:-3.7, 0, hasRegisters?3.2:3.6, hasRegisters?3.2:3.6, .65, session.style.palette.blue,
            `${replay.trace.structure.queueCapacity} ROWS × ${replay.dependencyReplay.columnCount} COLS · ${replay.trace.evidence?.scheduling.kind==="recorded"?"RECORDED":"RAW ESTIMATE"}`);
        // 駒を縮めずに置けるよう、待機列の行間と筐体の奥行きを確保する。
        scheduler.matrixDepth=Math.max(scheduler.w*.68,replay.trace.structure.queueCapacity*.14);
        scheduler.d=Math.max(scheduler.d,scheduler.matrixDepth/.84);
        for (const n of replay.trace.structure.executionNodes) {
            const z = { integer: -4.2, branch: 0, memory: 4.2 }[n.kind];
            const compact=n.kind!=="memory";
            const node=makeNode(n.id, {integer:"INTEGER",branch:"BRANCH",memory:"LOAD / STORE"}[n.kind], hasRegisters?2.1:.9, z, compact?1.95:3.65, 3.05, .65, session.style.palette[n.kind], `${n.pipeCount} ${n.pipeCount === 1 ? "PIPE" : "PIPES"} · →`);
            node.pipeCount=n.pipeCount;node.compact=compact;
        }
        if (replay.trace.structure.memoryWait) makeNode("memory-wait", "MEMORY WAIT", hasRegisters?4.8:4.1, 5.5, hasRegisters?1.3:1.55, 1.6, .5, session.style.palette.memory, "OBSERVED WAIT");
        // 左端を保って右へ広げ、メモリ待ちからの接続線が逆向きになるのを避ける。
        const robWidth=replay.trace.structure.robCapacity>96?3.0:2.45;
        makeNode("rob", replay.trace.machineOrder === "in-order" ? "COMPLETION FIFO" : "REORDER BUFFER", 6.8+(robWidth-2.45)/2, 0, robWidth, 8.0, .65, session.style.palette.blue, `${replay.trace.structure.robCapacity} ENTRIES · HEAD → COMMIT`);
        makeNode("commit", "COMMIT", 11.1, 0, 2.15, 3.0, .65, session.style.palette.integer, `${replay.trace.retireWidth} SLOTS / CYCLE`);
        if(hasRegisters)makeNode("register-read","PHYSICAL REGISTERS",-1.65,0,2.2,11.3,.4,session.style.palette.blue,replay.trace.evidence.registers.origin==="gem5"?`${replay.registerTags.length} INT · ${replay.trace.evidence.registers.kind==="configuration"?"CONFIG ONLY":"RECORDED ACCESSES"}`:`${replay.registerTags.length} OBSERVED · READ AT Rr`);
        front.slice(1).forEach((n, i) => addConnection(front[i].id,n.id,scene.nodes.get(front[i].id).color));
        addConnection(front.at(-1).id,"issue",session.style.palette.integer);
        if(hasRegisters)addConnection("issue","register-read",session.style.palette.blue);
        for (const n of replay.trace.structure.executionNodes){addConnection(hasRegisters?"register-read":"issue",n.id,session.style.palette[n.kind]);addConnection(n.id,"rob",session.style.palette[n.kind]);}
        if (scene.nodes.has("memory-wait")){addConnection("exec-memory","memory-wait",session.style.palette.memory);addConnection("memory-wait","rob",session.style.palette.memory);}
        addConnection("rob","commit",session.style.palette.integer);
        addConnection("input",front[0].id,session.style.palette.integer);addConnection("commit","output",session.style.palette.integer);
        const robNode=scene.nodes.get("rob"),robInputs=scene.connections.filter(c=>c.to==="rob").flatMap(c=>c.lanes);
        robInputs.sort((a,b)=>a.source[2]-b.source[2]);
        robInputs.forEach((lane,index)=>{lane.target[2]=robNode.z+(index-(robInputs.length-1)/2)*robNode.d*.82/Math.max(1,robInputs.length-1);});

    }

    // 固定部品の形状・材質・ラベルと接地面。
    function vertex(out, p, color, alpha = 1) { (out.triangles??out).push(...p, ...color, alpha); }
    function line(out, a, b, color, alpha = 1) { vertex(out, a, color, alpha); vertex(out, b, color, alpha); }
    function point(out, p, color, size, alpha = 1) { out.push(...p, ...color, alpha, size); }
    const baseLevels={table:-.87,lowerBoard:-.71,board:-.29,plinth:-.09};
    // 通常の三角形と材質付きの部品を同じ組立処理から分ける。
    function beveledBlock(out,x,y,z,w,h,d,color,alpha=1,material=0,supportY=y) {
        const bevel=Math.min(.10,h*.18,w*.09,d*.09),bottom=Math.min(y,supportY),height=y+h-bottom;
        // 天面と面取りを保ち、底面だけを支持面まで伸ばす。命令やポートの座標は動かさない。
        (out.materials??out).push(x,bottom+height/2,z,w/2,height/2,d/2,...color,alpha,bevel,material);
    }
    function flatQuad(tris,x,y,z,w,d,color,alpha=1) {
        const p=[[x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y,z+d/2],[x-w/2,y,z+d/2]];
        for(const k of [0,1,2,0,2,3])vertex(tris,p[k],color,alpha);
    }
    function contactShadow(tris,x,y,z,w,d,spread,opacity=.22) {
        // 重複した四角を重ねず、丸い輪郭から連続的に薄くなる影を作る。
        const radius=Math.min(.18,w*.12,d*.12),color=[.24,.19,.13];
        const rim=pad=>{
            const points=[];
            for(let corner=0;corner<4;corner++){
                const sx=corner===0||corner===3?1:-1,sz=corner<2?1:-1;
                for(let k=0;k<=4;k++){
                    const angle=(corner+k/4)*Math.PI/2;
                    points.push([x+sx*(w/2-radius)+Math.cos(angle)*(radius+pad),y,z+sz*(d/2-radius)+Math.sin(angle)*(radius+pad)]);
                }
            }
            return points;
        };
        let inner=rim(0),alpha=opacity;
        for(let i=0;i<inner.length;i++)for(const p of [[x,y,z],inner[i],inner[(i+1)%inner.length]])vertex(tris,p,color,alpha);
        for(let ring=1;ring<=6;ring++){
            const t=ring/6,outer=rim(spread*t),next=opacity*(1-smooth(t))**2;
            for(let i=0;i<inner.length;i++){
                const j=(i+1)%inner.length,p=[inner[i],inner[j],outer[j],outer[i]];
                for(const k of [0,1,2,0,2,3])vertex(tris,p[k],color,k<2?alpha:next);
            }
            inner=outer;alpha=next;
        }
    }
    function ring(out, x, y, z, radius, color, alpha = 1, start = 0, end = TAU, segments = 80) {
        for (let i = 0; i < segments; i++) {
            const a = mix(start, end, i / segments), b = mix(start, end, (i + 1) / segments);
            line(out, [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius], [x + Math.cos(b) * radius, y, z + Math.sin(b) * radius], color, alpha);
        }
    }
    function box(tris, lines, x, y, z, w, h, d, color, glow = .55, supportY=y) {
        if(session.style.matte){housing(tris,lines,x,y,z,w,h,d,color,glow,supportY);return;}
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
    function housing(tris, lines, x, y, z, w, h, d, color, glow=.4, supportY=y) {
        if(session.style.matte){
            const floor=color===session.style.palette.floor,base=y<-.1;
            // 大きな構造面は中性色に揃え、意味を持つ色は命令と識別帯へ集める。
            const paint=floor?session.style.surface.wood:base?session.style.structure.base:h<.10?session.style.structure.recess:h<.20?session.style.structure.rail:session.style.structure.body;
            beveledBlock(tris,x,y,z,w,h,d,paint,1,floor||base?1:0,supportY);
            if(tris.shadows&&y>=-.05&&w>.4&&d>.4&&h>.09)contactShadow(tris.shadows,x,Math.min(y,supportY)+.002,z,w,d,.10,.18);
            return;
        }
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
        housing(tris,lines,x,-.25,z,w+.2,.16,d+.2,color,.2,baseLevels.board);
        housing(tris,lines,x,-.05,z,w,h+.05,d,color,.23,baseLevels.plinth);
        // 並列の管路は上部を開いた溝として描き、内部を流れる光が見えるようにする。
        for(let k=0;k<node.pipeCount;k++){
            const {inlet:a,outlet:b,radius:r}=executionLane(node,k);
            housing(tris,lines,x,h+.01,a[2],b[0]-a[0]+.16,.09,r*2.5,color,.16,h);
            for(let j=6;j<12;j++){
                const u=j/12*TAU,v=(j+1)/12*TAU;
                const p=[[a[0],a[1]+Math.sin(u)*r,a[2]+Math.cos(u)*r],[b[0],b[1]+Math.sin(u)*r,b[2]+Math.cos(u)*r],
                    [b[0],b[1]+Math.sin(v)*r,b[2]+Math.cos(v)*r],[a[0],a[1]+Math.sin(v)*r,a[2]+Math.cos(v)*r]];
                for(const i of [0,1,2,0,2,3])vertex(tris,p[i],session.style.matte?session.style.structure.recess:color.map((c,i)=>[.014,.025,.032][i]+c*.045));
            }
            for(const side of [-1,1])line(lines,[a[0],a[1],a[2]+side*r],[b[0],b[1],b[2]+side*r],color,.12);
            line(lines,a,b,color,.05);
            for(const t of node.compact?[0,1]:[0,.33,.67,1])pipeCollar(lines,mix(a[0],b[0],t),a[1],a[2],r,color,t===0||t===1?.23:.12);
            for(const t of node.compact?[.5]:[.28,.72])flowChevron(lines,mix(a[0],b[0],t),a[1]-.01,a[2],r*.7,color,.16);
            // 入口・出口の両方で、各接続線を対応する pipe の軸に揃える。
            const intake=[nodePort(node,false)[0],a[1],a[2]],outlet=[nodePort(node,true)[0],b[1],b[2]];
            for(const [from,to] of [[intake,a],[b,outlet]])
                for(let j=0;j<16;j++)line(lines,route(from,to,j/16),route(from,to,(j+1)/16),color,.09);
        }
        for(const side of [-1,1]){
            const railZ=z+side*(d/2-.13);
            housing(tris,lines,x,h+.015,railZ,w-.7,.12,.12,color,.16,h);
            for(const dx of [-w*.36,w*.36]){
                line(lines,[x+dx,-.12,z+side*d/2],[x+dx,-.12,z+side*(d/2+.25)],color,.28);
                flowChevron(lines,x+dx,h+.17,railZ,.2,color,.25);
            }
        }
    }

    function matrixModule(tris,lines,n) {
        housing(tris,lines,n.x,-.25,n.z,n.w+.2,.16,n.d+.2,session.style.palette.blue,.22,baseLevels.board);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,session.style.palette.blue,.3,baseLevels.plinth);
        const y=n.h+.08,x0=n.x-n.w*.28,x1=n.x+n.w*.40,z0=n.z-n.matrixDepth/2,z1=n.z+n.matrixDepth/2;
        n.grid={rows:[],columns:[]};
        // 境界線ではなく、同じエントリの行・列を一本ずつ描く。交点を依存セルと揃える。
        for(let r=0;r<replay.trace.structure.queueCapacity;r++){
            const p=matrixPosition(r),segment=[[p[0],y,p[2]],[x1,y,p[2]]];
            n.grid.rows.push(segment);line(lines,...segment,session.style.palette.blue,session.style.matte?(r%8===0?.42:.27):(r%8===0?.24:.13));
        }
        for(let c=0;c<replay.dependencyReplay.columnCount;c++){
            const x=matrixPosition(0,c)[0],segment=[[x,y,z0],[x,y,z1]];
            n.grid.columns.push(segment);line(lines,...segment,session.style.palette.blue,session.style.matte?(c%8===0?.32:.20):(c%8===0?.22:.11));
        }
        for(const x of [x0,x1])line(lines,[x,y,z0],[x,y,z1],session.style.palette.blue,.5);
        for(const z of [z0,z1])line(lines,[x0,y,z],[x1,y,z],session.style.palette.blue,.5);
    }

    function renameModule(tris,lines,n){
        housing(tris,lines,n.x,-.25,n.z,n.w+.18,.16,n.d+.16,session.style.palette.blue,.25,baseLevels.board);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,session.style.palette.blue,.35,baseLevels.plinth);
        const banks=Math.ceil(n.mapWords/8),pitch=n.d*.84/banks;
        // Rn 上に 8 本ずつ 4 組のバーを重ね、RAT の立体配列を構成する。
        // 内部の小さなセルは割り当て先の物理レジスタ番号を二進数で表す。
        for(let bank=0;bank<banks;bank++){
            const z=n.z-n.d*.42+(bank+.5)*pitch,y=n.h+.065+bank*.018;
            housing(tris,lines,n.x,y,z,n.w*.87,.14,pitch*.87,session.style.palette.blue,.22,n.h);
            line(lines,[n.x-n.w*.40,y+.16,z-pitch*.40],[n.x+n.w*.40,y+.16,z-pitch*.40],session.style.palette.blue,.3);
        }
        for(let index=0;index<n.mapWords;index++){
            const row=renameWordLayout(index);
            const [x,y,z0]=row.start,z1=row.end[2];
            const rim=[[x-row.halfWidth,y,z0],[x+row.halfWidth,y,z0],[x+row.halfWidth,y,z1],[x-row.halfWidth,y,z1]];
            for(let i=0;i<4;i++)line(lines,rim[i],rim[(i+1)%4],session.style.palette.blue,.22);
        }
    }

    function registerModule(tris,lines,n){
        housing(tris,lines,n.x,-.25,n.z,n.w+.24,.16,n.d+.24,session.style.palette.blue,.25,baseLevels.board);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,session.style.palette.blue,.35,baseLevels.plinth);
        const depth=n.d*.70/Math.ceil(replay.registerTags.length/physicalColumns());
        for(const tag of replay.registerTags){
            const p=physicalTagPosition(tag);
            housing(tris,lines,p[0],n.h+.04,p[2],n.w*.70/physicalColumns(),.055,depth,session.style.palette.blue.map(v=>v*.35),.14,n.h);
        }
        for(const execution of [...scene.nodes.values()].filter(n=>n.pipeCount))for(let lane=0;lane<execution.pipeCount;lane++){
            const p=executionLane(execution,lane).inlet;
            line(lines,[n.x+n.w*.46,p[1],p[2]],[n.x+n.w*.5+.05,p[1],p[2]],execution.color,.55);
        }
    }

    function commitModule(tris,lines,n){
        housing(tris,lines,n.x,-.25,n.z,n.w+.24,.16,n.d+.24,session.style.palette.blue,.25,baseLevels.board);
        housing(tris,lines,n.x,-.05,n.z,n.w,n.h+.05,n.d,session.style.palette.blue,.35,baseLevels.plinth);
        for(let i=0;i<replay.trace.retireWidth;i++){
            const slot=commitSlot(i),a=slot.inlet,b=slot.outlet;
            housing(tris,lines,n.x,n.h+.05,a[2],n.w*.74,.07,slot.depth,session.style.palette.blue,.38,n.h);
            line(lines,a,b,session.style.palette.blue,.20);
            for(const p of [a,b])line(lines,[p[0],p[1],p[2]-slot.depth*.4],[p[0],p[1],p[2]+slot.depth*.4],session.style.palette.blue,.45);
            line(lines,[b[0]-.14,b[1],b[2]-slot.depth*.25],b,session.style.palette.blue,.4);
            line(lines,[b[0]-.14,b[1],b[2]+slot.depth*.25],b,session.style.palette.blue,.4);
        }
    }

    function buildWorld() {
        buildLayout();
        const lines=[],stars=[],shadows=[],tris={triangles:[],materials:[],shadows};
        if(session.style.matte){
            flatQuad(tris,0,baseLevels.table,0,200,200,session.style.background);
            contactShadow(shadows,0,baseLevels.table+.002,.4,29.4,15,.35);
        }
        box(tris, lines, 0, -.65, .4, 28.8, .36, 14.4, session.style.palette.floor, .5,baseLevels.lowerBoard);
        box(tris, lines, 0, -.81, .4, 29.4, .1, 15, session.style.palette.floor, .22,baseLevels.table);
        if(!session.style.matte){
            for (let x = -28; x <= 28; x += 1) line(lines, [x,-.84,-22], [x,-.84,22], session.style.palette.floor, x % 4 === 0 ? .27 : .12);
            for (let z = -22; z <= 22; z += 1) line(lines, [-28,-.84,z], [28,-.84,z], session.style.palette.floor, z % 4 === 0 ? .27 : .12);
            for (let i = 0; i < 130; i++) {
                const x = -14 + hash(i+41) * 28, z = -6.2 + hash(i+77) * 13;
                const y = -.26, len = .25 + hash(i) * 1.5, c = i % 8 === 0 ? session.style.palette.integer : session.style.palette.floor;
                line(lines, [x,y,z], [x+len,y,z], c, i % 8 === 0 ? .28 : .38);
                line(lines, [x+len,y,z], [x+len+.27,y,z+.27], c, .25);
                if (i % 4 === 0) point(stars, [x,y,z], c, 3, .6);
            }
            for (let i = 0; i < 310; i++) point(stars, [(hash(i+910)-.5)*70, hash(i+830)*17-3, (hash(i+920)-.5)*55], i%6 ? [.22,.42,.55] : session.style.palette.integer, .8+hash(i+940)*2.1, .2+hash(i)*.5);
        }
        for (const node of scene.nodes.values()) {
            const {x,z,w,d,h,color,id} = node;
            if(session.style.matte){
                contactShadow(shadows,x,baseLevels.board+.002,z,w+.2,d+.2,.14);
                const specialized=node.pipeCount||node.mapWords||["issue","register-read","commit"].includes(id);
                const stripe=Math.min(w*.60,1.5),top=h-(specialized?0:.05);
                beveledBlock(tris,x-w/2+.12+stripe/2,top+.004,z+d/2-.13,stripe,.018,.07,color,1,0,top);
            }
            if(node.pipeCount){executionModule(tris,lines,node);continue;}
            if(id==="issue"){matrixModule(tris,lines,node);continue;}
            if(id==="register-read"){registerModule(tris,lines,node);continue;}
            if(id==="commit"){commitModule(tris,lines,node);continue;}
            if(node.mapWords){renameModule(tris,lines,node);continue;}
            box(tris, lines, x, -.25, z, w+.25, .16, d+.25, color, .22,baseLevels.board);
            box(tris, lines, x, -.05, z, w, h, d, color, .52,baseLevels.plinth);
            // 天面の細かい刻みと側面のフィンで、光を載せる物体の質感を表す。
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
        // 連続した物理スロットを蛇行させ、1 本の循環 FIFO を構成する。
        for(let slot=0;slot<replay.trace.structure.robCapacity-1;slot++)line(lines,robCell(slot,-.09),robCell(slot+1,-.09),session.style.palette.blue,.28);
        const first=robCell(0,-.09),last=robCell(replay.trace.structure.robCapacity-1,-.09);
        const wrap=[last,[last[0]+.32,last[1],last[2]-.26],[first[0]-.32,first[1],first[2]-.26],first];
        for(let i=0;i<wrap.length-1;i++)line(lines,wrap[i],wrap[i+1],session.style.palette.blue,.22);
        if(scene.nodes.has("memory-wait")){
            const n=scene.nodes.get("memory-wait"),source=[n.x,n.h+.34,n.z];
            for(let i=0;i<80;i++)line(lines,wakePath(source,i/80),wakePath(source,(i+1)/80),session.style.palette.memory,.12);
        }
        for (const {color,lanes} of scene.connections) {
            // 配線の本数は各モジュールに表示する並列幅に合わせる。
            // 余分な装飾線は加えず、ポートを実行 pipe に揃える。
            for(const {source,target} of lanes){
                for(let k=0;k<48;k++)line(lines,route(source,target,k/48),route(source,target,(k+1)/48),color,.32);
                for(const p of [source,target])point(stars,p,color,3,.4);
            }
        }
        if(session.style.matte){
            // 静的な配線・格子・空きスロットは灰色。端子の小さな色印と動的な活動は残す。
            for(let i=0;i<lines.length;i+=7)for(let channel=0;channel<3;channel++)lines[i+3+channel]=session.style.structure.wire[channel];
        }
        [gpu.staticTriangles, gpu.staticLines, gpu.staticStars, gpu.staticShadows, gpu.staticMaterials].forEach(gpu.deleteBuffer);
        gpu.staticTriangles=gpu.buffer(tris.triangles);gpu.staticMaterials=gpu.materialBuffer(tris.materials);gpu.staticLines=gpu.buffer(lines);gpu.staticStars=gpu.buffer(stars,true);gpu.staticShadows=gpu.buffer(shadows);
        let ground=null;
        if(session.style.matte){
            const surfaces=[];
            // 卓上の巨大な二枚は無限平面として扱う。溝は表示用の三角形をそのまま使う。
            for(let i=42;i<tris.triangles.length;i+=21)surfaces.push([0,7,14].map(k=>tris.triangles.slice(i+k,i+k+3)));
            for(let i=0;i<tris.materials.length;i+=12){
                const m=tris.materials.slice(i,i+12);
                for(let j=0;j<gpu.roundedGeometry.length;j+=18){
                    if(gpu.roundedGeometry[j+4]+gpu.roundedGeometry[j+10]+gpu.roundedGeometry[j+16]<=0)continue;
                    surfaces.push([0,6,12].map(k=>[0,1,2].map(a=>m[a]+gpu.roundedGeometry[j+k+a]*(m[3+a]-m[10])+gpu.roundedGeometry[j+k+3+a]*m[10])));
                }
            }
            ground=createGround(surfaces,baseLevels.table);
        }
        $("labels").replaceChildren();
        let number=0;
        for (const n of scene.nodes.values()) {
            const el=document.createElement("div");el.className=`stage-label${n.id.startsWith("front")?" front-label":""}${n.id.startsWith("exec")?" execution-label":""}`;el.style.setProperty("--stage-color",rgb(n.color));
            const index=document.createElement("span");index.className="stage-index";index.textContent=String(++number).padStart(2,"0");
            const label=document.createElement("strong");label.textContent=n.label;
            el.dataset.compactLabel="";
            label.dataset.label=({"register-read":"REG FILE","rob":"ROB","memory-wait":"MEM WAIT"})[n.id]??n.label;
            const detail=document.createElement("small");detail.textContent=n.id.startsWith("front")&&!n.mapWords?"":n.detail;
            if(n.mapWords){el.classList.add("rename-label");el.title=replay.trace.evidence.registers.kind==="configuration"?"Rename table is present; mappings were not recorded in this trace. All entries remain unobserved.":"Rename map: one bar per logical register, perpendicular to instruction flow. Blue writes a new mapping; red restores an older mapping.";}
            if(n.id==="commit")el.title="One slot per instruction in this cycle's in-order commit group. Unused slots stay dark.";
            el.append(index,label,detail);
            if(n.id==="register-read"){
                const allocation=document.createElement("div");allocation.id="register-allocation";allocation.className="register-allocation";
                allocation.title=replay.trace.evidence.registers.allocation?.label??"Allocation state not recorded in this trace.";
                for(const state of ["allocated","free","unknown"]){
                    const item=document.createElement("span");item.dataset.state=state;
                    item.append(document.createElement("i"),document.createElement("b"));allocation.append(item);
                }
                el.append(allocation);
                if(replay.trace.evidence.registers.allocation?.kind==="inferred")detail.textContent=`${replay.registerTags.length} OBSERVED · RELEASE ≈`;
            }
            $("labels").append(el);n.element=el;
        }
        return ground;
    }
    return Object.assign(scene,{executionLane,nodePort,matrixPosition,crossesDependencyGrid,crossesMapWords,renameNode,renameInstructionPosition,renameWordLayout,physicalColumns,physicalTagPosition,registerReadPort,robCell,commitSlot,wakeBusEntry,wakeColumnHead,issueRowExit,issuePath,wakePath,buildLayout,buildWorld,vertex,line,point,beveledBlock,flatQuad,contactShadow,ring,box,pipeCollar});
}
module.exports={createScene,styles};

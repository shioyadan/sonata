"use strict";
// 命令・待機列・レジスタ・命令列・Top-down の表示状態と描画データ。
const {TAU,clamp,mix,smooth,hash,route,rgb,normalize,cross}=require("./geometry.cts");
const sonataReplay=require("./replay-model.cts");
const {feedRows,feedLead}=sonataReplay;
const wakeFlightCycles=1.2,wakeEffectCycles=2.8;
const $=id=>document.getElementById(id);
function createActivity({camera,clock,scene,gpu,paths,replay,session}) {
    const activity={visiblePieces:[],visibleParticles:[],currentStats:{},activeBranches:[],activeNotifications:[],
        matrixState:null,registerState:null,registerReads:[],renameWords:[],physicalElements:new Map()};
    function drawDynamic(dt) {
        const lines=[],points=[],pieces=[];
        drawTopDown(lines,dt);
        drawInstructionStream(lines,points);
        activity.currentStats=paths.occupancy(session.cycle);activity.visibleParticles=[];activity.visiblePieces=[];
        activity.activeBranches=replay.branchRecoveries.filter(e=>session.cycle>=e.cycle&&session.cycle<e.until&&paths.positionAt(e.op,session.cycle));
        activity.matrixState=replay.dependencyReplay.stateAt(session.cycle);activity.registerState=replay.registerReplay.stateAt(session.cycle);
        activity.registerReads=activity.registerState.available?replay.ops.flatMap(op=>op.reads.filter(r=>session.cycle>=r.start&&session.cycle<Math.min(r.end,op.end)).map(r=>({op,id:op.id,sources:r.sources??op.sourceRegisters,progress:(session.cycle-r.start)/(r.end-r.start)}))):[];
        drawDependencyMatrix(lines,points);drawRegisters(lines,points);drawCommit(lines,points);
        const activeNodes=new Map(),activeLanes=new Map();
        for(const op of activity.currentStats.active){
            const s=paths.stageAt(op,session.cycle);if(!s)continue;
            activeNodes.set(s.node,(activeNodes.get(s.node)||0)+1);
            const n=scene.nodes.get(s.node);
            if(n?.pipeCount){const key=`${n.id}:${op.index%n.pipeCount}`;activeLanes.set(key,(activeLanes.get(key)||0)+1);}
        }
        for(const n of scene.nodes.values()){
            const color=n.color;
            if(n.pipeCount){
                for(let k=0;k<n.pipeCount;k++){
                    const lane=scene.executionLane(n,k),busy=activeLanes.has(`${n.id}:${k}`);
                    scene.line(lines,lane.inlet,lane.outlet,color,busy?.75:.025);
                    scene.point(points,lane.inlet,color,busy?(session.style.matte?7:14):4,busy?.9:.08);
                    scene.point(points,lane.outlet,color,busy?(session.style.matte?6:12):4,busy?.8:.06);
                    if(busy){
                        for(const side of [-1,1])scene.line(lines,[lane.inlet[0],lane.inlet[1],lane.inlet[2]+side*lane.radius],
                            [lane.outlet[0],lane.outlet[1],lane.outlet[2]+side*lane.radius],color,.4);
                        for(const p of [lane.inlet,lane.outlet])scene.pipeCollar(lines,...p,lane.radius,color,.48);
                        const t=(clock.artTime*.4+k/n.pipeCount)%1,x=mix(lane.inlet[0],lane.outlet[0],t);
                        scene.pipeCollar(lines,x,lane.inlet[1],lane.inlet[2],lane.radius*1.07,color,.38);
                        if(session.trails)scene.line(lines,[Math.max(lane.inlet[0],x-.32),lane.inlet[1],lane.inlet[2]],[x,lane.inlet[1],lane.inlet[2]],color,.6);
                    }
                }
                continue;
            }

        }
        // 配線を照らす薄いパルスは演出として描き、トレースの命令を追加しない。
        for(const {from,to,color,lanes} of scene.connections){
            if(!activeNodes.has(from)&&!activeNodes.has(to))continue;
            for(let k=0;k<lanes.length;k++){
                const t=(clock.artTime*.18+k/Math.max(1,lanes.length)+hash(lanes[k].source[0]))%1;
                scene.point(points,route(lanes[k].source,lanes[k].target,t),color,4,.24);
            }
        }
        // 完了しても物理スロットは動かさず、末尾で割り当て、先頭でコミットする。
        const fifo=replay.robReplay.stateAt(session.cycle),occupied=new Map(fifo.entries.map(entry=>[entry.slot,entry.op]));
        for(let slot=0;slot<replay.trace.structure.robCapacity;slot++){
            const p=scene.robCell(slot),op=occupied.get(slot);
            const col=op?paths.instructionColor(op,session.cycle):session.style.matte?session.style.structure.wire:session.style.palette.blue;
            const ready=op?.completion!=null&&session.cycle>=op.completion;
            const completion=ready?1-smooth((session.cycle-op.completion)/.7):0;
            scene.point(points,p,col,op?(ready?6+completion*4:4):2.5,op?(ready?.38+completion*.55:.16):.07);
            if(ready)scene.line(lines,[p[0]-.10,p[1],p[2]-.04],[p[0]+.10,p[1],p[2]-.04],col,.3+completion*.5);
        }
        const head=scene.robCell(fifo.head,.10),tail=scene.robCell(fifo.tail,.10),oldest=fifo.entries[0]?.op;
        const headColor=oldest?.completion!=null&&session.cycle>=oldest.completion?session.style.palette.integer:session.style.palette.memory;
        scene.ring(lines,...[head[0],head[1],head[2]],.21,headColor,.95,0,TAU,24);
        scene.line(lines,head,[head[0],head[1]+.55,head[2]],headColor,.75);
        scene.ring(lines,tail[0],tail[1]+.03,tail[2],.15,session.style.palette.blue,.8,0,TAU,20);
        scene.line(lines,tail,[tail[0],tail[1]+.4,tail[2]],session.style.palette.blue,.65);
        // 完了通知をスケジューラへ返す。トレースの発行時刻は変更しない。
        activity.activeNotifications=replay.memoryEvents.filter(event=>session.cycle>=event.time&&session.cycle<event.time+wakeEffectCycles);
        for(const event of activity.activeNotifications){
            const age=session.cycle-event.time,source=paths.location(event.op,event.wait,event.time-.001);
            if(age<wakeFlightCycles){
                const u=age/wakeFlightCycles,p=scene.wakePath(source,u,event.id);
                const col=session.style.palette.memory.map((v,i)=>mix(v,session.style.palette.integer[i],u));
                scene.point(points,p,col,42,1.4);
                if(session.trails)for(let k=1;k<=22;k++){
                    const a=u-k*.018,b=u-(k-1)*.018;if(a<0)break;
                    scene.line(lines,scene.wakePath(source,a,event.id),scene.wakePath(source,b,event.id),col,(1-k/23)*.95);
                    if(k%3===0)scene.point(points,scene.wakePath(source,a,event.id),col,20-k*.4,(1-k/23)*.5);
                }
                scene.ring(lines,source[0],source[1],source[2],.18+age*.28,session.style.palette.memory,1-age/wakeFlightCycles,0,TAU,24);
            }else{
                const arrival=(age-wakeFlightCycles)/(wakeEffectCycles-wakeFlightCycles),p=scene.wakeBusEntry();
                const column=replay.dependencyReplay.columnAt(event.id,session.cycle);
                scene.ring(lines,p[0],p[1],p[2],.10+arrival*.15,session.style.palette.integer,(1-arrival)*.8,0,TAU,32);
                scene.point(points,p,session.style.palette.integer,25,(1-arrival)*.65);
                if(column!==null){
                    const target=scene.wakeColumnHead(column);
                    scene.line(lines,p,target,session.style.palette.integer,(1-arrival)*.65);
                    scene.point(points,route(p,target,smooth(arrival/.5)),session.style.palette.integer,14,(1-arrival)*.8);
                }
            }
        }
        for(const op of replay.ops){
            const path=paths.positionAt(op,session.cycle);if(!path)continue;
            const squashed=op.flush&&session.cycle>=op.end,leaving=session.cycle>=op.end;
            const alpha=leaving?clamp(1-(session.cycle-op.end)/(op.flush?2.2:2)):1;
            const color=squashed?session.style.palette.red:paths.instructionColor(op,session.cycle);
            const selected=op.id===session.selectedID;
            const recoveryBranch=activity.activeBranches.find(e=>e.id===op.id);
            const light=paths.instructionLight(op,session.cycle);
            if(recoveryBranch){light.brightness=Math.max(light.brightness,1.1);light.size=Math.max(light.size,32);}
            const piece=session.style.matte?paths.groundedPiece(op,session.cycle,path):null,p=piece?.position??path;
            const overMatrix=scene.crossesDependencyGrid(path)||scene.crossesMapWords(path);
            // Blocks の過去位置にも接地計算が必要なため、軌跡は追跡中の命令に絞る。
            if(session.trails&&(!session.style.matte||selected)){
                let previous=p;
                const count=session.style.matte?5:15;
                for(let k=1;k<=count;k++){
                    const old=session.style.matte?paths.groundedPiece(op,session.cycle-k*.045)?.position:paths.positionAt(op,session.cycle-k*.045);if(!old)break;
                    const fade=(1-k/16)*alpha*light.brightness/1.2;
                    if(!scene.crossesDependencyGrid(previous,old)&&!scene.crossesMapWords(previous,old)&&Math.hypot(...old.map((v,i)=>v-previous[i]))>.003){
                        const trailColor=squashed?session.style.palette.red:paths.instructionColor(op,session.cycle-k*.045);
                        scene.line(lines,previous,old,trailColor,fade*.88);
                        if(!session.style.matte&&k%2===0)scene.point(points,old,trailColor,Math.max(3,15-k*.7),fade*.5);
                    }
                    previous=old;
                }
            }
            if(session.style.matte){
                pieces.push(...p,piece.radius,...color,alpha,...piece.rotation);
                activity.visiblePieces.push(piece);
            }else scene.point(points,p,color,overMatrix?(selected?7:4):selected?43:squashed?31:light.size,alpha*(overMatrix?.28:selected?1.6:light.brightness));
            if(!leaving)activity.visibleParticles.push({op,position:p,pathPosition:path,screen:camera.project(p),state:light.state,brightness:light.brightness,color});
            if(recoveryBranch){
                scene.ring(lines,p[0],p[1]+.015,p[2],.26,session.style.palette.branch,.85,0,TAU,36);
                scene.line(lines,p,[p[0],p[1]+.65,p[2]],session.style.palette.branch,.65);
            }
            if(selected&&!overMatrix){
                scene.ring(lines,p[0],p[1]-.06,p[2],.34+.04*Math.sin(clock.artTime*3),color,.9);
                scene.line(lines,[p[0],p[1]-.2,p[2]],[p[0],-.15,p[2]],color,.28);
            }

        }
        let shock=0;
        const currentEvents=replay.flushEvents.filter(t=>session.cycle>=t&&session.cycle<t+2.8);
        for(const event of currentEvents){
            const age=session.cycle-event,fade=clamp(1-age/2.8);
            const origin=scene.nodes.get("exec-branch")||scene.nodes.get("issue");
            shock=Math.max(shock,Math.sin(clamp(age/.5)*Math.PI/2)*fade);
            for(let r=0;r<3;r++)scene.ring(lines,origin.x,.2+r*.12,origin.z,age*(4.5+r*.4)+.35,session.style.palette.red,fade*(.9-r*.22),0,TAU,150);
            scene.point(points,[origin.x,origin.h+.6,origin.z],session.style.palette.red,100,fade*.8);
            for(let k=0;k<50;k++){
                const a=hash(k+event)*TAU,dist=age*(3+hash(k+9)*5);
                scene.point(points,[origin.x+Math.cos(a)*dist,.3+Math.sin(hash(k)*Math.PI)*age*2,origin.z+Math.sin(a)*dist],session.style.palette.red,5+hash(k)*8,fade*.8);
            }
        }
        gpu.upload(gpu.movingLines,lines);gpu.upload(gpu.particles,points);gpu.upload(gpu.instructionPieces,pieces);
        return shock;
    }

    function drawDependencyMatrix(lines,points) {
        const n=scene.nodes.get("issue"),byID=new Map(replay.ops.map(op=>[op.id,op]));
        for(const row of activity.matrixState.rows){
            const p=scene.matrixPosition(row.slot),right=scene.matrixPosition(row.slot,replay.dependencyReplay.columnCount-1);
            const color=byID.get(row.id)?session.style.palette[byID.get(row.id).kind]:session.style.palette.blue;
            scene.line(lines,p,right,color,row.ready?.15:.075);
            scene.point(points,[right[0]+.14,right[1],right[2]],row.known?color:session.style.palette.blue,5,row.ready?.85:.25);
        }
        for(const cell of activity.matrixState.cells){
            const p=scene.matrixPosition(cell.row,cell.column),color=session.style.palette[byID.get(cell.consumer).kind];
            scene.point(points,p,color,cell.waiting?7:11,cell.alpha*(cell.waiting?.8:1.2));
            const dx=Math.min(.045,n.w*.24/replay.dependencyReplay.columnCount);
            scene.line(lines,[p[0]-dx,p[1],p[2]],[p[0]+dx,p[1],p[2]],color,cell.alpha);
        }
        for(const dep of activity.matrixState.external){
            const p=scene.matrixPosition(dep.row),color=session.style.palette[byID.get(dep.consumer).kind];
            scene.point(points,[p[0]-.13,p[1],p[2]],color,dep.waiting?6:12,dep.alpha*(dep.waiting?.65:1.15));
        }
        for(const issue of activity.matrixState.issues){
            const op=byID.get(issue.id),color=session.style.palette[op.kind],fade=1-issue.progress;
            const path=scene.issuePath(issue),rowProgress=clamp(issue.progress/.18);
            const head=path.origin.map((v,i)=>mix(v,path.exit[i],smooth(rowProgress)));
            // セル上は控えめな短い線で横切り、強い発光は出口に置く。
            if(rowProgress<1)scene.line(lines,[Math.max(path.origin[0],head[0]-.12),head[1],head[2]],head,color,fade*.24);
            else{
                scene.point(points,path.exit,color,10,fade*.7);
                scene.point(points,route(path.exit,path.port,smooth((issue.progress-.18)/.82)),color,16,fade*.85);
            }
            if(issue.column!==null){
                // 選択された行の命令は右へ抜ける。選択信号はその端を回り込み、
                // 対応するエントリの列を下から上へ進む。
                const progress=issue.progress<.3?clamp((issue.progress-.12)/.18)*2:2+clamp((issue.progress-.3)/.4);
                const columnGlow=smooth((issue.progress-.3)/.10)*(1-smooth((issue.progress-.68)/.32));
                for(let k=0;k<path.signal.length-1&&k<progress;k++){
                    const a=path.signal[k],b=path.signal[k+1],end=a.map((v,i)=>mix(v,b[i],clamp(progress-k)));
                    const inColumn=k===path.signal.length-2;
                    scene.line(lines,a,end,color,inColumn?columnGlow*.75:fade*.55);
                    scene.point(points,end,color,inColumn?8:10,inColumn?columnGlow*.85:fade*.75);
                }
                if(columnGlow>0){
                    const bottom=scene.matrixPosition(replay.trace.structure.queueCapacity-1,issue.column),top=scene.matrixPosition(0,issue.column);
                    // 選択列は明るい細線として一続きに描き、列全体を見分けやすくする。
                    scene.line(lines,bottom,top,color,columnGlow*.85);
                    for(const target of issue.targets)scene.point(points,scene.matrixPosition(target.row,issue.column),session.style.palette[byID.get(target.id).kind],8,columnGlow*.95);
                }
            }
        }
        for(const event of activity.matrixState.broadcasts){
            if(event.column!==null){
                const top=scene.wakeColumnHead(event.column),bottom=scene.matrixPosition(replay.trace.structure.queueCapacity-1,event.column);
                const head=top.map((v,i)=>mix(v,bottom[i],smooth(event.progress)));
                scene.line(lines,scene.wakeBusEntry(),top,session.style.palette.integer,(1-event.progress)*.8);
                scene.line(lines,top,head,session.style.palette.integer,(1-event.progress)*.65);scene.point(points,head,session.style.palette.integer,15,(1-event.progress)*.8);
            }else for(const row of event.rows){
                const p=scene.matrixPosition(row),entry=[p[0]-.13,p[1],p[2]],bus=scene.wakeBusEntry();
                scene.line(lines,bus,[bus[0],entry[1],entry[2]],session.style.palette.integer,(1-event.progress)*.5);
                scene.line(lines,[bus[0],entry[1],entry[2]],entry,session.style.palette.integer,(1-event.progress)*.8);
            }
        }
    }

    function drawCommit(lines,points){
        const group=replay.commitGroups.get(Math.floor(session.cycle))??[];
        for(const op of group){
            if(session.cycle<op.end)continue;
            const slot=scene.commitSlot(op.commitSlot),color=session.style.palette[op.kind],phase=session.cycle-op.end;
            const strength=.42+.58*Math.sin(clamp(phase/.95)*Math.PI);
            scene.line(lines,slot.inlet,slot.outlet,color,strength);
            for(const side of [-1,1])scene.line(lines,[slot.inlet[0],slot.inlet[1],slot.inlet[2]+side*slot.depth*.4],
                [slot.outlet[0],slot.outlet[1],slot.outlet[2]+side*slot.depth*.4],color,strength*.45);
            scene.point(points,slot.outlet,color,9,strength*.8);
        }
    }

    function drawRenameWords(tris,lines,points){
        activity.renameWords=[];
        if(!scene.renameNode()?.mapWords)return;
        const n=scene.renameNode();
        activity.registerState.rows.forEach((row,index)=>{
            const layout=scene.renameWordLayout(index),{start,end,halfWidth,bits}=layout;
            const [x,y,z0]=start,z1=end[2];
            const restoring=row.event?.type==="restore",color=restoring&&row.pulse>0?session.style.palette.red:session.style.matte&&row.pulse<=0?session.style.structure.ink:session.style.palette.blue;
            const previous=row.event?(restoring?row.event.physical:row.event.previous):row.physical;
            const progress=session.reducedMotion?1:row.event?smooth((session.cycle-row.event.cycle)/.8):1;
            const known=row.physical!==null,active=row.pulse>0&&!row.constant&&previous!==row.physical;
            const sweep=mix(z0,z1,restoring?1-progress:progress),cells=[];
            // バー 1 本が論理レジスタ 1 個を表す。番号のビットは内部の控えめな印とし、
            // 別のレジスタが増えたように見える独立した箱にはしない。
            const bar=[[x-halfWidth,y+.005,z0],[x+halfWidth,y+.005,z0],[x+halfWidth,y+.005,z1],[x-halfWidth,y+.005,z1]];
            for(const i of [0,1,2,0,2,3])scene.vertex(tris,bar[i],color,known?.10:.012);
            for(let bit=0;bit<bits;bit++){
                const z=mix(z0,z1,(bit+.5)/bits),halfDepth=(z1-z0)/bits*.34;
                const replaced=progress>=1||(restoring?z>=sweep:z<=sweep);
                const physical=active&&!replaced?previous:row.physical;
                const value=physical==null||row.constant?null:(physical>>(bits-bit-1))&1;
                const fill=value===1?.17+(active&&replaced?row.pulse*.15:0):0;
                const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx,dz])=>[x+dx*halfWidth*.78,y+.012,z+dz*halfDepth]);
                for(const i of [0,1,2,0,2,3])scene.vertex(tris,corners[i],color,fill);
                cells.push({bit:bits-bit-1,value,position:[x,y+.012,z]});
            }
            const inlet=[x,y+.018,z0-.075];
            scene.line(lines,inlet,[x,y+.018,z0-.02],color,known||row.constant?.5:.12);
            if(row.constant)scene.line(lines,[x,y+.025,z0],[x,y+.025,z1],session.style.palette.blue,.28);
            if(active){
                scene.line(lines,[x-halfWidth,y+.022,z0],[x-halfWidth,y+.022,z1],color,row.pulse*.6);
                if(progress<1){
                    scene.line(lines,[x-halfWidth,y+.025,sweep],[x+halfWidth,y+.025,sweep],color,.95);
                    scene.point(points,[x,y+.03,sweep],color,6,row.pulse*.5);
                }
                scene.point(points,inlet,color,6,row.pulse*.6);
            }
            activity.renameWords.push({logical:row.logical,physical:row.physical,constant:row.constant,known,active,progress,restoring,layout,cells});
        });
    }

    function registerReaders(physical){return activity.registerReads.filter(r=>r.sources.some(s=>s.physical===physical));}

    function registerCellColor(cell){
        const readers=registerReaders(cell.physical);
        return readers.length?session.style.palette[readers[0].op.kind]:cell.event?.type==="restore"&&cell.pulse>0?session.style.palette.red:session.style.palette.blue;
    }

    function registerCellAppearance(cell){
        const reading=registerReaders(cell.physical).length>0,allocated=cell.allocation==="allocated";
        const presence=allocated?1:cell.allocation==="free"?cell.allocationPulse:0;
        return {fill:reading?.48:presence*.23,outline:reading?1:allocated?.62:cell.allocation==="free"?.16:.075,
            valueAlpha:reading?.95:presence*.6,unknown:cell.allocation==="unknown"};
    }

    function drawRegisters(lines,points) {
        const triangles=[];
        if(!activity.registerState.available){gpu.upload(gpu.registerSurface,triangles);return;}
        const n=scene.nodes.get("register-read");
        const readIDs=new Set(activity.registerReads.flatMap(r=>r.sources.map(s=>s.physical)));
        // 明るい面では小さな点でも読めるため、活動の印が命令の駒を覆わないようにする。
        const signalScale=session.style.matte?.5:1;
        const halfWidth=n.w*.34/scene.physicalColumns(),halfDepth=n.d*.34/Math.ceil(replay.registerTags.length/scene.physicalColumns());
        drawRenameWords(triangles,lines,points);
        for(const cell of activity.registerState.physical){
            const p=scene.physicalTagPosition(cell.physical),reading=readIDs.has(cell.physical),appearance=registerCellAppearance(cell);
            const color=session.style.matte&&!reading&&cell.pulse<=0?session.style.structure.ink:registerCellColor(cell);
            const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,z])=>[p[0]+x*halfWidth,p[1]-.025,p[2]+z*halfDepth]);
            for(const i of [0,1,2,0,2,3])scene.vertex(triangles,corners[i],color,appearance.fill);
            for(let i=0;i<4;i++)scene.line(lines,corners[i],corners[(i+1)%4],color,appearance.outline);
            if(appearance.unknown)scene.line(lines,corners[0],corners[2],[.47,.52,.56],.16);
            if(cell.value!==null&&appearance.valueAlpha>0){
                const bits=BigInt(cell.value),chunk=(replay.trace.evidence.registers.wordBits??32)/8,mask=(1n<<BigInt(chunk))-1n;
                for(let bit=0;bit<8;bit++){
                    const value=Number(bits>>BigInt((7-bit)*chunk)&mask),x=p[0]+(bit-3.5)*n.w*.072/scene.physicalColumns();
                    scene.line(lines,[x,p[1],p[2]+halfDepth*.12],[x,p[1],p[2]+halfDepth*.78],color,appearance.valueAlpha*(.1+value/Number(mask)*.8));
                }
            }
            if(reading||cell.pulse>0)scene.point(points,p,color,(reading?15:10)*signalScale,reading?.85:cell.pulse*.55);
            registerReaders(cell.physical).slice(1).forEach((read,index)=>scene.point(points,[p[0]+.06*(index+1),p[1]+.04,p[2]],session.style.palette[read.op.kind],10*signalScale,.9));
        }
        for(const read of activity.registerReads){
            const port=scene.registerReadPort(read.op),color=session.style.palette[read.op.kind];
            for(const source of read.sources){
                if(!replay.registerTags.includes(source.physical))continue;
                const p=scene.physicalTagPosition(source.physical);
                for(let k=0;k<16;k++)scene.line(lines,route(p,port,k/16),route(p,port,(k+1)/16),color,.7);
                scene.point(points,route(p,port,smooth(read.progress)),color,14*signalScale,.9);
            }
            scene.point(points,port,color,16*signalScale,1);
        }
        gpu.upload(gpu.registerSurface,triangles);
    }

    function reset(){
        topDown.boundDisplay.trace=null;
        $("register-readouts").replaceChildren();activity.physicalElements=new Map();activity.renameWords=[];
        for(const tag of replay.registerTags){
            const el=document.createElement("span");el.className="physical-register-id";el.textContent=`p${tag}`;
            $("register-readouts").append(el);activity.physicalElements.set(tag,el);
        }
        $("register-writeback").hidden=!replay.trace.evidence?.registers;
    }

    // 流入する命令列と squash 時の巻き戻し。
    const stream={feedVisible:[],codeFragments:[],feedState:null};
    function feedPath(u) {
        const a=[-7.4,1.1,9.4],b=[-8.2,1.25,7.4],c=[-13.2,1.0,2.0],d=[-15.5,.8,0],q=1-u;
        return a.map((v,i)=>q*q*q*v+3*q*q*u*b[i]+3*q*u*u*c[i]+u*u*u*d[i]);
    }

    function drawInstructionStream(lines,points) {
        stream.feedVisible=[];stream.codeFragments=[];
        stream.feedState=replay.feedReplay.stateAt(session.cycle,session.reducedMotion);
        const type=[],unravel=[];
        if(!session.instructionStream){gpu.upload(gpu.feedType,type);gpu.upload(gpu.unravelType,unravel);return;}
        const right=normalize(cross([0,1,0],camera.eye)),up=normalize(cross(camera.eye,right));
        const offset=(p,x,y)=>p.map((v,i)=>v+right[i]*x+up[i]*y);
        const canceledIDs=new Set(stream.feedState.ids),layers=[];
        if(stream.feedState.cancelAlpha>0)layers.push({kind:"rewind",cursor:stream.feedState.cursor,alpha:stream.feedState.cancelAlpha,shift:0});
        if(stream.feedState.flowAlpha>0)layers.push({kind:"fetch",cursor:stream.feedState.normalCursor,alpha:stream.feedState.flowAlpha,shift:(1-stream.feedState.recovery)*.25});
        // 流入する命令列は記録された fetch 順の先読み表示で、別のキューではない。
        // フラッシュ中は実際に取り消された行を履歴の層として再表示する。
        for(const layer of layers)for(let index=Math.floor(layer.cursor);index<Math.min(replay.feedOps.length,Math.ceil(layer.cursor)+feedRows);index++){
            const distance=(index+.5-layer.cursor)/feedRows+layer.shift;if(distance<=0||distance>=1)continue;
            const op=replay.feedOps[index],canceled=layer.kind==="rewind"&&canceledIDs.has(op.id);
            if(layer.kind==="rewind"&&stream.feedState.phase!=="rewind"&&!canceled)continue;
            const u=1-distance,dissolve=canceled?stream.feedState.dissolve:0;
            const p=feedPath(u),screen=camera.project(p);
            const worldPerPixel=2*screen[2]*Math.tan(.66/2)/gpu.cssHeight;
            const scale=smooth(distance/.30),alpha=smooth((1-distance)/.15)*(.32+.68*u)*layer.alpha;
            const color=canceled?session.style.palette.red:paths.instructionColor(op,session.cycle),text=op.feedText,cell=.146*scale,height=.38*scale;
            // 先細りする帯の左端に、すべての命令の開始位置を揃える。
            const left=-3.0*scale,rightEdge=left+text.length*cell;
            for(let j=0;j<text.length;j++){
                const code=text.charCodeAt(j)-32;if(code<=0||code>=95)continue;
                const x=left+j*cell,col=code%16,row=Math.floor(code/16);
                const origin=offset(p,x+cell/2,0);
                // 保持している命令列から、実際に取り消された文字を剥がす。移動量は
                // CSS ピクセルで定め、カメラ距離や高 DPI によらず分離が見えるようにする。
                const stagger=hash(op.id+j*17)*.18,travel=smooth((dissolve-stagger)/(1-stagger));
                let fragment=origin,rotation=0,glyphWidth=cell,glyphHeight=height,opacity=(canceled?layer.alpha*(.7+.3*u):alpha)*(j<8?.5:1);
                if(canceled&&travel>0){
                    const home=camera.project(origin),spread=clamp(gpu.cssWidth*.065,35,75);
                    // 文字群は共通の方向へ穏やかに漂わせ、広く激しく飛び散らせない。
                    const drift=(.2+hash(op.id+31)*.4+(hash(op.id+j*31)-.5)*.5)*spread;
                    const targetX=clamp(home[0]+drift,16,gpu.cssWidth-16);
                    const targetY=clamp(home[1]-12-hash(op.id+j*43)*38,gpu.cssWidth<700?120:175,gpu.cssHeight-60);
                    fragment=offset(origin,(targetX-home[0])*worldPerPixel*travel,(home[1]-targetY)*worldPerPixel*travel);
                    rotation=(hash(op.id+j*59)-.5)*1.0*travel;
                    const lift=smooth(travel/.3);
                    glyphWidth=mix(cell,Math.max(cell,.146*.85),lift);
                    glyphHeight=mix(height,Math.max(height,.38*.85),lift);
                    stream.codeFragments.push({id:op.id,index:j,character:text[j],origin,position:fragment,opacity,rotation,travel});
                }
                const cos=Math.cos(rotation),sin=Math.sin(rotation);
                const corners=[[-.5,.5],[.5,.5],[.5,-.5],[-.5,-.5]].map(([dx,dy])=>
                    offset(fragment,dx*glyphWidth*cos-dy*glyphHeight*sin,dx*glyphWidth*sin+dy*glyphHeight*cos));
                const uv=[[col/16,row/6],[(col+1)/16,row/6],[(col+1)/16,(row+1)/6],[col/16,(row+1)/6]];
                const vertices=canceled&&travel>0?unravel:type;
                for(const k of [0,1,2,0,2,3])vertices.push(...corners[k],...color,opacity,...uv[k]);
            }
            const intact=1-smooth(dissolve/.25);
            scene.line(lines,offset(p,left-.17,0),offset(p,left-.08,0),color,alpha*.8*intact);
            if(canceled){
                scene.line(lines,offset(p,left,0),offset(p,rightEdge,0),session.style.palette.red,alpha*.45*intact);
            }
            scene.point(points,p,color,scale<.5?6:2,alpha*.45*intact);
            stream.feedVisible.push({id:op.id,fetch:op.fetch,label:op.label,position:p,progress:u,layer:layer.kind,canceled});
        }
        // 行を入口に集め、その先の表示は既存の fetch 粒子へ引き継ぐ。
        const recent=replay.fetchGroups.find(g=>session.cycle>=g.time-feedLead&&session.cycle<g.time+.3);
        if(recent&&stream.feedState.flowAlpha>0){
            const glow=Math.sin(clamp((session.cycle-recent.time+feedLead)/(feedLead+.3))*Math.PI);
            scene.point(points,feedPath(1),session.style.palette.integer,22,glow*.85*stream.feedState.flowAlpha);
        }
        const rewinding=stream.feedState.phase==="rewind"||stream.feedState.phase==="discard";
        // 赤いパルスは、逆流するコードと同じ帯を fetch から外向きに進む。
        if(stream.feedState.time!==null&&!session.reducedMotion){
            const pulse=1-clamp(stream.feedState.age/1.3),strength=(1-smooth(stream.feedState.age/2.2));
            scene.point(points,feedPath(pulse),session.style.palette.red,26,strength*.9);
            if(session.trails)for(let k=1;k<=12;k++){
                const u=pulse+k*.018;if(u>=1)break;
                scene.line(lines,feedPath(u-.018),feedPath(u),session.style.palette.red,(1-k/13)*strength*.65);
            }
        }
        for(let k=0;k<60;k++){
            const u=k/60,v=(k+1)/60;
            for(const side of [-1,1]){
                const a=offset(feedPath(u),side*3.3*smooth((1-u)/.30),0),b=offset(feedPath(v),side*3.3*smooth((1-v)/.30),0);
                scene.line(lines,a,b,rewinding?session.style.palette.red:session.style.palette.blue,(rewinding?.38:.10)*Math.sin(u*Math.PI));
            }
        }
        gpu.upload(gpu.feedType,type);gpu.upload(gpu.unravelType,unravel);
    }

    // Top-down の分類と表示補間。
    const topDown={sceneTopDown:{available:false},topDownRegion:null,topDownRail:[]};
    const boundStyles = {
        active: { label:"Pipeline active",context:"Recent allocations in flight or already committed",region:[-12.7,12.6,-6.1,6.8] },
        retiring: { label:"Retiring",context:"Allocation slots with commit already observed",region:[-12.7,12.6,-6.1,6.8] },
        inFlight: { label:"In flight",context:"Allocated work whose outcome is not yet known" },
        badSpeculation: { label:"Bad speculation",context:"Wrong-path allocation + recovery bubbles",region:[-12.7,8.5,-6.1,6.8] },
        frontend: { label:"Frontend bound",context:"Frontend delivery limits allocation",region:[-12.7,-5.5,-2.2,2.2] },
        backend: { label:"Backend bound",context:"Backend capacity limits allocation",region:[-5.5,8.5,-6.1,6.8] },
        unresolved: { label:"Unresolved",context:"Allocation slots with incomplete trace evidence" },
        mixed: { label:"Mixed",context:"Several categories share the largest allocation share" },
        unavailable: { label:"Not classified",context:"Top-down classification is unavailable for this trace" }
    };
    const boundKeys = ["retiring","inFlight","badSpeculation","frontend","backend","unresolved"];
    const boundRGB = key => session.style.bounds[key].slice(1).match(/../g).map(v=>parseInt(v,16)/255);

    topDown.boundDisplay={trace:null,shares:null,weights:{},color:boundRGB("unavailable")};

    function drawTopDown(lines,dt) {
        // 基板上の重ね描きで割り当ての集計を示す。命令の明るさ、ステージ時刻、
        // 個々のユニットの活動状態には影響させない。
        topDown.sceneTopDown=sonataReplay.sampleTopDown(replay.trace.topDown,session.cycle);
        const triangles=[];topDown.topDownRegion=null;topDown.topDownRail=[];
        const snap=!dt||session.reducedMotion||topDown.boundDisplay.trace!==replay.trace||!topDown.boundDisplay.shares;
        const follow=snap?1:1-Math.exp(-dt/0.11);
        const category=topDown.sceneTopDown.available?topDown.sceneTopDown.dominant:"unavailable";
        const converge=(from,to)=>Math.abs(from-to)<1e-5?to:mix(from,to,follow);
        const shares=Object.fromEntries(boundKeys.map(key=>[key,converge(topDown.boundDisplay.shares?.[key]??0,topDown.sceneTopDown.shares?.[key]??0)]));
        if(topDown.sceneTopDown.available&&!snap){
            const total=Object.values(shares).reduce((sum,v)=>sum+v,0);
            for(const key of boundKeys)shares[key]/=total;
        }
        const weights=Object.fromEntries(Object.keys(boundStyles).map(key=>[key,converge(topDown.boundDisplay.weights[key]??0,key===category?1:0)]));
        const color=[0,1,2].map(i=>Object.keys(weights).reduce((sum,key)=>sum+boundRGB(key)[i]*weights[key],0));
        topDown.boundDisplay={trace:replay.trace,shares,weights,color};
        const quad=(x0,x1,z0,z1,y,color,alpha)=>{
            const p=[[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]];
            for(const i of [0,1,2,0,2,3])scene.vertex(triangles,p[i],color,alpha);
        };
        if(topDown.sceneTopDown.available){
            const {dominant,dominantShare}=topDown.sceneTopDown;
            const targetRegion=boundStyles[dominant].region;
            topDown.topDownRegion=targetRegion?{category:dominant,bounds:[...targetRegion]}:null;
            for(const [key,weight] of Object.entries(weights)){
                const boundStyle=boundStyles[key],color=boundRGB(key);
                if(!boundStyle.region||weight<.001)continue;
                const [x0,x1,z0,z1]=boundStyle.region,y=-.255,cut=.45;
                quad(x0,x1,z0,z1,y,color,(.035+dominantShare*.045)*weight);
                const rim=[[x0+cut,y,z0],[x1-cut,y,z0],[x1,y,z0+cut],[x1,y,z1-cut],
                    [x1-cut,y,z1],[x0+cut,y,z1],[x0,y,z1-cut],[x0,y,z0+cut]];
                for(let i=0;i<rim.length;i++)scene.line(lines,rim[i],rim[(i+1)%rim.length],color,(.4+dominantShare*.45)*weight);
                for(const x of [x0,x1])for(const z of [z0,z1]){
                    const sx=x===x0?1:-1,sz=z===z0?1:-1;
                    scene.line(lines,[x+sx*.08,y+.015,z+sz*.6],[x+sx*.08,y+.015,z+sz*1.15],color,weight);
                    scene.line(lines,[x+sx*.6,y+.015,z+sz*.08],[x+sx*1.15,y+.015,z+sz*.08],color,weight);
                }
            }
            // 基板の手前の縁に、シーン座標で積み上げバーを描く。
            // 各区間の長さは HUD に表示する割合と一致させる。
            let x=-13.6;
            for(const key of boundKeys){
                const share=shares[key],next=x+27.2*share,col=boundRGB(key);
                if(share>0){
                    quad(x,next,7.14,7.31,-.245,col,.6);
                    scene.line(lines,[x,-.24,7.14],[next,-.24,7.14],col,.95);
                    scene.line(lines,[x,-.24,7.31],[next,-.24,7.31],col,.65);
                    topDown.topDownRail.push({category:key,share,start:x,end:next});
                }
                x=next;
            }
        }
        gpu.upload(gpu.analysisSurface,triangles);
    }

    function updateTopDownUI(animateLabels) {
        const classification=topDown.sceneTopDown;
        const category=classification.available?classification.dominant:"unavailable",boundStyle=boundStyles[category];
        const boundLabel=boundStyle.label,boundColor=rgb(topDown.boundDisplay.color),shares=topDown.boundDisplay.shares;
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
        sceneBound.title=classification.available?`${replay.trace.topDown.method} · cycles ${classification.firstCycle}–${classification.lastCycle} · ${classification.totalSlots} allocation slots`:"Stage evidence did not establish a Top-down classification.";
        sceneBound.style.setProperty("--bound-color",boundColor);
        text("bound-scene-value",classification.available?(dominantShare*100).toFixed(1):"");
        $("bound-scene-share").hidden=!classification.available;
        $("bound-scene-window").textContent=classification.available?`PAST ${Number(classification.cycles.toFixed(1))} CYC → NOW · ESTIMATE`:"UNAVAILABLE";
        $("bound-scene-context").textContent=boundStyle.context;
        $("bound-scene-bar").hidden=$("bound-scene-key").hidden=!classification.available;
        for(const el of $("bound-scene-bar").children)el.style.width=`${shares[el.dataset.bound]*100}%`;
        for(const el of $("bound-scene-key").children){
            el.querySelector("b").textContent=`${Math.round(shares[el.dataset.bound]*100)}%`;
            if(el.dataset.bound==="unresolved")el.hidden=shares.unresolved<.0001;
            if(el.dataset.bound==="inFlight")el.hidden=shares.inFlight<.0001;
        }
    }
    return Object.assign(activity,{drawDynamic,reset,registerReaders,registerCellColor,registerCellAppearance,stream,topDown,feedPath,updateTopDownUI});
}
module.exports={createActivity,wakeFlightCycles};

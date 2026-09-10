"use strict";
const assert = require("node:assert/strict");

module.exports = async function reviewStageTransfers(window) {
    const result = await window.webContents.executeJavaScript(`(()=>{
        const saved={style:sonata.visualStyle,cycle:sonata.cycle},trace=sonata.trace,cases=new Map();
        const choose=key=>document.getElementById('style-'+key).click();
        for(const op of sonata.ops){
            for(let i=1;i<op.stages.length;i++){
                const from=op.stages[i-1],to=op.stages[i],duration=to.node.startsWith('exec')?Math.min(.35,(to.end-to.start)*.22):Math.min(.82,Math.max(.08,to.end-to.start));
                const key=from.node+' → '+to.node;
                if(from.node!==to.node&&to.start>=trace.firstCycle&&to.start+duration<Math.min(op.end,trace.lastCycle)&&duration>.05&&!cases.has(key))
                    cases.set(key,{id:op.id,start:to.start,end:to.start+duration});
            }
            if(!op.flush&&op.end>=trace.firstCycle&&op.end+1.99<trace.lastCycle){
                if(!cases.has('ROB → COMMIT'))cases.set('ROB → COMMIT',{id:op.id,start:op.end,end:op.end+.45});
                if(!cases.has('COMMIT → output'))cases.set('COMMIT → output',{id:op.id,start:op.end+.95,end:op.end+1.99});
            }
        }
        try{
            choose('blocks');const transfers=[];
            for(const [key,{id,start,end}] of cases){
                const frames=[];
                for(let i=0;i<=8;i++){
                    const cycle=start+(end-start)*i/8;sonata.captureAt(cycle);
                    const p=sonata.pieces.find(p=>p.id===id);if(!p)throw Error(key+': instruction disappeared at '+cycle);
                    frames.push({cycle,height:p.position[1],radius:p.radius,contact:!!p.contact,position:p.position,path:p.pathPosition});
                }
                // 回転した形の上下幅ぶんだけ許容し、両端より土台まで落ちる回帰を検出する。
                const lower=Math.min(frames[0].height,frames.at(-1).height)-frames[0].radius*2-.02;
                const minimum=Math.min(...frames.map(f=>f.height));
                const biggestStep=Math.max(...frames.slice(1).map((f,i)=>Math.abs(f.height-frames[i].height)));
                sonata.captureAt(start);const returned=JSON.stringify(sonata.pieces.find(p=>p.id===id).position)===JSON.stringify(frames[0].position);
                transfers.push({key,id,start,end,minimum,lower,biggestStep,returned,airborne:frames.filter(f=>!f.contact).length,frames,
                    sameHorizontalPath:frames.every(f=>f.position[0]===f.path[0]&&f.position[2]===f.path[2])});
            }
            return {trace:trace.key,transfers,error:sonata.renderer.error};
        }finally{choose(saved.style);sonata.captureAt(saved.cycle);}
    })()`);
    assert.ok(result.transfers.length >= 5, `${result.trace}: too few stage transitions exercised`);
    assert.ok(
        result.transfers.some((t) => t.airborne > 0),
        `${result.trace}: transitions still follow the board`
    );
    for (const transfer of result.transfers) {
        assert.ok(
            transfer.minimum >= transfer.lower,
            `${result.trace}: ${transfer.key} fell below the stage heights (${transfer.minimum} < ${transfer.lower})`
        );
        assert.ok(
            transfer.biggestStep < 0.4,
            `${result.trace}: ${transfer.key} jumps vertically between samples: ${JSON.stringify(transfer)}`
        );
        assert.ok(
            transfer.returned && transfer.sameHorizontalPath,
            `${result.trace}: ${transfer.key} changed with seek order or left its horizontal path`
        );
    }
    assert.equal(result.error, 0);
    return result;
};

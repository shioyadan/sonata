"use strict";
const assert = require("node:assert/strict");

module.exports = async function reviewStageLayout(window) {
    const result = await window.webContents.executeJavaScript(`(()=>{
        const original=sonata.cycle,trace=sonata.trace,grid=sonata.schedulerGrid,layout=sonata.instructionLayout;
        const entries=trace.ops.flatMap(op=>op[6].filter(s=>s[0]==='Rn').map(s=>({id:op[0],start:s[2],end:Math.min(s[3],op[4]?(op[11]??op[3]):op[3])}))).filter(e=>e.start<e.end);
        // 入場の補間が終わった時点から、実トレースで最も多くの命令が滞在する場面を選ぶ。
        const candidates=entries.map(e=>Math.max(trace.firstCycle,e.start+.9)).filter(cycle=>cycle<=trace.lastCycle)
            .map(cycle=>({cycle,entries:entries.filter(e=>e.start<=cycle&&cycle<e.end)}));
        const peak=candidates.sort((a,b)=>b.entries.length-a.entries.length||a.cycle-b.cycle)[0];
        const gl=document.getElementById('scene').getContext('webgl2'),draw=gl.drawArrays,seen=new Set(),segments=[];
        gl.drawArrays=function(mode,first,count){
            if(mode===gl.LINES){
                const buffer=gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
                if(!seen.has(buffer)){
                    seen.add(buffer);const binding=gl.getParameter(gl.ARRAY_BUFFER_BINDING),data=new Float32Array(count*7);
                    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.getBufferSubData(gl.ARRAY_BUFFER,first*7*4,data);gl.bindBuffer(gl.ARRAY_BUFFER,binding);
                    for(let i=0;i<data.length;i+=14)segments.push([Array.from(data.slice(i,i+3)),Array.from(data.slice(i+7,i+10))]);
                }
            }
            return draw.call(this,mode,first,count);
        };
        try{
            sonata.captureAt(peak.cycle);gl.drawArrays=draw;
            const pieces=sonata.particles.filter(p=>peak.entries.some(e=>e.id===p.id));
            let minimum=Infinity;
            for(let i=0;i<pieces.length;i++)for(let j=i+1;j<pieces.length;j++)
                minimum=Math.min(minimum,Math.hypot(pieces[i].position[0]-pieces[j].position[0],pieces[i].position[2]-pieces[j].position[2]));
            const matches=expected=>segments.filter(actual=>expected.every((p,i)=>p.every((v,k)=>Math.abs(v-actual[i][k])<1e-5))).length;
            const poses=pieces=>JSON.stringify(pieces.map(({id,position,pathPosition})=>({id,position,pathPosition})));
            const before=poses(pieces);sonata.captureAt(peak.cycle+1);sonata.captureAt(peak.cycle);
            const returned=before===poses(sonata.particles.filter(p=>peak.entries.some(e=>e.id===p.id)));
            // 全滞在区間を照合し、別時点の混雑でも同じ配置先を同時に使っていないことを確認する。
            const positions=entries.map(e=>({ ...e,position:layout.rename[sonata.ops.find(op=>op.id===e.id).stages.find(s=>s.names.includes('Rn')&&s.start<=e.start&&s.end>=e.end).displaySlot]}));
            let overlaps=0;
            for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++){
                const a=positions[i],b=positions[j];
                if(Math.max(a.start,b.start)<Math.min(a.end,b.end)&&Math.hypot(a.position[0]-b.position[0],a.position[2]-b.position[2])<=layout.radius*2)overlaps++;
            }
            return {key:trace.key,rows:grid.rows.length,columns:grid.columns.length,capacity:trace.structure.queueCapacity,
                rowAligned:grid.rows.every((line,row)=>line[0][0]===layout.scheduler[row][0]&&line[0][2]===layout.scheduler[row][2]),
                gpuMatches:[...grid.rows,...grid.columns].map(matches),rename:{cycle:peak.cycle,expected:peak.entries.length,rendered:pieces.length,slots:layout.rename.length,minimum,overlaps,returned},error:gl.getError()};
        }finally{gl.drawArrays=draw;sonata.captureAt(original);}
    })()`);
    assert.equal(result.rows, result.capacity, `${result.key}: scheduler row lines do not match capacity`);
    assert.equal(result.columns, result.capacity, `${result.key}: scheduler column lines do not match capacity`);
    assert.ok(result.rowAligned, `${result.key}: scheduler lines miss waiting entries`);
    assert.ok(
        result.gpuMatches.every((count) => count === 1),
        `${result.key}: scheduler entry lines are missing or duplicated in GPU geometry`
    );
    assert.ok(
        result.rename.expected > 0 && result.rename.rendered === result.rename.expected,
        `${result.key} @ ${result.rename.cycle}: Rn expected ${result.rename.expected}, rendered ${result.rename.rendered}`
    );
    assert.ok(result.rename.minimum > 0.24, `${result.key}: resident Rn instructions overlap`);
    assert.equal(result.rename.overlaps, 0, `${result.key}: Rn slots overlap in another residence interval`);
    assert.ok(result.rename.returned, `${result.key}: seeking changed Rn positions`);
    assert.equal(result.error, 0);
    return result;
};

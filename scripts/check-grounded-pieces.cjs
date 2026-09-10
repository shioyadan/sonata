"use strict";
const assert = require("node:assert/strict");

module.exports = async function reviewGroundedPieces(window) {
    const result = await window.webContents.executeJavaScript(`(()=>{
        const gl=document.getElementById('scene').getContext('webgl2'),draw=gl.drawArraysInstanced;
        const original=sonata.cycle,batches=[];
        // 診断値だけでなく、実際の描画と影へ渡したインスタンスの中心座標を読む。
        gl.drawArraysInstanced=function(mode,first,vertices,count){
            if(vertices===6&&count>0&&gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_DIVISOR)===1){
                const binding=gl.getParameter(gl.ARRAY_BUFFER_BINDING),buffer=gl.getVertexAttrib(0,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
                const data=new Float32Array(count*12);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.getBufferSubData(gl.ARRAY_BUFFER,0,data);gl.bindBuffer(gl.ARRAY_BUFFER,binding);
                batches.push(data);
            }
            return draw.call(this,mode,first,vertices,count);
        };
        try{
            sonata.captureAt(459.4);
            const pieces=sonata.pieces;
            let maximumGap=0,gpuError=0,moved=0,grounded=0,transferring=0;
            for(let i=0;i<pieces.length;i++){
                const p=pieces[i],q=p.rotation;
                if(p.contact){
                    const lower=sonataPieceGrounding.lowerAt((p.contact[0]-p.position[0])/p.radius,(p.contact[2]-p.position[2])/p.radius,[-q[0],-q[1],-q[2],q[3]]);
                    if(lower===null)throw Error('Contact lies outside instruction '+p.id);
                    maximumGap=Math.max(maximumGap,Math.abs(p.position[1]+lower*p.radius-p.contact[1]));grounded++;
                }else{
                    if(!p.transfer)throw Error('Resident instruction lost contact '+p.id);
                    transferring++;
                }
                if(Math.abs(p.position[1]-p.pathPosition[1])>.01)moved++;
                for(const batch of batches)for(let k=0;k<4;k++)gpuError=Math.max(gpuError,Math.abs(batch[i*12+k]-(k===3?p.radius:p.position[k])));
            }
            const first=JSON.stringify(pieces);sonata.captureAt(460.4);sonata.captureAt(459.4);
            return {pieces:pieces.length,moved,grounded,transferring,maximumGap,gpuError,batches:batches.length,returned:first===JSON.stringify(sonata.pieces),error:gl.getError()};
        }finally{gl.drawArraysInstanced=draw;sonata.captureAt(original);}
    })()`);
    assert.ok(result.pieces > 0 && result.moved > 20, `Cut crystal: instructions still use hovering heights`);
    assert.ok(
        result.grounded > 20 && result.transferring > 0,
        `Cut crystal: stage contact and airborne transfer were not both exercised`
    );
    assert.ok(result.maximumGap < 1e-6, `Cut crystal: instruction does not touch its support`);
    assert.ok(
        result.batches > 0 && result.gpuError < 2e-6,
        `Cut crystal: rendered positions differ from grounded positions`
    );
    assert.ok(result.returned, `Cut crystal: seeking changed grounded positions`);
    assert.equal(result.error, 0);
    return result;
};

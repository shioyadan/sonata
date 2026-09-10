"use strict";
const assert=require("node:assert/strict");

// 実トレースの同じフレームで影だけを切り替え、駒以外の面の暗さを画素から確認する。
module.exports=async function reviewPieceShadows(window){
    const result=await window.webContents.executeJavaScript(`(()=>{
        const gl=document.getElementById('scene').getContext('webgl2'),surface=sonataStyles.blocks.surface;
        const original={cycle:sonata.cycle,strength:surface.pieceShadow};
        const read=cycle=>{sonata.captureAt(cycle);const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
            gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
        const difference=(a,b)=>{let changed=0;for(let i=0;i<a.length;i+=4)if(Math.max(...[0,1,2].map(k=>Math.abs(a[i+k]-b[i+k])))>3)changed++;return changed;};
        const shadow=cycle=>{
            surface.pieceShadow=0;const plain=read(cycle);surface.pieceShadow=original.strength;const shaded=read(cycle);
            const mask=new Uint8Array(plain.length/4);let darkened=0,brightened=0;
            for(let i=0;i<plain.length;i+=4){const drop=(plain[i]+plain[i+1]+plain[i+2]-shaded[i]-shaded[i+1]-shaded[i+2])/3;
                if(drop>3){mask[i/4]=1;darkened++;}if(drop<-3)brightened++;}
            return {mask,shaded,darkened,brightened};
        };
        try{
            const first=shadow(459.4),updates=sonata.renderer.pieceShadows.updates;
            const repeated=read(459.4),cacheReused=updates===sonata.renderer.pieceShadows.updates;
            const moved=shadow(460.4);let movedMask=0;for(let i=0;i<first.mask.length;i++)if(first.mask[i]!==moved.mask[i])movedMask++;
            const returned=read(459.4),state=sonata.renderer.pieceShadows;
            return {darkened:first.darkened,brightened:first.brightened,repeatedDifference:difference(first.shaded,repeated),
                returnedDifference:difference(first.shaded,returned),movedMask,cacheReused,state,error:gl.getError()};
        }finally{surface.pieceShadow=original.strength;sonata.captureAt(original.cycle);}
    })()`);
    assert.ok(result.darkened>20,"Moving instructions did not cast visible shadows on the scene");
    assert.equal(result.brightened,0,"Instruction shadows unexpectedly brightened opaque surfaces");
    assert.equal(result.repeatedDifference,0,"Paused instruction shadows changed with the decorative clock");
    assert.equal(result.returnedDifference,0,"Seeking back did not restore the same shadows");
    assert.ok(result.movedMask>20,"Advancing the trace did not move the cast shadows");
    assert.ok(result.cacheReused,"Paused shadows were unnecessarily regenerated");
    assert.ok(result.state.size>0&&result.state.instances>0,"Crystal instructions lost their shadows");
    assert.equal(result.error,0,"Instruction shadows caused a WebGL error");
    return result;
};

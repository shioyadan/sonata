/* 表示用の経路から命令の駒の姿勢を求める。再生モデルやフレーム時計は変更しない。 */
(function(root){
    "use strict";
    const identity=[0,0,0,1];
    function advance(rotation,from,to,distancePerRadian){
        if(!from||!to)return [...rotation];
        const dx=to[0]-from[0],dz=to[2]-from[2],distance=Math.hypot(dx,dz);
        if(distance<1e-10)return [...rotation];
        // 上向き法線と進行方向の外積。接地点が進行方向と逆へ回る向きにする。
        const half=distance/distancePerRadian/2,s=Math.sin(half)/distance;
        const x=dz*s,z=-dx*s,w=Math.cos(half),[a,b,c,d]=rotation;
        const q=[w*a+x*d-z*b,w*b+z*a-x*c,w*c+z*d+x*b,w*d-x*a-z*c];
        const length=Math.hypot(...q);
        return q.map(v=>v/length);
    }
    function createRollingTrack(positionAt,breakpoints,{distancePerRadian=.85}={}){
        // ステージの境界・曲がり角を区切りに採取し、待機時間が長くても標本を増やさない。
        const times=[...new Set(breakpoints)].sort((a,b)=>a-b),samples=[];
        let previous=null,rotation=[...identity];
        const sample=time=>{
            const position=positionAt(time);
            rotation=advance(rotation,previous,position,distancePerRadian);
            if(!samples.length||!position||!previous||position.some((v,i)=>Math.abs(v-previous[i])>1e-10)){
                samples.push({time,position,rotation});
            }
            previous=position;
        };
        if(times.length)sample(times[0]);
        for(let i=1;i<times.length;i++)for(let step=1;step<=16;step++)sample(times[i-1]+(times[i]-times[i-1])*step/16);
        const previousAt=time=>{
            let lo=0,hi=samples.length;
            while(lo<hi){const mid=(lo+hi)>>1;if(samples[mid].time<=time)lo=mid+1;else hi=mid;}
            return samples[lo-1];
        };
        return {
            rotationAt(time,position=positionAt(time)){
                // 直前までの姿勢に現在位置までの回転を加える。呼出順や fps に依存しない。
                const before=previousAt(time);
                return before?advance(before.rotation,before.position,position,distancePerRadian):[...identity];
            }
        };
    }
    const api={createRollingTrack};
    if(typeof module!=="undefined"&&module.exports)module.exports=api;
    root.sonataPieceMotion=api;
})(globalThis);

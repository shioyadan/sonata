/* 描画する表面と駒の形から接地高さを求める。時刻・水平経路・再生モデルは変更しない。 */
(function(root){
    "use strict";
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const sub=(a,b)=>a.map((v,i)=>v-b[i]);
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const rotate=(v,q)=>{
        const t=cross(q,v).map(x=>x*2),u=cross(q,t);
        return v.map((x,i)=>x+q[3]*t[i]+u[i]);
    };
    // シェーダーと同じ凸多面体の面。支持点は面同士の交点から求める。
    function polyhedron(){
        const planes=[],vertices=[];
        for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
            const axes=Math.abs(x)+Math.abs(y)+Math.abs(z);
            if(!axes||axes===2)continue;
            planes.push({n:[x,y,z],d:axes===1?.88:1.20});
        }
        for(let i=0;i<planes.length;i++)for(let j=i+1;j<planes.length;j++)for(let k=j+1;k<planes.length;k++){
            const [a,b,c]=[planes[i],planes[j],planes[k]],bc=cross(b.n,c.n),det=dot(a.n,bc);
            if(Math.abs(det)<1e-8)continue;
            const ca=cross(c.n,a.n),ab=cross(a.n,b.n),p=bc.map((v,l)=>(v*a.d+ca[l]*b.d+ab[l]*c.d)/det);
            if(planes.every(f=>dot(f.n,p)<=f.d+1e-8)&&!vertices.some(v=>Math.hypot(...sub(v,p))<1e-8))vertices.push(p);
        }
        return {planes,vertices};
    }
    const crystal=polyhedron();
    function support(direction,boundingSphere=false){
        if(boundingSphere){const length=Math.hypot(...direction);return direction.map(v=>v/length);}
        return crystal.vertices.reduce((best,p)=>dot(p,direction)>dot(best,direction)?p:best);
    }
    // 世界の垂直線に沿う Cut crystal の下端。外接球は移動経路の障害物判定専用。
    function lowerAt(x,z,inverse,boundingSphere=false){
        if(boundingSphere){const d=1-x*x-z*z;return d>=0?-Math.sqrt(d):null;}
        const start=rotate([x,-2,z],inverse),direction=rotate([0,1,0],inverse);
        let lo=-Infinity,hi=Infinity;
        for(const {n,d} of crystal.planes){
            const slope=dot(n,direction),gap=d-dot(n,start);
            if(Math.abs(slope)<1e-10){if(gap<0)return null;continue;}
            if(slope<0)lo=Math.max(lo,gap/slope);else hi=Math.min(hi,gap/slope);
        }
        return lo<=hi?-2+lo:null;
    }
    function createGround(triangles,floor=-.87){
        const cells=new Map(),cellSize=.5;
        const cell=v=>Math.floor(v/cellSize),key=(x,z)=>`${x}/${z}`;
        for(const vertices of triangles){
            let n=cross(sub(vertices[1],vertices[0]),sub(vertices[2],vertices[0]));
            if(Math.abs(n[1])<1e-10)continue;
            if(n[1]<0)n=n.map(v=>-v);
            const xs=vertices.map(p=>p[0]),zs=vertices.map(p=>p[2]);
            const bounds=[Math.min(...xs),Math.max(...xs),Math.min(...zs),Math.max(...zs)];
            const triangle={vertices,n,d:dot(n,vertices[0]),bounds};
            for(let x=cell(bounds[0]);x<=cell(bounds[1]);x++)for(let z=cell(bounds[2]);z<=cell(bounds[3]);z++){
                const id=key(x,z);if(!cells.has(id))cells.set(id,[]);cells.get(id).push(triangle);
            }
        }
        const inside=(x,z,{vertices:[a,b,c]})=>{
            const signs=[[a,b],[b,c],[c,a]].map(([p,q])=>(q[0]-p[0])*(z-p[2])-(q[2]-p[2])*(x-p[0]));
            return signs.every(v=>v>=-1e-9)||signs.every(v=>v<=1e-9);
        };
        return {
            seat(position,radius,q,boundingSphere=false){
                const inverse=[-q[0],-q[1],-q[2],q[3]],x=position[0],z=position[2];
                const lowest=rotate(support(rotate([0,-1,0],inverse),boundingSphere),q);
                let y=floor-lowest[1]*radius,contact=[x+lowest[0]*radius,floor,z+lowest[2]*radius];
                const nearby=new Set();
                for(let a=cell(x-radius);a<=cell(x+radius);a++)for(let b=cell(z-radius);b<=cell(z+radius);b++)for(const t of cells.get(key(a,b))??[])nearby.add(t);
                for(const triangle of nearby){
                    const {vertices,n,d,bounds}=triangle;
                    if(x+radius<bounds[0]||x-radius>bounds[1]||z+radius<bounds[2]||z-radius>bounds[3])continue;
                    const low=(n[0]===0&&n[2]===0?lowest:rotate(support(rotate(n.map(v=>-v),inverse),boundingSphere),q)).map(v=>v*radius);
                    const limit=(d-n[0]*x-n[2]*z-dot(n,low))/n[1];
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
                        const at=t=>{
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
    const api={createGround,support,lowerAt,rotate};
    if(typeof module!=="undefined"&&module.exports)module.exports=api;
    root.sonataPieceGrounding=api;
})(globalThis);

"use strict";
const assert=require("node:assert/strict");
const {createGround}=require("../src/geometry.js");
const identity=[0,0,0,1],near=(a,b,message,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<tolerance,`${message}: ${a} / ${b}`);
const plane=(height,x0=-3,x1=3)=>[[[x0,height,-3],[x1,height,-3],[x1,height,3]],[[x0,height,-3],[x1,height,3],[x0,height,3]]];
const ground=createGround(plane(.4),-.8);
// Cut crystal の軸に垂直な面と斜めの面を、シェーダーと同じ寸法で接地させる。
const a=ground.seat([.3,7,.2],.2,identity),b=ground.seat([.3,-7,.2],.2,identity);
near(a.position[1],.4+.88*.2,"Crystal is not seated");assert.deepEqual(a,b,"Contact depends on original hovering height");
near(a.position[0],.3,"Grounding changed horizontal travel");near(a.position[2],.2,"Grounding changed lane");
const quarter=[0,0,Math.SQRT1_2,Math.SQRT1_2],eighth=[0,0,Math.sin(Math.PI/8),Math.cos(Math.PI/8)];
near(ground.seat([0,0,0],.2,quarter).position[1],.4+.88*.2,"Quarter-turn changed crystal height");
near(ground.seat([0,0,0],.2,eighth).position[1],.4+.2*1.20/Math.SQRT2,"Rotating crystal clips its facets");
// 傾斜面は鉛直方向の半径を足すだけでは貫通する。面の法線に沿って接する必要がある。
const slope=createGround([[[-3,-1.5,-3],[3,1.5,-3],[3,1.5,3]],[[-3,-1.5,-3],[3,1.5,3],[-3,-1.5,3]]],-5);
near(slope.seat([0,10,0],.2,identity).position[1],.2*(.88+.5*.32),"Crystal penetrates sloped trough");
near(slope.seat([0,10,0],.2,identity,true).position[1],.2*Math.sqrt(1.25),"Sphere penetrates sloped trough");
// 台の外へ出ると縁を支点に下がり、離れた後は下の面へ接する。
const edge=createGround(plane(.4,-3,0),0);
near(edge.seat([.12,8,0],.2,identity,true).position[1],.4+Math.sqrt(.2**2-.12**2),"Sphere floats at a ledge",2e-6);
near(edge.seat([.21,8,0],.2,identity,true).position[1],.2,"Sphere did not reach the lower surface");
near(edge.seat([.12,8,0],.2,identity).position[1],.4+.2*(1.20-.12/.2),"Crystal floats at a ledge",2e-6);
near(edge.seat([.18,8,0],.2,identity).position[1],.88*.2,"Crystal did not reach the lower surface");
// 三角形の順序、以前のシーク、半径・姿勢の変更は同じ条件での接地点を変えない。
const before=edge.seat([-.1,3,.17],.136,eighth);
edge.seat([2,3,1],.06,quarter);
assert.deepEqual(edge.seat([-.1,3,.17],.136,eighth),before);
near(createGround(plane(.4,-3,0).reverse(),0).seat([-.1,3,.17],.136,eighth).position[1],before.position[1],"Triangle order changed the height");
console.log("Piece grounding: cut crystal and clearance sphere; rotation; sloped surfaces; ledges; deterministic contact");

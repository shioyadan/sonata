import type {Op} from "../vendor/konata-core/model";

// 解析器は割り当てを事後的に分類する。その解析結果は保持したまま、
// 再生時に結果が判明する時刻を追加する。
export function topDownObservationTimes(analysis:any,ops:Readonly<Op>[],first:number,last:number,slots:number[][],endCycle:(op:Readonly<Op>)=>number){
    const outcomes:number[][]=[],allocated=new Map<number,number>(),backend=new Set<number>();
    const previous=new Map<number,{start:number}>(),pending=new Map<number,{start:number;notice:number}>(),recoveries:Array<{start:number;end:number;notice:number}>=[];
    const control=(label:string)=>{
        const disassembly=label.slice(label.indexOf(":")+1).trim(),mnemonic=(disassembly.split(/\s+/,1)[0]??"").toLowerCase();
        if(/\bwrip\b/i.test(disassembly))return /^(?:j|call|ret)/.test(mnemonic);
        return /^(?:j|jr|jal|jalr|call|ret|b|bl|blr|br|bx|bal|beq|bne|beqz|bnez|blt|bge|bltu|bgeu|bgez|bltz|blez|bgtz|cbz|cbnz|tbz|tbnz)(?:\..*)?$/.test(mnemonic.replace(/^c[._]/,""));
    };
    for(const op of ops){
        const o=analysis.structure.observe(op),cycle=o.allocationCycle===null?null:Math.floor(o.allocationCycle);
        if(cycle!==null&&cycle>=first&&cycle<=last&&(allocated.get(cycle)??0)<analysis.allocationWidth){
            allocated.set(cycle,(allocated.get(cycle)??0)+1);
            if(op.retired||op.flush)outcomes.push([cycle,op.retired?op.retiredCycle:endCycle(op),op.retired?0:1]);
        }
        if(o.admissionStallStartCycle!==null&&o.admissionStallEndCycle!==null){
            for(let c=Math.max(first,Math.floor(o.admissionStallStartCycle));c<Math.min(last+1,Math.ceil(o.admissionStallEndCycle));c++)backend.add(c);
        }
        const predecessor=previous.get(op.tid);
        if(op.flush&&predecessor)pending.set(op.tid,{start:predecessor.start,notice:endCycle(op)});
        if(!op.flush&&pending.has(op.tid)){
            const recovery=pending.get(op.tid)!;pending.delete(op.tid);
            if(op.retired&&o.allocationCycle!==null&&o.allocationCycle>=recovery.start&&analysis.minimumRecoveryCycles!==null){
                recoveries.push({...recovery,end:Math.min(o.allocationCycle,recovery.start+analysis.minimumRecoveryCycles)});
            }
        }
        previous.delete(op.tid);
        if(!op.flush&&op.retired&&o.allocationCycle!==null&&o.completionCycle!==null&&o.completionCycle>o.allocationCycle&&control(op.labelName))previous.set(op.tid,{start:o.completionCycle});
    }
    // 解析器のスロット割り当てと同じ命令の走査順・幅の上限を使う。
    for(let i=0;i<slots.length;i++)for(const category of [0,1]){
        if(outcomes.filter(e=>e[0]===first+i&&e[2]===category).length!==slots[i][category])throw new Error(`Top-down outcome evidence disagrees at ${first+i}, class ${category}`);
    }
    const recoveryNotices=slots.map((row,i)=>{
        if(!row[2])return null;
        const cycle=first+i,matching=recoveries.filter(r=>cycle>=Math.floor(r.start)&&cycle<Math.ceil(r.end));
        if(!matching.length)throw new Error(`Top-down recovery has no observation time at ${cycle}`);
        return [Math.min(...matching.map(r=>r.notice)),backend.has(cycle)?4:3];
    });
    return {outcomes,recoveryNotices};
}

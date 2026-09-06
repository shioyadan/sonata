import fs from "node:fs";

export interface RsdEvent {
    cycle: number;
    sourceCycle: number;
    id: number;
    kind: "branch-mispredict" | "dcache-miss" | "icache-miss";
    message: string;
    line: number;
}

/** OnikiriParser と同じサイクル起点で、明示されたイベント注釈を読み取る。 */
export function readRsdEvents(fileName: string, firstCycle: number, lastCycle: number): RsdEvent[] {
    let cycle=0,sourceCycle=0;
    const events:RsdEvent[]=[];
    for(const [index,line] of fs.readFileSync(fileName,"utf8").split("\n").entries()){
        const fields=line.split("\t");
        if(fields[0]==="C="){sourceCycle=Number(fields[1]);continue;}
        if(fields[0]==="C"){cycle+=Number(fields[1]);sourceCycle+=Number(fields[1]);continue;}
        if(cycle>lastCycle)break;
        // L/1 と L/2 に同じ注釈があるため、命令詳細の側だけを残す。
        if(cycle<firstCycle||fields[0]!=="L"||fields[2]!=="1")continue;
        const message=(fields[3]??"").replace(/\\n/g," ").trim();
        const kind=/Br-pred-miss/i.test(message)?"branch-mispredict":/D\$[ -]miss/i.test(message)?"dcache-miss":/i-cache-miss/i.test(message)?"icache-miss":null;
        if(kind)events.push({cycle,sourceCycle,id:Number(fields[1]),kind,message,line:index+1});
    }
    return events;
}

export type AllocationEvent={cycle:number;physical:number;state:"allocated"|"free";reason:string;line?:number;id?:number};

// Preserve unknown cells. Seeing no current RAT reference does not imply free:
// an older version remains allocated until commit or squash reclamation.
export function allocationEvidence(events:AllocationEvent[],firstCycle:number,lastCycle:number,kind:"recorded"|"inferred",label:string){
    const initial=new Map<number,string>();
    for(const event of events){if(event.cycle>=firstCycle)break;initial.set(event.physical,event.state);}
    return {kind,label,initial:[...initial],events:events.filter(e=>e.cycle>=firstCycle&&e.cycle<=lastCycle)};
}

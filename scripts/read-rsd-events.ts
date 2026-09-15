import evidence = require("../src/trace-evidence.cts");
import { evidenceLines } from "./evidence-input";
export type RsdEvent = evidence.Event;

/** OnikiriParser と同じサイクル起点で、明示されたイベント注釈を読み取る。 */
export function readRsdEvents(fileName: string, firstCycle: number, lastCycle: number): RsdEvent[] {
    const index = evidence.createEvidenceIndex();
    for (const line of evidenceLines(fileName)) index.observeLine(line);
    return index.windowEvidence(firstCycle, lastCycle).events;
}

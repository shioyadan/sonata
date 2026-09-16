"use strict";
// 共通の座標・接続と、固定部品の外観を組み立てる。
import geometry = require("./geometry.cts");
import type renderer = require("./renderer.cts");
const { TAU, clamp, mix, smooth, hash, rgb, route, crossesBox, createGround } = geometry;
import sonataReplay = require("./replay-model.cts");
const $ = (id: string) => document.getElementById(id)!;
type Vector = geometry.Vector;
type Color = readonly number[];
type BoundKey = sonataReplay.Bound | "retiring" | "inFlight";
interface StyleBase {
    label: string;
    palette: Record<"integer" | "memory" | "branch" | "fp" | "red" | "blue" | "floor", Vector>;
    background: Vector;
    bounds: Record<BoundKey, string>;
    timeline: string[];
}
type SceneStyle = StyleBase &
    (
        | { matte: false }
        | {
              matte: true;
              structure: Record<"body" | "base" | "rail" | "recess" | "wire" | "ink", Vector>;
              surface: {
                  floor: Vector;
                  roughness: number;
                  grain: number;
                  light: Vector;
                  pieceShadow: number;
                  paper?: true;
                  aluminum?: true;
              };
          }
    );
interface SceneNode {
    id: string;
    label: string;
    x: number;
    z: number;
    w: number;
    d: number;
    h: number;
    color: Vector;
    detail: string;
    names?: string[];
    pipeCount?: number;
    compact?: boolean;
    latency?: number;
    matrixDepth?: number;
    matrixBanks?: number;
    mapWords?: number;
    instructionSlots?: number;
    instructionRows?: number;
    grid?: { rows: [Vector, Vector][]; columns: [Vector, Vector][] };
    element?: HTMLDivElement;
}
interface Connection {
    from: string;
    to: string;
    color: Color;
    peak: number;
    lanes: { source: Vector; target: Vector }[];
}
interface TriangleData {
    triangles: number[];
    materials: number[];
    shadows: number[];
}
type VertexData = (number[] & { triangles?: never; materials?: never }) | TriangleData;
type Issue = { id: number; slot: number | undefined; column: number | null | undefined };
interface SceneOptions {
    gpu?: renderer.Gpu;
    replay: sonataReplay.Replay;
    session: { style: SceneStyle };
}

/* 外観だけのプリセット。命令の配置、再生時刻、記録値は再生モデルと共通にする。 */
const solidColors: Pick<StyleBase, "palette" | "background" | "bounds" | "timeline"> = {
    palette: {
        integer: [0.16, 0.72, 0.48],
        fp: [0.22, 0.61, 0.86],
        memory: [0.95, 0.64, 0.28],
        branch: [0.69, 0.51, 0.93],
        red: [0.94, 0.28, 0.34],
        blue: [0.36, 0.65, 0.89],
        floor: [0.84, 0.72, 0.52]
    },
    background: [0.955, 0.936, 0.896],
    bounds: {
        active: "#287b60",
        retiring: "#287b60",
        inFlight: "#48877c",
        badSpeculation: "#bf3948",
        frontend: "#386d9c",
        backend: "#a3601c",
        unresolved: "#65716e",
        mixed: "#66645e",
        unavailable: "#716c63"
    },
    timeline: ["#c8d2ce", "#43836b", "#9aaca4"]
};

const styles: Record<"neon" | "aluminum" | "paper", SceneStyle> = {
    neon: {
        label: "Neon",
        matte: false,
        palette: {
            integer: [0.29, 1, 0.81],
            fp: [0.3, 0.7, 1],
            memory: [1, 0.6, 0.22],
            branch: [0.62, 0.43, 1],
            red: [1, 0.19, 0.36],
            blue: [0.3, 0.64, 1],
            floor: [0.08, 0.19, 0.24]
        },
        background: [0.012, 0.022, 0.035],
        bounds: {
            active: "#71f5db",
            retiring: "#71f5db",
            inFlight: "#53b7af",
            badSpeculation: "#ff6277",
            frontend: "#80b7ff",
            backend: "#ffbb65",
            unresolved: "#8aa9b9",
            mixed: "#b0bfc8",
            unavailable: "#76838f"
        },
        timeline: ["#1d3946", "#59bba9", "#31525e"]
    },
    aluminum: {
        ...solidColors,
        label: "Aluminum",
        matte: true,
        background: [0.925, 0.943, 0.952],
        structure: {
            body: [0.82, 0.85, 0.88],
            base: [0.55, 0.59, 0.63],
            rail: [0.76, 0.8, 0.84],
            recess: [0.39, 0.43, 0.47],
            wire: [0.42, 0.47, 0.51],
            ink: [0.28, 0.33, 0.37]
        },
        surface: {
            floor: [0.73, 0.77, 0.81],
            roughness: 0.34,
            grain: 0.1,
            light: [-0.55, 0.85, -0.4],
            pieceShadow: 0.44,
            aluminum: true
        }
    },
    paper: {
        ...solidColors,
        label: "Paper model",
        matte: true,
        structure: {
            body: [0.94, 0.93, 0.89],
            base: [0.86, 0.84, 0.79],
            rail: [0.89, 0.89, 0.85],
            recess: [0.76, 0.77, 0.73],
            wire: [0.52, 0.53, 0.5],
            ink: [0.38, 0.39, 0.36]
        },
        surface: {
            floor: [0.9, 0.88, 0.84],
            roughness: 0.95,
            grain: 0,
            light: [-0.55, 0.85, -0.4],
            pieceShadow: 0.44,
            paper: true
        }
    }
};
globalThis.sonataStyles = styles;

// loadTrace → buildLayout → 描画の順で使う。特化ノードの属性は buildLayout が設定する。
function createScene({ gpu, replay, session }: SceneOptions) {
    const scene: {
        nodes: Map<string, SceneNode>;
        connections: Connection[];
        transferProfile: ReturnType<typeof sonataReplay.measureTransfers>;
    } = { nodes: new Map(), connections: [], transferProfile: new Map() };
    function executionLane(
        node: Pick<SceneNode, "x" | "z" | "h" | "w" | "d" | "pipeCount">,
        index: number
    ): { inlet: Vector; outlet: Vector; radius: number } {
        const pitch = Math.min(0.72, (node.d - 0.65) / node.pipeCount!),
            z = node.z + (index - (node.pipeCount! - 1) / 2) * pitch;
        const y = node.h + 0.34,
            half = (node.w - 0.78) / 2;
        return { inlet: [node.x - half, y, z], outlet: [node.x + half, y, z], radius: Math.min(0.19, pitch * 0.31) };
    }

    function nodePort(node: SceneNode, output: boolean): Vector {
        return node.pipeCount
            ? [node.x + (output ? 1 : -1) * (node.w / 2 + 0.12), node.h + 0.34, node.z]
            : [node.x, node.h + 0.26, node.z];
    }

    function inputPosition(): Vector {
        const first = scene.nodes.get(replay.trace.structure.frontNodes[0].id)!;
        return [Math.min(-15.6, first.x - first.w / 2 - 1.4), 0.8, 0];
    }

    function layoutBounds() {
        if (replay.trace.key !== "local-file") return { left: -14.7, right: 14.7, back: -7.1, front: 7.9 };
        const nodes = [...scene.nodes.values()];
        return {
            left: Math.min(-14.7, ...nodes.map((n) => n.x - n.w / 2 - 0.5)),
            right: Math.max(14.7, ...nodes.map((n) => n.x + n.w / 2 + 0.5)),
            back: Math.min(-7.1, ...nodes.map((n) => n.z - n.d / 2 - 0.5)),
            front: Math.max(7.9, ...nodes.map((n) => n.z + n.d / 2 + 0.5))
        };
    }

    function linkPort(id: string, output: boolean, lane: number, count: number): Vector {
        const n = scene.nodes.get(id)!,
            offset = lane - (count - 1) / 2;
        if (!n) return [id === "input" ? inputPosition()[0] : 15.8, 0.8, offset * 0.3];
        if (id === "commit") {
            const p = commitSlot(lane)[output ? "outlet" : "inlet"];
            return [n.x + (output ? 1 : -1) * (n.w / 2 + 0.01), p[1], p[2]];
        }
        if (n.pipeCount!) {
            const position = count === 1 ? (n.pipeCount - 1) / 2 : (lane * (n.pipeCount - 1)) / (count - 1);
            const pipe = count > n.pipeCount ? position : Math.round(position);
            const p = executionLane(n, pipe)[output ? "outlet" : "inlet"];
            return [n.x + (output ? 1 : -1) * (n.w / 2 + 0.12), p[1], p[2]];
        }
        return [
            n.x + (output ? 1 : -1) * (n.w / 2 + 0.01),
            n.h + 0.26,
            n.z + offset * Math.min(0.3, (n.d - 0.6) / Math.max(1, count - 1))
        ];
    }

    function addConnection(from: string, to: string, color: Vector) {
        const peak =
            (
                scene.transferProfile.get(`${from}>${to}`) ??
                (from === "register-read" ? scene.transferProfile.get(`issue>${to}`) : null)
            )?.peak ?? 0;
        // 並列幅はモジュールのラベルと同じ情報から決める。抜粋内で実際に使う
        // 管路はこれより少ない場合があるため、観測ピークは別の診断値に保持する。
        const execution = scene.nodes.get(from)?.pipeCount ?? scene.nodes.get(to)?.pipeCount;
        const memoryPath = from === "memory-wait" || to === "memory-wait";
        const retiring = from === "commit" || to === "commit";
        const count =
            from === "issue" && to === "register-read"
                ? replay.memory.executionNodes.reduce((sum, n) => sum + n.pipeCount, 0)
                : (execution ??
                  (memoryPath
                      ? (scene.nodes.get("exec-load")?.pipeCount ?? 1)
                      : retiring
                        ? replay.trace.retireWidth
                        : to === "issue"
                          ? replay.trace.structure.allocationWidth
                          : replay.trace.fetchWidth));
        const lanes = Array.from({ length: count }, (_, index) => {
            const source = linkPort(from, true, index, count),
                target = linkPort(to, false, index, count);
            if (from === "register-read" && scene.nodes.get(to)?.pipeCount) {
                source[1] = target[1];
                source[2] = target[2];
            }
            if (from === "issue" && to === "register-read") {
                const ports = [...scene.nodes.values()]
                    .filter((n) => n.pipeCount)
                    .flatMap((n) => Array.from({ length: n.pipeCount! }, (_, i) => executionLane(n, i).inlet))
                    .sort((a, b) => a[2] - b[2]);
                target[1] = ports[index][1];
                target[2] = ports[index][2];
            }
            return { source, target };
        });
        scene.connections.push({ from, to, color, peak, lanes });
    }

    function makeNode(
        id: string,
        label: string,
        x: number,
        z: number,
        w: number,
        d: number,
        h: number,
        color: Vector,
        detail: string
    ): SceneNode {
        const node: SceneNode = { id, label, x, z, w, d, h, color, detail };
        scene.nodes.set(id, node);
        return node;
    }

    function matrixPosition(row: number, column = -1): Vector {
        const n = scene.nodes.get("issue")!,
            columns = replay.dependencyReplay.columnCount,
            banks = n.matrixBanks ?? 1,
            rows = Math.ceil(replay.trace.structure.queueCapacity / banks),
            bank = Math.floor(row / rows),
            width = n.w / banks,
            x = n.x + (bank - (banks - 1) / 2) * width;
        return [
            x + (column < 0 ? -0.44 * width + (row % 2) * 0.28 : (-0.28 + ((column + 0.5) * 0.68) / columns) * width),
            n.h + 0.23,
            n.z - n.matrixDepth! / 2 + (((row % rows) + 0.5) * n.matrixDepth!) / rows
        ];
    }

    function crossesDependencyGrid(a: Vector, b = a) {
        const n = scene.nodes.get("issue")!,
            low: Vector = [n.x - n.w * 0.3, n.h + 0.06, n.z - n.matrixDepth! / 2 - 0.06],
            high: Vector = [n.x + n.w * 0.42, n.h + 1.2, n.z + n.matrixDepth! / 2 + 0.06];
        return crossesBox(a, b, low, high);
    }

    function crossesMapWords(a: Vector, b = a) {
        const n = renameNode();
        return (
            n?.mapWords &&
            crossesBox(
                a,
                b,
                [n.x - n.w * 0.48, n.h + 0.06, n.z - n.d * 0.46],
                [n.x + n.w * 0.48, n.h + 1.2, n.z + n.d * 0.46]
            )
        );
    }

    function renameNode() {
        return [...scene.nodes.values()].find((n) => n.names?.includes("Rn"));
    }

    function frontInstructionPosition(
        node: Pick<SceneNode, "x" | "z" | "h" | "instructionSlots" | "instructionRows">,
        slot: number
    ): Vector {
        const n = node,
            rows = n.instructionRows ?? Math.max(2, replay.trace.fetchWidth),
            columns = Math.ceil(n.instructionSlots! / rows);
        return [
            n.x + (Math.floor(slot / rows) - (columns - 1) / 2) * 0.32,
            n.h + 0.34,
            n.z + ((slot % rows) - (rows - 1) / 2) * 0.38
        ];
    }

    function renameInstructionPosition(slot: number): Vector {
        return frontInstructionPosition(renameNode()!, slot);
    }

    function renameWordLayout(index: number): {
        bits: number;
        bank: number;
        start: Vector;
        end: Vector;
        halfWidth: number;
    } {
        const n = renameNode()!,
            banks = Math.ceil(n.mapWords! / 8),
            bank = Math.floor(index / 8),
            column = index % 8;
        const pitch = (n.d * 0.84) / banks,
            z = n.z - n.d * 0.42 + (bank + 0.5) * pitch;
        const bits = Math.max(
            1,
            Math.ceil(Math.log2(replay.trace.evidence!.registers!.capacity ?? replay.registerTags.at(-1)! + 1))
        );
        const x = n.x + (column - 3.5) * n.w * 0.095,
            y = n.h + 0.23 + bank * 0.018;
        // レジスタを表すバーは Z 軸方向に向け、X 軸方向の命令の流れと直交させる。
        return { bits, bank, start: [x, y, z - pitch * 0.32], end: [x, y, z + pitch * 0.32], halfWidth: n.w * 0.031 };
    }

    function physicalColumns() {
        return Math.max(3, Math.ceil(Math.sqrt((replay.registerTags.length * 2.2) / 11.3)));
    }

    function physicalTagPosition(physical: number): Vector {
        const n = scene.nodes.get("register-read")!,
            index = replay.registerTags.indexOf(physical),
            columns = physicalColumns(),
            rows = Math.ceil(replay.registerTags.length / columns);
        return [
            n.x - n.w * 0.44 + (((index % columns) + 0.5) * n.w * 0.88) / columns,
            n.h + 0.18,
            n.z - n.d * 0.44 + ((Math.floor(index / columns) + 0.5) * n.d * 0.88) / rows
        ];
    }

    function memoryWaitPosition(slot: number): Vector {
        const n = scene.nodes.get("memory-wait")!;
        const columns = 3,
            rows = Math.max(1, Math.floor((n.d - 0.4) / 0.3));
        return [
            n.x + ((slot % columns) - 1) * 0.3,
            n.h + 0.34,
            n.z + (Math.floor(slot / columns) - (rows - 1) / 2) * 0.3
        ];
    }

    function registerReadPort(op: Pick<sonataReplay.Operation, "execution" | "index" | "pipeLane">): Vector {
        const n = scene.nodes.get("register-read")!,
            execution = scene.nodes.get(op.execution)!,
            lane = executionLane(execution, (op.pipeLane ?? op.index) % execution.pipeCount!);
        return [n.x + n.w * 0.5 + 0.03, lane.inlet[1], lane.inlet[2]];
    }

    function robColumns() {
        const capacity = replay.trace.structure.robCapacity;
        return capacity > 224 ? Math.ceil(Math.sqrt((capacity * 0.28) / 0.3)) : capacity > 96 ? 8 : 4;
    }

    function robCell(slot: number, lift = 0): Vector {
        const n = scene.nodes.get("rob")!,
            columns = robColumns(),
            rows = Math.ceil(replay.trace.structure.robCapacity / columns);
        const column = Math.floor(slot / rows),
            offset = slot % rows;
        const row = column % 2 ? rows - 1 - offset : offset;
        return [
            n.x + ((column - (columns - 1) / 2) * n.w * 0.8) / columns,
            n.h + 0.15 + lift,
            n.z + ((row - (rows - 1) / 2) * (n.d - 1.35)) / Math.max(1, rows - 1)
        ];
    }

    function robWrap(lift = 0): Vector[] {
        const first = robCell(0, lift),
            last = robCell(replay.trace.structure.robCapacity - 1, lift);
        const outside: Vector = [last[0] + 0.32, last[1], last[2] - (last[2] === first[2] ? 0.26 : 0)];
        return [
            last,
            outside,
            ...(last[2] === first[2] ? [] : [[outside[0], outside[1], first[2] - 0.26] as Vector]),
            [first[0] - 0.32, first[1], first[2] - 0.26],
            first
        ];
    }

    // 表示マーカーだけをセル間で補間し、折り返し・循環も固定配線と同じ経路を通す。
    function robMarker(slot: number, lift = 0): Vector {
        const capacity = replay.trace.structure.robCapacity,
            wrapped = ((slot % capacity) + capacity) % capacity,
            index = Math.floor(wrapped),
            fraction = wrapped - index;
        const path = index === capacity - 1 ? robWrap(lift) : [robCell(index, lift), robCell(index + 1, lift)];
        const lengths = path.slice(1).map((point, i) => Math.hypot(...point.map((value, k) => value - path[i][k])));
        let remaining = fraction * lengths.reduce((sum, length) => sum + length, 0);
        for (let i = 0; i < lengths.length; i++) {
            if (remaining <= lengths[i]) {
                const t = lengths[i] > 0 ? remaining / lengths[i] : 0;
                return path[i].map((value, k) => mix(value, path[i + 1][k], t)) as Vector;
            }
            remaining -= lengths[i];
        }
        return path.at(-1)!;
    }

    function commitSlot(index: number): { inlet: Vector; outlet: Vector; depth: number } {
        const n = scene.nodes.get("commit")!,
            pitch = (n.d * 0.8) / replay.trace.retireWidth,
            z = n.z + (index - (replay.trace.retireWidth - 1) / 2) * pitch,
            y = n.h + 0.2;
        return { inlet: [n.x - n.w * 0.35, y, z], outlet: [n.x + n.w * 0.35, y, z], depth: pitch * 0.65 };
    }

    function wakeBusEntry(): Vector {
        const n = scene.nodes.get("issue")!;
        return [n.x - n.w * 0.5, n.h + 0.3, n.z - n.d * 0.5 - 0.22];
    }

    function wakeColumnHead(column: number): Vector {
        const n = scene.nodes.get("issue")!,
            p = matrixPosition(0, column);
        return [p[0], n.h + 0.3, n.z - n.d * 0.5 - 0.22];
    }

    function issueRowExit(slot: number): Vector {
        const n = scene.nodes.get("issue")!,
            p = matrixPosition(slot);
        return [n.x + n.w * 0.5 + 0.06, p[1], p[2]];
    }

    function issuePath(issue: Issue) {
        const n = scene.nodes.get("issue")!,
            op = replay.ops.find((o) => o.id === issue.id)!,
            origin = matrixPosition(issue.slot!),
            exit = issueRowExit(issue.slot!);
        const connection =
            scene.connections.find((c) => c.from === "issue" && c.to === op.execution) ??
            scene.connections.find((c) => c.from === "issue")!;
        const unit = scene.nodes.get(op.execution)!,
            z = executionLane(unit, (op.pipeLane ?? op.index) % unit.pipeCount!).inlet[2];
        const lane =
            connection.lanes.find((l) => l.target[2] === z) ?? connection.lanes[op.index % connection.lanes.length];
        const signal: Vector[] =
            issue.column === null
                ? []
                : [
                      exit,
                      [exit[0], exit[1], n.z + n.d * 0.5 + 0.18],
                      [matrixPosition(0, issue.column!)[0], exit[1], n.z + n.d * 0.5 + 0.18],
                      matrixPosition(0, issue.column!)
                  ];
        return { id: issue.id, column: issue.column, origin, exit, port: lane.target, signal };
    }

    function wakePath(source: Vector, progress: number, producerID?: number): Vector {
        const scheduler = scene.nodes.get("issue")!;
        const target = wakeBusEntry();
        const a = [source[0] - 1.2, 2.5, 7.0],
            b = [scheduler.x - 1.0, 2.8, 5.8];
        const t = clamp(progress),
            q = 1 - t;
        return source.map(
            (v, i) => q * q * q * v + 3 * q * q * t * a[i] + 3 * q * t * t * b[i] + t * t * t * target[i]
        ) as Vector;
    }

    function buildLayout(preserveCapacity = false) {
        const previous = scene.nodes;
        scene.nodes = new Map();
        scene.connections = [];
        const front = replay.trace.structure.frontNodes;
        scene.transferProfile = sonataReplay.measureTransfers(replay.ops, {
            firstCycle: replay.trace.firstCycle,
            lastCycle: replay.trace.lastCycle,
            frontNodes: front
        });
        const hasRegisters = !!replay.trace.evidence?.registers;
        const hasRegisterRead = hasRegisters || !!replay.trace.structure.registerRead;
        front.forEach((n, i) => {
            const node = makeNode(
                n.id,
                n.names.join(" / "),
                mix(hasRegisterRead ? -12.5 : -11.4, hasRegisterRead ? -7.8 : -6.7, i / Math.max(1, front.length - 1)),
                0,
                Math.min(1.65, 4.4 / Math.max(1, front.length - 1)),
                2.7,
                0.6 + i * 0.1,
                session.style.palette.integer,
                i === 0 ? "FETCH" : "FRONT END"
            );
            node.names = n.names;
        });
        const rn = renameNode();
        if (rn && replay.trace.evidence?.registers?.rows.length) {
            rn.mapWords = replay.trace.evidence.registers.rows.length;
            rn.d = 3.6;
            rn.color = session.style.palette.blue;
            rn.detail =
                replay.trace.evidence.registers.logicalNames?.[0] === "RAX"
                    ? "16 ARCH + 16 TEMP"
                    : `${rn.mapWords} LOGICAL REGS`;
            if (replay.trace.evidence.registers.kind === "configuration")
                rn.detail = `${rn.mapWords} LOGICAL · MAP NOT LOGGED`;
        }
        if (rn && replay.trace.key !== "local-file")
            rn.instructionSlots = Math.max(
                1,
                preserveCapacity && previous.get(rn.id)?.names?.join() === rn.names?.join()
                    ? (previous.get(rn.id)?.instructionSlots ?? 1)
                    : 1,
                ...replay.ops.flatMap((op) =>
                    op.stages.filter((s) => s.names.includes("Rn")).map((s) => (s.displaySlot ?? 0) + 1)
                )
            );
        if (replay.trace.key === "local-file") {
            // 長く滞在する前段命令を同じfetchレーンへ重ねず、固定サイズの格子へ置く。
            for (const descriptor of front) {
                const node = scene.nodes.get(descriptor.id)!;
                node.instructionSlots = Math.max(
                    1,
                    preserveCapacity ? (previous.get(node.id)?.instructionSlots ?? 1) : 1,
                    ...replay.ops.flatMap((op) =>
                        op.stages.filter((stage) => stage.node === node.id).map((stage) => (stage.displaySlot ?? 0) + 1)
                    )
                );
                node.instructionRows = Math.max(
                    2,
                    replay.trace.fetchWidth,
                    Math.ceil(Math.sqrt((node.instructionSlots * 0.32) / 0.38)),
                    preserveCapacity ? (previous.get(node.id)?.instructionRows ?? 0) : 0
                );
                const columns = Math.ceil(node.instructionSlots / node.instructionRows);
                node.w = Math.max(node.w, (columns - 1) * 0.32 + 0.48);
                node.d = Math.max(node.d, (node.instructionRows - 1) * 0.38 + 0.48);
            }
        }
        const capacity = replay.trace.structure.queueCapacity;
        const scheduler = makeNode(
            "issue",
            "SCHEDULER",
            hasRegisterRead ? -5.2 : -3.7,
            0,
            hasRegisterRead ? 3.2 : 3.6,
            hasRegisterRead ? 3.2 : 3.6,
            0.65,
            session.style.palette.blue,
            `${capacity} ROWS × ${replay.dependencyReplay.columnCount} COLS · ${replay.trace.evidence?.scheduling.kind === "recorded" ? "RECORDED" : replay.trace.key === "local-file" ? "UNOBSERVED" : "RAW ESTIMATE"}`
        );
        // 駒を縮めずに置けるよう、待機列の行間と筐体の奥行きを確保する。
        if (replay.trace.key === "local-file" && !replay.trace.evidence && capacity > 128) {
            // 依存未観測の大きな待機列は、未知の依存列を補わず128行ずつ並べる。
            scheduler.matrixBanks = Math.ceil(capacity / 128);
            scheduler.x -= (scheduler.w * (scheduler.matrixBanks - 1)) / 2;
            scheduler.w *= scheduler.matrixBanks;
            scheduler.detail = `${capacity} ROWS · ${scheduler.matrixBanks} BANKS · UNOBSERVED`;
        }
        scheduler.matrixDepth = Math.max(
            (scheduler.w / (scheduler.matrixBanks ?? 1)) * 0.68,
            Math.ceil(capacity / (scheduler.matrixBanks ?? 1)) * 0.14
        );
        scheduler.d = Math.max(scheduler.d, scheduler.matrixDepth / 0.84);
        if (replay.trace.key === "local-file") {
            let right = scheduler.x - scheduler.w / 2 - 0.3;
            for (const descriptor of [...front].reverse()) {
                const node = scene.nodes.get(descriptor.id)!;
                node.x = Math.min(node.x, right - node.w / 2);
                right = node.x - node.w / 2 - 0.4;
            }
        }
        // INT / BR を共有し、存在する実行ユニットを一定間隔で中央へ並べる。
        // STORE より下には LOAD と LOAD WAIT をまとめる。
        const order = ["exec-integer", "exec-fp", "exec-store", "exec-load", "exec-memory"];
        const units = [...replay.memory.executionNodes]
            .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
            .map((node) => ({
                ...node,
                depth: Math.max(
                    node.kind === "memory" ? 1.25 : 3.05,
                    node.pipeCount * (node.kind === "memory" ? 0.38 : 0.3) + 0.65
                )
            }));
        let executionEdge =
            -(units.reduce((sum, node) => sum + node.depth, 0) + Math.max(0, units.length - 1) * 0.4) / 2;
        for (const n of units) {
            const memory = n.kind === "memory";
            const latency = n.latency;
            const width = 0.78 + 1.17 * latency;
            const depth = n.depth;
            const z = executionEdge + depth / 2;
            executionEdge += depth + 0.4;
            const label = {
                "exec-integer": "INT / BR",
                "exec-fp": "FP / SIMD",
                "exec-load": "LOAD",
                "exec-store": "STORE",
                "exec-memory": "ATOMIC"
            }[n.id]!;
            const known =
                n.id === "exec-load"
                    ? replay.memory.minimum.load
                    : n.id === "exec-store"
                      ? replay.memory.minimum.store
                      : null;
            const node = makeNode(
                n.id,
                label,
                (hasRegisterRead ? 1.515 : 0.315) + (width - 0.78) / 2,
                z,
                width,
                depth,
                0.65,
                session.style.palette[n.kind],
                memory
                    ? `${known == null ? "LATENCY ?" : `${known} CYC MIN`} · ${n.pipeCount} ROUTES / ${n.sharedPipes} SHARED`
                    : `${n.pipeCount} ${n.pipeCount === 1 ? "PIPE" : "PIPES"} · →`
            );
            node.pipeCount = n.pipeCount;
            node.compact = latency <= 1;
            node.latency = latency;
        }
        const load = scene.nodes.get("exec-load"),
            slots = Math.max(
                replay.memory.waitSlots.load,
                preserveCapacity ? (previous.get("memory-wait")?.instructionSlots ?? 0) : 0
            );
        if (load && slots) {
            const width = 1.15,
                depth = Math.max(1.25, Math.ceil(slots / 3) * 0.3 + 0.4);
            const wait = makeNode(
                "memory-wait",
                "LOAD WAIT",
                load.x + load.w / 2 + width / 2 + 0.24,
                load.z,
                width,
                depth,
                0.5,
                session.style.palette.memory,
                "INFERRED RESPONSE WAIT"
            );
            wait.instructionSlots = slots;
        }
        // 左端を保って右へ広げ、メモリ待ちからの接続線が逆向きになるのを避ける。
        const robWidth = Math.max(replay.trace.structure.robCapacity > 96 ? 3.0 : 2.45, (robColumns() * 0.3) / 0.8),
            robDepth =
                replay.trace.structure.robCapacity > 224
                    ? Math.max(8, (Math.ceil(replay.trace.structure.robCapacity / robColumns()) - 1) * 0.28 + 1.35)
                    : 8;
        const robLeft = Math.max(
            5.575,
            ...[...scene.nodes.values()]
                .filter((n) => n.id.startsWith("exec") || n.id === "memory-wait")
                .map((n) => n.x + n.w / 2 + 0.3)
        );
        makeNode(
            "rob",
            replay.trace.machineOrder === "in-order" ? "COMPLETION FIFO" : "REORDER BUFFER",
            robLeft + robWidth / 2,
            0,
            robWidth,
            robDepth,
            0.65,
            session.style.palette.blue,
            `${replay.trace.structure.robCapacity} ENTRIES · HEAD → COMMIT`
        );
        makeNode(
            "commit",
            "COMMIT",
            Math.max(11.1, robLeft + robWidth + 1.6),
            0,
            2.15,
            Math.max(3.0, (replay.trace.retireWidth * 0.3) / 0.8),
            0.65,
            session.style.palette.integer,
            `${replay.trace.retireWidth} SLOTS / CYCLE`
        );
        if (hasRegisterRead) {
            // 実行 pipe を並べ替えても、レジスタ側の端子を筐体内に収める。
            const ports = [...scene.nodes.values()]
                .filter((n) => n.pipeCount)
                .flatMap((n) => [executionLane(n, 0).inlet[2], executionLane(n, n.pipeCount! - 1).inlet[2]]);
            const minZ = Math.min(-5.65, ...ports.map((z) => z - 0.35)),
                maxZ = Math.max(5.65, ...ports.map((z) => z + 0.35));
            makeNode(
                "register-read",
                hasRegisters ? "PHYSICAL REGISTERS" : "REGISTER READ",
                -1.65,
                (minZ + maxZ) / 2,
                2.2,
                maxZ - minZ,
                0.4,
                session.style.palette.blue,
                !hasRegisters
                    ? "Is / Rr · VALUES NOT LOGGED"
                    : replay.trace.evidence!.registers!.origin === "gem5"
                      ? `${replay.registerTags.length} INT · ${replay.trace.evidence!.registers!.kind === "configuration" ? "CONFIG ONLY" : "RECORDED ACCESSES"}`
                      : `${replay.registerTags.length} OBSERVED · READ AT Rr`
            );
        }
        front.slice(1).forEach((n, i) => addConnection(front[i].id, n.id, scene.nodes.get(front[i].id)!.color));
        addConnection(front.at(-1)!.id, "issue", session.style.palette.integer);
        if (hasRegisterRead) addConnection("issue", "register-read", session.style.palette.blue);
        for (const n of replay.memory.executionNodes) {
            addConnection(hasRegisterRead ? "register-read" : "issue", n.id, session.style.palette[n.kind]);
            addConnection(n.id, "rob", session.style.palette[n.kind]);
        }
        if (scene.nodes.has("memory-wait")) {
            addConnection("exec-load", "memory-wait", session.style.palette.memory);
            addConnection("memory-wait", "rob", session.style.palette.memory);
        }
        addConnection("rob", "commit", session.style.palette.integer);
        addConnection("input", front[0].id, session.style.palette.integer);
        addConnection("commit", "output", session.style.palette.integer);
        const robNode = scene.nodes.get("rob")!,
            robInputs = scene.connections.filter((c) => c.to === "rob").flatMap((c) => c.lanes);
        robInputs.sort((a, b) => a.source[2] - b.source[2]);
        robInputs.forEach((lane, index) => {
            lane.target[2] =
                robNode.z +
                ((index - (robInputs.length - 1) / 2) * robNode.d * 0.82) / Math.max(1, robInputs.length - 1);
        });
    }

    // 固定部品の形状・材質・ラベルと接地面。
    function vertex(out: VertexData, p: Color, color: Color, alpha = 1) {
        (out.triangles ?? out).push(...p, ...color, alpha);
    }
    function line(out: VertexData, a: Color, b: Color, color: Color, alpha = 1) {
        vertex(out, a, color, alpha);
        vertex(out, b, color, alpha);
    }
    function point(out: number[], p: Color, color: Color, size: number, alpha = 1) {
        out.push(...p, ...color, alpha, size);
    }
    const baseLevels = { table: -0.87, lowerBoard: -0.71, board: -0.29, plinth: -0.09 };
    // 通常の三角形と材質付きの部品を同じ組立処理から分ける。
    function beveledBlock(
        out: VertexData,
        x: number,
        y: number,
        z: number,
        w: number,
        h: number,
        d: number,
        color: Color,
        alpha = 1,
        material = 0,
        supportY = y
    ) {
        const bevel = Math.min(0.1, h * 0.18, w * 0.09, d * 0.09),
            bottom = Math.min(y, supportY),
            height = y + h - bottom;
        // 天面と面取りを保ち、底面だけを支持面まで伸ばす。命令やポートの座標は動かさない。
        (out.materials ?? out).push(
            x,
            bottom + height / 2,
            z,
            w / 2,
            height / 2,
            d / 2,
            ...color,
            alpha,
            bevel,
            material
        );
    }
    function flatQuad(
        tris: VertexData,
        x: number,
        y: number,
        z: number,
        w: number,
        d: number,
        color: Color,
        alpha = 1
    ) {
        const p = [
            [x - w / 2, y, z - d / 2],
            [x + w / 2, y, z - d / 2],
            [x + w / 2, y, z + d / 2],
            [x - w / 2, y, z + d / 2]
        ];
        for (const k of [0, 1, 2, 0, 2, 3]) vertex(tris, p[k], color, alpha);
    }
    function contactShadow(
        tris: VertexData,
        x: number,
        y: number,
        z: number,
        w: number,
        d: number,
        spread: number,
        opacity = 0.22
    ) {
        // 重複した四角を重ねず、丸い輪郭から連続的に薄くなる影を作る。
        const radius = Math.min(0.18, w * 0.12, d * 0.12),
            color = [0.24, 0.19, 0.13];
        const rim = (pad: number) => {
            const points = [];
            for (let corner = 0; corner < 4; corner++) {
                const sx = corner === 0 || corner === 3 ? 1 : -1,
                    sz = corner < 2 ? 1 : -1;
                for (let k = 0; k <= 4; k++) {
                    const angle = ((corner + k / 4) * Math.PI) / 2;
                    points.push([
                        x + sx * (w / 2 - radius) + Math.cos(angle) * (radius + pad),
                        y,
                        z + sz * (d / 2 - radius) + Math.sin(angle) * (radius + pad)
                    ]);
                }
            }
            return points;
        };
        let inner = rim(0),
            alpha = opacity;
        for (let i = 0; i < inner.length; i++)
            for (const p of [[x, y, z], inner[i], inner[(i + 1) % inner.length]]) vertex(tris, p, color, alpha);
        for (let ring = 1; ring <= 6; ring++) {
            const t = ring / 6,
                outer = rim(spread * t),
                next = opacity * (1 - smooth(t)) ** 2;
            for (let i = 0; i < inner.length; i++) {
                const j = (i + 1) % inner.length,
                    p = [inner[i], inner[j], outer[j], outer[i]];
                for (const k of [0, 1, 2, 0, 2, 3]) vertex(tris, p[k], color, k < 2 ? alpha : next);
            }
            inner = outer;
            alpha = next;
        }
    }
    function ring(
        out: VertexData,
        x: number,
        y: number,
        z: number,
        radius: number,
        color: Color,
        alpha = 1,
        start = 0,
        end = TAU,
        segments = 80
    ) {
        for (let i = 0; i < segments; i++) {
            const a = mix(start, end, i / segments),
                b = mix(start, end, (i + 1) / segments);
            line(
                out,
                [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius],
                [x + Math.cos(b) * radius, y, z + Math.sin(b) * radius],
                color,
                alpha
            );
        }
    }
    function box(
        tris: TriangleData,
        lines: number[],
        x: number,
        y: number,
        z: number,
        w: number,
        h: number,
        d: number,
        color: Color,
        glow = 0.55,
        supportY = y
    ) {
        if (session.style.matte) {
            housing(tris, lines, x, y, z, w, h, d, color, glow, supportY);
            return;
        }
        const p = [
            [x - w / 2, y, z - d / 2],
            [x + w / 2, y, z - d / 2],
            [x + w / 2, y, z + d / 2],
            [x - w / 2, y, z + d / 2],
            [x - w / 2, y + h, z - d / 2],
            [x + w / 2, y + h, z - d / 2],
            [x + w / 2, y + h, z + d / 2],
            [x - w / 2, y + h, z + d / 2]
        ];
        const faces = [
            [0, 1, 5, 4],
            [1, 2, 6, 5],
            [2, 3, 7, 6],
            [3, 0, 4, 7],
            [4, 5, 6, 7],
            [3, 2, 1, 0]
        ];
        faces.forEach((f, i) => {
            const shade = i === 4 ? 0.11 : 0.035 + i * 0.006;
            const c = color.map((v, axis) => v * shade + [0.009, 0.018, 0.024][axis]);
            for (const j of [0, 1, 2, 0, 2, 3]) vertex(tris, p[f[j]], c);
        });
        for (const [a, b] of [
            [0, 1],
            [1, 2],
            [2, 3],
            [3, 0],
            [4, 5],
            [5, 6],
            [6, 7],
            [7, 4],
            [0, 4],
            [1, 5],
            [2, 6],
            [3, 7]
        ])
            line(lines, p[a], p[b], color, glow);
    }
    function housing(
        tris: TriangleData,
        lines: number[],
        x: number,
        y: number,
        z: number,
        w: number,
        h: number,
        d: number,
        color: Color,
        glow = 0.4,
        supportY = y
    ) {
        if (session.style.matte) {
            const floor = color === session.style.palette.floor,
                base = y < -0.1;
            // 大きな構造面は中性色に揃え、意味を持つ色は命令と識別帯へ集める。
            const paint = floor
                ? session.style.surface.floor
                : base
                  ? session.style.structure.base
                  : h < 0.1
                    ? session.style.structure.recess
                    : h < 0.2
                      ? session.style.structure.rail
                      : session.style.structure.body;
            // 形状と支持面を共用し、紙の折り筋とアルミの反射を材質で描き分ける。
            const material = session.style.surface.paper ? (floor || base ? 1 : h >= 0.2 ? 2 : 3) : 4;
            beveledBlock(tris, x, y, z, w, h, d, paint, 1, material, supportY);
            if (tris.shadows && y >= -0.05 && w > 0.4 && d > 0.4 && h > 0.09)
                contactShadow(tris.shadows, x, Math.min(y, supportY) + 0.002, z, w, d, 0.1, 0.18);
            return;
        }
        const bevel = Math.min(0.12, h * 0.3),
            cut = Math.min(0.22, w * 0.13, d * 0.13);
        const rim = (inset: number, height: number) => {
            const a = w / 2 - inset,
                b = d / 2 - inset,
                c = cut * 0.7;
            return [
                [-a + c, -b],
                [a - c, -b],
                [a, -b + c],
                [a, b - c],
                [a - c, b],
                [-a + c, b],
                [-a, b - c],
                [-a, -b + c]
            ].map(([dx, dz]) => [x + dx, height, z + dz]);
        };
        const bottom = rim(0, y),
            shoulder = rim(0, y + h - bevel),
            top = rim(bevel, y + h);
        const face = (p: Color[], c: Color) => {
            for (const k of [0, 1, 2, 0, 2, 3]) vertex(tris, p[k], c);
        };
        for (let i = 0; i < 8; i++) {
            const j = (i + 1) % 8,
                side = color.map((v, k) => [0.016, 0.027, 0.034][k] + v * (i % 2 ? 0.035 : 0.022));
            face([bottom[i], bottom[j], shoulder[j], shoulder[i]], side);
            face(
                [shoulder[i], shoulder[j], top[j], top[i]],
                color.map((v, k) => [0.025, 0.038, 0.045][k] + v * 0.09)
            );
            for (const p of [[x, y + h, z], top[i], top[j]])
                vertex(
                    tris,
                    p,
                    color.map((v, k) => [0.023, 0.036, 0.044][k] + v * 0.035)
                );
            line(lines, top[i], top[j], color, glow);
            line(lines, bottom[i], bottom[j], color, glow * 0.3);
            if (i % 2 === 0) line(lines, bottom[i], shoulder[i], color, glow * 0.35);
        }
    }

    function pipeCollar(lines: number[], x: number, y: number, z: number, r: number, color: Color, alpha: number) {
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * TAU,
                b = ((i + 1) / 12) * TAU;
            line(
                lines,
                [x, y + Math.sin(a) * r, z + Math.cos(a) * r],
                [x, y + Math.sin(b) * r, z + Math.cos(b) * r],
                color,
                alpha
            );
        }
    }

    function flowChevron(lines: number[], x: number, y: number, z: number, size: number, color: Color, alpha: number) {
        line(lines, [x - size * 0.6, y, z - size * 0.55], [x + size * 0.4, y, z], color, alpha);
        line(lines, [x + size * 0.4, y, z], [x - size * 0.6, y, z + size * 0.55], color, alpha);
    }

    function executionModule(tris: TriangleData, lines: number[], node: SceneNode) {
        const { x, z, w, d, h, color } = node;
        housing(tris, lines, x, -0.25, z, w + 0.2, 0.16, d + 0.2, color, 0.2, baseLevels.board);
        housing(tris, lines, x, -0.05, z, w, h + 0.05, d, color, 0.23, baseLevels.plinth);
        // 並列の管路は上部を開いた溝として描き、内部を流れる光が見えるようにする。
        for (let k = 0; k < node.pipeCount!; k++) {
            const { inlet: a, outlet: b, radius: r } = executionLane(node, k);
            housing(tris, lines, x, h + 0.01, a[2], b[0] - a[0] + 0.16, 0.09, r * 2.5, color, 0.16, h);
            for (let j = 6; j < 12; j++) {
                const u = (j / 12) * TAU,
                    v = ((j + 1) / 12) * TAU;
                const p = [
                    [a[0], a[1] + Math.sin(u) * r, a[2] + Math.cos(u) * r],
                    [b[0], b[1] + Math.sin(u) * r, b[2] + Math.cos(u) * r],
                    [b[0], b[1] + Math.sin(v) * r, b[2] + Math.cos(v) * r],
                    [a[0], a[1] + Math.sin(v) * r, a[2] + Math.cos(v) * r]
                ];
                for (const i of [0, 1, 2, 0, 2, 3])
                    vertex(
                        tris,
                        p[i],
                        session.style.matte
                            ? session.style.structure.recess
                            : color.map((c, i) => [0.014, 0.025, 0.032][i] + c * 0.045)
                    );
            }
            for (const side of [-1, 1])
                line(lines, [a[0], a[1], a[2] + side * r], [b[0], b[1], b[2] + side * r], color, 0.12);
            line(lines, a, b, color, 0.05);
            for (const t of node.compact ? [0, 1] : [0, 0.33, 0.67, 1])
                pipeCollar(lines, mix(a[0], b[0], t), a[1], a[2], r, color, t === 0 || t === 1 ? 0.23 : 0.12);
            for (const t of node.compact ? [0.5] : [0.28, 0.72])
                flowChevron(lines, mix(a[0], b[0], t), a[1] - 0.01, a[2], r * 0.7, color, 0.16);
            // 入口・出口の両方で、各接続線を対応する pipe の軸に揃える。
            const intake: Vector = [nodePort(node, false)[0], a[1], a[2]],
                outlet: Vector = [nodePort(node, true)[0], b[1], b[2]];
            for (const [from, to] of [
                [intake, a],
                [b, outlet]
            ])
                for (let j = 0; j < 16; j++)
                    line(lines, route(from, to, j / 16), route(from, to, (j + 1) / 16), color, 0.09);
        }
        for (const side of [-1, 1]) {
            const railZ = z + side * (d / 2 - 0.13);
            housing(tris, lines, x, h + 0.015, railZ, w - 0.7, 0.12, 0.12, color, 0.16, h);
            for (const dx of [-w * 0.36, w * 0.36]) {
                line(
                    lines,
                    [x + dx, -0.12, z + (side * d) / 2],
                    [x + dx, -0.12, z + side * (d / 2 + 0.25)],
                    color,
                    0.28
                );
                flowChevron(lines, x + dx, h + 0.17, railZ, 0.2, color, 0.25);
            }
        }
    }

    function matrixModule(tris: TriangleData, lines: number[], n: SceneNode) {
        housing(tris, lines, n.x, -0.25, n.z, n.w + 0.2, 0.16, n.d + 0.2, n.color, 0.22, baseLevels.board);
        housing(tris, lines, n.x, -0.05, n.z, n.w, n.h + 0.05, n.d, n.color, 0.3, baseLevels.plinth);
        const y = n.h + 0.08,
            x0 = n.x - n.w * 0.28,
            x1 = n.x + n.w * 0.4,
            z0 = n.z - n.matrixDepth! / 2,
            z1 = n.z + n.matrixDepth! / 2;
        n.grid = { rows: [], columns: [] };
        // 境界線ではなく、同じエントリの行・列を一本ずつ描く。交点を依存セルと揃える。
        for (let r = 0; r < replay.trace.structure.queueCapacity; r++) {
            const p = matrixPosition(r),
                segment: [Vector, Vector] = [
                    [p[0], y, p[2]],
                    [
                        n.matrixBanks
                            ? matrixPosition(r, replay.dependencyReplay.columnCount - 1)[0] +
                              ((n.w / n.matrixBanks) * 0.34) / replay.dependencyReplay.columnCount
                            : x1,
                        y,
                        p[2]
                    ]
                ];
            n.grid.rows.push(segment);
            line(
                lines,
                ...segment,
                n.color,
                session.style.matte ? (r % 8 === 0 ? 0.42 : 0.27) : r % 8 === 0 ? 0.24 : 0.13
            );
        }
        if (n.matrixBanks) return;
        for (let c = 0; c < replay.dependencyReplay.columnCount; c++) {
            const x = matrixPosition(0, c)[0],
                segment: [Vector, Vector] = [
                    [x, y, z0],
                    [x, y, z1]
                ];
            n.grid.columns.push(segment);
            line(
                lines,
                ...segment,
                n.color,
                session.style.matte ? (c % 8 === 0 ? 0.32 : 0.2) : c % 8 === 0 ? 0.22 : 0.11
            );
        }
        for (const x of [x0, x1]) line(lines, [x, y, z0], [x, y, z1], n.color, 0.5);
        for (const z of [z0, z1]) line(lines, [x0, y, z], [x1, y, z], n.color, 0.5);
    }

    function renameModule(tris: TriangleData, lines: number[], n: SceneNode) {
        housing(
            tris,
            lines,
            n.x,
            -0.25,
            n.z,
            n.w + 0.18,
            0.16,
            n.d + 0.16,
            session.style.palette.blue,
            0.25,
            baseLevels.board
        );
        housing(
            tris,
            lines,
            n.x,
            -0.05,
            n.z,
            n.w,
            n.h + 0.05,
            n.d,
            session.style.palette.blue,
            0.35,
            baseLevels.plinth
        );
        const banks = Math.ceil(n.mapWords! / 8),
            pitch = (n.d * 0.84) / banks;
        // Rn 上に 8 本ずつ 4 組のバーを重ね、RAT の立体配列を構成する。
        // 内部の小さなセルは割り当て先の物理レジスタ番号を二進数で表す。
        for (let bank = 0; bank < banks; bank++) {
            const z = n.z - n.d * 0.42 + (bank + 0.5) * pitch,
                y = n.h + 0.065 + bank * 0.018;
            housing(tris, lines, n.x, y, z, n.w * 0.87, 0.14, pitch * 0.87, session.style.palette.blue, 0.22, n.h);
            line(
                lines,
                [n.x - n.w * 0.4, y + 0.16, z - pitch * 0.4],
                [n.x + n.w * 0.4, y + 0.16, z - pitch * 0.4],
                session.style.palette.blue,
                0.3
            );
        }
        for (let index = 0; index < n.mapWords!; index++) {
            const row = renameWordLayout(index);
            const [x, y, z0] = row.start,
                z1 = row.end[2];
            const rim = [
                [x - row.halfWidth, y, z0],
                [x + row.halfWidth, y, z0],
                [x + row.halfWidth, y, z1],
                [x - row.halfWidth, y, z1]
            ];
            for (let i = 0; i < 4; i++) line(lines, rim[i], rim[(i + 1) % 4], session.style.palette.blue, 0.22);
        }
    }

    function registerModule(tris: TriangleData, lines: number[], n: SceneNode) {
        housing(
            tris,
            lines,
            n.x,
            -0.25,
            n.z,
            n.w + 0.24,
            0.16,
            n.d + 0.24,
            session.style.palette.blue,
            0.25,
            baseLevels.board
        );
        housing(
            tris,
            lines,
            n.x,
            -0.05,
            n.z,
            n.w,
            n.h + 0.05,
            n.d,
            session.style.palette.blue,
            0.35,
            baseLevels.plinth
        );
        const depth = (n.d * 0.7) / Math.ceil(replay.registerTags.length / physicalColumns());
        for (const tag of replay.registerTags) {
            const p = physicalTagPosition(tag);
            housing(
                tris,
                lines,
                p[0],
                n.h + 0.04,
                p[2],
                (n.w * 0.7) / physicalColumns(),
                0.055,
                depth,
                session.style.palette.blue.map((v) => v * 0.35),
                0.14,
                n.h
            );
        }
        for (const execution of [...scene.nodes.values()].filter((n) => n.pipeCount!))
            for (let lane = 0; lane < execution.pipeCount!; lane++) {
                const p = executionLane(execution, lane).inlet;
                line(
                    lines,
                    [n.x + n.w * 0.46, p[1], p[2]],
                    [n.x + n.w * 0.5 + 0.05, p[1], p[2]],
                    execution.color,
                    0.55
                );
            }
    }

    function commitModule(tris: TriangleData, lines: number[], n: SceneNode) {
        housing(
            tris,
            lines,
            n.x,
            -0.25,
            n.z,
            n.w + 0.24,
            0.16,
            n.d + 0.24,
            session.style.palette.blue,
            0.25,
            baseLevels.board
        );
        housing(
            tris,
            lines,
            n.x,
            -0.05,
            n.z,
            n.w,
            n.h + 0.05,
            n.d,
            session.style.palette.blue,
            0.35,
            baseLevels.plinth
        );
        for (let i = 0; i < replay.trace.retireWidth; i++) {
            const slot = commitSlot(i),
                a = slot.inlet,
                b = slot.outlet;
            housing(
                tris,
                lines,
                n.x,
                n.h + 0.05,
                a[2],
                n.w * 0.74,
                0.07,
                slot.depth,
                session.style.palette.blue,
                0.38,
                n.h
            );
            line(lines, a, b, session.style.palette.blue, 0.2);
            for (const p of [a, b])
                line(
                    lines,
                    [p[0], p[1], p[2] - slot.depth * 0.4],
                    [p[0], p[1], p[2] + slot.depth * 0.4],
                    session.style.palette.blue,
                    0.45
                );
            line(lines, [b[0] - 0.14, b[1], b[2] - slot.depth * 0.25], b, session.style.palette.blue, 0.4);
            line(lines, [b[0] - 0.14, b[1], b[2] + slot.depth * 0.25], b, session.style.palette.blue, 0.4);
        }
    }

    // 配置だけの検査は GPU を渡さず、描画データを作るときにのみ GPU が必要になる。
    let worldSignature = "";
    let worldGround: ReturnType<typeof createGround> | null = null;
    let worldBuilds = 0;
    function buildWorld(reuse = false) {
        const previous = scene.nodes;
        buildLayout(reuse);
        // 観測ピークは窓ごとに更新するが、同じ形状の固定GPU資源とDOMは使い続ける。
        const signature = JSON.stringify([
            session.style,
            [...scene.nodes.values()],
            scene.connections.map(({ peak, ...shape }) => shape),
            replay.registerTags,
            replay.trace.evidence?.registers
        ]);
        if (reuse && signature === worldSignature) {
            for (const node of scene.nodes.values()) {
                node.element = previous.get(node.id)?.element;
                node.grid = previous.get(node.id)?.grid;
            }
            return worldGround;
        }
        const lines: number[] = [],
            stars: number[] = [],
            shadows: number[] = [],
            tris: TriangleData = { triangles: [], materials: [], shadows };
        const bounds = layoutBounds(),
            centerX = (bounds.left + bounds.right) / 2,
            centerZ = (bounds.back + bounds.front) / 2,
            boardWidth = bounds.right - bounds.left,
            boardDepth = bounds.front - bounds.back;
        if (session.style.matte) {
            flatQuad(tris, 0, baseLevels.table, 0, 200, 200, session.style.background);
            contactShadow(shadows, centerX, baseLevels.table + 0.002, centerZ, boardWidth, boardDepth, 0.35);
        }
        box(
            tris,
            lines,
            centerX,
            -0.65,
            centerZ,
            boardWidth - 0.6,
            0.36,
            boardDepth - 0.6,
            session.style.palette.floor,
            0.5,
            baseLevels.lowerBoard
        );
        box(
            tris,
            lines,
            centerX,
            -0.81,
            centerZ,
            boardWidth,
            0.1,
            boardDepth,
            session.style.palette.floor,
            0.22,
            baseLevels.table
        );
        if (!session.style.matte) {
            for (let x = -28; x <= 28; x += 1)
                line(lines, [x, -0.84, -22], [x, -0.84, 22], session.style.palette.floor, x % 4 === 0 ? 0.27 : 0.12);
            for (let z = -22; z <= 22; z += 1)
                line(lines, [-28, -0.84, z], [28, -0.84, z], session.style.palette.floor, z % 4 === 0 ? 0.27 : 0.12);
            for (let i = 0; i < 130; i++) {
                const x = -14 + hash(i + 41) * 28,
                    z = -6.2 + hash(i + 77) * 13;
                const y = -0.26,
                    len = 0.25 + hash(i) * 1.5,
                    c = i % 8 === 0 ? session.style.palette.integer : session.style.palette.floor;
                line(lines, [x, y, z], [x + len, y, z], c, i % 8 === 0 ? 0.28 : 0.38);
                line(lines, [x + len, y, z], [x + len + 0.27, y, z + 0.27], c, 0.25);
                if (i % 4 === 0) point(stars, [x, y, z], c, 3, 0.6);
            }
            for (let i = 0; i < 310; i++)
                point(
                    stars,
                    [(hash(i + 910) - 0.5) * 70, hash(i + 830) * 17 - 3, (hash(i + 920) - 0.5) * 55],
                    i % 6 ? [0.22, 0.42, 0.55] : session.style.palette.integer,
                    0.8 + hash(i + 940) * 2.1,
                    0.2 + hash(i) * 0.5
                );
        }
        for (const node of scene.nodes.values()) {
            const { x, z, w, d, h, color, id } = node;
            if (session.style.matte) {
                contactShadow(shadows, x, baseLevels.board + 0.002, z, w + 0.2, d + 0.2, 0.14);
                const specialized =
                    node.pipeCount! || node.mapWords! || ["issue", "register-read", "commit"].includes(id);
                const stripe = Math.min(w * 0.6, 1.5),
                    top = h - (specialized ? 0 : 0.05);
                beveledBlock(
                    tris,
                    x - w / 2 + 0.12 + stripe / 2,
                    top + 0.004,
                    z + d / 2 - 0.13,
                    stripe,
                    0.018,
                    0.07,
                    color,
                    1,
                    session.style.surface.paper ? 3 : 0,
                    top
                );
            }
            if (node.pipeCount!) {
                executionModule(tris, lines, node);
                continue;
            }
            if (id === "issue") {
                matrixModule(tris, lines, node);
                continue;
            }
            if (id === "register-read" && replay.trace.evidence?.registers) {
                registerModule(tris, lines, node);
                continue;
            }
            if (id === "commit") {
                commitModule(tris, lines, node);
                continue;
            }
            if (node.mapWords!) {
                renameModule(tris, lines, node);
                continue;
            }
            box(tris, lines, x, -0.25, z, w + 0.25, 0.16, d + 0.25, color, 0.22, baseLevels.board);
            box(tris, lines, x, -0.05, z, w, h, d, color, 0.52, baseLevels.plinth);
            // 天面の細かい刻みと側面のフィンで、光を載せる物体の質感を表す。
            for (let k = 0; k < 8; k++) {
                const dz = z - d * 0.38 + (k * d * 0.76) / 7;
                line(lines, [x - w * 0.38, h - 0.04, dz], [x + w * 0.38, h - 0.04, dz], color, 0.16);
                line(lines, [x - w / 2 - 0.01, 0.06, dz], [x - w / 2 - 0.01, h * 0.65, dz], color, 0.23);
            }
            for (let side = -1; side <= 1; side += 2) {
                line(
                    lines,
                    [x - w * 0.34, h + 0.012, z + (side * d) / 2],
                    [x + w * 0.34, h + 0.012, z + (side * d) / 2],
                    color,
                    0.95
                );
                for (let k = 0; k < 6; k++) {
                    const xx = x - w * 0.34 + (k * w * 0.68) / 5;
                    line(
                        lines,
                        [xx, -0.2, z + side * (d / 2 + 0.15)],
                        [xx, -0.2, z + side * (d / 2 + 0.42)],
                        color,
                        0.38
                    );
                }
            }
        }
        // 連続した物理スロットを蛇行させ、1 本の循環 FIFO を構成する。
        for (let slot = 0; slot < replay.trace.structure.robCapacity - 1; slot++)
            line(lines, robCell(slot, -0.09), robCell(slot + 1, -0.09), session.style.palette.blue, 0.28);
        const wrap = robWrap(-0.09);
        for (let i = 0; i < wrap.length - 1; i++) line(lines, wrap[i], wrap[i + 1], session.style.palette.blue, 0.22);
        for (const id of ["memory-wait"]) {
            if (!scene.nodes.has(id)) continue;
            const n = scene.nodes.get(id)!,
                source: Vector = [n.x, n.h + 0.34, n.z];
            for (let i = 0; i < 80; i++)
                line(
                    lines,
                    wakePath(source, i / 80),
                    wakePath(source, (i + 1) / 80),
                    session.style.palette.memory,
                    0.12
                );
        }
        for (const { color, lanes } of scene.connections) {
            // 配線の本数は各モジュールに表示する並列幅に合わせる。
            // 余分な装飾線は加えず、ポートを実行 pipe に揃える。
            for (const { source, target } of lanes) {
                for (let k = 0; k < 48; k++)
                    line(lines, route(source, target, k / 48), route(source, target, (k + 1) / 48), color, 0.32);
                for (const p of [source, target]) point(stars, p, color, 3, 0.4);
            }
        }
        if (session.style.matte) {
            // 静的な配線・格子・空きスロットは灰色。端子の小さな色印と動的な活動は残す。
            for (let i = 0; i < lines.length; i += 7)
                for (let channel = 0; channel < 3; channel++)
                    lines[i + 3 + channel] = session.style.structure.wire[channel];
        }
        [gpu!.staticTriangles, gpu!.staticLines, gpu!.staticStars, gpu!.staticShadows, gpu!.staticMaterials].forEach(
            gpu!.deleteBuffer
        );
        gpu!.staticTriangles = gpu!.buffer(tris.triangles);
        gpu!.staticMaterials = gpu!.materialBuffer(tris.materials);
        gpu!.staticLines = gpu!.buffer(lines);
        gpu!.staticStars = gpu!.buffer(stars, true);
        gpu!.staticShadows = gpu!.buffer(shadows);
        let ground = null;
        if (session.style.matte) {
            const surfaces: geometry.GroundTriangle[] = [];
            // 卓上の巨大な二枚は無限平面として扱う。溝は表示用の三角形をそのまま使う。
            for (let i = 42; i < tris.triangles.length; i += 21)
                surfaces.push(
                    [0, 7, 14].map((k) => tris.triangles.slice(i + k, i + k + 3) as Vector) as geometry.GroundTriangle
                );
            for (let i = 0; i < tris.materials.length; i += 12) {
                const m = tris.materials.slice(i, i + 12);
                for (let j = 0; j < gpu!.roundedGeometry.length; j += 18) {
                    if (gpu!.roundedGeometry[j + 4] + gpu!.roundedGeometry[j + 10] + gpu!.roundedGeometry[j + 16] <= 0)
                        continue;
                    surfaces.push(
                        [0, 6, 12].map(
                            (k) =>
                                [0, 1, 2].map(
                                    (a) =>
                                        m[a] +
                                        gpu!.roundedGeometry[j + k + a] * (m[3 + a] - m[10]) +
                                        gpu!.roundedGeometry[j + k + 3 + a] * m[10]
                                ) as Vector
                        ) as geometry.GroundTriangle
                    );
                }
            }
            ground = createGround(surfaces, baseLevels.table);
        }
        $("labels").replaceChildren();
        let number = 0;
        for (const n of scene.nodes.values()) {
            const el = document.createElement("div");
            el.className = `stage-label${n.id.startsWith("front") ? " front-label" : ""}${n.id.startsWith("exec") ? " execution-label" : ""}`;
            if (["exec-load", "exec-store", "memory-wait"].includes(n.id)) el.classList.add("memory-label");
            el.style.setProperty("--stage-color", rgb(n.color));
            const index = document.createElement("span");
            index.className = "stage-index";
            index.textContent = String(++number).padStart(2, "0");
            const label = document.createElement("strong");
            label.textContent = n.label;
            el.dataset.compactLabel = "";
            label.dataset.label =
                ({ "register-read": "REG FILE", rob: "ROB", "memory-wait": "MEM WAIT" } as Record<string, string>)[
                    n.id
                ] ?? n.label;
            if (n.id === "register-read" && !replay.trace.evidence?.registers) label.dataset.label = "REG READ";
            const detail = document.createElement("small");
            detail.textContent = n.id.startsWith("front") && !n.mapWords ? "" : n.detail;
            if (n.mapWords!) {
                el.classList.add("rename-label");
                el.title =
                    replay.trace.evidence!.registers!.kind === "configuration"
                        ? "Rename table is present; mappings were not recorded in this trace. All entries remain unobserved."
                        : "Rename map: one bar per logical register, perpendicular to instruction flow. Blue writes a new mapping; red restores an older mapping.";
            }
            if (n.id === "commit")
                el.title = "One slot per instruction in this cycle's in-order commit group. Unused slots stay dark.";
            el.append(index, label, detail);
            if (n.id === "register-read" && replay.trace.evidence?.registers) {
                const allocation = document.createElement("div");
                allocation.id = "register-allocation";
                allocation.className = "register-allocation";
                allocation.title =
                    replay.trace.evidence!.registers!.allocation?.label ??
                    "Allocation state not recorded in this trace.";
                for (const state of ["allocated", "free", "unknown"]) {
                    const item = document.createElement("span");
                    item.dataset.state = state;
                    item.append(document.createElement("i"), document.createElement("b"));
                    allocation.append(item);
                }
                el.append(allocation);
                if (replay.trace.evidence!.registers!.allocation?.kind === "inferred")
                    detail.textContent = `${replay.registerTags.length} OBSERVED · RELEASE ≈`;
            }
            $("labels").append(el);
            n.element = el;
        }
        worldSignature = signature;
        worldGround = ground;
        worldBuilds++;
        return ground;
    }
    return Object.assign(scene, {
        executionLane,
        nodePort,
        matrixPosition,
        crossesDependencyGrid,
        crossesMapWords,
        renameNode,
        renameInstructionPosition,
        frontInstructionPosition,
        inputPosition,
        layoutBounds,
        renameWordLayout,
        physicalColumns,
        physicalTagPosition,
        registerReadPort,
        memoryWaitPosition,
        robCell,
        robMarker,
        commitSlot,
        wakeBusEntry,
        wakeColumnHead,
        issueRowExit,
        issuePath,
        wakePath,
        buildLayout,
        buildWorld,
        worldBuildCount: () => worldBuilds,
        vertex,
        line,
        point,
        beveledBlock,
        flatQuad,
        contactShadow,
        ring,
        box,
        pipeCollar
    });
}
const sceneModule = { createScene, styles };
namespace sceneModule {
    export type Scene = ReturnType<typeof createScene>;
    export type Node = SceneNode;
    export type Style = SceneStyle;
    export type StyleKey = keyof typeof styles;
    export type Bound = BoundKey;
}
declare global {
    var sonataStyles: typeof styles;
}
export = sceneModule;

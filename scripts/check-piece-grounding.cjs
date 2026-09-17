"use strict";
const assert = require("node:assert/strict");
const {
    createGround,
    createPaths,
    lowerAt,
    support,
    paperBoxHalfExtent,
    metalPuck,
    metalPuckPlanes
} = require("../src/geometry.cts");
const identity = [0, 0, 0, 1],
    near = (a, b, message, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${message}: ${a} / ${b}`);
const plane = (height, x0 = -3, x1 = 3) => [
    [
        [x0, height, -3],
        [x1, height, -3],
        [x1, height, 3]
    ],
    [
        [x0, height, -3],
        [x1, height, 3],
        [x0, height, 3]
    ]
];
const ground = createGround(plane(0.4), -0.8);
const paper = "paper-box",
    half = 1 / Math.sqrt(3);
// 既定形状の紙箱は、平らな底面と回した角を実寸法で接地させる。
const a = ground.seat([0.3, 7, 0.2], 0.2, identity),
    b = ground.seat([0.3, -7, 0.2], 0.2, identity);
near(a.position[1], 0.4 + half * 0.2, "Default paper box is not seated");
assert.deepEqual(a, b, "Contact depends on original hovering height");
near(a.position[0], 0.3, "Grounding changed horizontal travel");
near(a.position[2], 0.2, "Grounding changed lane");
const quarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    eighth = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
near(ground.seat([0, 0, 0], 0.2, quarter).position[1], 0.4 + half * 0.2, "Quarter-turn changed paper box height");
near(
    ground.seat([0, 0, 0], 0.2, eighth).position[1],
    0.4 + 0.2 * half * Math.SQRT2,
    "Rotating paper box clips its corners"
);
// 傾斜面は鉛直方向の半径を足すだけでは貫通する。面の法線に沿って接する必要がある。
const slope = createGround(
    [
        [
            [-3, -1.5, -3],
            [3, 1.5, -3],
            [3, 1.5, 3]
        ],
        [
            [-3, -1.5, -3],
            [3, 1.5, 3],
            [-3, -1.5, 3]
        ]
    ],
    -5
);
near(
    slope.seat([0, 10, 0], 0.2, identity, "sphere").position[1],
    0.2 * Math.sqrt(1.25),
    "Sphere penetrates sloped trough"
);
// 台の外へ出ると縁を支点に下がり、離れた後は下の面へ接する。
const edge = createGround(plane(0.4, -3, 0), 0);
near(
    edge.seat([0.12, 8, 0], 0.2, identity, "sphere").position[1],
    0.4 + Math.sqrt(0.2 ** 2 - 0.12 ** 2),
    "Sphere floats at a ledge",
    2e-6
);
near(edge.seat([0.21, 8, 0], 0.2, identity, "sphere").position[1], 0.2, "Sphere did not reach the lower surface");
// 三角形の順序、以前のシーク、半径・姿勢の変更は同じ条件での接地点を変えない。
const before = edge.seat([-0.1, 3, 0.17], 0.136, eighth);
edge.seat([2, 3, 1], 0.06, quarter);
assert.deepEqual(edge.seat([-0.1, 3, 0.17], 0.136, eighth), before);
near(
    createGround(plane(0.4, -3, 0).reverse(), 0).seat([-0.1, 3, 0.17], 0.136, eighth).position[1],
    before.position[1],
    "Triangle order changed the height"
);
// 紙箱の6面は各軸の ±1/√3。8頂点を外接半径1の球内へ収める。
assert.equal(paperBoxHalfExtent, half, "Paper box dimensions changed");
for (const axis of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
]) {
    const vertex = support(axis, paper);
    near(
        vertex.reduce((sum, v, i) => sum + v * axis[i], 0),
        half,
        "Paper box lost a supporting face"
    );
}
for (const x of [-1, 1])
    for (const y of [-1, 1])
        for (const z of [-1, 1]) {
            const corner = support([x, y, z], paper);
            for (const [i, sign] of [x, y, z].entries()) near(corner[i], sign * half, "Paper box corner changed");
            near(Math.hypot(...corner), 1, "Paper box exceeds the shared radius");
        }
near(lowerAt(0.5, 0.5, identity, paper), -half, "Paper box bottom is not a flat face");
near(lowerAt(half, half, identity, paper), -half, "Paper box corner was lost");
assert.equal(lowerAt(half + 1e-6, 0, identity, paper), null, "A point beyond the box was accepted as contact");
// 角の接点を世界座標へ移して戻しても、丸め誤差だけで面の外側とは判定しない。
const cornerSeat = createGround(plane(0.6, 8, 12)).seat([9.655, 5, 1.0119565217391302], 0.12, identity, paper);
const cornerLower = lowerAt(
    (cornerSeat.contact[0] - cornerSeat.position[0]) / 0.12,
    (cornerSeat.contact[2] - cornerSeat.position[2]) / 0.12,
    identity,
    paper
);
assert.notEqual(cornerLower, null, "Rounding placed a paper box corner outside its outline");
near(cornerSeat.position[1] + cornerLower * 0.12, cornerSeat.contact[1], "Paper box corner lost contact", 1e-12);
const seatedPaper = ground.seat([0.3, 7, 0.2], 0.2, identity, paper);
near(seatedPaper.position[1], 0.4 + half * 0.2, "Paper box bottom does not touch the surface");
assert.deepEqual(seatedPaper, ground.seat([0.3, -7, 0.2], 0.2, identity, paper));
near(seatedPaper.position[0], 0.3, "Paper grounding changed horizontal travel");
near(seatedPaper.position[2], 0.2, "Paper grounding changed lane");
near(slope.seat([0, 10, 0], 0.2, identity, paper).position[1], 0.2 * half * 1.5, "Paper box penetrates the slope");
// 底面が台に重なる間はその高さを保ち、全体が縁から出ると下の面へ降りる。
near(edge.seat([0.1, 8, 0], 0.2, identity, paper).position[1], 0.4 + half * 0.2, "Paper box left its ledge early");
near(
    edge.seat([0.12, 8, 0], 0.2, identity, paper).position[1],
    half * 0.2,
    "Paper box did not reach the lower surface"
);
const paperBefore = edge.seat([-0.1, 3, 0.17], 0.136, identity, paper);
edge.seat([2, 3, 1], 0.06, quarter);
assert.deepEqual(edge.seat([-0.1, 3, 0.17], 0.136, identity, paper), paperBefore);
near(
    createGround(plane(0.4, -3, 0).reverse(), 0).seat([-0.1, 3, 0.17], 0.136, identity, paper).position[1],
    paperBefore.position[1],
    "Triangle order changed paper contact"
);

// 金属パックは16角の側面を上下45度で面取りし、平らな底面を保つ。
const puck = "metal-puck",
    sideDistance = 0.94 * Math.cos(Math.PI / 16),
    capRadius = (sideDistance - 0.08) / Math.cos(Math.PI / 16);
assert.deepEqual(metalPuck, { sides: 16, radius: 0.94, halfHeight: 0.32, bevel: 0.08 });
assert.equal(metalPuckPlanes.length, 50, "Puck side, bevel or cap planes are missing");
near(lowerAt(0, 0, identity, puck), -0.32, "Puck bottom is not flat");
near(lowerAt(sideDistance - 0.04, 0, identity, puck), -0.28, "Puck bevel does not slope at 45 degrees");
near(lowerAt(sideDistance, 0, identity, puck), -0.24, "Puck side meets the bevel at the wrong height");
assert.equal(lowerAt(sideDistance + 1e-6, 0, identity, puck), null, "Puck extends beyond its side");
for (let i = 0; i < 16; i++) {
    const angle = ((i + 0.5) * Math.PI * 2) / 16,
        x = Math.cos(angle),
        z = Math.sin(angle);
    for (const y of [-3, 0, 3]) {
        const vertex = support([x, y, z], puck);
        near(Math.hypot(vertex[0], vertex[2]), y === 0 ? 0.94 : capRadius, "Puck rim radius changed");
        near(Math.abs(vertex[1]), y === 0 ? 0.24 : 0.32, "Puck rim height changed");
        assert.ok(Math.hypot(...vertex) < 1, "Puck exceeds the shared bounding sphere");
    }
}
const puckSeat = ground.seat([0.3, 7, 0.2], 0.2, identity, puck);
near(puckSeat.position[1], 0.4 + 0.2 * 0.32, "Puck does not rest on its bottom cap");
assert.deepEqual(puckSeat, ground.seat([0.3, -7, 0.2], 0.2, identity, puck));
near(
    slope.seat([0, 10, 0], 0.2, identity, puck).position[1],
    0.2 * (0.32 + 0.5 * (sideDistance - 0.08)),
    "Puck penetrates the slope"
);
near(
    edge.seat([0.2 * (sideDistance - 0.04), 8, 0], 0.2, identity, puck).position[1],
    0.4 + 0.2 * 0.28,
    "Puck bevel floats at a ledge",
    2e-6
);
near(
    edge.seat([0.2 * (sideDistance + 1e-4), 8, 0], 0.2, identity, puck).position[1],
    0.2 * 0.32,
    "Puck did not reach the lower surface"
);
const puckCorner = createGround(plane(0.6, 8, 12)).seat([9.655, 5, 1.0119565217391302], 0.12, identity, puck);
const puckLower = lowerAt(
    (puckCorner.contact[0] - puckCorner.position[0]) / 0.12,
    (puckCorner.contact[2] - puckCorner.position[2]) / 0.12,
    identity,
    puck
);
assert.notEqual(puckLower, null, "Rounding placed the puck contact outside its rim");
near(
    puckCorner.position[1] + puckLower * 0.12,
    puckCorner.contact[1],
    "Puck lost contact after coordinate conversion",
    1e-12
);
near(
    createGround(plane(0.4).reverse(), -0.8).seat([0.3, 7, 0.2], 0.2, identity, puck).position[1],
    puckSeat.position[1],
    "Triangle order changed puck contact"
);

// 同時刻と同じ停止位置のキャッシュ、移動両端のキャッシュをスタイル間で混同しない。
const op = {
    id: 1,
    index: 0,
    kind: "integer",
    execution: "integer",
    fetch: 0,
    end: 10,
    stages: [
        { node: "front", start: 0, end: 4 },
        { node: "next", start: 4, end: 10 }
    ]
};
const palette = { integer: [0.2, 0.8, 0.6] };
const styles = {
    [paper]: { palette, surface: { paper: true } },
    [puck]: { palette, surface: { aluminum: true } }
};
const heights = { [paper]: half, [puck]: 0.32 };
const session = { style: styles[paper], reducedMotion: true };
const paths = createPaths({
    session,
    replay: { ops: [op], trace: { firstCycle: 0, fetchWidth: 2 }, frontend: { stages: new Map() } },
    scene: {
        nodes: new Map(["front", "next"].map((id, i) => [id, { id, x: i * 2, h: 1, z: 0, w: 1, d: 1 }])),
        commitSlot: () => ({ inlet: [3, 1, 0], outlet: [4, 1, 0] }),
        inputPosition: () => [-15.6, 0.8, 0]
    }
});
paths.setGround(ground);
for (const time of [2, 2.1, 4.3, 4.4]) {
    let referencePiece;
    for (const shape of [paper, puck, paper, puck]) {
        session.style = styles[shape];
        const piece = paths.groundedPiece(op, time);
        near(piece.position[1], 0.4 + 0.12 * heights[shape], "Cached pose used another shape");
        assert.equal(piece.radius, 0.12);
        near(piece.position[0], piece.pathPosition[0], "Changing shape changed horizontal travel");
        near(piece.position[2], piece.pathPosition[2], "Changing shape changed lane");
        if (!referencePiece) referencePiece = piece;
        else {
            assert.deepEqual(piece.rotation, referencePiece.rotation, "Changing shape changed orientation");
            assert.deepEqual(piece.transfer, referencePiece.transfer, "Changing shape changed transfer timing or path");
        }
        if (time >= 4) assert.ok(piece.transfer, "Transfer cache was not exercised");
    }
}
session.reducedMotion = false;
// 紙箱と金属パックは移動・待機・COMMIT・squash後も、演出設定にかかわらず正立のまま滑る。
const squashed = { ...op, id: 2, flush: true };
for (const shape of [paper, puck]) {
    session.style = styles[shape];
    const initial = paths.groundedPiece(op, 2);
    assert.deepEqual(initial.rotation, identity, `${shape}: changed the upright orientation`);
    for (const current of [op, squashed]) {
        const times = [0.2, 2, 4.3, 6, 10.2, 10.7, 11.2];
        const snapshots = times.map((time) => paths.groundedPiece(current, time));
        assert.notDeepEqual(snapshots[0].position, snapshots[1].position, `${shape}: movement was not exercised`);
        assert.notDeepEqual(snapshots[4].position, snapshots[6].position, `${shape}: exit was not exercised`);
        for (const reducedMotion of [true, false]) {
            session.reducedMotion = reducedMotion;
            for (const [index, time] of times.entries()) {
                const piece = paths.groundedPiece(current, time);
                assert.deepEqual(piece.rotation, identity, `${shape}: rotates while sliding`);
                assert.equal(piece.radius, 0.12);
                assert.deepEqual(
                    piece.pathPosition,
                    paths.positionAt(current, time),
                    `${shape}: changed the timed path`
                );
                assert.deepEqual(
                    paths.instructionColor(current, time),
                    palette.integer,
                    `${shape}: changed the instruction color`
                );
                near(piece.position[0], piece.pathPosition[0], `${shape}: changed horizontal travel`);
                near(piece.position[2], piece.pathPosition[2], `${shape}: changed lane`);
                assert.deepEqual(piece, snapshots[index], `${shape}: motion effects changed the sliding pose`);
            }
        }
        for (const time of times.toReversed())
            assert.deepEqual(
                paths.groundedPiece(current, time),
                snapshots[times.indexOf(time)],
                `${shape}: reverse seek changed the pose`
            );
    }
    for (let time = 2.01; time < 3; time += 0.02) paths.groundedPiece(op, time);
    assert.deepEqual(paths.groundedPiece(op, 2), initial, `${shape}: cache eviction changed the pose`);
    paths.setGround(ground);
    assert.deepEqual(paths.groundedPiece(structuredClone(op), 2), initial, `${shape}: reloading changed the pose`);
}
console.log(
    "Piece grounding: paper box, beveled metal puck and clearance sphere; slopes; ledges; fixed sliding; shape caches; deterministic seeks"
);

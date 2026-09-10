"use strict";
const assert = require("node:assert/strict");
const { createRollingTrack } = require("../src/geometry.cts");
const near = (a, b, message) => assert.ok(Math.hypot(...a.map((v, i) => v - b[i])) < 1e-9, message);
const turn = (q, v) => {
    const [x, y, z, w] = q,
        [a, b, c] = v;
    const t = [2 * (y * c - z * b), 2 * (z * a - x * c), 2 * (x * b - y * a)];
    return [a + w * t[0] + y * t[2] - z * t[1], b + w * t[1] + z * t[0] - x * t[2], c + w * t[2] + x * t[1] - y * t[0]];
};
const quarter = Math.PI / 2;
// 単位半径の駒が 1/4 周ぶん進むと、上の印が進行方向の正面へ来る。
for (const direction of [
    [1, 0, 0],
    [0, 0, 1],
    [-1, 0, 0],
    [0, 0, -1]
]) {
    const track = createRollingTrack((t) => direction.map((v) => v * t), [0, Math.PI], { distancePerRadian: 1 });
    near(turn(track.rotationAt(quarter), [0, 1, 0]), direction, "Piece rolls against the travel direction");
}
// 待機では静止し、同じ道を逆へ戻れば元の向きへ戻る。
const back = createRollingTrack((t) => [quarter * (t < 1 ? t : t < 3 ? 1 : 4 - t), 0, 0], [0, 1, 3, 4], {
    distancePerRadian: 1
});
near(back.rotationAt(1.2), back.rotationAt(2.8), "Waiting piece kept rotating");
near(turn(back.rotationAt(4), [0, 1, 0]), [0, 1, 0], "Returning piece did not undo its rotation");
// 曲がり角では回転軸が変わり、以前の姿勢から続けて回る。
const corner = createRollingTrack((t) => [quarter * Math.min(t, 1), 0, quarter * Math.max(t - 1, 0)], [0, 1, 2], {
    distancePerRadian: 1
});
near(turn(corner.rotationAt(2), [0, 0, 1]), [0, -1, 0], "Corner reset the previous orientation");
const lift = createRollingTrack((t) => [0, t, 0], [0, 4]);
near(lift.rotationAt(2), [0, 0, 0, 1], "Vertical lift introduced horizontal rolling");
// 途中への直接シーク、細かい通常再生、逆順の呼び出しで同じ姿勢を再現する。
const path = (t) => [Math.cos(t * 2), t * 0.2, Math.sin(t * 2)];
const curve = createRollingTrack(path, [0, 0.5, 1, 1.5, 2]);
const direct = curve.rotationAt(0.731);
for (let t = 0; t < 2; t += 1 / 120) curve.rotationAt(t);
for (let t = 2; t > 0; t -= 1 / 15) curve.rotationAt(t);
assert.deepEqual(curve.rotationAt(0.731), direct, "Rolling depends on seek direction or frame rate");
const fresh = createRollingTrack(path, [0, 0.5, 1, 1.5, 2]);
assert.deepEqual(fresh.rotationAt(0.731), direct, "A freshly loaded path has a different orientation");
for (let t = 0; t <= 2; t += 0.031)
    assert.ok(Math.abs(Math.hypot(...curve.rotationAt(t)) - 1) < 1e-12, "Rotation lost normalization");
const modified = curve.rotationAt(0.5);
modified.fill(0);
assert.ok(Math.hypot(...curve.rotationAt(0.5)) > 0.999, "Reading orientation exposed mutable cached data");
console.log(
    "Piece rolling: direction; distance; corners; waiting; reversal; deterministic seeks; normalized rotations"
);

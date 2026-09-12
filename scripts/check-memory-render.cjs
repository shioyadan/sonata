"use strict";
// 書込みの記録は命令詳細で確認し、実行待機とコミット後の状態を混同しない。
const assert = require("node:assert/strict");
const fs = require("node:fs"),
    path = require("node:path");
const { createBrowserTest, waitFor } = require("./load-test.cjs")("browser-test.cts");
module.exports = async function reviewMemory(window, screenshots) {
    const { evaluate, sampleFrame, settle } = createBrowserTest(window);
    const results = [];
    await evaluate(({ sonata, $ }) => {
        sonata.setPlaying(false);
        sonata.setCamera("orbit");
        if ($("auto-camera").getAttribute("aria-pressed") === "true") $("auto-camera").click();
    });
    await waitFor(
        () =>
            evaluate(({ sonata }) => {
                const camera = sonata.camera;
                return (
                    Math.abs(camera.radius - camera.targetRadius) < 0.001 &&
                    Math.abs(camera.elevation - camera.targetElevation) < 0.001 &&
                    Math.abs(camera.azimuth - camera.targetAzimuth) < 0.001
                );
            }),
        "Memory review camera did not settle",
        { timeout: 30000 }
    );

    async function pinInstruction(id, cycle) {
        const pick = await sampleFrame(() =>
            evaluate(
                ({ sonata, $ }, id, cycle) => {
                    sonata.captureAt(cycle);
                    const particle = sonata.particles.find((p) => p.id === id);
                    if (!particle) throw new Error("Instruction is not visible for picking: " + id);
                    const rect = $("scene").getBoundingClientRect();
                    return { x: Math.round(rect.x + particle.screen[0]), y: Math.round(rect.y + particle.screen[1]) };
                },
                id,
                cycle
            )
        );
        window.webContents.sendInputEvent({ type: "mouseDown", ...pick, button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", ...pick, button: "left", clickCount: 1 });
        await waitFor(
            () => evaluate(({ sonata }, id) => sonata.selectedID === id, id),
            `Could not pin memory review instruction #${id}`,
            { diagnostics: () => evaluate(({ sonata }) => ({ selected: sonata.selectedID, cycle: sonata.cycle })) }
        );
    }

    for (const key of ["branch-storm", "rename-rush", "x86-recovery"]) {
        const selected = await sampleFrame(() =>
            evaluate(({ sonata, $ }, key) => {
                sonata.loadTrace(key);
                $("style-aluminum").click();
                const record = sonata.trace.storeCompletions.find(([id, end]) => {
                    const op = sonata.ops.find((op) => op.id === id);
                    return (
                        op && op.end >= sonata.trace.firstCycle && end > op.end + 2.1 && end < sonata.trace.lastCycle
                    );
                });
                if (!record) throw new Error("No recorded pending store in " + key);
                const op = sonata.ops.find((op) => op.id === record[0]);
                const stage = op.stages.find((s) => s.node === "exec-store");
                return {
                    id: op.id,
                    start: op.end,
                    end: record[1],
                    pickCycle: Math.max(sonata.trace.firstCycle, stage.start + (stage.end - stage.start) * 0.65),
                    minimum: sonata.memoryTiming.minimum
                };
            }, key)
        );
        await pinInstruction(selected.id, selected.pickCycle);
        const times = [
            selected.start - 0.001,
            selected.start,
            selected.start + 2.1,
            selected.end - 0.001,
            selected.end,
            selected.start + 2.1,
            selected.start - 0.001
        ];
        const states = [];
        for (const cycle of times) {
            states.push(
                await sampleFrame(() =>
                    evaluate(
                        ({ sonata, gl, $ }, cycle, id) => {
                            sonata.captureAt(cycle);
                            return {
                                pending: sonata.pendingStores.find((s) => s.id === id) ?? null,
                                inRob: sonata.rob.entries.some((e) => e.id === id),
                                piece: sonata.pieces.some((p) => p.id === id),
                                detail: {
                                    id: $("op-id").textContent,
                                    hidden: $("op-write").hidden,
                                    text: $("op-write").textContent
                                },
                                error: gl.getError()
                            };
                        },
                        cycle,
                        selected.id
                    )
                )
            );
        }
        assert.equal(states[0].pending, null, "Store write anticipated commit");
        assert.equal(states[0].inRob, true);
        assert.equal(states[0].detail.text, "WRITE · AWAITING COMMIT", "Write details anticipated commit");
        assert.deepEqual(states[1].pending, { id: selected.id, start: selected.start, end: selected.end });
        assert.equal(states[1].inRob, false, "Pending write retained a retired ROB entry");
        for (const state of states.slice(1, 4)) assert.equal(state.detail.text, "WRITE · PENDING");
        assert.ok(states[2].pending, "Instruction departure removed an outstanding write record");
        assert.equal(states[2].piece, false, "Outstanding write duplicated the retired instruction");
        assert.equal(states[4].pending, null, "Completed write remained pending");
        assert.equal(
            states[4].detail.text,
            `WRITE · COMPLETE @ ${selected.end}`,
            "Completion timestamp was lost or rounded"
        );
        assert.deepEqual(states[5], states[2], "Seeking changed pending write state");
        assert.deepEqual(states[6], states[0], "Rewinding retained a future commit or completion");
        assert.ok(states.every((s) => s.detail.id === `#${selected.id}` && !s.detail.hidden && s.error === 0));
        await settle({ finish: true });
        fs.writeFileSync(path.join(screenshots, `memory-${key}.png`), (await window.webContents.capturePage()).toPNG());
        results.push({ key, ...selected });
    }

    const waiting = await sampleFrame(() =>
        evaluate(({ sonata, gl }) => {
            sonata.loadTrace("memory-tide");
            const draw = gl.drawArraysInstanced,
                batches = [];
            // ROB の診断座標だけでなく、駒と影の描画に渡したインスタンス座標も照合する。
            gl.drawArraysInstanced = function (mode, first, vertices, count) {
                if (vertices === 6 && count > 0 && gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_DIVISOR) === 1) {
                    const binding = gl.getParameter(gl.ARRAY_BUFFER_BINDING),
                        buffer = gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
                        data = new Float32Array(count * 12);
                    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data);
                    gl.bindBuffer(gl.ARRAY_BUFFER, binding);
                    batches.push(data);
                }
                return draw.call(this, mode, first, vertices, count);
            };
            try {
                sonata.captureAt(3970.9);
            } finally {
                gl.drawArraysInstanced = draw;
            }
            if (sonata.pendingStores.length) throw new Error("Unrecorded RSD store writes were invented");
            if (sonata.connections.some((c) => [c.from, c.to].includes("store-wait")))
                throw new Error("An independent STORE WAIT connection remains");
            const pieces = sonata.pieces;
            return sonata.ops
                .filter(
                    (op) =>
                        op.memoryKind === "store" &&
                        (op.completion === null || op.completion > sonata.cycle) &&
                        op.stages.some((s) => s.node === "rob" && s.start <= sonata.cycle && s.end > sonata.cycle)
                )
                .map((op) => {
                    const index = pieces.findIndex((p) => p.id === op.id),
                        particle = sonata.particles.find((p) => p.id === op.id);
                    return {
                        id: op.id,
                        piece: pieces[index],
                        entry: sonata.rob.entries.find((e) => e.id === op.id),
                        cell: sonata.instructionLayout.rob[op.robSlot],
                        light: particle && { state: particle.state, brightness: particle.brightness },
                        gpuPositions: batches.map((batch) => [...batch.slice(index * 12, index * 12 + 3)]),
                        error: gl.getError()
                    };
                });
        })
    );
    assert.deepEqual(
        waiting.map((s) => s.id),
        [4318, 4323, 4328, 4333, 4338, 4343]
    );
    assert.deepEqual(
        waiting.map((s) => s.entry?.slot),
        [14, 19, 24, 29, 34, 39]
    );
    for (const [index, store] of waiting.entries()) {
        assert.ok(store.piece?.contact, `Waiting STORE #${store.id} is not grounded`);
        assert.equal(store.piece.transfer, null, `Waiting STORE #${store.id} is still moving`);
        assert.deepEqual(store.piece.pathPosition, store.cell, `Waiting STORE #${store.id} did not enter its ROB cell`);
        assert.equal(store.piece.position[0], store.cell[0]);
        assert.equal(store.piece.position[2], store.cell[2]);
        assert.equal(store.entry.ready, false, `Waiting STORE #${store.id} became ready early`);
        assert.ok(store.light?.state === "waiting" && store.light.brightness < 0.35);
        assert.ok(store.gpuPositions.length > 0, `Waiting STORE #${store.id} was not drawn`);
        for (const position of store.gpuPositions)
            assert.ok(
                position.every((v, i) => Math.abs(v - store.piece.position[i]) < 2e-6),
                `Rendered STORE #${store.id} is outside its ROB cell`
            );
        assert.equal(store.error, 0);
        for (const other of waiting.slice(index + 1)) {
            assert.ok(other.piece, `Waiting STORE #${other.id} is missing`);
            assert.ok(
                Math.hypot(...store.piece.position.map((v, i) => v - other.piece.position[i])) >=
                    store.piece.radius + other.piece.radius,
                `Waiting STORE #${store.id} overlaps #${other.id}`
            );
        }
    }
    // #4318 の初回移動は表示範囲より前。範囲内で移動する #4333 で STORE → ROB を検査する。
    const arrival = await sampleFrame(() =>
        evaluate(({ sonata }) => {
            sonata.captureAt(3965.4);
            return { cycle: sonata.cycle, piece: sonata.pieces.find((p) => p.id === 4333) };
        })
    );
    assert.equal(arrival.cycle, 3965.4);
    assert.ok(arrival.piece?.transfer, "STORE-to-ROB transfer was not rendered");
    const retryTimes = [3964, 3970.9, 3981, 3983, 3985.9, 3986, 3986.9];
    const retryStates = [];
    for (const cycle of [...retryTimes, ...retryTimes.toReversed()]) {
        retryStates.push(
            await sampleFrame(() =>
                evaluate(({ sonata, gl }, cycle) => {
                    sonata.captureAt(cycle);
                    const op = sonata.ops.find((o) => o.id === 4318),
                        particle = sonata.particles.find((p) => p.id === op.id);
                    return {
                        cycle: sonata.cycle,
                        stage: op.stages.find((s) => s.start <= cycle && s.end > cycle).node,
                        piece: sonata.pieces.find((p) => p.id === op.id),
                        state: particle?.state,
                        rob: sonata.rob,
                        error: gl.getError()
                    };
                }, cycle)
            )
        );
    }
    const forward = retryStates.slice(0, retryTimes.length);
    assert.deepEqual(
        forward.map((s) => s.cycle),
        retryTimes,
        "STORE retry samples left the visible trace range"
    );
    assert.deepEqual(
        retryStates.slice(retryTimes.length).toReversed(),
        forward,
        "Reverse seek changed STORE retry rendering"
    );
    assert.deepEqual(
        forward.map((s) => s.stage),
        ["rob", "rob", "register-read", "exec-store", "exec-store", "rob", "rob"]
    );
    assert.equal(forward[1].state, "waiting");
    assert.equal(forward[2].state, "reading");
    assert.equal(forward[3].state, "executing");
    assert.equal(forward[5].state, "ready");
    assert.equal(forward[6].piece.transfer, null);
    assert.deepEqual(
        forward[6].piece.position,
        forward[1].piece.position,
        "Retried STORE returned to another ROB cell"
    );
    for (const state of forward) {
        const entry = state.rob.entries.find((e) => e.id === 4318);
        assert.equal(entry?.slot, 14, "A retry changed the allocated ROB slot");
        assert.equal(entry.ready, state.cycle >= 3986, "A retry anticipated STORE completion");
        assert.equal(state.error, 0);
    }
    results.push({ key: "memory-tide", waits: waiting.map(({ id, entry }) => ({ id, ...entry })), retryTimes });
    await pinInstruction(waiting[0].id, 3970.9);
    const unknown = await sampleFrame(() =>
        evaluate(({ sonata, $ }) => {
            sonata.captureAt(3970.9);
            return { stage: $("op-stage").textContent, hidden: $("op-write").hidden, text: $("op-write").textContent };
        })
    );
    assert.deepEqual(unknown, { stage: "REORDER BUFFER", hidden: false, text: "WRITE COMPLETION · NOT LOGGED" });
    await settle({ finish: true });
    fs.writeFileSync(
        path.join(screenshots, "memory-tide-store-rob.png"),
        (await window.webContents.capturePage()).toPNG()
    );

    const other = await evaluate(({ sonata }) => {
        const op = sonata.ops.find((op) => op.kind === "integer" && op.fetch <= sonata.cycle && op.end > sonata.cycle);
        const stage = op.stages.find((s) => s.node === "exec-integer");
        return { id: op.id, cycle: stage.start + (stage.end - stage.start) * 0.65 };
    });
    await pinInstruction(other.id, other.cycle);
    const cleared = await sampleFrame(() =>
        evaluate(({ sonata, $ }) => {
            sonata.captureAt(sonata.cycle);
            const hidden = $("op-write").hidden && $("op-write").textContent === "";
            $("unpin").click();
            sonata.captureAt(sonata.cycle);
            const displayed = sonata.ops.find((op) => `#${op.id}` === $("op-id").textContent);
            return {
                hidden,
                unpinned: sonata.selectedID === null,
                current: $("op-write").hidden === (displayed?.memoryKind !== "store")
            };
        })
    );
    assert.deepEqual(
        cleared,
        { hidden: true, unpinned: true, current: true },
        "Instruction selection retained old store details"
    );
    return results;
};

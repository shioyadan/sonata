"use strict";
// FileセッションとWorkerの検査で使う、入力・応答の制御と小さな記録fixture。
function overviewTotals(overview) {
    return overview.bins.reduce(
        (sum, bin) => ({
            fetched: sum.fetched + bin.fetched,
            committed: sum.committed + bin.committed,
            flushed: sum.flushed + bin.flushed
        }),
        { fetched: 0, committed: 0, flushed: 0 }
    );
}
function overviewBin(overview, cycle) {
    return overview.bins[Math.floor((cycle - overview.firstCycle) / overview.binWidth)];
}

// EOFをテスト側で保持する。タイミングの速さではなく、閉じていない入力への応答を検査する。
function controlledInput(first, name = "stream.kanata") {
    const controllers = new Set();
    let canceled = 0,
        streams = 0,
        finished = false;
    return {
        name,
        size: first.length * 2,
        type: "",
        stream() {
            streams++;
            let current;
            return new ReadableStream({
                start(controller) {
                    current = controller;
                    controllers.add(controller);
                    controller.enqueue(new TextEncoder().encode(first));
                },
                cancel() {
                    canceled++;
                    controllers.delete(current);
                }
            });
        },
        append(text) {
            for (const controller of controllers) controller.enqueue(new TextEncoder().encode(text));
        },
        finish() {
            finished = true;
            for (const controller of controllers) controller.close();
            controllers.clear();
        },
        get finished() {
            return finished;
        },
        get canceled() {
            return canceled;
        },
        get streams() {
            return streams;
        }
    };
}
function mailbox() {
    const messages = [],
        waiting = new Set();
    return {
        messages,
        send(message) {
            messages.push(message);
            for (const waiter of waiting) if (waiter.predicate(message)) waiter.resolve(message);
        },
        wait(predicate) {
            const previous = messages.find(predicate);
            if (previous) return Promise.resolve(previous);
            return new Promise((resolve, reject) => {
                const waiter = {
                    predicate,
                    resolve(message) {
                        clearTimeout(timer);
                        waiting.delete(waiter);
                        resolve(message);
                    }
                };
                const timer = setTimeout(() => {
                    waiting.delete(waiter);
                    reject(new Error(`No matching trace response: ${JSON.stringify(messages.map((m) => m.type))}`));
                }, 5000);
                waiting.add(waiter);
            });
        }
    };
}
function kanataOp(id, end = true) {
    return (
        `I\t${id}\t${id}\t0\nL\t${id}\t0\tadd x1, x2\nS\t${id}\t0\tF\nC\t1\nE\t${id}\t0\tF\nS\t${id}\t0\tX\nC\t1\n` +
        (end ? `R\t${id}\t${id}\t0\n` : "")
    );
}
const request = (id, cycle = 0) => ({ type: "window", request: id, cycle, span: 16, thread: 0 });

module.exports = { overviewTotals, overviewBin, controlledInput, mailbox, kanataOp, request };

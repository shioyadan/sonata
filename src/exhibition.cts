"use strict";

// 展示の時計は可視フレームからだけ進め、非表示タブ用のタイマーを持たない。
type ExhibitionPhase = "off" | "transition" | "loading" | "playing" | "exploring" | "waiting";
interface ExhibitionSnapshot {
    readonly active: boolean;
    readonly phase: ExhibitionPhase;
    readonly key: string | null;
    readonly idleRemaining: number;
    readonly error: string | null;
}
interface Options {
    keys: readonly string[];
    load(key: string): Promise<boolean>;
    cancelLoad(): void;
    present(): void;
    changed(state: ExhibitionSnapshot): void;
}

function createExhibition(options: Options) {
    const keys = [...new Set(options.keys)];
    const failed = new Set<string>();
    let phase: ExhibitionPhase = "off";
    let index = -1;
    let remaining = 0;
    let error: string | null = null;
    let revision = 0;

    function snapshot(): ExhibitionSnapshot {
        return {
            active: phase !== "off",
            phase,
            key: keys[index] ?? null,
            idleRemaining: phase === "exploring" ? remaining : 0,
            error
        };
    }
    function changed() {
        options.changed(snapshot());
    }
    function invalidate() {
        revision++;
        // Promiseの失効とは別に、Workerや通信を呼び出し元で解放する。
        if (phase === "loading") options.cancelLoad();
    }
    function transition(next: number) {
        invalidate();
        index = next;
        phase = "transition";
        remaining = 0.4;
        error = null;
        changed();
    }
    function failedLoad(message: string) {
        failed.add(keys[index]);
        phase = "waiting";
        remaining = failed.size === keys.length ? 30 : 2;
        error = message;
        changed();
    }
    function nextIndex() {
        let next = (index + 1) % keys.length;
        for (let skipped = 0; skipped < keys.length && failed.has(keys[next]); skipped++) {
            next = (next + 1) % keys.length;
        }
        return next;
    }
    async function load() {
        phase = "loading";
        remaining = 30;
        const request = revision;
        changed();
        if (request !== revision || phase !== "loading") return;
        try {
            const loaded = await options.load(keys[index]);
            if (request !== revision || phase !== "loading") return;
            if (!loaded) {
                failedLoad("The sample could not be loaded. Retrying another sample.");
                return;
            }
            failed.clear();
            phase = "playing";
            remaining = 0;
            error = null;
            options.present();
            if (request === revision && phase === "playing") changed();
        } catch (cause) {
            if (request !== revision || (phase !== "loading" && phase !== "playing")) return;
            const message = cause instanceof Error ? cause.message : String(cause);
            failedLoad(message || "The sample could not be loaded.");
        }
    }
    function start(key?: string) {
        if (!keys.length) return;
        failed.clear();
        const requested = key === undefined ? index : keys.indexOf(key);
        transition(requested < 0 ? 0 : requested);
    }
    function stop() {
        if (phase === "off") return;
        invalidate();
        phase = "off";
        remaining = 0;
        error = null;
        failed.clear();
        changed();
    }
    function interact(key?: string) {
        if (phase === "off") return;
        const current = key === undefined ? -1 : keys.indexOf(key);
        const notify = phase !== "exploring" || Math.ceil(remaining) !== 30 || (current >= 0 && current !== index);
        invalidate();
        if (current >= 0) index = current;
        phase = "exploring";
        remaining = 30;
        error = null;
        if (notify) changed();
    }
    function resume(key?: string) {
        if (phase !== "exploring") return;
        const current = key === undefined ? -1 : keys.indexOf(key);
        failed.clear();
        transition(current >= 0 ? current : index);
    }
    function loop() {
        if (phase === "playing") transition(nextIndex());
    }
    function tick(seconds: number, blocked = false) {
        if (phase === "off" || phase === "playing" || !Number.isFinite(seconds) || seconds < 0) return;
        if (phase === "exploring" && blocked) {
            const notify = Math.ceil(remaining) !== 30;
            remaining = 30;
            if (notify) changed();
            return;
        }
        const previousSecond = Math.ceil(remaining);
        remaining = Math.max(0, remaining - seconds);
        if (remaining > 1e-9) {
            if (phase === "exploring" && Math.ceil(remaining) !== previousSecond) changed();
            return;
        }
        if (phase === "exploring") resume();
        else if (phase === "transition") void load();
        else if (phase === "loading") {
            invalidate();
            failedLoad("Loading the sample timed out. Retrying another sample.");
        } else if (phase === "waiting") {
            if (failed.size === keys.length) failed.clear();
            transition(nextIndex());
        }
    }
    return {
        start,
        stop,
        interact,
        resume,
        loop,
        tick,
        snapshot,
        get active() {
            return phase !== "off";
        },
        get phase() {
            return phase;
        },
        get key() {
            return keys[index] ?? null;
        },
        get idleRemaining() {
            return phase === "exploring" ? remaining : 0;
        },
        get error() {
            return error;
        }
    };
}

const exhibition = { createExhibition };
namespace exhibition {
    export type Snapshot = ExhibitionSnapshot;
    export type Phase = ExhibitionPhase;
}
export = exhibition;

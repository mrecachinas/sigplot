/**
 * Main-thread pool manager for SigPlot Web Workers.
 *
 * Dispatches tasks to a pool of workers using round-robin scheduling
 * and falls back to synchronous execution when Workers are unavailable.
 */

export default class WorkerPool {
    private workers: Worker[];
    private nextWorker: number;
    private pending: Map<string, { resolve: Function; reject: Function }>;
    private taskId: number;
    private fallbackFns: Record<string, Function> | null;

    constructor(options?: { poolSize?: number; workerUrl?: string | URL; fallback?: boolean }) {
        const opts = options ?? {};
        this.workers = [];
        this.nextWorker = 0;
        this.pending = new Map();
        this.taskId = 0;
        this.fallbackFns = null;

        const poolSize = opts.poolSize ?? Math.min(typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2, 4);

        try {
            if (typeof Worker === "undefined") {
                throw new Error("Worker not available");
            }

            for (let i = 0; i < poolSize; i++) {
                const url = opts.workerUrl ?? new URL("./worker-task.ts", import.meta.url);
                const worker = new Worker(url, { type: "module" });

                worker.onmessage = (e: MessageEvent) => {
                    const { type, id, data, error } = e.data;
                    const p = this.pending.get(id);
                    if (!p) return;
                    this.pending.delete(id);
                    if (type === "error") {
                        p.reject(new Error(error));
                    } else {
                        p.resolve(data);
                    }
                };

                worker.onerror = (err: ErrorEvent) => {
                    // Reject all pending promises for this worker
                    // We can't easily track which promises belong to which worker
                    // with round-robin, so reject all pending on fatal error
                    for (const [id, p] of this.pending) {
                        p.reject(new Error(err.message || "Worker error"));
                    }
                    this.pending.clear();
                };

                this.workers.push(worker);
            }
        } catch (_e) {
            // Workers unavailable — fall back if allowed (default: true)
            if (opts.fallback !== false) {
                this.workers = [];
                // fallbackFns will be lazily loaded on first run() call
            } else {
                throw _e;
            }
        }
    }

    /**
     * Run a function in a worker.
     * @param fn - Function name (e.g., 'vmov', 'prep1d', 'create_image')
     * @param args - Arguments to pass
     * @param transferables - ArrayBuffers to transfer (zero-copy)
     * @returns Promise resolving with the result
     */
    async run(fn: string, args: any[], transferables?: Transferable[]): Promise<any> {
        if (this.workers.length === 0) {
            return this._runFallback(fn, args);
        }

        const id = String(this.taskId++);
        const worker = this.workers[this.nextWorker];
        this.nextWorker = (this.nextWorker + 1) % this.workers.length;

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            worker.postMessage({ type: "task", id, fn, args }, transferables ?? []);
        });
    }

    /** Terminate all workers */
    terminate(): void {
        for (const w of this.workers) {
            w.terminate();
        }
        this.workers = [];
        // Reject any pending promises
        for (const [_id, p] of this.pending) {
            p.reject(new Error("WorkerPool terminated"));
        }
        this.pending.clear();
    }

    /** Number of workers in the pool */
    get size(): number {
        return this.workers.length;
    }

    /** Synchronous fallback when workers are unavailable */
    private async _runFallback(fn: string, args: any[]): Promise<any> {
        if (!this.fallbackFns) {
            const mod = await import("./m.js");
            const m = mod.default ?? mod;
            this.fallbackFns = {
                vmov: m.vmov,
                vsmul: m.vsmul,
                vfill: m.vfill,
                vabs: m.vabs,
                vmxmn: m.vmxmn,
                vmovmax: m.vmovmax,
                vlog10: m.vlog10,
                cvmag: m.cvmag,
                cvmag2: m.cvmag2,
                cvmag2logscale: m.cvmag2logscale,
                cvpha: m.cvpha,
                cvphad: m.cvphad,
                vlogscale: m.vlogscale,
            };
        }

        const fallback = this.fallbackFns[fn];
        if (!fallback) {
            throw new Error(
                `WorkerPool fallback: "${fn}" is not supported without Web Workers. ` +
                `Only simple math functions (vmov, cvmag, etc.) have synchronous fallbacks.`
            );
        }
        return fallback(...args);
    }
}

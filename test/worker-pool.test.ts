import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WorkerPool from "../js/worker-pool.js";

describe("WorkerPool", () => {
    describe("fallback mode (no real Workers in jsdom)", () => {
        let pool: InstanceType<typeof WorkerPool>;

        beforeEach(() => {
            // jsdom doesn't support real Workers, so the pool will auto-fallback
            pool = new WorkerPool({ fallback: true });
        });

        afterEach(() => {
            pool.terminate();
        });

        it("creates pool in fallback mode", () => {
            expect(pool.size).toBe(0); // no actual workers in jsdom
        });

        it("runs vmov in fallback", async () => {
            const src = new Float64Array([1, 2, 3, 4, 5]);
            const dst = new Float64Array(5);
            await pool.run("vmov", [src, 1, dst, 1, 5]);
            expect(Array.from(dst)).toEqual([1, 2, 3, 4, 5]);
        });

        it("runs vsmul in fallback", async () => {
            const src = new Float64Array([1, 2, 3, 4]);
            const dst = new Float64Array(4);
            await pool.run("vsmul", [src, 2.0, dst, 4]);
            expect(Array.from(dst)).toEqual([2, 4, 6, 8]);
        });

        it("runs cvmag in fallback", async () => {
            // Complex interleaved: [re0, im0, re1, im1] = [3, 4, 0, 1]
            const cx = new Float64Array([3, 4, 0, 1]);
            const dst = new Float64Array(2);
            await pool.run("cvmag", [cx, dst, 2]);
            expect(dst[0]).toBeCloseTo(5.0); // sqrt(9+16)
            expect(dst[1]).toBeCloseTo(1.0); // sqrt(0+1)
        });

        it("runs vmxmn in fallback", async () => {
            const data = new Float64Array([3, 1, 4, 1, 5, 9, 2, 6]);
            const result = await pool.run("vmxmn", [data, 8]);
            expect(result.smax).toBe(9);
            expect(result.smin).toBe(1);
        });

        it("runs vlog10 in fallback", async () => {
            const src = new Float64Array([1, 10, 100, 1000]);
            const dst = new Float64Array(4);
            await pool.run("vlog10", [src, 1e-20, dst]);
            expect(dst[0]).toBeCloseTo(0);
            expect(dst[1]).toBeCloseTo(1);
            expect(dst[2]).toBeCloseTo(2);
            expect(dst[3]).toBeCloseTo(3);
        });

        it("rejects unknown functions in fallback", async () => {
            await expect(pool.run("nonexistent", [])).rejects.toThrow(
                /not supported without Web Workers/,
            );
        });

        it("rejects prep1d in fallback with descriptive error", async () => {
            await expect(pool.run("prep1d", [{}])).rejects.toThrow(
                /not supported without Web Workers/,
            );
        });

        it("terminate clears state", () => {
            pool.terminate();
            expect(pool.size).toBe(0);
        });
    });

    describe("constructor options", () => {
        it("throws when fallback is false and Workers unavailable", () => {
            // jsdom doesn't have real Worker support
            expect(() => new WorkerPool({ fallback: false })).toThrow();
        });

        it("accepts custom poolSize", () => {
            // Will still fallback in jsdom, but shouldn't throw
            const pool = new WorkerPool({ poolSize: 8, fallback: true });
            expect(pool.size).toBe(0); // fallback mode
            pool.terminate();
        });
    });
});

describe("sigplot.Plot worker integration", () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement("div");
        container.style.width = "600px";
        container.style.height = "400px";
        container.style.position = "absolute";
        Object.defineProperty(container, "clientWidth", {
            get: () => parseInt(container.style.width) || 0,
            configurable: true,
        });
        Object.defineProperty(container, "clientHeight", {
            get: () => parseInt(container.style.height) || 0,
            configurable: true,
        });
        document.body.appendChild(container);
    });

    afterEach(() => {
        document.body.removeChild(container);
    });

    it("enableWorkers creates a worker pool", () => {
        const plot = new sigplot.Plot(container, {});
        expect(plot._workerPool).toBeNull();
        plot.enableWorkers();
        expect(plot._workerPool).not.toBeNull();
        expect(plot._workerPool).toBeInstanceOf(WorkerPool);
        plot.disableWorkers();
    });

    it("disableWorkers removes the worker pool", () => {
        const plot = new sigplot.Plot(container, {});
        plot.enableWorkers();
        expect(plot._workerPool).not.toBeNull();
        plot.disableWorkers();
        expect(plot._workerPool).toBeNull();
    });

    it("enableWorkers accepts options", () => {
        const plot = new sigplot.Plot(container, {});
        plot.enableWorkers({ poolSize: 2 });
        expect(plot._workerPool).not.toBeNull();
        plot.disableWorkers();
    });

    it("overlay_array works with worker pool enabled (fallback mode)", () => {
        const plot = new sigplot.Plot(container, {});
        plot.enableWorkers();

        const data = new Float64Array(100);
        for (let i = 0; i < 100; i++) data[i] = Math.sin(i * 0.1);

        // Should not throw — sync fallback or sync prep path
        const lyr = plot.overlay_array(data);
        expect(lyr).toBeDefined();
        plot.disableWorkers();
    });

    it("plot renders correctly after enable/disable cycle", () => {
        const plot = new sigplot.Plot(container, {});

        const data = [];
        for (let i = 0; i < 100; i++) data.push(i);
        plot.overlay_array(data);

        plot.enableWorkers();
        plot.disableWorkers();

        // Plot should still be functional
        expect(plot._Gx.lyr.length).toBeGreaterThan(0);
    });

    it("WorkerPool is exported on sigplot namespace", () => {
        expect(sigplot.WorkerPool).toBe(WorkerPool);
    });
});

/**
 * Worker script for SigPlot — runs inside a Web Worker.
 *
 * Offloads pure math from the main thread: vector ops, prep1d/prep2d
 * mode conversion, and create_image pixel mapping.
 */

import m from "./m.js";

// ── Function registry ──────────────────────────────────────────────
const fns: Record<string, Function> = {
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

// ── Message protocol types ─────────────────────────────────────────
interface TaskMessage {
    type: "task";
    id: string;
    fn: string;
    args: any[];
}

interface Prep1DConfig {
    ybuf: ArrayBuffer;
    xbuf?: ArrayBuffer;
    npts: number;
    skip: number;
    cx: boolean;
    mode: string;
    xstart: number;
    xdelta: number;
    xmin: number;
    xmax: number;
    imin: number;
    size: number;
    cmode: number;
    index: boolean;
    dbmin: number;
    plab: number;
    panxmin: number;
    panxmax: number;
    firstLayerCx: boolean;
    maxhold?: { decay: number };
    mhpoint?: ArrayBuffer;
    line: number;
    xsub: number;
}

interface Prep2DConfig {
    buf: ArrayBuffer;
    zbufLen: number;
    cx: boolean;
    skip: number;
    cmode: number;
    dbmin: number;
    plab: number;
}

interface CreateImageConfig {
    data: ArrayBuffer;
    colormap: ArrayBuffer; // Uint32Array of packed RGBA values
    mapLength: number;
    subsize: number;
    w: number;
    h: number;
    zmin: number;
    zmax: number;
    xcompression: number;
    drawdirection: string;
    origin: number;
}

// ── Helpers ────────────────────────────────────────────────────────
const PointArray = m.PointArray as Float64ArrayConstructor | Float32ArrayConstructor;

function postResult(id: string, data: any, transferables: Transferable[] = []) {
    (self as any).postMessage({ type: "result", id, data }, transferables);
}

function postError(id: string, error: string) {
    (self as any).postMessage({ type: "error", id, error });
}

// ── Simple math dispatch ───────────────────────────────────────────
function handleSimpleMath(id: string, fnName: string, args: any[]) {
    const fn = fns[fnName];
    if (!fn) {
        postError(id, `Unknown function: ${fnName}`);
        return;
    }

    // Reconstruct typed arrays from transferred ArrayBuffers
    const rebuilt = args.map((a) => {
        if (a && typeof a === "object" && a.__type && a.buffer instanceof ArrayBuffer) {
            switch (a.__type) {
                case "Float64Array":
                    return new Float64Array(a.buffer);
                case "Float32Array":
                    return new Float32Array(a.buffer);
                case "Int32Array":
                    return new Int32Array(a.buffer);
                case "Uint32Array":
                    return new Uint32Array(a.buffer);
                default:
                    return a.buffer;
            }
        }
        return a;
    });

    const result = fn(...rebuilt);

    // Collect transferable buffers from the rebuilt args (they may have been mutated in-place)
    const transferSet = new Set<ArrayBuffer>();
    const resultData: any = { returnValue: result, args: [] };
    for (const a of rebuilt) {
        if (ArrayBuffer.isView(a)) {
            resultData.args.push({
                __type: a.constructor.name,
                buffer: (a as any).buffer,
            });
            transferSet.add((a as any).buffer);
        } else {
            resultData.args.push(a);
        }
    }

    postResult(id, resultData, [...transferSet]);
}

// ── prep1d ─────────────────────────────────────────────────────────
function handlePrep1D(id: string, config: Prep1DConfig) {
    let npts = config.npts;
    const skip = config.skip;

    if (npts === 0) {
        postResult(id, { num: 0, start: 0, end: 0 });
        return;
    }

    // Allocate point buffers
    const xpoint = new PointArray(npts);
    const ypoint = new PointArray(npts);

    let dbuf = new PointArray(config.ybuf);
    let qmin = config.xmin;
    let qmax = config.xmax;
    let n1 = 0;
    let n2 = 0;
    let mxmn: { smax: number; smin: number; imax: number; imin: number } | undefined;

    if (config.cmode === 5 || config.xsub > 0 || config.mode === "XY") {
        if (npts <= 0) {
            qmin = config.panxmin;
            qmax = config.panxmax;
        } else if (config.cmode !== 5 && config.mode === "XDELTA") {
            // xsub path — use xbuf as x-coordinates
            if (config.xbuf) {
                const xdata = new PointArray(config.xbuf);
                xpoint.set(xdata.subarray(0, npts));
            }
        } else if (config.cx || config.mode === "XY") {
            m.vmov(dbuf, skip, xpoint, 1, npts);
        } else if (config.line !== 0) {
            mxmn = m.vmxmn(dbuf, npts);
            xpoint[0] = mxmn.smax;
            xpoint[1] = mxmn.smin;
            n1 = 0;
            n2 = 2;
            npts = 2;
        } else {
            // copy dbuf into xpoint
            for (let i = 0; i < npts; i++) {
                xpoint[i] = dbuf[i];
            }
        }
        if (npts > 0) {
            mxmn = m.vmxmn(xpoint, npts);
            qmax = mxmn.smax;
            qmin = mxmn.smin;
            n1 = 0;
            n2 = npts;
        }
    } else if (npts > 0) {
        let xstart = config.xstart;
        const xdelta = config.xdelta;
        const d = npts;

        if (config.index) {
            n1 = 0;
            n2 = npts - 1;
        } else if (xdelta >= 0.0) {
            n1 = Math.max(1.0, Math.min(config.size, Math.round((config.xmin - xstart) / xdelta))) - 1.0;
            n2 = Math.max(1.0, Math.min(config.size, Math.round((config.xmax - xstart) / xdelta) + 2.0)) - 1.0;
        } else {
            n1 = Math.max(1.0, Math.min(config.size, Math.round((config.xmax - xstart) / xdelta) - 1.0)) - 1.0;
            n2 = Math.max(1.0, Math.min(config.size, Math.round((config.xmin - xstart) / xdelta) + 2.0)) - 1.0;
        }

        n2 = Math.min(n2, n1 + d - 1);
        if (npts < 0) {
            npts = 0;
        }
        dbuf = new PointArray(config.ybuf);
        xstart = xstart + xdelta * n1;
        for (let i = 0; i < npts; i++) {
            if (config.index) {
                xpoint[i] = config.imin + i + 1;
            } else {
                xpoint[i] = config.xmin + i * xdelta;
            }
        }
    }

    if (npts <= 0) {
        postResult(id, { num: npts, start: n1, end: n2 });
        return;
    }

    // Save x-bounds before y-axis processing overwrites qmin/qmax
    const panxmin = qmin;
    const panxmax = qmax;

    // cmode transforms
    if (config.cx) {
        if (config.cmode === 1) {
            m.cvmag(dbuf, ypoint, npts);
        } else if (config.cmode === 2) {
            if (config.plab === 25) {
                m.cvpha(dbuf, ypoint, npts);
                m.vsmul(ypoint, 1.0 / (2 * Math.PI), ypoint, npts);
            } else if (config.plab !== 24) {
                m.cvpha(dbuf, ypoint, npts);
            } else {
                m.cvphad(dbuf, ypoint, npts);
            }
        } else if (config.cmode === 3) {
            m.vmov(dbuf, skip, ypoint, 1, npts);
        } else if (config.cmode >= 6) {
            m.cvmag2(dbuf, ypoint, npts);
        } else if (config.cmode >= 4) {
            m.vmov(dbuf.subarray(1), skip, ypoint, 1, npts);
        }
    } else if (config.mode === "XY") {
        m.vmov(dbuf.subarray(1), skip, ypoint, 1, npts);
    } else {
        if (config.cmode === 5) {
            m.vfill(ypoint, 0, npts);
        } else if (config.cmode === 1 || config.cmode >= 6) {
            for (let i = 0; i < npts; i++) {
                ypoint[i] = Math.abs(dbuf[i]);
            }
        } else {
            for (let i = 0; i < npts; i++) {
                ypoint[i] = dbuf[i];
            }
        }
    }

    // dB scaling
    if (config.cmode >= 6) {
        m.vlog10(ypoint, config.dbmin, ypoint);
        let dbscale = 10.0;
        if (config.cmode === 7) {
            dbscale = 20.0;
        }
        if (config.firstLayerCx) {
            dbscale = dbscale / 2.0;
        }
        m.vsmul(ypoint, dbscale, ypoint);
    }

    mxmn = m.vmxmn(ypoint, npts);

    // maxhold
    let mhpointOut: ArrayBuffer | undefined;
    if (config.maxhold && config.mhpoint) {
        const mhpoint = new PointArray(config.mhpoint);
        m.vmovmax(ypoint, 0, 1, mhpoint, n1, 1, npts, config.maxhold.decay);
        mhpointOut = mhpoint.buffer;
    }

    // y-bounds
    qmax = mxmn.smax;
    qmin = mxmn.smin;

    let yran = qmax - qmin;
    if (yran < 0.0) {
        qmax = qmin;
        qmin = qmax + yran;
        yran = -yran;
    }
    if (yran <= 1.0e-20) {
        qmin = qmin - 1.0;
        qmax = qmax + 1.0;
    } else {
        qmin = qmin - 0.02 * yran;
        qmax = qmax + 0.02 * yran;
    }

    const transferables: Transferable[] = [xpoint.buffer, ypoint.buffer];
    if (mhpointOut) {
        transferables.push(mhpointOut);
    }

    postResult(
        id,
        {
            xpoint: xpoint.buffer,
            ypoint: ypoint.buffer,
            num: npts,
            start: n1,
            end: n2,
            xmin: panxmin,
            xmax: panxmax,
            ymin: qmin,
            ymax: qmax,
            panxmin: panxmin,
            panxmax: panxmax,
            panymin: qmin,
            panymax: qmax,
            mhpoint: mhpointOut,
        },
        transferables
    );
}

// ── prep2d ─────────────────────────────────────────────────────────
function handlePrep2D(id: string, config: Prep2DConfig) {
    const buf = new PointArray(config.buf);
    const zbuf = new Float32Array(config.zbufLen);

    if (config.cx) {
        if (config.cmode === 1) {
            m.cvmag(buf, zbuf, zbuf.length);
        } else if (config.cmode === 2) {
            if (config.plab === 25) {
                m.cvpha(buf, zbuf, zbuf.length);
                m.vsmul(zbuf, 1.0 / (2 * Math.PI), zbuf, zbuf.length);
            } else if (config.plab !== 24) {
                m.cvpha(buf, zbuf, zbuf.length);
            } else {
                m.cvphad(buf, zbuf, zbuf.length);
            }
        } else if (config.cmode === 3) {
            m.vmov(buf, config.skip, zbuf, 1, zbuf.length);
        } else if (config.cmode === 4) {
            m.vmov(buf.subarray(1), config.skip, zbuf, 1, zbuf.length);
        } else if (config.cmode === 5) {
            m.vfill(zbuf, 0, zbuf.length);
        } else if (config.cmode === 6) {
            m.cvmag2logscale(buf, config.dbmin, 10.0, zbuf);
        } else if (config.cmode === 7) {
            m.cvmag2logscale(buf, config.dbmin, 20.0, zbuf);
        }
    } else {
        if (config.cmode === 1) {
            m.vabs(buf, zbuf);
        } else if (config.cmode === 2) {
            m.vfill(zbuf, 0, zbuf.length);
        } else if (config.cmode === 3) {
            m.vmov(buf, config.skip, zbuf, 1, zbuf.length);
        } else if (config.cmode === 4) {
            m.vfill(zbuf, 0, zbuf.length);
        } else if (config.cmode === 5) {
            m.vfill(zbuf, 0, zbuf.length);
        } else if (config.cmode === 6) {
            m.vlogscale(buf, config.dbmin, 10.0, zbuf);
        } else if (config.cmode === 7) {
            m.vlogscale(buf, config.dbmin, 20.0, zbuf);
        }
    }

    postResult(id, { zbuf: zbuf.buffer }, [zbuf.buffer]);
}

// ── create_image ───────────────────────────────────────────────────
function handleCreateImage(id: string, config: CreateImageConfig) {
    const data = new Float32Array(config.data);
    const colormap = new Uint32Array(config.colormap);

    let w = config.w;
    let h = config.h;

    if (config.drawdirection === "horizontal") {
        const tmp = w;
        w = h;
        h = tmp;
    }

    w = Math.ceil(w);
    h = Math.ceil(h);

    const pixelBuf = new ArrayBuffer(w * h * 4);
    const imgd = new Uint32Array(pixelBuf);

    // ColorMap scaling
    const low = config.zmin;
    const high = config.zmax;
    const fscale = config.mapLength / Math.abs(high - low);
    const mapLen = config.mapLength;

    let nxc: number;
    if (config.drawdirection !== "horizontal") {
        nxc = Math.max(1, config.subsize / w);
    } else {
        nxc = Math.max(1, config.subsize / h);
    }

    const origin = config.origin;
    const subsize = config.subsize;
    const xcompression = config.xcompression;
    const isHorizontal = config.drawdirection === "horizontal";

    for (let i = 0; i < imgd.length; i++) {
        let ix: number;
        let iy: number;

        if (origin === 1 || origin === 4) {
            ix = Math.floor(i % w);
        } else {
            ix = w - Math.floor(i % w) - 1;
        }
        if (origin === 3 || origin === 4) {
            iy = Math.floor(i / w);
        } else {
            iy = h - Math.floor(i / w) - 1;
        }

        let didx: number;
        if (!isHorizontal) {
            didx = iy * subsize + Math.floor(ix * nxc);
        } else {
            didx = ix * subsize + Math.floor(iy * nxc);
        }

        let value = data[didx];
        if (nxc > 1) {
            if (xcompression === 1) {
                for (let j = 1; j < nxc; j++) {
                    value += data[didx + j];
                }
                value = value / nxc;
            } else if (xcompression === 2) {
                for (let j = 1; j < nxc; j++) {
                    value = Math.min(value, data[didx + j]);
                }
            } else if (xcompression === 3) {
                for (let j = 1; j < nxc; j++) {
                    value = Math.max(value, data[didx + j]);
                }
            } else if (xcompression === 4) {
                // first — already have data[didx]
            } else if (xcompression === 5) {
                for (let j = 1; j < nxc; j++) {
                    value = Math.max(Math.abs(value), Math.abs(data[didx + j]));
                }
            }
        }

        // Inline getColorIndex
        let n = (value - low) * fscale;
        let colorindex = ~~n;
        if (colorindex > mapLen - 1) {
            colorindex = mapLen - 1;
        } else if (colorindex < 0) {
            colorindex = 0;
        }
        imgd[i] = colormap[colorindex];
    }

    postResult(id, { pixels: pixelBuf, width: w, height: h }, [pixelBuf]);
}

// ── parse_file (fetch + return raw buffer) ─────────────────────────
interface ParseFileConfig {
    href: string;
}

async function handleParseFile(id: string, config: ParseFileConfig) {
    const response = await fetch(config.href);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${config.href}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();

    // Extract filename from URL (URL API is available in Workers)
    let fileName = "";
    try {
        const url = new URL(config.href, self.location.href);
        fileName = url.pathname.split("/").pop() || "";
    } catch {
        fileName = config.href.split("/").pop()?.split("?")[0] || "";
    }

    postResult(id, { buffer, fileName }, [buffer]);
}

// ── Message handler ────────────────────────────────────────────────
self.onmessage = function (e: MessageEvent<TaskMessage>) {
    const msg = e.data;
    if (msg.type !== "task") return;

    const { id, fn, args } = msg;

    try {
        switch (fn) {
            case "prep1d":
                handlePrep1D(id, args[0] as Prep1DConfig);
                break;
            case "prep2d":
                handlePrep2D(id, args[0] as Prep2DConfig);
                break;
            case "create_image":
                handleCreateImage(id, args[0] as CreateImageConfig);
                break;
            case "parse_file":
                handleParseFile(id, args[0] as ParseFileConfig);
                break;
            default:
                handleSimpleMath(id, fn, args);
                break;
        }
    } catch (err: any) {
        postError(id, err?.message ?? String(err));
    }
};

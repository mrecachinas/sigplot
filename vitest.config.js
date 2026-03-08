import { defineConfig } from "vitest/config";

// sec2tod uses local‑timezone Date methods, so pin to UTC for deterministic results
process.env.TZ = "UTC";

export default defineConfig({
    test: {
        include: ["test/**/*.test.js"],
        globals: true,

        // jsdom for basic unit tests (math, data structures)
        environment: "jsdom",

        // Setup file that imports sigplot and creates globals
        setupFiles: ["test/vitest.setup.js"],

        // Browser mode for canvas/rendering tests (enable with --browser.enabled)
        browser: {
            enabled: false,
            instances: [
                {
                    browser: "chromium",
                    provider: () => import("@vitest/browser-playwright"),
                    headless: true,
                },
            ],
        },
    },
});

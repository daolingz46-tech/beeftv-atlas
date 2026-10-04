// Run with Bun. Serves an isolated fixture, never opens the user's workspace data.
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";

const bundle = await Bun.build({ entrypoints: ["test/fixtures/canvas-viewport-browser.tsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
if (!bundle.success) throw new AggregateError(bundle.logs, "Fixture build failed");
const script = await bundle.outputs[0].text();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    return new Response('<html><style>html,body,#root{margin:0;width:1200px;height:800px}#root>div{position:relative;width:100%;height:100%;overflow:hidden}.canvas-world-layer,.canvas-world-raster-layer{position:absolute;transform-origin:0 0}.canvas-world-raster-layer{transform:scale(var(--canvas-committed-scale))}</style><div id="root"></div><script type="module" src="/fixture.js"></script></html>', { headers: { "Content-Type": "text/html" } });
} });
const executablePath = process.env.CHROME_BIN || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
let browser;
try {
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.canvasReady);
    await page.evaluate(() => {
        window.canvasStats.previews.length = 0;
        document.querySelector("#root>div").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(220);
    let stats = await page.evaluate(() => window.canvasStats);
    const target = Math.pow(1.1, 100 / 72);
    assert(stats.previews.some(v => v.k > 1 && v.k < target - 0.001), "wheel zoom must have intermediate frames");
    assert(Math.abs(stats.previews.at(-1).k - target) < 1e-8, "idle viewport must reach the exact target");
    assert(stats.previews.every(v => Math.abs(v.x + 600 * v.k - 600) < 1e-6), "zoom must preserve the cursor's world point");
    console.log("PASS smooth wheel interpolation, cursor anchor and exact final scale");

    await page.reload();
    await page.waitForFunction(() => window.canvasReady);
    await page.evaluate(async () => {
        const container = document.querySelector("#root>div");
        for (let i = 0; i < 26; i++) {
            container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 8));
        }
    });
    await page.waitForTimeout(220);
    stats = await page.evaluate(() => window.canvasStats);
    assert.equal(stats.commits.length, 1, "continuous wheel input must commit only after idle");
    assert(stats.commits[0] - stats.lastInput >= 110, "every wheel event must extend the idle deadline");
    assert.equal(stats.renders, 2, "zooming into existing coverage must avoid intermediate React renders");
    assert.equal(stats.previews.at(-1).k, 8, "precision zoom must stop at 800%");
    const interacting = await page.locator("#root>div").getAttribute("data-canvas-viewport-interacting");
    assert.equal(interacting, null, "idle must clear the interaction state");
    console.log("PASS high-frequency wheel coalescing, idle deadline, mounted-node reuse and 800% limit");
    await page.reload();
    await page.waitForFunction(() => window.canvasReady);
    await page.evaluate(async () => {
        const container = document.querySelector("#root>div");
        for (let i = 0; i < 20; i++) {
            container.dispatchEvent(new WheelEvent("wheel", { deltaY: 20, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 8));
        }
    });
    await page.waitForTimeout(200);
    stats = await page.evaluate(() => window.canvasStats);
    assert.equal(stats.previews.at(-1).y, -400, "trackpad must accumulate all pan deltas");
    assert.equal(stats.previews.at(-1).k, 1, "trackpad pan must keep the scale");
    assert(stats.renders > 2, "large pans must refresh newly exposed node coverage during the gesture");
    assert.equal(stats.commits.length, 1, "pan must commit once after idle");
    console.log("PASS continuous trackpad pan and virtualization coverage refresh");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.waitForFunction(() => window.canvasReady);
    await page.evaluate(() => {
        window.canvasStats.previews.length = 0;
        document.querySelector("#root>div").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 600, clientY: 400, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    stats = await page.evaluate(() => window.canvasStats);
    assert(stats.previews.every(v => Math.abs(v.k - target) < 1e-8), "reduced motion must bypass interpolation");
    console.log("PASS reduced-motion preference");
    assert.deepEqual(errors, [], "browser must have no runtime errors");
} finally {
    await browser?.close();
    server.stop(true);
}

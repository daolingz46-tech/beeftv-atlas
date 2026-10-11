import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let resourceRequests = 0;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-minimap-harness.tsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}", __BEEFTV_HEAVY_MEDIA_ENABLED__: "true" }, plugins: [{ name: "source", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    server = Bun.serve({ port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/fixture.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
        if (new URL(request.url).pathname.startsWith("/api/resources/")) {
            resourceRequests++;
            if (request.headers.get("X-Desktop-Token") !== "synthetic-minimap-token") return new Response("auth required", { status: 401 });
            return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>', { headers: { "Content-Type": "image/svg+xml" } });
        }
        return new Response('<style>.absolute{position:absolute}.relative{position:relative}.h-full{height:100%}.w-full{width:100%}.overflow-hidden{overflow:hidden}.size-full{width:100%;height:100%}.inset-0{inset:0}.minimap-image-preview>.cached-resource-image-shell{display:block;width:100%;height:100%}</style><div id="root"></div><script>globalThis.Bun={}</script><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
test("large minimap loads every image including owned resources, removes crowded labels and navigates", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        const map = page.locator("[data-canvas-minimap]"); await map.waitFor();
        expect(await map.locator("[data-minimap-node]").count()).toBe(30);
        await page.waitForFunction(() => document.querySelectorAll("[data-canvas-minimap] img").length === 30 && [...document.querySelectorAll("[data-canvas-minimap] img")].every(el => (el as HTMLImageElement).naturalWidth > 0));
        expect(await map.locator("img").count()).toBe(30);
        expect(await map.locator("span:not(.cached-resource-image-shell)").count()).toBe(0);
        expect(await map.locator('[data-minimap-node="0"]').getAttribute("title")).toBe("image-0");
        await map.click({ position: { x: 150, y: 100 } });
        const viewport = JSON.parse(await page.locator("output").textContent() || "{}");
        expect(viewport.k).toBe(1); expect(viewport.x).not.toBe(0); expect(viewport.y).not.toBe(0);
    } finally { await page.close(); }
}, 30000);

test("distant nodes do not suppress sub-eight-pixel images or stall owned resource loading", async () => {
    const page = await browser.newPage(); const before = resourceRequests;
    try {
        await page.goto(server.url.toString() + "?tiny=1");
        await page.waitForFunction(() => document.querySelectorAll("[data-canvas-minimap] img").length === 30 && [...document.querySelectorAll("[data-canvas-minimap] img")].every(el => (el as HTMLImageElement).naturalWidth > 0));
        const size = await page.locator('[data-minimap-node="0"] img').boundingBox();
        expect(size?.width).toBeGreaterThan(0); expect(size!.width).toBeLessThan(8);
        expect(size?.height).toBeGreaterThan(0);
        expect(resourceRequests - before).toBe(15);
        expect(await page.locator('[data-minimap-node="hidden-batch-image"]').count()).toBe(0);
    } finally { await page.close(); }
}, 30000);

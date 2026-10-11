import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-minimap-harness.tsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}", __BEEFTV_HEAVY_MEDIA_ENABLED__: "true" }, plugins: [{ name: "source", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    server = Bun.serve({ port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/fixture.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
        return new Response('<style>.absolute{position:absolute}.relative{position:relative}.h-full{height:100%}.w-full{width:100%}.overflow-hidden{overflow:hidden}.size-full{width:100%;height:100%}</style><div id="root"></div><script>globalThis.Bun={}</script><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
    browser = await chromium.launch({ headless: true, executablePath });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
test("large minimap retains bounded visible previews, removes crowded labels and navigates", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        const map = page.locator("[data-canvas-minimap]"); await map.waitFor();
        expect(await map.locator("[data-minimap-node]").count()).toBe(30);
        expect(await map.locator("img").count()).toBe(24);
        await page.waitForFunction(() => [...document.querySelectorAll("[data-canvas-minimap] img")].every(el => (el as HTMLImageElement).naturalWidth > 0));
        expect(await map.locator("span").count()).toBe(0);
        expect(await map.locator('[data-minimap-node="0"]').getAttribute("title")).toBe("image-0");
        await map.click({ position: { x: 150, y: 100 } });
        const viewport = JSON.parse(await page.locator("output").textContent() || "{}");
        expect(viewport.k).toBe(1); expect(viewport.x).not.toBe(0); expect(viewport.y).not.toBe(0);
    } finally { await page.close(); }
}, 30000);

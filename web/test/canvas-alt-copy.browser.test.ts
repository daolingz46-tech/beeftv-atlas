import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-alt-copy-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}", __BEEFTV_HEAVY_MEDIA_ENABLED__: "true" },
        plugins: [{ name: "source", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    server = Bun.serve({ port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/fixture.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
        return new Response('<style>body{margin:0}#state{display:none}</style><div id="root"></div><script>globalThis.Bun={}</script><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
const state = async (page: Page) => JSON.parse(await page.locator("#state").textContent() || "{}");
async function fresh() {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(server.url.toString()); await page.locator('[data-node-id="image"]').waitFor(); return page;
}
async function begin(page: Page, id: string) {
    const bounds = await page.locator(`[data-node-id="${id}"]`).boundingBox();
    if (!bounds) throw new Error("missing node");
    const start = { x: bounds.x + 15, y: bounds.y + 15 };
    await page.mouse.move(start.x, start.y); await page.keyboard.down("Alt"); await page.mouse.down(); return start;
}
test("Alt drag creates one media copy at scaled offset, originals stay still, undo and redo include connections", async () => {
    const page = await fresh();
    try {
        const before = await state(page), start = await begin(page, "image");
        await page.mouse.move(start.x + 180, start.y + 90, { steps: 15 });
        await page.locator('[data-canvas-copy-preview="true"]').waitFor();
        expect((await state(page)).nodes).toEqual(before.nodes);
        const original = await page.locator('[data-node-id="image"]').boundingBox();
        expect(original?.x).toBe(80); expect(original?.y).toBe(120);
        const preview = await page.locator('[data-canvas-copy-preview="true"]').boundingBox();
        expect(preview?.x).toBe(260); expect(preview?.y).toBe(210);
        await page.mouse.up(); await page.keyboard.up("Alt");
        const after = await state(page), copy = after.nodes.find((node: any) => node.metadata?.copiedFromNodeId === "image");
        expect(after.nodes).toHaveLength(6);
        expect(copy.position).toEqual({ x: 130, y: 105 });
        expect(copy.metadata.storageKey).toBe("resource:image");
        expect(copy.metadata.taskId).toBeUndefined(); expect(copy.metadata.generationEffectKeys).toBeUndefined();
        expect(after.connections.filter((edge: any) => edge.toNodeId === copy.id).map((edge: any) => edge.fromNodeId)).toEqual(["reference"]);
        expect(await page.locator("[data-canvas-copy-preview]").count()).toBe(0);
        await page.getByRole("button", { name: "undo", exact: true }).click();
        expect((await state(page)).nodes).toHaveLength(5); expect((await state(page)).connections).toHaveLength(2);
        await page.getByRole("button", { name: "redo", exact: true }).click(); expect((await state(page)).nodes).toHaveLength(6);
    } finally { await page.close(); }
}, 30_000);
test("box selection duplicates image and video together with internal edges; frame copies remap children", async () => {
    const page = await fresh();
    try {
        await page.mouse.move(60, 100); await page.mouse.down(); await page.mouse.move(660, 320, { steps: 10 }); await page.mouse.up();
        expect((await state(page)).selected.sort()).toEqual(["image", "video"]);
        const start = await begin(page, "video"); await page.mouse.move(start.x + 100, start.y + 420, { steps: 15 }); await page.mouse.up(); await page.keyboard.up("Alt");
        const copied = await state(page), image = copied.nodes.find((node: any) => node.metadata?.copiedFromNodeId === "image"), video = copied.nodes.find((node: any) => node.metadata?.copiedFromNodeId === "video");
        expect(copied.nodes).toHaveLength(7); expect(video.metadata.storageKey).toBe("resource:video");
        expect(copied.connections.some((edge: any) => edge.fromNodeId === image.id && edge.toNodeId === video.id)).toBe(true);
        expect(copied.selected.sort()).toEqual([image.id, video.id].sort());
        await page.reload(); await page.locator('[data-node-id="frame"]').waitFor();
        const frameStart = await begin(page, "frame"); await page.mouse.move(frameStart.x + 700, frameStart.y + 160, { steps: 15 }); await page.mouse.up(); await page.keyboard.up("Alt");
        const framed = await state(page), frame = framed.nodes.find((node: any) => node.metadata?.copiedFromNodeId === "frame"), child = framed.nodes.find((node: any) => node.metadata?.copiedFromNodeId === "child");
        expect(framed.nodes).toHaveLength(7); expect(child.parentId).toBe(frame.id);
        expect(child.position.x - frame.position.x).toBe(40); expect(child.position.y - frame.position.y).toBe(40);
    } finally { await page.close(); }
}, 30_000);
test("Alt click, cancelled drag and locked nodes make no copy; ordinary drag still moves", async () => {
    const page = await fresh();
    try {
        await begin(page, "image"); await page.mouse.up(); await page.keyboard.up("Alt"); expect((await state(page)).nodes).toHaveLength(5);
        const start = await begin(page, "video"); await page.mouse.move(start.x + 100, start.y + 100, { steps: 5 });
        await page.locator("[data-canvas-copy-preview]").waitFor(); await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await page.mouse.up(); await page.keyboard.up("Alt"); expect((await state(page)).nodes).toHaveLength(5); expect(await page.locator("[data-canvas-copy-preview]").count()).toBe(0);
        const locked = await begin(page, "reference"); await page.mouse.move(locked.x + 80, locked.y + 80); await page.mouse.up(); await page.keyboard.up("Alt"); expect((await state(page)).nodes).toHaveLength(5);
        await page.mouse.move(90, 130); await page.mouse.down(); await page.mouse.move(170, 190, { steps: 5 }); await page.mouse.up();
        expect((await state(page)).nodes.find((node: any) => node.id === "image").position).toEqual({ x: 80, y: 90 });
    } finally { await page.close(); }
}, 30_000);

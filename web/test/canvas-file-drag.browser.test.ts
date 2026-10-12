import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-file-drag-harness.tsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, plugins: [{ name: "alias", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch(request) { return new URL(request.url).pathname === "/fixture.js" ? new Response(script, { headers: { "Content-Type": "text/javascript" } }) : new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } }); } });
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });
async function pageFixture() { const page = await browser.newPage(); await page.goto(server.url.toString()); await page.locator('[data-node-id="image"]').waitFor(); return page; }
async function state(page: Page) { return JSON.parse(await page.locator("#state").textContent() || "{}"); }
async function move(page: Page) { await page.mouse.move(150, 150); await page.mouse.down(); await page.mouse.move(190, 210, { steps: 8 }); }

test("ordinary canvas dragging commits its position and cancels only the native watcher", async () => {
    const page = await pageFixture();
    try { await move(page); await page.mouse.up(); const result = await state(page); expect(result.nodes[0].position).toEqual({ x: 140, y: 160 }); expect(result.dragging).toBe(false); expect(await page.evaluate(() => (window as any).fileDragFixture.cancellations.length)).toBe(1); }
    finally { await page.close(); }
});
test("external takeover cancels canvas preview without moving or reparenting originals", async () => {
    const page = await pageFixture();
    try { const before = (await state(page)).nodes; await move(page); await page.evaluate(() => (window as any).fileDragFixture.takeover()); await page.mouse.up(); const result = await state(page); expect(result.nodes).toEqual(before); expect(result.dragging).toBe(false); expect(result.paused).toBe(false); await page.evaluate(() => (window as any).fileDragFixture.settle("dropped")); }
    finally { await page.close(); }
});
test("box-selected mixed content travels as a batch of real media plus text", async () => {
    const page = await pageFixture();
    try { await page.getByRole("button", { name: "全选" }).click(); await move(page); const files = await page.evaluate(() => (window as any).fileDragFixture.calls.at(-1).files); expect(files).toEqual([{ fileName: "图片.png", resourceId: "owned-image" }, { fileName: "视频.mp4", resourceId: "owned-video" }, { fileName: "剧本.txt", text: "第一行\n第二行" }]); await page.evaluate(() => (window as any).fileDragFixture.takeover()); await page.mouse.up(); expect((await state(page)).nodes.map((node: any) => node.position)).toEqual([{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 500, y: 100 }]); }
    finally { await page.close(); }
});
test("Alt dragging keeps duplication and does not arm native export", async () => {
    const page = await pageFixture();
    try { await page.keyboard.down("Alt"); await move(page); await page.mouse.up(); await page.keyboard.up("Alt"); expect(await page.evaluate(() => (window as any).fileDragFixture.calls.length)).toBe(0); expect(await page.evaluate(() => (window as any).fileDragFixture.duplicates)).toBe(1); }
    finally { await page.close(); }
});
test("blur cancels the node gesture without persisting temporary positions", async () => {
    const page = await pageFixture();
    try { const before = (await state(page)).nodes; await move(page); await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up(); expect((await state(page)).nodes).toEqual(before); expect((await state(page)).paused).toBe(false); }
    finally { await page.close(); }
});
test("a quick off-window release cannot commit a node beyond the window before native handoff", async () => {
    const page = await pageFixture();
    try { const before = (await state(page)).nodes; await move(page); await page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { clientX: -20, clientY: 210 }))); await page.mouse.up(); expect((await state(page)).nodes).toEqual(before); expect((await state(page)).dragging).toBe(false); }
    finally { await page.close(); }
});

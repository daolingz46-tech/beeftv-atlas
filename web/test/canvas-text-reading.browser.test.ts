import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-text-reading-harness.tsx"], target: "browser", define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}", __BEEFTV_HEAVY_MEDIA_ENABLED__: "true" }, plugins: [{ name: "aliases", setup(builder) { builder.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) })); } }] });
    if (!build.success) throw Error(build.logs.join("\n"));
    const script = await build.outputs.find(output => output.path.endsWith(".js"))!.text();
    const dist = path.resolve(import.meta.dir, "../dist");
    const css = [...readFileSync(path.join(dist, "index.html"), "utf8").matchAll(/href="([^"]+\.css)"/g)].map(match => match[1]);
    // globals.css belongs to the lazy application chunk, not the boot page.
    css.push(...readdirSync(path.join(dist, "static")).filter(name => name.endsWith(".css") && readFileSync(path.join(dist, "static", name), "utf8").includes(".canvas-node-composer-expand")).map(name => "/static/" + name));
    if (!css.length) throw Error("Build production CSS before browser verification");
    server = Bun.serve({ port: 0, fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (pathname.startsWith("/static/")) {
            const file = path.join(dist, pathname.slice(1));
            return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
        }
        if (pathname.startsWith("/api/")) return Response.json({ code: 0, data: { items: [], total: 0 } });
        return new Response(css.map(href => `<link rel="stylesheet" href="${href}">`).join("") + '<div id="root"></div><script>globalThis.Bun={}</script><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(p => p && existsSync(p));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

async function newPage() {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.setDefaultTimeout(7000);
    return page;
}

for (const theme of ["dark", "light"]) test(`${theme}: compact text prompt expands, retains references and syncs edits back on close`, async () => {
    const page = await newPage();
    try {
        await page.goto(server.url.toString() + "?theme=" + theme);
        const compact = page.locator("[data-composer-fixture]");
        const expand = compact.getByRole("button", { name: "放大编辑提示词" });
        await expand.waitFor();
        expect(await expand.isVisible()).toBe(true);
        const bounds = await expand.boundingBox(), panel = await compact.boundingBox();
        expect(bounds!.x).toBeGreaterThan(panel!.x + panel!.width * .8);
        const original = await page.evaluate(() => (window as any).textReadingFixture.prompt());
        await expand.click();
        const modal = page.getByRole("dialog"); await modal.waitFor();
        await page.waitForFunction(() => (document.querySelector('[role="dialog"]') as HTMLElement).clientHeight > 500);
        const editor = modal.locator('[aria-label="文本提示词"]');
        // Playwright waits for the AntD enter animation before focusing.
        await editor.click();
        expect(await editor.innerText()).toContain("第 80 段");
        expect(await editor.innerText()).toContain("文本1");
        // Layout size is independent of AntD's temporary scale(.2) animation.
        expect(await modal.evaluate(el => el.clientHeight)).toBeGreaterThan(500);
        expect(await page.evaluate(() => (window as any).textReadingFixture.prompt())).toBe(original);
        await editor.hover(); await page.mouse.wheel(0, 250);
        await page.waitForFunction(() => document.querySelector('[role="dialog"] [contenteditable=true]')!.scrollTop > 0);
        const next = "@文本1\n弹窗中修改的完整脚本\n保留换行";
        await editor.fill("");
        // Exercise the editor's actual plain-text paste and Enter handlers.
        // Playwright fill(multiline) inserts native block divs that user input
        // cannot create because this editor deliberately intercepts both paths.
        await editor.evaluate((el, value) => {
            const transfer = new DataTransfer(); transfer.setData("text/plain", value);
            el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
        }, next);
        await page.waitForFunction(() => (window as any).textReadingFixture.prompt().includes("弹窗中修改的完整脚本"));
        expect(await page.evaluate(() => (window as any).textReadingFixture.prompt())).toBe(next);
        await editor.press("End"); await editor.press("Enter");
        await editor.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.keyboard.insertText("额外一行");
        expect(await page.evaluate(() => (window as any).textReadingFixture.prompt())).toBe(next + "\n额外一行");
        await page.keyboard.press("Escape"); await modal.waitFor({ state: "hidden" });
        expect(await compact.locator('[aria-label="文本提示词"]').innerText()).toContain("弹窗中修改的完整脚本");
        await expand.click(); await modal.waitFor();
        expect(await modal.locator('[aria-label="文本提示词"]').innerText()).toContain("保留换行");
    } finally { await page.close(); }
}, 30000);

test("selected plain and rich text scroll both ways without moving the canvas; Ctrl wheel still zooms", async () => {
    const page = await newPage();
    try {
        await page.goto(server.url.toString());
        for (const id of ["plain", "rich"]) {
            const reader = page.locator(`[data-reader="${id}"] [data-canvas-text-content]`);
            await reader.click();
            const content = reader.locator("div").first();
            const initial = await page.evaluate(() => (window as any).textReadingFixture.viewport());
            await content.hover(); await page.mouse.wheel(0, 350);
            await page.waitForFunction(id => document.querySelector(`[data-reader="${id}"] [data-canvas-text-content] > div`)!.scrollTop > 0, id);
            const down = await content.evaluate(el => el.scrollTop);
            await page.mouse.wheel(0, -150);
            await page.waitForFunction(({ id, down }) => document.querySelector(`[data-reader="${id}"] [data-canvas-text-content] > div`)!.scrollTop < down, { id, down });
            expect(await page.evaluate(() => (window as any).textReadingFixture.viewport())).toEqual(initial);
            await content.evaluate(el => { el.scrollTop = el.scrollHeight; });
            await page.mouse.wheel(0, 200); await page.waitForTimeout(160);
            expect(await page.evaluate(() => (window as any).textReadingFixture.viewport())).toEqual(initial);
        }
        const content = page.locator('[data-reader="rich"] [data-canvas-text-content] > div');
        await content.dispatchEvent("wheel", { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
        await page.waitForFunction(() => (window as any).textReadingFixture.viewport().k > 1);
    } finally { await page.close(); }
}, 30000);

test("unselected text keeps canvas navigation and inline editing keeps native scrolling", async () => {
    const page = await newPage();
    try {
        await page.goto(server.url.toString());
        const reader = page.locator('[data-reader="plain"] [data-canvas-text-content]'); await reader.waitFor();
        await reader.locator("div").first().hover(); await page.mouse.wheel(0, -120);
        await page.waitForFunction(() => (window as any).textReadingFixture.viewport().k > 1);
        await page.evaluate(() => (window as any).textReadingFixture.edit());
        const editor = reader.locator("textarea"); await editor.waitFor();
        const initial = await page.evaluate(() => (window as any).textReadingFixture.viewport());
        await editor.hover(); await page.mouse.wheel(0, 250);
        await page.waitForFunction(() => document.querySelector('[data-reader="plain"] textarea')!.scrollTop > 0);
        expect(await page.evaluate(() => (window as any).textReadingFixture.viewport())).toEqual(initial);
    } finally { await page.close(); }
}, 30000);

for (const mode of ["image", "video", "audio"]) test(`${mode}: expand entry is available with the compact header hidden`, async () => {
    const page = await newPage();
    try {
        await page.goto(server.url.toString() + "?mode=" + mode);
        await page.getByRole("button", { name: "放大编辑提示词" }).click();
        const modal = page.getByRole("dialog"); await modal.waitFor();
        expect(await modal.locator("[contenteditable=true]").innerText()).toContain("第 80 段");
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await modal.waitFor({ state: "hidden" });
    } finally { await page.close(); }
}, 30000);

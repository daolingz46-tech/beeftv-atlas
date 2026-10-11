import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/default-model-filters-harness.tsx"],
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}", __BEEFTV_HEAVY_MEDIA_ENABLED__: "true" },
        plugins: [
            {
                name: "source",
                setup(builder) {
                    builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
                },
            },
        ],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const css = (await build.outputs.find((output) => output.path.endsWith(".css"))?.text()) || "";
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/fixture.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/fixture.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            return new Response('<style>body{margin:0;font-family:Arial}*{box-sizing:border-box}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script>globalThis.Bun={}</script><script type="module" src="/fixture.js"></script>', {
                headers: { "Content-Type": "text/html" },
            });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string =>
        Boolean(path && existsSync(path)),
    );
    browser = await chromium.launch({ headless: true, executablePath });
}, 60_000);
afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function popup(page: Page, name: string) {
    const id = await page.getByRole("combobox", { name, exact: true }).getAttribute("aria-controls");
    return page.locator(".ant-select-dropdown").filter({ has: page.locator(`[id="${id}"]`) });
}
async function choose(page: Page, name: string, label: string) {
    await page.getByRole("combobox", { name, exact: true }).click();
    await (
        await popup(page, name)
    )
        .locator(".ant-select-item-option-content")
        .filter({ has: page.getByText(label, { exact: true }) })
        .click();
}
async function modelLabels(page: Page, name: string) {
    await page.getByRole("combobox", { name, exact: true }).click();
    const labels = await (await popup(page, name)).locator(".model-default-select-option > span:first-child").allTextContents();
    await page.keyboard.press("Escape");
    return labels;
}
async function saved(page: Page) {
    return JSON.parse(await page.getByLabel("saved changes").innerText());
}

test("channel and family narrow large catalogs without saving until a concrete model is chosen", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        expect(await modelLabels(page, "默认生图模型")).toEqual(["GPT Image 2.5"]);
        await choose(page, "默认生图模型渠道", "Alternate Fixture");
        expect(await saved(page)).toEqual([]);
        expect(await page.locator('[aria-labelledby="default-image-title"] .model-default-select').innerText()).toBe("GPT Image 2.5");
        await choose(page, "默认生图模型系列", "Seedream · 即梦图片");
        expect(await modelLabels(page, "默认生图模型")).toEqual(["Seedream 5.0"]);
        expect(await saved(page)).toEqual([]);
        await choose(page, "默认生图模型", "Seedream 5.0");
        expect(await saved(page)).toEqual([{ key: "imageModel", value: "b::seedream-5.0" }]);
        await choose(page, "默认生图模型系列", "GPT Image");
        await choose(page, "默认生图模型", "GPT Image 2.5");
        expect((await saved(page)).at(-1)).toEqual({ key: "imageModel", value: "b::gpt-image-2.5" });
        await page.getByRole("button", { name: "外部更新图片默认模型" }).click();
        expect(await modelLabels(page, "默认生图模型")).toEqual(["Seedream 5.0"]);
        expect(await page.locator('[aria-labelledby="default-image-title"] .model-default-filters').innerText()).toContain("Atlas Fixture");
    } finally {
        await page.close();
    }
}, 30_000);

test("video, text, audio and assistant selectors use their capability families and preserve follow behavior", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        for (const [title, family, label, key, id] of [
            ["默认视频模型", "Kling · 可灵", "Kling v3 Image-to-Video", "videoModel", "kling-v3/image-to-video"],
            ["默认文本模型", "OpenAI", "GPT 6", "textModel", "gpt-6"],
            ["默认音频模型", "MiniMax", "MiniMax Speech 2.6", "audioModel", "minimax/speech-2.6"],
        ]) {
            await choose(page, `${title}系列`, family);
            expect(await modelLabels(page, title)).toEqual([label]);
            await choose(page, title, label);
            expect((await saved(page)).at(-1)).toEqual({ key, value: `a::${id}` });
        }
        await choose(page, "助手模型渠道", "Alternate Fixture");
        await choose(page, "助手模型系列", "全部系列");
        const assistantLabels = await modelLabels(page, "助手模型");
        expect(assistantLabels).toContain("跟随默认文本模型");
        expect(assistantLabels).not.toContain("Unsupported Text");
        await choose(page, "助手模型系列", "DeepSeek");
        await choose(page, "助手模型", "DeepSeek V4.1 Flash");
        expect((await saved(page)).at(-1)).toEqual({ key: "assistantModel", value: "b::deepseek-v4.1-flash" });
        await choose(page, "助手模型", "跟随默认文本模型");
        expect((await saved(page)).at(-1)).toEqual({ key: "assistantModel", value: "" });
        await page.getByRole("button", { name: "助手选择失效" }).click();
        expect(await page.locator('[aria-labelledby="default-assistant-title"] .model-default-select').innerText()).toContain("已选模型不可用");
    } finally {
        await page.close();
    }
}, 30_000);

test("family ordering, search and selectors fit desktop and narrow screens in both themes", async () => {
    const page = await browser.newPage();
    try {
        await page.goto(server.url.toString());
        await page.getByRole("combobox", { name: "默认生图模型系列", exact: true }).click();
        expect(await (await popup(page, "默认生图模型系列")).locator(".ant-select-item-option-content").allTextContents()).toEqual(["全部系列", "Seedream · 即梦图片", "GPT Image", "FLUX"]);
        await page.keyboard.press("Escape");
        await choose(page, "默认生图模型系列", "FLUX");
        const input = page.getByRole("combobox", { name: "默认生图模型", exact: true });
        await input.fill("Variant 159");
        expect(await (await popup(page, "默认生图模型")).locator(".model-default-select-option > span:first-child").allTextContents()).toEqual(["FLUX 2 Variant 159"]);
        await page.keyboard.press("Escape");
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 900 });
            for (let i = 0; i < 2; i++) {
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
                expect(await page.getByRole("combobox").count()).toBe(15);
                await page.getByRole("button", { name: "切换主题" }).click();
            }
        }
    } finally {
        await page.close();
    }
}, 30_000);

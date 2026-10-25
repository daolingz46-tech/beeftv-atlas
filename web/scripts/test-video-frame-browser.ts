// Run with Bun. FFMPEG_PATH may point to the desktop's bundled FFmpeg.
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";

const directory = await mkdtemp(join(tmpdir(), "beeftv-frame-test-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
    const generated = Bun.spawnSync([process.env.FFMPEG_PATH || "ffmpeg", "-v", "error",
        "-f", "lavfi", "-i", "color=red:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=green:s=320x240:r=25:d=1",
        "-f", "lavfi", "-i", "color=blue:s=320x240:r=25:d=1",
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]", "-map", "[out]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", join(directory, "fixture.mp4")]);
    assert.equal(generated.exitCode, 0, generated.stderr.toString());
    const bundled = await Bun.build({
        entrypoints: [resolve("test/fixtures/video-frame-browser.tsx")], target: "browser", outdir: directory,
        plugins: [{ name: "isolated-preview-data", setup(build) {
            // Replace only app data access: the dialog, controls and video decoder are production code.
            build.onLoad({ filter: /services[\\/]file-storage\.ts$/ }, () => ({ contents: "export async function resolveMediaUrl(key, fallback) { return fallback; }", loader: "js" }));
            build.onLoad({ filter: /services[\\/]api[\\/]resources\.ts$/ }, () => ({ contents: "export function resourceIdFromStorageKey() { return ''; }", loader: "js" }));
            build.onLoad({ filter: /services[\\/]resource-blob-cache\.ts$/ }, () => ({ contents: "export async function cacheResourceObjectUrl() { return null; }", loader: "js" }));
            build.onLoad({ filter: /stores[\\/]canvas[\\/]use-canvas-theme-store\.ts$/ }, () => ({ contents: "export function useActiveTheme() { return 'dark'; }", loader: "js" }));
        } }],
    });
    assert.ok(bundled.success, bundled.logs.join("\n"));
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/") return new Response('<div id="root"></div><script type="module" src="/video-frame-browser.js"></script>', { headers: { "Content-Type": "text/html" } });
        if (!["/video-frame-browser.js", "/fixture.mp4"].includes(path)) return new Response("Not found", { status: 404 });
        return new Response(Bun.file(join(directory, path.slice(1))));
    } });
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByRole("button", { name: "提取 3 张图片" }).waitFor();
    await page.getByRole("button", { name: "提取 3 张图片" }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).confirmed), [0, 1000, 2000]);
    const interval = page.getByRole("spinbutton", { name: "抽帧间隔（秒）" });
    await interval.fill("0.5"); await interval.press("Tab");
    await page.getByRole("button", { name: "提取 6 张图片" }).waitFor();
    const sliders = page.getByRole("slider");
    assert.equal(await sliders.nth(0).getAttribute("aria-valuemax"), "3");
    assert.equal(await sliders.nth(1).getAttribute("aria-valuemax"), "3");
    await sliders.nth(1).focus(); await sliders.nth(1).press("End");
    assert.equal(Number(await interval.inputValue()), 3);
    await page.getByRole("button", { name: "提取 1 张图片" }).waitFor();
    const time = page.getByRole("spinbutton", { name: "当前取帧时间（秒）" });
    await time.fill("1.5"); await time.press("Tab");
    assert.equal(await page.locator("video").evaluate(video => (video as HTMLVideoElement).currentTime), 1.5);
    await page.getByRole("button", { name: "当前帧", exact: true }).click();
    await page.getByRole("button", { name: "提取 1 张图片" }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).confirmed), [1500]);
    const result = await page.evaluate(() => (window as any).runCapture());
    assert.deepEqual(result.progress, [1, 2, 3]);
    assert.equal(result.retainedBlobs, 0);
    assert.deepEqual(result.failures, []);
    assert.ok(result.colors[0][0] > 200 && result.colors[0][1] < 30, "first frame red");
    assert.ok(result.colors[1][1] > 90 && result.colors[1][0] < 30, "second frame green");
    assert.ok(result.colors[2][2] > 200 && result.colors[2][0] < 30, "third frame blue");
    assert.deepEqual(errors, []);
    console.log("PASS: interval input, sliders, duration limit, manual selection, RGB decoding, per-frame save and progress");
} finally {
    await browser?.close();
    server?.stop();
    // mkdtemp owns this exact temporary test directory.
    await rm(directory, { recursive: true, force: true });
}

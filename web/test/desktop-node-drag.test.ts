import { expect, test } from "bun:test";
import { buildNodeDragFiles } from "../src/services/desktop-node-drag";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(type: CanvasNodeType, content: string): CanvasNodeData { return { id: "test", type, title: "../测试", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content } }; }
test("text and markup export actual multiline content with matching extensions", () => {
    for (const [type, extension] of [[CanvasNodeType.Text, "txt"], [CanvasNodeType.Markdown, "md"], [CanvasNodeType.Html, "html"], [CanvasNodeType.Svg, "svg"]] as const) expect(buildNodeDragFiles([node(type, "first\nsecond")])).toEqual([{ fileName: `测试.${extension}`, text: "first\nsecond" }]);
});
test("unfinished media cannot fall back to a misleading URL or JSON file", () => {
    const item = buildNodeDragFiles([node(CanvasNodeType.Video, "https://example.com/file.mp4")])[0];
    expect(item.resourceId).toBe(""); expect(item.text).toBeUndefined(); expect(item.fileName).toBe("测试.mp4");
});
test("structured nodes retain their data while excluding credentials", () => {
    const item = node(CanvasNodeType.Chart, "chart");
    item.metadata = { ...item.metadata, pluginData: { series: [1, 2], apiKey: "synthetic-secret", nested: { authorization: "synthetic", caption: "keep" } } };
    const exported = buildNodeDragFiles([item])[0];
    expect(exported.fileName).toBe("测试.json");
    expect(exported.text).not.toContain("synthetic");
    expect(JSON.parse(exported.text!).metadata.pluginData).toEqual({ series: [1, 2], nested: { caption: "keep" } });
});

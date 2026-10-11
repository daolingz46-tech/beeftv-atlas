import { describe, expect, test } from "bun:test";
import { applyCanvasMediaMirror, canMirrorCanvasMedia } from "../src/lib/canvas/canvas-media-mirror";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const source: CanvasNodeData = {
    id: "synthetic", type: CanvasNodeType.Image, title: "Synthetic", position: { x: 100, y: 200 }, width: 300, height: 400,
    metadata: { content: "/original.png", storageKey: "resource:original", assetId: "original-asset", prompt: "Synthetic prompt", taskId: "synthetic-task", taskStatus: "succeeded", status: "success", nodeRole: "result", resultOrigin: "generated", previewContent: "old-preview", arkPrivateAssetUpload: "old-private-asset" },
};
const media = { content: "/mirrored.png", storageKey: "resource:mirrored", naturalWidth: 600, naturalHeight: 800, mimeType: "image/png", bytes: 123, status: "success" as const };

describe("in-place media mirror", () => {
    test("changes the resource and binding, retaining layout, prompt and task receipt", () => {
        const result = applyCanvasMediaMirror(source, source, media, "mirrored-asset", "horizontal");
        expect(result.id).toBe(source.id);
        expect(result.position).toEqual(source.position);
        expect([result.width, result.height]).toEqual([300, 400]);
        expect(result.metadata?.storageKey).toBe("resource:mirrored");
        expect(result.metadata?.assetId).toBe("mirrored-asset");
        expect(result.metadata?.prompt).toBe(source.metadata?.prompt);
        expect(result.metadata?.taskId).toBe("synthetic-task");
        expect(result.metadata?.localMediaEdit?.sourceStorageKey).toBe("resource:original");
        expect(result.metadata?.previewContent).toBeUndefined();
        expect(result.metadata?.arkPrivateAssetUpload).toBeUndefined();
        expect(source.metadata?.storageKey).toBe("resource:original");
    });
    test("does not overwrite a replacement, a changed URL or a different node", () => {
        for (const current of [
            { ...source, metadata: { ...source.metadata, storageKey: "resource:replacement" } },
            { ...source, metadata: { ...source.metadata, content: "/replacement.png" } },
            { ...source, id: "another" },
        ]) expect(applyCanvasMediaMirror(current, source, media, "mirrored-asset", "horizontal")).toBe(current);
    });
    test("locked, empty, uploading and live generation nodes are ineligible", () => {
        for (const metadata of [{}, { ...source.metadata, locked: true }, { ...source.metadata, fileUpload: "uploading" as const }, { ...source.metadata, taskStatus: "running" }, { ...source.metadata, processingLabel: "Processing" }]) {
            const node = { ...source, metadata };
            expect(canMirrorCanvasMedia(node)).toBe(false);
            expect(applyCanvasMediaMirror(node, source, media, "asset", "horizontal")).toBe(node);
        }
        expect(canMirrorCanvasMedia({ ...source, type: CanvasNodeType.Audio })).toBe(false);
    });
    test("video replacement keeps the new poster, audio and duration", () => {
        const video = { ...source, type: CanvasNodeType.Video };
        const result = applyCanvasMediaMirror(video, video, { ...media, mimeType: "video/mp4", durationMs: 2000, hasAudio: true, videoPreview: { content: "/mirrored-poster.png" } }, "video-asset", "vertical");
        expect(result.metadata?.videoPreview?.content).toBe("/mirrored-poster.png");
        expect(result.metadata?.hasAudio).toBe(true);
        expect(result.metadata?.durationMs).toBe(2000);
        expect(result.metadata?.localMediaEdit?.operation).toBe("mirror-vertical");
    });
});

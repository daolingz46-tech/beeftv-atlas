import { isCanvasNodeGenerating } from "./canvas-node-task-state";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export type CanvasMirrorAxis = "horizontal" | "vertical";

export function canMirrorCanvasMedia(node: CanvasNodeData) {
    return (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video)
        && Boolean(node.metadata?.content || node.metadata?.storageKey)
        && !node.metadata?.locked && !node.metadata?.fileUpload && node.metadata?.status !== "loading"
        && !node.metadata?.processingLabel && !isCanvasNodeGenerating(node);
}

/** Apply only to the source that was processed; never overwrite a replacement or a new generation. */
export function applyCanvasMediaMirror(current: CanvasNodeData, source: CanvasNodeData, media: CanvasNodeMetadata, assetId: string, axis: CanvasMirrorAxis): CanvasNodeData {
    if (!canMirrorCanvasMedia(current) || current.id !== source.id || current.type !== source.type
        || current.metadata?.content !== source.metadata?.content
        || current.metadata?.storageKey !== source.metadata?.storageKey) return current;
    return {
        ...current,
        metadata: {
            ...current.metadata, ...media, assetId,
            previewContent: undefined,
            arkPrivateAssetUpload: undefined,
            localMediaEdit: {
                operation: axis === "horizontal" ? "mirror-horizontal" : "mirror-vertical",
                sourceStorageKey: source.metadata?.storageKey,
                sourceContent: source.metadata?.content,
                editedAt: new Date().toISOString(),
            },
        },
    };
}

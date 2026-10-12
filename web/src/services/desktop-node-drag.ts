import { nanoid } from "nanoid";
import { canvasMediaFileExtension, sanitizeDownloadFileName } from "@/lib/canvas/canvas-media-download";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { ownedResourceIdFromMediaRef } from "@/services/api/resources";

export type NodeDragFile = { fileName: string; resourceId?: string; text?: string };

export function buildNodeDragFiles(nodes: CanvasNodeData[]): NodeDragFile[] {
    return nodes.map(node => {
        const content = node.metadata?.content ?? "";
        const title = node.title || "未命名节点";
        if ([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Panorama].includes(node.type as CanvasNodeType)) {
            return { fileName: sanitizeDownloadFileName(`${title}.${canvasMediaFileExtension(node)}`), resourceId: ownedResourceIdFromMediaRef(node.metadata?.storageKey, content) };
        }
        const extensions: Partial<Record<CanvasNodeType, string>> = {
            [CanvasNodeType.Text]: "txt", [CanvasNodeType.Script]: "txt", [CanvasNodeType.Markdown]: "md",
            [CanvasNodeType.Svg]: "svg", [CanvasNodeType.Html]: "html",
        };
        const extension = extensions[node.type as CanvasNodeType];
        // A structured script without prose should retain its storyboard rows.
        if (extension && (content || !node.metadata?.storyboard)) return { fileName: sanitizeDownloadFileName(`${title}.${extension}`), text: content };
        return {
            fileName: sanitizeDownloadFileName(`${title}.json`),
            text: JSON.stringify(node, (key, value) => /api.?key|token|password|secret|authorization|cookie|headers/i.test(key) ? undefined : value, 2),
        };
    });
}

/** Native polling survives the cursor leaving WebView, unlike DOM mousemove.
 * Keep cancellation and event subscription tied to this one held gesture. */
export function armDesktopNodeDrag(nodes: CanvasNodeData[], onTakeOver: () => void, onError: (text: string) => void): (() => void) | undefined {
    const binding = window.go?.main?.DesktopApp;
    const runtime = (window as unknown as { runtime?: { EventsOn?: (name: string, callback: (id: string) => void) => () => void } }).runtime;
    if (!binding?.ArmNodeFileDrag || !binding.CancelNodeFileDrag || !runtime?.EventsOn) return;
    const id = nanoid();
    let takenOver = false;
    let settled = false;
    const unsubscribe = runtime.EventsOn("desktop:node-file-drag", (gestureId) => {
        if (gestureId !== id || settled) return;
        takenOver = true;
        onTakeOver();
    });
    void binding.ArmNodeFileDrag(id, buildNodeDragFiles(nodes))
        .catch(error => onError(typeof error === "string" ? error : error instanceof Error ? error.message : "文件拖出失败"))
        .finally(() => { settled = true; unsubscribe(); });
    return () => {
        if (!takenOver && !settled) void binding.CancelNodeFileDrag!(id).catch(() => {});
        // Do not remove the listener on blur: Windows may have taken over just
        // before its event reaches WebView. Native cancellation checks started.
    };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";
import { applyCanvasMediaMirror, canMirrorCanvasMedia, type CanvasMirrorAxis } from "@/lib/canvas/canvas-media-mirror";
import { mirrorImageBlob } from "@/lib/canvas/canvas-image-data";
import { mirrorVideo } from "@/lib/canvas/canvas-video-segment";
import { imageMetadata, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function useCanvasMediaMirror({ projectId, domainProjectId, nodesRef, updateNode }: {
    projectId: string;
    domainProjectId?: string;
    nodesRef: { current: CanvasNodeData[] };
    updateNode: (id: string, update: (node: CanvasNodeData) => CanvasNodeData) => void;
}) {
    const { message } = App.useApp();
    const busyRef = useRef(false);
    const sessionRef = useRef<AbortController | null>(null);
    const [mirroring, setMirroring] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        sessionRef.current = controller;
        return () => controller.abort();
    }, [projectId]);

    const mirrorNode = useCallback(async (target: CanvasNodeData, axis: CanvasMirrorAxis) => {
        const source = nodesRef.current.find((node) => node.id === target.id);
        const signal = sessionRef.current?.signal;
        if (!source || !canMirrorCanvasMedia(source) || busyRef.current || !signal || signal.aborted) return;
        busyRef.current = true;
        setMirroring(true);
        const key = `mirror-${source.id}`;
        const showProgress = (content: string) => { if (!signal.aborted) message.open({ key, type: "loading", content, duration: 0 }); };
        try {
            showProgress("正在镜像素材…");
            const media = source.type === CanvasNodeType.Image
                ? imageMetadata(await uploadImage(await mirrorImageBlob(await resolveImageUrl(source.metadata?.storageKey, source.metadata?.content, { cacheMiss: true }), axis)))
                : videoMetadata(await uploadMediaFile(await mirrorVideo({ storageKey: source.metadata?.storageKey, url: source.metadata?.content }, axis, ({ phase, progress }) => {
                    showProgress(phase === "loading" ? "正在加载视频镜像工具…" : phase === "reading" ? "正在读取视频…" : `正在镜像视频 ${progress}%`);
                }), "video"));
            if (signal.aborted) return;
            const current = nodesRef.current.find((node) => node.id === source.id);
            if (!current || applyCanvasMediaMirror(current, source, media, "", axis) === current) {
                message.warning("节点素材已改变，本次镜像未覆盖当前内容");
                return;
            }
            showProgress("正在保存镜像结果…");
            // Register a new Asset by resource, while retaining the original task receipt on the node.
            const candidate = applyCanvasMediaMirror(current, source, media, "", axis);
            const result = await ensureCanvasNodeAsset({ canvasId: projectId, domainProjectId, source: "canvas-manual", signal,
                node: { ...candidate, metadata: { ...candidate.metadata, assetId: undefined, taskId: undefined } },
            });
            if (signal.aborted) return;
            const latest = nodesRef.current.find((node) => node.id === source.id);
            if (!latest || applyCanvasMediaMirror(latest, source, media, result.assetId, axis) === latest) {
                message.warning("节点素材已改变，本次镜像未覆盖当前内容");
                return;
            }
            updateNode(source.id, (latest) => applyCanvasMediaMirror(latest, source, media, result.assetId, axis));
            message.success("镜像完成，可用撤销恢复");
        } catch (error) {
            if (!signal.aborted) message.error(error instanceof Error ? error.message : "镜像失败，请重试");
        } finally {
            message.destroy(key);
            busyRef.current = false;
            setMirroring(false);
        }
    }, [domainProjectId, message, nodesRef, projectId, updateNode]);
    return { mirrorNode, mirroring };
}

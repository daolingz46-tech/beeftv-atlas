import { useEffect, useState, type ReactNode } from "react";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import { resolveImageUrl } from "@/services/image-storage";
import type { CanvasNodeData } from "@/types/canvas";

/** Native image tags cannot send the desktop token. Materialize owned resources first. */
export function CanvasImageToolSource({ node, onClose, children }: {
    node: CanvasNodeData;
    onClose: () => void;
    children: (url: string) => ReactNode;
}) {
    const storageKey = node.metadata?.storageKey;
    const content = node.metadata?.content || "";
    const identity = `${node.id}:${storageKey || ""}:${content}`;
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState({ identity: "", url: "", error: "" });
    useEffect(() => {
        let active = true;
        setState({ identity, url: "", error: "" });
        const resolve = async () => {
            const resourceId = ownedResourceIdFromMediaRef(storageKey, content);
            const url = resourceId
                ? await cacheResourceObjectUrl(resourceStorageKey(resourceId))
                : await resolveImageUrl(storageKey, content, { cacheMiss: true });
            if (!url) throw new Error("无法读取图片素材，请重试");
            await new Promise<void>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve();
                image.onerror = () => reject(new Error("图片加载失败，请重试或重新导入素材"));
                image.src = url;
            });
            if (active) setState({ identity, url, error: "" });
        };
        void resolve().catch((error) => {
            if (active) setState({ identity, url: "", error: error instanceof Error ? error.message : "图片加载失败，请重试" });
        });
        return () => { active = false; };
    }, [attempt, content, identity, storageKey]);
    if (state.identity === identity && state.url) return children(state.url);
    const error = state.identity === identity ? state.error : "";
    return <div data-canvas-no-zoom className="aceternity-floating-panel flex min-h-48 flex-col items-center justify-center gap-3 rounded-[var(--r-2xl)] p-6" onPointerDown={(event) => event.stopPropagation()}>
        <span role={error ? "alert" : "status"}>{error || "正在加载图片…"}</span>
        <div className="flex gap-3">
            {error ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试加载</button> : null}
            <button type="button" onClick={onClose}>关闭</button>
        </div>
    </div>;
}

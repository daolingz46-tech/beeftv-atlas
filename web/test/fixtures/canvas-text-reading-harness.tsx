import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CanvasNodeContent } from "@/components/canvas/canvas-node-content";
import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasThemeStore } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");
useCanvasThemeStore.setState({ active: true, theme });
const text = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：这是一份完整的口播脚本，需要上下滚动阅读。`).join("\n");
const reference: CanvasResourceReference = { id: "ref", nodeId: "source", kind: "text", label: "文本1", title: "参考脚本", text: "参考内容", active: true };
const references = [reference];
const mode = params.get("mode") || "text";
const nodeType = mode === "image" ? CanvasNodeType.Image : mode === "video" ? CanvasNodeType.Video : mode === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Text;

function Harness() {
    const containerRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const [selected, setSelected] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [node, setNode] = useState<CanvasNodeData>({ id: "composer", type: nodeType, title: "草稿", position: { x: 0, y: 0 }, width: 420, height: 240, metadata: { composerContent: "@文本1\n" + text } });
    const onPromptChange = useCallback((_id: string, value: string) => setNode(current => ({ ...current, metadata: { ...current.metadata, composerContent: value } })), []);
    const onConfigChange = useCallback((_id: string, patch: object) => setNode(current => ({ ...current, metadata: { ...current.metadata, ...patch } })), []);
    Object.assign(window, { textReadingFixture: { prompt: () => node.metadata?.composerContent, viewport: () => viewport, deselect: () => setSelected(null), edit: () => { setSelected("plain"); setEditing(true); } } });
    return <App><QueryClientProvider client={new QueryClient()}>
        <div style={{ width: "100vw", height: "100vh" }}>
            <InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportChange={setViewport} onCanvasDeselect={() => setSelected(null)}>
                {["plain", "rich"].map((id, index) => <div key={id} data-node-id={id} data-reader={id} onPointerDown={() => setSelected(id)} style={{ position: "absolute", left: 30 + index * 450, top: 30, width: 420, height: 260, background: canvasThemes[theme].node.fill }}>
                    <CanvasNodeContent node={{ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 420, height: 260, metadata: { content: text, ...(id === "rich" ? { richText: { type: "doc", content: text.split("\n").map(line => ({ type: "paragraph", content: [{ type: "text", text: line }] })) } } : {}) } }} theme={canvasThemes[theme]} isSelected={selected === id} isEditingContent={id === "plain" && editing} textareaRef={textareaRef} isBatchRoot={false} batchCount={0} batchExpanded={false} batchOpening={false} batchRecovering={false} mentionReferences={[]} onContentChange={() => {}} onStopEditing={() => setEditing(false)} />
                </div>)}
            </InfiniteCanvas>
            <div data-composer-fixture style={{ position: "fixed", left: 30, bottom: 25, width: 800 }}>
                <CanvasNodePromptPanel projectId="synthetic" addedSkills={[]} node={node} isRunning={false} onPromptChange={onPromptChange} onConfigChange={onConfigChange} onGenerate={() => { throw Error("Generation must not run in this fixture"); }} mentionReferences={references} />
            </div>
        </div>
    </QueryClientProvider></App>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

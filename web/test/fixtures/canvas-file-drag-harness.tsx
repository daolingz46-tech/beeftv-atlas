import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCanvasSelectionController } from "@/pages/canvas/use-canvas-selection-controller";
import { armDesktopNodeDrag, buildNodeDragFiles } from "@/services/desktop-node-drag";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const fixture = {
    calls: [] as Array<{ id: string; files: ReturnType<typeof buildNodeDragFiles>; immediate: boolean }>,
    cancellations: [] as string[], errors: [] as string[], duplicates: 0,
    takeover: () => {}, settle: (_result: string) => {},
};
const listeners = new Set<(id: string) => void>();
(window as any).runtime = { EventsOn: (_name: string, listener: (id: string) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
(window as any).go = { main: { DesktopApp: {
    ArmNodeFileDrag: (id: string, files: ReturnType<typeof buildNodeDragFiles>, immediate: boolean) => {
        fixture.calls.push({ id, files, immediate });
        let taken = false;
        fixture.takeover = () => { taken = true; for (const listener of listeners) listener(id); };
        return new Promise<string>(resolve => { fixture.settle = resolve; (fixture as any).cancel = (target: string) => { if (target === id && !taken) resolve("cancelled"); }; });
    },
    CancelNodeFileDrag: async (id: string) => { fixture.cancellations.push(id); (fixture as any).cancel?.(id); },
} } };
(window as any).fileDragFixture = fixture;
const noop = () => {};

function Harness() {
    const [nodes, setNodes] = useState<CanvasNodeData[]>([
        { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 100, y: 100 }, width: 120, height: 100, parentId: "outside-frame", metadata: { storageKey: "resource:owned-image", mimeType: "image/png" } },
        { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 300, y: 100 }, width: 120, height: 100, metadata: { storageKey: "resource:owned-video", mimeType: "video/mp4" } },
        { id: "text", type: CanvasNodeType.Text, title: "剧本", position: { x: 500, y: 100 }, width: 120, height: 100, metadata: { content: "第一行\n第二行" } },
    ]);
    const containerRef = useRef<HTMLDivElement>(null), nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const viewportRef = useRef({ x: 0, y: 0, k: 1 }), historyPausedRef = useRef(false);
    const [selected, setSelected] = useState(new Set<string>()), selectedNodeIdsRef = useRef(selected);
    selectedNodeIdsRef.current = selected;
    const ctrl = useCanvasSelectionController({ containerRef, nodesRef, viewportRef, selectedNodeIdsRef, historyPausedRef, screenToCanvas: (x, y) => ({ x, y }), setNodes, setSelectedNodeIds: setSelected, setSelectedConnectionId: noop, cancelPendingConnectionCreate: noop, onCanvasSelectionStart: noop, onNodeInteractionStart: noop, onNodeClick: noop, onDeselect: noop,
        onDuplicateDrag: () => { fixture.duplicates++; },
        onNodeFileDrag: (items, takeover, immediate) => armDesktopNodeDrag(items, takeover, text => fixture.errors.push(text), immediate),
    });
    return <div ref={containerRef} style={{ position: "absolute", inset: 0 }}>
        <button onClick={() => { const all = new Set(nodes.map(node => node.id)); selectedNodeIdsRef.current = all; setSelected(all); }}>全选</button>
        <output id="state">{JSON.stringify({ nodes, dragging: ctrl.isNodeDragging, paused: historyPausedRef.current })}</output>
        {nodes.map(node => <div key={node.id} data-node-id={node.id} data-canvas-node-root="true" onMouseDown={event => ctrl.handleNodeMouseDown(event, node.id)} style={{ position: "absolute", left: node.position.x, top: node.position.y, width: node.width, height: node.height, background: "#777" }}>{node.title}
            <div data-node-file-drag={node.type !== CanvasNodeType.Text ? "true" : undefined} style={{ height: 60 }}>产物画面<button aria-label={`${node.id}-播放`}>播放</button></div>
        </div>)}
    </div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { useCanvasSelectionController } from "@/pages/canvas/use-canvas-selection-controller";
import { useCanvasNodeOperations } from "@/pages/canvas/use-canvas-node-operations";
import { useCanvasHistory } from "@/pages/canvas/use-canvas-history";
import { canvasAppearanceForTheme } from "@/lib/canvas/canvas-appearance";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const noop = () => {};
const appearance = canvasAppearanceForTheme("dark");
const chats: [] = [];
const node = (id: string, type: CanvasNodeType, x: number, y: number, extra = {}): CanvasNodeData => ({
    id, type, title: id, position: { x, y }, width: 120, height: 90,
    metadata: { content: `https://example.invalid/${id}`, storageKey: `resource:${id}`, status: "success", taskId: "source-task", generationEffectKeys: ["source-effect"] }, ...extra,
});
const initial = [node("image", CanvasNodeType.Image, 40, 60), node("video", CanvasNodeType.Video, 200, 60),
    node("frame", CanvasNodeType.Frame, 40, 210, { width: 400, height: 150, metadata: { frame: {} } }),
    node("child", CanvasNodeType.Image, 80, 250, { parentId: "frame" }),
    node("reference", CanvasNodeType.Image, 520, 60, { metadata: { locked: true } })];
function Harness() {
    const [nodes, setNodes] = useState(initial);
    const [connections, setConnections] = useState<CanvasConnection[]>([
        { id: "external-edge", fromNodeId: "reference", toNodeId: "image" },
        { id: "internal-edge", fromNodeId: "image", toNodeId: "video" },
    ] as CanvasConnection[]);
    const [selected, setSelected] = useState(new Set<string>());
    const nodesRef = useRef(nodes); nodesRef.current = nodes;
    const connectionsRef = useRef(connections); connectionsRef.current = connections;
    const selectedNodeIdsRef = useRef(selected); selectedNodeIdsRef.current = selected;
    const containerRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef({ x: 0, y: 0, k: 2 });
    const history = useCanvasHistory({ projectLoaded: true, nodes, connections, chatSessions: chats, activeChatId: null,
        canvasAppearance: appearance, backgroundMode: "grid", showImageInfo: false, setNodes, setConnections,
        setChatSessions: noop, setActiveChatId: noop, applyCanvasAppearance: noop, setBackgroundMode: noop, setShowImageInfo: noop,
        setSelectedNodeIds: setSelected, setSelectedConnectionId: noop, setContextMenu: noop });
    useEffect(() => { history.resetHistory({ nodes: initial, connections, chatSessions: chats, activeChatId: null,
        canvasAppearance: appearance, backgroundMode: "grid", showImageInfo: false }); }, []);
    const operations = useCanvasNodeOperations({ projectId: "synthetic", defaultDrawingEngine: "excalidraw", nodesRef, connectionsRef,
        selectedNodeIdsRef, getCanvasCenter: () => ({ x: 0, y: 0 }), setNodes, setConnections, setSelectedNodeIds: setSelected,
        setSelectedConnectionId: noop, setContextMenu: noop, setDialogNodeId: noop, onNodesDeleted: noop });
    const controller = useCanvasSelectionController({ containerRef, nodesRef, viewportRef, selectedNodeIdsRef,
        historyPausedRef: history.historyPausedRef, screenToCanvas: (x, y) => ({ x: x / 2, y: y / 2 }), setNodes,
        setSelectedNodeIds: setSelected, setSelectedConnectionId: noop, cancelPendingConnectionCreate: noop,
        onCanvasSelectionStart: noop, onNodeInteractionStart: noop, onNodeClick: noop, onDeselect: noop,
        onDuplicateDrag: operations.duplicateNodesAtOffset });
    return <>
        <div ref={containerRef} onPointerDown={controller.handleCanvasMouseDown} style={{ position: "absolute", inset: 0 }}>
            <div data-canvas-world-layer style={{ transform: "scale(2)", transformOrigin: "0 0" }}>
                {nodes.map((node) => <div key={node.id} data-node-id={node.id} onPointerDown={(event) => controller.handleNodeMouseDown(event, node.id)}
                    style={{ position: "absolute", transform: `translate(${node.position.x}px, ${node.position.y}px)`, width: node.width, height: node.height,
                        background: node.type === "frame" ? "#999" : "#345", color: "white", outline: selected.has(node.id) ? "2px solid cyan" : "none", userSelect: "none" }}>
                    {node.title}
                </div>)}
            </div>
        </div>
        <div style={{ position: "fixed", top: 0, right: 0 }}><button onClick={history.undoCanvas}>undo</button><button onClick={history.redoCanvas}>redo</button>
            <output id="state">{JSON.stringify({ nodes, connections, selected: [...selected], paused: history.historyPausedRef.current, ...history.historyState })}</output></div>
    </>;
}
createRoot(document.getElementById("root")!).render(<App><Harness /></App>);

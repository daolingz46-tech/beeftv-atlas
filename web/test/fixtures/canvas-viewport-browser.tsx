import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { InfiniteCanvas } from "../../src/components/canvas/infinite-canvas";
import { useCanvasViewportController } from "../../src/pages/canvas/use-canvas-viewport-controller";
import { CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT } from "../../src/lib/canvas/canvas-live-viewport";

const stats = { previews: [] as { x: number; y: number; k: number; at: number }[], commits: [] as number[], renders: 0, lastInput: 0 };
Object.assign(window, { canvasStats: stats });

function Repro() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const viewportRef = useRef(viewport);
    const nodesRef = useRef([]);
    const selectedNodeIdsRef = useRef(new Set<string>());
    const controller = useCanvasViewportController({ containerRef, size: { width: 1200, height: 800 }, viewportRef, nodesRef, selectedNodeIdsRef, setViewport,
        setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, setContextMenu: () => {}, setDialogNodeId: () => {}, setToolbarNodeId: () => {} });
    stats.renders++;
    useEffect(() => {
        const container = containerRef.current!;
        container.addEventListener(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, (event) => stats.previews.push({ ...(event as CustomEvent).detail, at: performance.now() }));
        container.addEventListener("wheel", () => { stats.lastInput = performance.now(); });
        Object.assign(window, { canvasReady: true });
    }, []);
    return <InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportPreviewChange={controller.handleViewportPreviewChange}
        onViewportChange={(next) => { stats.commits.push(performance.now()); controller.handleViewportChange(next); }}>
        {Array.from({ length: 200 }, (_, i) => <div key={i} data-node-id={i} style={{ position: "absolute", left: (i % 20) * 150, top: Math.floor(i / 20) * 110, width: 130, height: 90, background: "#234", border: "1px solid #789" }}>Node {i}</div>)}
    </InfiniteCanvas>;
}

createRoot(document.getElementById("root")!).render(<Repro />);

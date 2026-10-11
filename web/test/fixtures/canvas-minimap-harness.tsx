import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { configureApiRuntime } from "@/services/api/request";

configureApiRuntime("/api", "synthetic-minimap-token");

const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');
const nodes: CanvasNodeData[] = Array.from({ length: 30 }, (_, i) => ({ id: String(i), type: CanvasNodeType.Image, title: `image-${i}`, position: { x: (i % 6) * 400, y: Math.floor(i / 6) * 500 }, width: 300, height: 400, metadata: { content: image } }));
nodes.forEach((node, i) => {
    if (i % 2 === 0) node.metadata = { storageKey: `resource:synthetic-${i}`, content: "http://127.0.0.1:1/stale-image.png" };
});
nodes.push({ id: "hidden-batch-image", type: CanvasNodeType.Image, title: "hidden", position: { x: 0, y: 0 }, width: 300, height: 400, metadata: { content: image, batchRootId: "0" } });
if (new URLSearchParams(window.location.search).has("tiny")) nodes.push({ id: "far-text", type: CanvasNodeType.Text, title: "far", position: { x: 6500, y: 20000 }, width: 300, height: 300 });
function Harness() {
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    return <main style={{ position: "relative", width: 1000, height: 600 }}><Minimap nodes={nodes} viewport={viewport} viewportSize={{ width: 1000, height: 600 }} onViewportPreviewChange={setViewport} onViewportChange={setViewport} /><output>{JSON.stringify(viewport)}</output></main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

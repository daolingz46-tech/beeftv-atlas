import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "antd";
import { CanvasVideoFrameDialog } from "../../src/components/canvas/canvas-video-frame-dialog";
import { captureVideoFrames, planVideoFrameInterval } from "../../src/lib/canvas/canvas-video-frame";
import { CanvasNodeType } from "../../src/types/canvas";

const state = window as typeof window & { confirmed?: number[]; runCapture?: () => Promise<unknown> };
createRoot(document.getElementById("root")!).render(<App><CanvasVideoFrameDialog
    open node={{ id: "fixture", type: CanvasNodeType.Video, title: "三秒测试视频", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/fixture.mp4" } }}
    onClose={() => undefined} onConfirm={({ timesMs }) => { state.confirmed = timesMs; }}
/></App>);

state.runCapture = async () => {
    const colors: number[][] = [];
    const progress: number[] = [];
    const result = await captureVideoFrames("/fixture.mp4", planVideoFrameInterval(3000, 1000).timesMs, {
        onFrame: async (frame) => {
            const bitmap = await createImageBitmap(frame.blob);
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext("2d")!;
            context.drawImage(bitmap, 0, 0);
            colors.push(Array.from(context.getImageData(160, 120, 1, 1).data).slice(0, 3));
            bitmap.close();
        },
        onProgress: (completed) => progress.push(completed),
    });
    return { colors, progress, retainedBlobs: result.frames.length, failures: result.failures };
};

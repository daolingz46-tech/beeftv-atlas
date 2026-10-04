import type { ViewportTransform } from "@/types/canvas";

export const CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS = 64;

export function shouldRefreshCanvasVirtualization(rendered: ViewportTransform, next: ViewportTransform, lastRefreshAt: number, now: number, size = { width: 0, height: 0 }) {
    if (rendered.x === next.x && rendered.y === next.y && rendered.k === next.k) return false;
    if (now - lastRefreshAt < CANVAS_VIRTUALIZATION_REFRESH_INTERVAL_MS) return false;
    // 已挂载节点有至少 128px 预留区；只在新视野接近预留区边缘时更新 React。
    // 缩放放大且仍在旧视野内时直接复用节点，手势结束会提交最终倍率。
    const ratio = next.k / rendered.k;
    const left = next.x - rendered.x * ratio;
    const top = next.y - rendered.y * ratio;
    const right = left + size.width * ratio;
    const bottom = top + size.height * ratio;
    return left > 96 || top > 96 || right < size.width - 96 || bottom < size.height - 96;
}

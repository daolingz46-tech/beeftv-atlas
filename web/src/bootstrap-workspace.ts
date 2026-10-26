import { bootstrapAppearance } from "@/services/appearance-bootstrap";
import { bootstrapDesktopRuntime } from "@/services/desktop-runtime";
import { hydrateLocalCanvasProjectsFromBackend } from "@/services/local-workspace-repository";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { enableWorkspaceCacheRecovery, workspaceCacheRecoveryStores } from "@/lib/workspace-cache-recovery";
import { getCanvasHydrationHealth } from "@/services/canvas-hydration-health";

export async function startApplication() {
    enableWorkspaceCacheRecovery(await bootstrapDesktopRuntime());
    // 浏览器缓存晚于后端读入完成时，会用旧连接数组盖掉刚合并的画布。
    await useCanvasStore.persist.rehydrate();
    await hydrateLocalCanvasProjectsFromBackend();
    if (getCanvasHydrationHealth().error && workspaceCacheRecoveryStores().includes("infinite-canvas:canvas_store")) {
        throw new Error("画布缓存不可读，尚未完成本机项目库恢复，请重试");
    }
    await bootstrapAppearance().catch(() => console.warn("外观初始化未完成，继续打开工作区"));
    await import("./application");
}

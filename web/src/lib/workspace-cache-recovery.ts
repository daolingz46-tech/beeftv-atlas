// Only these two stores are projections of the desktop SQLite workspace.
// Journals, drafts, history, media blobs and model credentials must never use this fallback.
const recoverableStores = new Set(["infinite-canvas:canvas_store", "infinite-canvas:asset_store"]);
let desktopEnabled = false;
const damagedStores = new Set<string>();

export function enableWorkspaceCacheRecovery(enabled: boolean) { desktopEnabled = enabled; }
export function workspaceCacheRecoveryStores() { return [...damagedStores]; }

export async function readWorkspaceCache<T>(name: string, read: () => Promise<T>): Promise<T | null> {
    try {
        return await read();
    } catch (error) {
        if (!desktopEnabled || !recoverableStores.has(name) || !(error instanceof DOMException) || error.name !== "NotReadableError") throw error;
        damagedStores.add(name);
        return null;
    }
}

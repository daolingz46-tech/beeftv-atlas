import { expect, test } from "bun:test";
import { enableWorkspaceCacheRecovery, readWorkspaceCache, workspaceCacheRecoveryStores } from "../src/lib/workspace-cache-recovery";

test("desktop can reload irrecoverable projection records but not drafts or credentials", async () => {
    enableWorkspaceCacheRecovery(true);
    const broken = () => Promise.reject(new DOMException("Missing backing file", "NotReadableError"));
    expect(await readWorkspaceCache("infinite-canvas:canvas_store", broken)).toBeNull();
    expect(await readWorkspaceCache("infinite-canvas:asset_store", broken)).toBeNull();
    expect(workspaceCacheRecoveryStores()).toHaveLength(2);
    for (const key of ["canvas-document-journal:1", "infinite-canvas:asset_store_drafts", "model-config", "infinite-canvas:deleted_history_store"]) {
        await expect(readWorkspaceCache(key, broken)).rejects.toThrow("Missing backing file");
    }
});
test("valid records and unrelated storage errors retain their original semantics", async () => {
    expect(await readWorkspaceCache("infinite-canvas:canvas_store", async () => "original")).toBe("original");
    await expect(readWorkspaceCache("infinite-canvas:canvas_store", async () => { throw new DOMException("Disk full", "QuotaExceededError"); })).rejects.toThrow("Disk full");
    enableWorkspaceCacheRecovery(false);
    await expect(readWorkspaceCache("infinite-canvas:canvas_store", async () => { throw new DOMException("Missing backing file", "NotReadableError"); })).rejects.toThrow("Missing backing file");
});

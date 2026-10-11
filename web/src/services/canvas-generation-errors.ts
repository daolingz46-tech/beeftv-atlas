export class CanvasGenerationDurableAckError extends Error {
    readonly code = "canvas_conflict";
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("生成结果已保留，画布尚未更新");
        this.name = "CanvasGenerationDurableAckError";
        this.cause = cause;
    }
}

export class CanvasGenerationTargetSaveError extends Error {
    constructor(cause?: unknown, message = "画布尚未保存，未开始生成。请先处理画布保存提示后重试。") {
        const conflict = cause instanceof Error && cause.name === "CanvasBackendSubmitPausedError";
        super(conflict ? "画布版本冲突，未开始生成。请点击顶栏保存状态，保留当前内容为副本后继续，或加载最新版本。" : message, { cause });
        this.name = "CanvasGenerationTargetSaveError";
    }
}

import { expect, test } from "bun:test";
import { ApiError } from "@/services/api/request";
import { explainGenerationError, formatGenerationDiagnostics, generationFailureMetadata } from "@/lib/generation-error";

test("deleted or cleared canvas fails local admission, rather than blaming model parameters", () => {
    const failure = new ApiError("当前画布或项目不可用，无法创建生成任务", { status: 400, reason: "task_scope_unavailable" });
    const explanation = explainGenerationError(failure);
    expect(explanation.category).toBe("workspace_unavailable");
    expect(explanation.reason).toContain("尚未提交生成");
    expect(explanation.action).toContain("画布列表");
    expect(explanation.requestId).toBeUndefined();
    expect(explanation.retryable).toBe(false);
    expect(explanation.blockAutomaticRetry).toBe(true);
    const diagnostics = formatGenerationDiagnostics(explanation);
    expect(diagnostics).toContain("错误来源：本机画布或项目校验");
    expect(diagnostics).toContain("请求 ID：未发起模型请求");
    expect(generationFailureMetadata(failure, "prompt").generationErrorCode).toBe("workspace_unavailable");
});

test("existing local failure summaries render correctly; real upstream 400 remains invalid params", () => {
    const legacy = explainGenerationError({ code: "invalid_params", message: "模型不接受当前参数" }, { errorSummary: "当前画布或项目不可用，无法创建生成任务" });
    expect(legacy.category).toBe("workspace_unavailable");
    expect(explainGenerationError({ status: 400, message: "invalid video duration" }).category).toBe("invalid_params");
    const archived = explainGenerationError(new ApiError("项目已归档，无法创建生成任务", { status: 400, reason: "task_scope_archived" }));
    expect(archived.reason).toContain("归档");
    expect(archived.action).toContain("取消项目归档");
});

import { useEffect, useMemo, useRef, useState } from "react";
import { buildNodeGenerationContext, hydrateNodeGenerationContext } from "./canvas-node-generation";
import { modelGroupReferenceLimits } from "@/lib/model-selection";
import { prepareBackendGenerationTask, backendProviderConfig } from "@/services/api/generation-task";
import { estimateModelCost, type ModelCostEstimate } from "@/services/api/model-cost";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { BackendGenerationMode } from "@/services/api/generation-task";
import { getGenerationCount } from "@/lib/canvas/canvas-project-generation";
import { buildCanvasGenerationPrompt, prepareCanvasGenerationContent } from "@/services/canvas-generation-preparation";
import type { Skill } from "@/services/api/skills";

type QuoteState = { key: string; status: "loading" | "ready" | "error"; quote?: ModelCostEstimate; error?: string };

export function useGenerationCostEstimate(projectId: string, node: CanvasNodeData, config: AiConfig, prompt: string, mode: BackendGenerationMode, addedSkills: Skill[]) {
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const assets = useAssetStore((state) => state.assets);
    const request = resolveModelRequestConfig(config, config.model);
    let atlas = false;
    try { atlas = new URL(request.baseUrl).hostname === "api.atlascloud.ai" && (mode === "text" || !config.taskWorkflowProvider || config.taskWorkflowProvider === "model"); } catch { /* An incomplete channel has no quote. */ }
    const count = mode === "image" ? getGenerationCount(config.count) : mode === "text" ? getGenerationCount(String(node.metadata?.textCount ?? 1)) : 1;
    const context = useMemo(() => {
        if (!atlas || !prompt.trim()) return null;
        try {
            const generationPrompt = buildCanvasGenerationPrompt(node, prompt.trim(), mode);
            return { value: buildNodeGenerationContext(node.id, project?.nodes || [node], project?.connections || [], generationPrompt, assets, mode === "video") };
        } catch (error) { return { error: error instanceof Error ? error.message : "参考素材未准备完成" }; }
    }, [atlas, prompt, node, project, assets, mode]);
    const metadata = { videoEditOperation: node.metadata?.videoEditOperation, videoStartFrameNodeId: node.metadata?.videoStartFrameNodeId, videoEndFrameNodeId: node.metadata?.videoEndFrameNodeId };
    const styleNode = project?.nodes.find((item) => item.metadata?.workflowKind === "styleboard");
    const key = atlas && prompt.trim() ? JSON.stringify({ mode, count, context, config: backendProviderConfig(config, mode), metadata, skills: addedSkills.map(({ skillId, skillName, isAdded, versionId, contentHash, updatedAt }) => ({ skillId, skillName, isAdded, versionId, contentHash, updatedAt })), style: styleNode ? { title: styleNode.title, metadata: styleNode.metadata } : undefined }) : "";
    const current = useRef({ context, config, metadata, project, mode, count, node, addedSkills });
    current.current = { context, config, metadata, project, mode, count, node, addedSkills };
    const [state, setState] = useState<QuoteState | null>(null);
    const [retry, setRetry] = useState(0);
    const quotes = useRef(new Map<string, { expires: number; quote: ModelCostEstimate }>());
    const cached = key ? quotes.current.get(key) : undefined;
    const cachedQuote = cached && cached.expires > Date.now() ? cached.quote : undefined;
    useEffect(() => {
        if (!key) { setState(null); return; }
        const cached = quotes.current.get(key);
        if (cached && cached.expires > Date.now()) { setState({ key, status: "ready", quote: cached.quote }); return; }
        const controller = new AbortController();
        setState({ key, status: "loading" });
        const timer = window.setTimeout(async () => {
            try {
                const { context, config, metadata, project, mode, count, node, addedSkills } = current.current;
                if (!context?.value) throw new Error(context?.error || "请先准备参考素材");
                const limits = modelGroupReferenceLimits(config, config.model, mode);
                const hydrated = await hydrateNodeGenerationContext(context.value, projectId, project?.projectId, mode, mode === "video" && Boolean(limits?.maxAudios), mode !== "video", limits, true);
                const prepared = await prepareCanvasGenerationContent({ context: hydrated, config, nodes: project?.nodes || [node], sourceNode: node, mode, skills: addedSkills });
                const quoteConfig = mode === "image" ? { ...prepared.generationConfig, count: "1" } : prepared.generationConfig;
                const task = await prepareBackendGenerationTask({ projectId, mode, prompt: prepared.effectivePrompt, config: quoteConfig, referenceImages: hydrated.referenceImages, referenceVideos: hydrated.referenceVideos, referenceAudios: hydrated.referenceAudios, metadata: { ...metadata, ...prepared.styleMetadata, ...prepared.skillMetadata }, signal: controller.signal });
                const quote = await estimateModelCost(task.input, controller.signal);
                if (!controller.signal.aborted) {
                    const total = { ...quote, price: quote.price * count };
                    if (quotes.current.size >= 64) quotes.current.delete(quotes.current.keys().next().value!);
                    quotes.current.set(key, { expires: Date.now() + 60000, quote: total });
                    setState({ key, status: "ready", quote: total });
                }
            } catch (error) {
                if (!controller.signal.aborted) setState({ key, status: "error", error: error instanceof Error ? error.message : "暂时无法预估费用" });
            }
        }, 200);
        return () => { window.clearTimeout(timer); controller.abort(); };
    }, [key, retry, projectId]);
    // Quotes refresh periodically, and changed inputs cannot reuse an earlier price.
    useEffect(() => {
        if (!atlas || !key || state?.key !== key || state.status !== "ready") return;
        const timer = window.setInterval(() => { quotes.current.delete(key); setRetry((value) => value + 1); }, 60000);
        return () => window.clearInterval(timer);
    }, [atlas, key, state?.key, state?.status]);
    return { atlas, count, status: !key ? "empty" : cachedQuote ? "ready" : state?.key === key ? state.status : "loading", quote: cachedQuote || (state?.key === key ? state.quote : undefined), error: state?.key === key ? state.error : undefined, refresh: () => { quotes.current.delete(key); setRetry((value) => value + 1); } };
}

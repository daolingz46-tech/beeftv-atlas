import type { hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildPortraitTexturePrompt } from "@/lib/canvas/canvas-portrait-texture";
import { buildCameraPrompt } from "@/lib/canvas/camera-prompt-library";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { modelPromptLengthError } from "@/lib/model-selection";
import { buildTextRewritePrompt } from "@/lib/prompts";
import type { Skill } from "@/services/api/skills";
import type { BackendGenerationMode } from "@/services/api/generation-task";
import { skillRuntime } from "@/services/skill-runtime";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function buildCanvasGenerationPrompt(node: CanvasNodeData | undefined, prompt: string, mode: BackendGenerationMode) {
    if (mode === "text" && node?.type === CanvasNodeType.Text && node.metadata?.content?.trim()) {
        return buildTextRewritePrompt(node.metadata.content.trim(), prompt);
    }
    let result = mode === "image" && node?.metadata?.portraitTexture ? buildPortraitTexturePrompt(prompt, node.metadata.portraitTexture) : prompt;
    if (mode === "image" && node?.metadata?.cameraControl?.enabled) {
        const camera = node.metadata.cameraControl;
        result += `\n${buildCameraPrompt({ cameraId: camera.camera, lensId: camera.lens, focalLengthMm: camera.focalLength, apertureF: camera.aperture })}`;
    }
    return result;
}

// Quotes and generation must expand the same skills and style before pricing
// or submitting. This step prepares content and never creates a model task.
export async function prepareCanvasGenerationContent(
    { context, config, nodes, sourceNode, mode, skills }: {
        context: Awaited<ReturnType<typeof hydrateNodeGenerationContext>>;
        config: AiConfig;
        nodes: CanvasNodeData[];
        sourceNode?: CanvasNodeData;
        mode: BackendGenerationMode;
        skills: Skill[];
    },
    runtime = skillRuntime,
) {
    const skillExecution = await runtime.prepare({ profile: "canvas", prompt: context.prompt, skills });
    let prompt = skillExecution.prompt.trim();
    const style = mode === "image" ? resolveCanvasStyleExecution(nodes, sourceNode, prompt, config, mode) : null;
    if (style) prompt = style.prompt;
    const promptError = mode === "video" ? modelPromptLengthError(config, config.model, mode, prompt) : "";
    if (promptError) throw new Error(promptError);
    if (mode === "audio" && context.characterReferences.length) {
        if (context.characterReferences.length !== 1) throw new Error("角色配音一次只能引用一个角色卡");
        const voice = context.resolvedCharacterVoices[0];
        if (!voice) throw new Error("角色尚未绑定可用声音，无法创建角色配音任务");
        config = { ...config, audioVoice: voice.voiceKey, audioInstructions: [voice.instructions, config.audioInstructions].filter(Boolean).join("；") };
    }
    return {
        generationContext: { ...context, prompt },
        generationConfig: config,
        effectivePrompt: prompt,
        skillMetadata: skillExecution.metadata,
        styleMetadata: style ? { styleProfileJson: style.profileJson, styleExecutionPlan: style.plan } : {},
    };
}

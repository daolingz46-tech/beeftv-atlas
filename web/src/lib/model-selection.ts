import { defaultImageCapabilityConfig, modelCapabilityConfigFor, normalizeImageValue, normalizeVideoValue, STANDARD_IMAGE_SIZE_VALUES, videoDurationAllowed, type ImageCapabilityConfig } from "@/lib/model-capabilities";
import { videoResolutionComparisonKey } from "@/lib/video-generation-options";
import { imageSizePresets } from "@/lib/image-size-presets";
import { channelHasGenerationCredential, modelOptionName, resolveModelChannel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

export type ModelInputSummary = {
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
    characterCount: number;
};

export type ModelRequirements = {
    capability?: ModelCapability;
    input?: ModelInputSummary;
    videoOperation?: string;
    videoSeconds?: string;
    imageSize?: string;
    options?: Record<string, unknown>;
};

export type DisplayModelGroup = {
    key: string;
    label: string;
    models: string[];
};

export type ModelReferenceLimits = {
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
};

// Keep versions and input modes together; the provider menu remains the first level.
const PRIORITY_MODEL_FAMILIES = [
    "Seedance · 即梦", "Kling · 可灵", "Wan · 通义万相", "Veo", "Sora",
    "Hailuo · 海螺", "Vidu", "Grok", "HappyHorse", "PixVerse", "Gemini", "Luma", "LTX",
    "Seedream · 即梦图片", "FLUX", "OpenAI", "Claude", "DeepSeek", "Qwen · 通义千问", "Ideogram", "Recraft",
];

const PRIORITY_IMAGE_FAMILIES = [
    "Nano Banana", "Seedream · 即梦图片", "GPT Image", "FLUX", "Qwen · 通义千问",
    "Ideogram", "Recraft", "Grok", "Gemini", "Wan · 通义万相", "Luma",
];

const PRIORITY_TEXT_FAMILIES = ["DeepSeek", "OpenAI", "Claude", "Gemini", "Qwen · 通义千问", "Doubao · 豆包", "Kimi", "GLM · 智谱", "Grok", "MiniMax"];
const PRIORITY_AUDIO_FAMILIES = ["Seed Audio · 豆包语音", "MiniMax", "ElevenLabs", "Gemini", "Grok", "Suno"];

// Selection considers saved credentials and current references. It does not probe
// paid endpoints or claim that provider permissions and balance are verified.
export function modelPickerCompatibilityError(config: AiConfig, model: string, requirements?: ModelRequirements) {
    const channel = resolveModelChannel(config, model);
    if (channel.enabled === false) return "该渠道未启用";
    if (!channel.baseUrl.trim()) return "请先配置渠道地址";
    if (!channelHasGenerationCredential(channel)) return "请先配置该渠道的 API Key";
    return modelCompatibilityError(config, model, requirements);
}

export function modelGroupAvailableCount(config: AiConfig, group: DisplayModelGroup, requirements?: ModelRequirements) {
    return group.models.some((model) => !modelPickerCompatibilityError(config, model, requirements)) ? 1 : 0;
}

export function availableModelGroupsFirst(config: AiConfig, groups: DisplayModelGroup[], requirements?: ModelRequirements) {
    const availability = new Map(groups.map((group) => [group.key, modelGroupAvailableCount(config, group, requirements)]));
    return [...groups].sort((a, b) => availability.get(b.key)! - availability.get(a.key)!);
}

export function modelPurposeLabel(config: AiConfig, value: string, capability?: ModelCapability) {
    const name = modelOptionName(value).toLowerCase();
    if (capability === "image") {
        if (/text-to-image/.test(name)) return "文生图";
        if (/\/edit\b|image-to-image/.test(name)) return "图片编辑";
        if (/upscal/.test(name)) return "图片放大";
        if (/remove-background/.test(name)) return "移除背景";
        const image = modelCapabilityConfigFor(config, value).image;
        return image?.references.maxImages === 0 ? "文生图" : "文生图 · 图片参考";
    }
    if (capability === "video") {
        if (/motion-control/.test(name)) return "动作控制";
        if (/video-edit/.test(name)) return "视频编辑";
        if (/start-end-frame|first-last-frame/.test(name)) return "首尾帧生视频";
        if (/audio-to-video/.test(name)) return "音频生视频";
        if (/reference-to-video/.test(name)) return "参考生视频";
        if (/image-to-video|\bi2v\b/.test(name)) return "图生视频";
        if (/text-to-video|\bt2v\b/.test(name)) return "文生视频";
        const operations = modelCapabilityConfigFor(config, value).video?.operations;
        return operations?.length === 1 ? videoOperationLabel(operations[0]) : "视频生成";
    }
    if (capability === "audio") return /lyrics/.test(name) ? "歌词生成" : /music|chirp|suno/.test(name) ? "音乐生成" : "语音生成";
    return capability === "text" ? "文字 · 剧本" : "";
}

// A curated menu order, not a claim about live provider usage statistics.
function compareFamilyModels(a: DisplayModelGroup, b: DisplayModelGroup) {
    const identity = (group: DisplayModelGroup) => `${modelOptionName(group.models[0])} ${group.label}`.toLowerCase();
    const specialty = (value: string) => /developer|lora/.test(value) ? 2 : /layer-decomposition|sequential|avatar|motion-control|video-edit|start-end-frame|video-extend|effects?|upscal|remove-background|relight|style-transfer|blend/.test(value) ? 1 : 0;
    const version = (value: string) => {
        const match = /(?:seedream|seedance|seed-audio|kling(?:-video)?|wan|gpt(?:-image)?|qwen(?:-image)?|flux|veo|vidu|hailuo|happyhorse|gemini|ltx|nano-?banana|claude(?:[-\s](?:opus|sonnet|haiku))?|deepseek|glm|kimi|speech|music|grok|chirp|\bv)[-\s]*(?:v|o|k)?(\d+(?:[.-]\d+)*)/.exec(value);
        return match?.[1].split(/[.-]/).map(Number) || [];
    };
    const edition = (value: string) => /(?:^|[-\s/])(mini|lite)(?:$|[-\s/])/.test(value) ? 3 : /(?:^|[-\s/])(fast|flash|turbo|schnell)(?:$|[-\s/])/.test(value) ? 2 : /(?:^|[-\s/])(pro|max|ultra|prime|master)(?:$|[-\s/])/.test(value) ? 0 : 1;
    const operation = (value: string) => /text-to-(?:image|video)|\bt2v\b/.test(value) ? 0 : /image-to-(?:image|video)|\bi2v\b|\/edit\b/.test(value) ? 1 : /reference-to-/.test(value) ? 2 : 0;
    const left = identity(a), right = identity(b);
    const specialOrder = specialty(left) - specialty(right);
    if (specialOrder) return specialOrder;
    const leftVersion = version(left), rightVersion = version(right);
    for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index++) {
        const order = (rightVersion[index] || 0) - (leftVersion[index] || 0);
        if (order) return order;
    }
    return edition(left) - edition(right) || operation(left) - operation(right) || a.label.localeCompare(b.label, undefined, { numeric: true });
}

export function groupModelsByFamily(config: AiConfig, groups: DisplayModelGroup[], capability?: ModelCapability, requirements?: ModelRequirements) {
    const families = new Map<string, { key: string; label: string; models: DisplayModelGroup[]; availableCount: number }>();
    for (const group of groups) {
        const value = group.models[0];
        const channel = resolveModelChannel(config, value);
        const profile = channel.modelProfiles?.find((item) => item.model === modelOptionName(value));
        const raw = `${profile?.family || ""} ${modelOptionName(value).split("/").slice(-2).join("/")} ${group.label}`;
        const rules: Array<[RegExp, string]> = [
            [/nano[-\s]?banana|gemini-(?:2\.5-flash|3\.1-flash|3-pro)-image/i, "Nano Banana"],
            [/gpt[-\s]?image/i, "GPT Image"],
            [/seed-audio|seed-tts/i, "Seed Audio · 豆包语音"], [/elevenlabs/i, "ElevenLabs"], [/suno|chirp/i, "Suno"],
            [/seedance/i, "Seedance · 即梦"], [/kling/i, "Kling · 可灵"], [/wan\b|wan[\d.-]/i, "Wan · 通义万相"],
            [/veo/i, "Veo"], [/vidu/i, "Vidu"], [/hailuo/i, "Hailuo · 海螺"], [/minimax|\bh3\b/i, "MiniMax"],
            [/grok/i, "Grok"], [/happyhorse/i, "HappyHorse"], [/pixverse/i, "PixVerse"], [/ltx/i, "LTX"],
            [/luma|ray-/i, "Luma"], [/seedream/i, "Seedream · 即梦图片"], [/flux/i, "FLUX"],
            [/gemini/i, "Gemini"], [/gpt|openai/i, "OpenAI"], [/deepseek/i, "DeepSeek"], [/claude/i, "Claude"],
            [/qwen/i, "Qwen · 通义千问"], [/ideogram/i, "Ideogram"], [/recraft/i, "Recraft"], [/sora/i, "Sora"],
            [/doubao/i, "Doubao · 豆包"], [/kimi|moonshot/i, "Kimi"], [/glm|zai-org/i, "GLM · 智谱"],
        ];
        const label = rules.find(([pattern]) => pattern.test(raw))?.[1] || profile?.family || modelOptionName(value).split("/")[0] || "其他模型";
        const family = families.get(label) || { key: label, label, models: [], availableCount: 0 };
        family.models.push(group);
        families.set(label, family);
    }
    const first = groups[0]?.models[0];
    const firstProfile = first ? resolveModelChannel(config, first).modelProfiles?.find((item) => item.model === modelOptionName(first)) : undefined;
    const mode = capability || firstProfile?.capability;
    const priorities = mode === "image" ? PRIORITY_IMAGE_FAMILIES : mode === "text" ? PRIORITY_TEXT_FAMILIES : mode === "audio" ? PRIORITY_AUDIO_FAMILIES : PRIORITY_MODEL_FAMILIES;
    for (const family of families.values()) {
        family.models.sort(compareFamilyModels);
        if (requirements) family.models = availableModelGroupsFirst(config, family.models, requirements);
        family.availableCount = family.models.reduce((count, group) => count + modelGroupAvailableCount(config, group, requirements), 0);
    }
    const rank = (label: string) => {
        const index = priorities.indexOf(label);
        return index < 0 ? priorities.length : index;
    };
    return Array.from(families.values()).sort((a, b) => (requirements ? Number(b.availableCount > 0) - Number(a.availableCount > 0) : 0) || rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
}

export function groupModelsByDisplayName(config: AiConfig, models: string[]): DisplayModelGroup[] {
    const groups = new Map<string, DisplayModelGroup>();
    models.forEach((model) => {
        const channel = resolveModelChannel(config, model);
        const label = configuredModelDisplayName(config, model);
        const key = `${channel.id}\u0000${label.toLocaleLowerCase()}`;
        const current = groups.get(key);
        if (current) current.models.push(model);
        else groups.set(key, { key, label, models: [model] });
    });
    return Array.from(groups.values());
}

export function configuredModelDisplayName(config: AiConfig, value: string) {
    const model = modelOptionName(value);
    const channel = resolveModelChannel(config, value);
    return channel.modelProfiles?.find((item) => item.model === model)?.displayName?.trim() || model;
}

export function modelCompatibilityError(config: AiConfig, model: string, requirements?: ModelRequirements) {
    const capability = requirements?.capability;
    if (!capability) return "";
    const input = requirements?.input;
    const visualInputCount = input ? input.imageCount + input.characterCount : 0;
    const channel = resolveModelChannel(config, model);
    const logicalCost = channel.modelProfiles?.find((item) => item.model === modelOptionName(model));
    const logicalSpecs = logicalCost?.logicalCapabilityProfiles?.length ? logicalCost.logicalCapabilityProfiles : logicalCost?.logicalCapabilitySpec ? [logicalCost.logicalCapabilitySpec] : [];
    if (logicalSpecs.length) {
        const publicOptionNames = logicalCost?.logicalCapabilitySpec?.options || {};
        const logicalRequirements = {
            ...requirements,
            options: Object.fromEntries(Object.entries(requirements.options || {}).filter(([name]) => Boolean(publicOptionNames[name]))),
        };
        const errors = logicalSpecs.map((spec) => logicalModelCompatibilityError(spec, logicalRequirements, visualInputCount));
        return errors.some((error) => !error) ? "" : errors[0] || "当前输入不受支持";
    }

    if (capability === "image") {
        const image = modelCapabilityConfigFor(config, model).image!;
        // 尺寸兼容不依赖输入摘要：无输入时（如画布重试/工具链）也要按尺寸过滤组内模型。
        if (requirements.imageSize && !image.size.allowCustom && !image.size.values.includes(requirements.imageSize)) return "不支持当前尺寸";
        if (!input) return "";
        if (input.videoCount > 0) return "图片模型不支持参考视频";
        if (input.audioCount > 0) return "图片模型不支持参考音频";
        if (visualInputCount > 0 && image.references.maxImages === 0) return "不支持参考图，请移除参考图";
        if (visualInputCount > image.references.maxImages) return `最多支持 ${image.references.maxImages} 张参考图`;
        return "";
    }

    if (capability === "video") {
        const profile = modelCapabilityConfigFor(config, model).video!;
        if (requirements.videoSeconds && !videoDurationAllowed(profile, Number(requirements.videoSeconds))) return "不支持当前视频时长";
        if (!input) return "";
        if (visualInputCount < profile.references.minImages) return `需要至少 ${profile.references.minImages} 张参考图`;
        if (visualInputCount > 0 && profile.references.maxImages === 0) return profile.operations.includes("text_to_video") && profile.references.maxVideos === 0 && profile.references.maxAudios === 0 ? "仅支持文生视频，请移除参考图" : "不支持参考图，请移除参考图";
        if (visualInputCount > profile.references.maxImages) return `最多支持 ${profile.references.maxImages} 张参考图`;
        if (input.videoCount > 0 && profile.references.maxVideos === 0) return "不支持参考视频，请移除参考视频";
        if (input.videoCount > profile.references.maxVideos) return `最多支持 ${profile.references.maxVideos} 个参考视频`;
        if (input.audioCount > 0 && profile.references.maxAudios === 0) return "不支持参考音频，请移除参考音频";
        if (input.audioCount > profile.references.maxAudios) return `最多支持 ${profile.references.maxAudios} 个参考音频`;
        const operation = resolveVideoOperation(input, requirements.videoOperation);
        if (operation !== "concat" && !profile.operations.includes(operation)) return `不支持${videoOperationLabel(operation)}`;
        return "";
    }

    if (!input) return "";

    if (capability === "text") {
        return input.audioCount > 0 ? "文本模型不支持参考音频" : "";
    }

    if (input.characterCount > 1) return "角色配音一次只能引用一个角色卡";
    return input.imageCount > 0 || input.videoCount > 0 || input.audioCount > 0 ? "音频模型只接受文本或单个角色卡输入" : "";
}

export function modelPromptLengthError(config: AiConfig, model: string, capability: ModelCapability, prompt: string) {
    const channel = resolveModelChannel(config, model);
    const configuredProfile = channel.modelProfiles?.find((item) => item.model === modelOptionName(model))?.capabilityConfig;
    if (!configuredProfile) return "";
    const profile = modelCapabilityConfigFor(config, model);
    const maxChars = capability === "text" ? profile.text?.references.promptMaxChars : capability === "image" ? profile.image?.references.promptMaxChars : capability === "video" ? profile.video?.references.promptMaxChars : undefined;
    if (!maxChars || maxChars <= 0) return "";
    const actualChars = Array.from(prompt).length;
    if (actualChars <= maxChars) return "";
    const label = capability === "text" ? "文本" : capability === "image" ? "图片" : "视频";
    return `当前${label}模型提示词最多 ${maxChars} 个字符，完整提示词为 ${actualChars} 个字符。系统不会自动截断，请精简当前输入、连线内容或技能上下文后重试`;
}

export function modelRequestOptions(config: AiConfig, capability: ModelCapability) {
    switch (capability) {
        case "image":
            return { size: config.size, quality: config.quality, transparentBackground: config.transparentBackground === "true", count: Number(config.count) };
        case "video":
            return { size: config.size, videoSeconds: Number(config.videoSeconds), vquality: config.vquality, videoGenerateAudio: config.videoGenerateAudio === "true", videoWatermark: config.videoWatermark === "true" };
        case "audio":
            return { audioVoice: config.audioVoice, audioFormat: config.audioFormat, audioSpeed: Number(config.audioSpeed), audioPitch: Number(config.audioPitch), audioVolume: Number(config.audioVolume) };
        default:
            return {};
    }
}

function logicalModelCompatibilityError(spec: NonNullable<NonNullable<AiConfig["channels"][number]["modelProfiles"]>[number]["logicalCapabilitySpec"]>, requirements: ModelRequirements, visualInputCount: number) {
    if (requirements.capability && spec.capability !== requirements.capability) return "不支持当前生成类型";
    const input = requirements.input;
    const counts: Record<string, number> = {
        text: 0,
        image: visualInputCount,
        video: input?.videoCount || 0,
        audio: input?.audioCount || 0,
    };
    for (const [kind, count] of Object.entries(counts)) {
        const constraint = spec.inputs?.[kind];
        if (!constraint && count > 0) return `不支持${kind}输入`;
        if (constraint && (count < constraint.min || count > constraint.max)) return `${kind}输入需为 ${constraint.min}-${constraint.max} 个`;
    }
    const operation = requirements.capability === "video" && input ? resolveVideoOperation(input, requirements.videoOperation) : requirements.videoOperation;
    if (operation && spec.operations?.length && !spec.operations.includes(operation)) return "不支持当前生成模式";
    // 图片创作状态也会携带全局默认视频时长；这个字段只对视频模型有意义，
    // 不能把它拼进图片逻辑模型的能力匹配，否则图片模型会被误判为“不支持当前时长”。
    const options = {
        ...requirements.options,
        ...(requirements.capability === "video" && requirements.videoSeconds ? { videoSeconds: requirements.videoSeconds } : {}),
        ...(requirements.capability === "image" && requirements.imageSize ? { size: requirements.imageSize } : {}),
    };
    for (const [name, value] of Object.entries(options)) {
        if (value === undefined || value === null || value === "") continue;
        const constraint = spec.options?.[name];
        if (!constraint || !logicalOptionMatches(name, constraint, value)) return logicalOptionError(name);
    }
    return "";
}

function logicalOptionMatches(name: string, constraint: { values?: unknown[]; min?: number; max?: number; step?: number }, value: unknown) {
    if (constraint.values?.length) {
        const requested = normalizeLogicalOptionValue(name, value);
        return constraint.values.some((candidate) => normalizeLogicalOptionValue(name, candidate) === requested);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return false;
    if (constraint.min !== undefined && numeric < constraint.min) return false;
    if (constraint.max !== undefined && numeric > constraint.max) return false;
    if (constraint.step !== undefined && constraint.min !== undefined) return Math.abs((numeric - constraint.min) / constraint.step - Math.round((numeric - constraint.min) / constraint.step)) < 1e-9;
    return true;
}

function normalizeLogicalOptionValue(name: string, value: unknown) {
    const normalized = String(value).trim().toLowerCase();
    if (name !== "vquality" && name !== "resolution") return normalized;
    return videoResolutionComparisonKey(normalized);
}

function logicalOptionError(name: string) {
    const label: Record<string, string> = {
        size: "尺寸",
        quality: "质量",
        transparentBackground: "透明背景",
        count: "输出数量",
        videoSeconds: "时长",
        vquality: "分辨率",
        videoGenerateAudio: "同步音频",
        videoWatermark: "水印设置",
        audioVoice: "音色",
        audioFormat: "音频格式",
        audioSpeed: "语速",
        audioPitch: "声调",
        audioVolume: "音量",
    };
    return `不支持当前${label[name] || name}`;
}

export function compatibleModelInGroup(config: AiConfig, models: string[], requirements?: ModelRequirements, preferred?: string) {
    const compatible = models.filter((model) => !modelCompatibilityError(config, model, requirements));
    if (!compatible.length) return "";
    if (compatible.length === 1) return compatible[0];
    return compatible.sort((left, right) => (left === preferred ? -1 : right === preferred ? 1 : 0))[0];
}

export function resolveCompatibleModel(config: AiConfig, selected: string, requirements?: ModelRequirements) {
    if (!requirements?.capability) return selected;
    const options = selectableModelsByCapability(config, requirements.capability);
    if (!options.length) return selected;
    const selectedGroup = groupModelsByDisplayName(config, options).find((group) => group.models.includes(selected));
    if (!selectedGroup) return selected;
    return compatibleModelInGroup(config, selectedGroup.models, requirements, selected);
}

// 同显示名分组的模型族：尺寸/比例/分辨率选项取组内全部模型配置的并集，
// 让用户能看到并选择任意成员支持的能力，选中后由兼容路由落到具体模型。
// 质量、透明背景等其余能力取当前选中（路由后）模型的配置，与创作页面一致。
export function mergedImageCapabilityConfig(config: AiConfig, selected: string): ImageCapabilityConfig {
    const options = selectableModelsByCapability(config, "image");
    const group = options.length ? groupModelsByDisplayName(config, options).find((item) => item.models.includes(selected)) : undefined;
    const models = group?.models.length ? group.models : [selected];
    const selectedProfile = modelCapabilityConfigFor(config, selected).image;
    const profiles = models.map((model) => modelCapabilityConfigFor(config, model).image).filter((profile): profile is ImageCapabilityConfig => Boolean(profile));
    if (profiles.length <= 1) return selectedProfile || defaultImageCapabilityConfig();
    const concreteValues = Array.from(new Set(profiles.flatMap((profile) => profile.size.values).filter((value) => value !== "*")));
    const allowCustom = profiles.some((profile) => profile.size.allowCustom || profile.size.values.includes("*"));
    const values = concreteValues.length ? concreteValues : allowCustom ? [...STANDARD_IMAGE_SIZE_VALUES] : [];
    const base = selectedProfile || profiles[0];
    const presets = profiles.some((profile) => profile.size.presets) ? [...new Map(profiles.flatMap((profile) => imageSizePresets(profile)).map((preset) => [`${preset.tier}:${preset.ratio}:${preset.size}`, preset])).values()] : undefined;
    return { ...base, size: { ...base.size, values, allowCustom, presets } };
}

// 切换模型后初始化图片参数为该模型能力默认值，避免旧参数在目标模型族不兼容导致无法切换。
export function defaultImageParamsForModel(config: AiConfig, model: string): Pick<AiConfig, "size" | "quality" | "transparentBackground"> {
    const image = modelCapabilityConfigFor(config, model).image;
    if (!image) return { size: "1:1", quality: "auto", transparentBackground: "false" };
    const sizeValues = image.size.values.filter((value) => value !== "*");
    const sizeDefault = image.size.default !== "*" && image.size.default ? image.size.default : sizeValues[0] || "1:1";
    return {
        size: sizeDefault,
        quality: image.quality.default || "auto",
        transparentBackground: String(image.transparentBackground.default ?? false),
    };
}

export type ModelGenerationDefaults = Pick<AiConfig, "size" | "quality" | "transparentBackground" | "count" | "videoSeconds" | "vquality" | "videoGenerateAudio" | "videoWatermark">;

type ModelVideoBooleanOptions = Pick<AiConfig, "videoGenerateAudio" | "videoWatermark">;

export function resolveModelGenerationDefaults(
    config: AiConfig,
    model: string,
    capability: "image" | "video" | undefined,
    explicit: Partial<ModelGenerationDefaults> = {},
    fallback: Partial<ModelGenerationDefaults> = {},
): Partial<ModelGenerationDefaults> {
    if (!capability) return {};
    const channel = resolveModelChannel(config, model);
    const profile = channel.modelProfiles?.find((item) => item.model === modelOptionName(model));
    const isManagedModel = Boolean(profile?.logicalModelId || profile?.logicalCapabilitySpec);
    // A channel model capability profile is an explicit per-model contract too.
    // The persisted global values are legacy defaults and must not override a
    // model's configured duration, ratio, or resolution on a new canvas node.
    const hasModelCapabilityProfile = Boolean(profile?.capabilityConfig);
    const source = (key: keyof ModelGenerationDefaults) => explicit[key] ?? (isManagedModel || hasModelCapabilityProfile ? undefined : fallback[key]);
    const capabilityProfile = modelCapabilityConfigFor(config, model);

    if (capability === "image" && capabilityProfile.image) {
        const normalized = normalizeImageValue(capabilityProfile.image, {
            size: source("size"),
            quality: source("quality"),
            count: source("count"),
            transparentBackground: source("transparentBackground"),
        });
        return normalized;
    }

    if (capability === "video" && capabilityProfile.video) {
        const normalized = normalizeVideoValue(capabilityProfile.video, {
            seconds: source("videoSeconds"),
            ratio: source("size"),
            resolution: source("vquality"),
        });
        return {
            videoSeconds: normalized.seconds,
            size: normalized.ratio,
            vquality: normalized.resolution.replace(/p$/i, ""),
            videoGenerateAudio: source("videoGenerateAudio") ?? String(capabilityProfile.video.generateAudio.default),
            videoWatermark: source("videoWatermark") ?? String(capabilityProfile.video.watermark.default),
        };
    }

    return {};
}

export function resolveModelVideoBooleanOptions(config: AiConfig, model: string, explicit: Partial<ModelVideoBooleanOptions> = {}, fallback: Partial<ModelVideoBooleanOptions> = {}): ModelVideoBooleanOptions {
    const profile = modelCapabilityConfigFor(config, model).video!;
    const defaults = resolveModelGenerationDefaults(config, model, "video", explicit, fallback);
    return {
        videoGenerateAudio: profile.generateAudio.supported ? (defaults.videoGenerateAudio ?? String(profile.generateAudio.default)) : "false",
        videoWatermark: profile.watermark.supported ? (defaults.videoWatermark ?? String(profile.watermark.default)) : "false",
    };
}

export function maxModelInputCapacity(config: AiConfig, capability: "image" | "video", kind: "image" | "video" | "audio") {
    const options = selectableModelsByCapability(config, capability);
    if (!options.length) return null;
    return options.reduce((maximum, model) => {
        const profile = modelCapabilityConfigFor(config, model);
        const value =
            capability === "image" ? (kind === "image" ? profile.image!.references.maxImages : 0) : kind === "image" ? profile.video!.references.maxImages : kind === "video" ? profile.video!.references.maxVideos : profile.video!.references.maxAudios;
        return Math.max(maximum, value);
    }, 0);
}

export function modelGroupReferenceLimits(config: AiConfig, selected: string, capability: ModelCapability, requirements?: ModelRequirements): ModelReferenceLimits | undefined {
    if (capability !== "image" && capability !== "video") return undefined;
    const options = selectableModelsByCapability(config, capability);
    const selectedGroup = groupModelsByDisplayName(config, options).find((group) => group.models.includes(selected));
    const groupModels = selectedGroup?.models || (selected ? [selected] : []);
    if (!groupModels.length) return undefined;
    const compatibleModels = requirements ? groupModels.filter((model) => !modelCompatibilityError(config, model, requirements)) : groupModels;
    const models = compatibleModels.length ? compatibleModels : groupModels;
    return models.reduce<ModelReferenceLimits>(
        (limits, model) => {
            const profile = modelCapabilityConfigFor(config, model);
            if (capability === "image") {
                return { ...limits, maxImages: Math.max(limits.maxImages, profile.image!.references.maxImages) };
            }
            const references = profile.video!.references;
            return {
                maxImages: Math.max(limits.maxImages, references.maxImages),
                maxVideos: Math.max(limits.maxVideos, references.maxVideos),
                maxAudios: Math.max(limits.maxAudios, references.maxAudios),
            };
        },
        { maxImages: 0, maxVideos: 0, maxAudios: 0 },
    );
}

export function inferVideoOperation(input: ModelInputSummary) {
    const visualInputCount = input.imageCount + input.characterCount;
    // 图片或角色决定图生视频主模式，音频只作为附加参考，不应把组合请求
    // 提升为全模态参考；纯音频输入才使用独立的 audio_to_video 能力。
    if (input.videoCount > 0 || visualInputCount > 2) return "reference_to_video";
    if (visualInputCount > 0) return "image_to_video";
    if (input.audioCount > 0) return "audio_to_video";
    return "text_to_video";
}

export function resolveVideoOperation(input: ModelInputSummary, storedOperation?: string) {
    if (storedOperation === "reference_to_video" && input.imageCount + input.characterCount + input.videoCount + input.audioCount > 0) return storedOperation;
    if (storedOperation === "extend" && input.videoCount > 0) return storedOperation;
    if (storedOperation && !["text_to_video", "image_to_video", "audio_to_video", "extend", "reference_to_video"].includes(storedOperation)) return storedOperation;
    return inferVideoOperation(input);
}

function videoOperationLabel(operation: string) {
    if (operation === "text_to_video") return "文生视频";
    if (operation === "image_to_video") return "图生视频";
    if (operation === "audio_to_video") return "音频生视频";
    if (operation === "reference_to_video") return "全模态参考";
    if (operation === "extend") return "视频续写";
    return "当前生成模式";
}

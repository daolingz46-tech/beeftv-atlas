import { expect, test } from "bun:test";
import { availableModelGroupsFirst, groupModelsByDisplayName, groupModelsByFamily, modelCompatibilityError, modelPickerCompatibilityError, modelPurposeLabel } from "../src/lib/model-selection";
import { createModelChannel, defaultConfig, encodeChannelModel, selectableModelsByCapability } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { prepareBackendGenerationTask } from "../src/services/api/generation-task";

test("current reference availability precedes family popularity and version recency", () => {
    const models = ["bytedance/seedance-2.5/text-to-video", "bytedance/seedance-2.0/image-to-video", "kwaivgi/kling-v3/image-to-video", "cold/provider/image-to-video"];
    const base = defaultModelCapabilityConfig().video!;
    const channel = createModelChannel({ id: "atlas", apiKey: "test", models, modelProfiles: models.map((model) => ({ model, capability: "video" as const, capabilityConfig: { version: 1 as const, video: { ...base, operations: [model.includes("text-to") ? "text_to_video" : "image_to_video"], defaultOperation: model.includes("text-to") ? "text_to_video" : "image_to_video", references: { ...base.references, minImages: model.includes("text-to") ? 0 : 1, maxImages: model.includes("text-to") ? 0 : 1, maxVideos: 0, maxAudios: 0 } } } })) });
    const config = { ...defaultConfig, channels: [channel] };
    const groups = groupModelsByDisplayName(config, selectableModelsByCapability(config, "video"));
    const withImage = { capability: "video" as const, input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } };
    const families = groupModelsByFamily(config, groups, "video", withImage);
    expect(families.map((family) => family.label)).toEqual(["Seedance · 即梦", "Kling · 可灵", "cold"]);
    expect(families[0].models.map((group) => group.models[0])).toEqual([models[1], models[0]].map((model) => encodeChannelModel("atlas", model)));
    expect(families[0].availableCount).toBe(1);
    expect(availableModelGroupsFirst(config, families.flatMap((family) => family.models), withImage).at(-1)?.models[0]).toBe(encodeChannelModel("atlas", models[0]));
    const withoutImage = { ...withImage, input: { ...withImage.input, imageCount: 0 } };
    const changed = groupModelsByFamily(config, groups, "video", withoutImage);
    expect(changed[0].models[0].models[0]).toBe(encodeChannelModel("atlas", models[0]));
    expect(changed.slice(1).every((family) => family.availableCount === 0)).toBe(true);
    expect(groups[0].models[0]).toBe(encodeChannelModel("atlas", models[0]));
});

test("an entirely incompatible popular image family follows a compatible cold family", () => {
    const models = ["google/nano-banana-2/text-to-image", "cold/tool/edit"];
    const image = defaultModelCapabilityConfig().image!;
    const channel = createModelChannel({ id: "atlas", apiKey: "test", models, modelProfiles: models.map((model) => ({ model, capability: "image" as const, capabilityConfig: { version: 1 as const, image: { ...image, references: { ...image.references, maxImages: model.includes("text-to") ? 0 : 8 } } } })) });
    const config = { ...defaultConfig, channels: [channel] };
    const requirements = { capability: "image" as const, input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } };
    const groups = groupModelsByDisplayName(config, selectableModelsByCapability(config, "image"));
    const families = groupModelsByFamily(config, groups, "image", requirements);
    expect(families.map((family) => family.label)).toEqual(["cold", "Nano Banana"]);
    expect(families.map((family) => family.availableCount)).toEqual([1, 0]);
    expect(modelPurposeLabel(config, encodeChannelModel("atlas", models[0]), "image")).toBe("文生图");
    expect(modelPickerCompatibilityError(config, encodeChannelModel("atlas", models[0]), requirements)).toContain("参考图");
});

test("script and audio menus classify their series and prefer recent common versions", () => {
    for (const capability of ["text", "audio"] as const) {
        const models = capability === "text" ? ["other/cold", "deepseek-ai/deepseek-v4-flash", "deepseek-ai/deepseek-v4.1-flash", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.8"] : ["other/cold", "minimax/speech-2.5-hd", "minimax/speech-2.6-hd", "bytedance/seed-audio-1.0", "elevenlabs/v3/text-to-speech"];
        const channel = createModelChannel({ id: "atlas", apiKey: "test", models, modelProfiles: models.map((model) => ({ model, capability })) });
        const config = { ...defaultConfig, channels: [channel] };
        const families = groupModelsByFamily(config, groupModelsByDisplayName(config, selectableModelsByCapability(config, capability)), capability, { capability });
        expect(families[0].label).toBe(capability === "text" ? "DeepSeek" : "Seed Audio · 豆包语音");
        expect(families.find((family) => family.label === (capability === "text" ? "DeepSeek" : "MiniMax"))?.models[0].models[0]).toBe(encodeChannelModel("atlas", models[2]));
        expect(families.at(-1)?.label).toBe("other");
    }
});

test("missing credentials stay disabled while managed BeefAPI credentials remain selectable", () => {
    const model = "gpt-5";
    const missing = createModelChannel({ id: "missing", apiKey: "", models: [model] });
    const managed = createModelChannel({ id: "beefapi", pinned: true, credentialRef: "beefapi-enterprise", apiKey: "", models: [model] });
    const config = { ...defaultConfig, channels: [missing, managed] };
    expect(modelPickerCompatibilityError(config, encodeChannelModel(missing.id, model), { capability: "text" })).toContain("API Key");
    expect(modelPickerCompatibilityError(config, encodeChannelModel(managed.id, model), { capability: "text" })).toBe("");
});

test("Atlas versions and input modes share a series, while unrelated series stay separate", () => {
    const models = ["bytedance/seedance-2.0/text-to-video", "bytedance/seedance-2.5/image-to-video", "kwaivgi/kling-v3/text-to-video", "alibaba/wan-2.7/video-edit"];
    const channel = createModelChannel({ id: "atlas", models, modelProfiles: models.map((model) => ({ model, capability: "video" as const })) });
    const config = { ...defaultConfig, channels: [channel] };
    const groups = groupModelsByFamily(config, groupModelsByDisplayName(config, selectableModelsByCapability(config, "video")));
    expect(groups.find((item) => item.label.startsWith("Seedance"))?.models).toHaveLength(2);
    expect(groups).toHaveLength(3);
    expect(groups.map((item) => item.label)).toEqual(["Seedance · 即梦", "Kling · 可灵", "Wan · 通义万相"]);
});

test("common series precede unknown families regardless of alphabetical order", () => {
    const models = ["other/a-cold-family/text-to-video", "minimax/hailuo-02/t2v-pro", "google/veo-3.1/text-to-video", "kwaivgi/kling-v3/text-to-video", "bytedance/seedance-2.0/text-to-video"];
    const channel = createModelChannel({ id: "atlas", models, modelProfiles: models.map((model) => ({ model, capability: "video" as const })) });
    const config = { ...defaultConfig, channels: [channel] };
    const groups = groupModelsByFamily(config, groupModelsByDisplayName(config, selectableModelsByCapability(config, "video")));
    expect(groups.map((item) => item.label)).toEqual(["Seedance · 即梦", "Kling · 可灵", "Veo", "Hailuo · 海螺", "other"]);
});

test("image families use their own priority and combine Nano Banana version aliases", () => {
    const models = ["other/cold-image", "black-forest-labs/flux-2-pro/text-to-image", "openai/gpt-image-2/text-to-image", "bytedance/seedream-v5.0-pro/text-to-image", "google/nano-banana-2/text-to-image", "google/nano-banana-pro/edit"];
    const channel = createModelChannel({ id: "atlas", models, modelProfiles: models.map((model) => ({ model, family: model.includes("nano-banana-2") ? "nanobanana-2" : undefined, capability: "image" as const })) });
    const config = { ...defaultConfig, channels: [channel] };
    const families = groupModelsByFamily(config, groupModelsByDisplayName(config, selectableModelsByCapability(config, "image")), "image");
    expect(families.map((item) => item.label)).toEqual(["Nano Banana", "Seedream · 即梦图片", "GPT Image", "FLUX", "other"]);
    expect(families[0].models).toHaveLength(2);
});

test("series list puts current main editions before older versions and specialty variants", () => {
    const models = ["bytedance/seedream-v5.0-pro/layer-decomposition", "bytedance/seedream-v4.5/text-to-image", "bytedance/seedream-v5.0-flash/text-to-image", "bytedance/seedream-v5.0-pro/edit", "bytedance/seedream-v5.0-pro/text-to-image"];
    const channel = createModelChannel({ id: "atlas", models, modelProfiles: models.map((model) => ({ model, capability: "image" as const })) });
    const config = { ...defaultConfig, channels: [channel] };
    const family = groupModelsByFamily(config, groupModelsByDisplayName(config, selectableModelsByCapability(config, "image")), "image")[0];
    expect(family.models.map((item) => item.models[0])).toEqual([models[4], models[3], models[2], models[1], models[0]].map((model) => encodeChannelModel("atlas", model)));
});

test("video series prioritize main new versions over old versions and developer modes", () => {
    const models = ["kwaivgi/kling-v2.6-pro/text-to-video", "kwaivgi/kling-v3.0-pro/motion-control", "kwaivgi/kling-v3.0-turbo/text-to-video", "kwaivgi/kling-v3.0-pro/text-to-video"];
    const channel = createModelChannel({ id: "atlas", models, modelProfiles: models.map((model) => ({ model, capability: "video" as const })) });
    const config = { ...defaultConfig, channels: [channel] };
    const family = groupModelsByFamily(config, groupModelsByDisplayName(config, selectableModelsByCapability(config, "video")), "video")[0];
    expect(family.models.map((item) => item.models[0])).toEqual([models[3], models[2], models[0], models[1]].map((model) => encodeChannelModel("atlas", model)));
});

test("Hailuo text-to-video rejects references with an actionable reason and becomes available without them", () => {
    const model = "minimax/hailuo-02/t2v-pro";
    const defaults = defaultModelCapabilityConfig();
    const channel = createModelChannel({ id: "atlas", models: [model], modelProfiles: [{ model, capability: "video", capabilityConfig: { ...defaults, video: { ...defaults.video!, operations: ["text_to_video"], references: { ...defaults.video!.references, minImages: 0, maxImages: 0, maxVideos: 0, maxAudios: 0 } } } }] });
    const config = { ...defaultConfig, channels: [channel] };
    const requirements = { capability: "video" as const, input: { textCount: 1, imageCount: 1, videoCount: 0, audioCount: 0, characterCount: 0 } };
    expect(modelCompatibilityError(config, encodeChannelModel(channel.id, model), requirements)).toBe("仅支持文生视频，请移除参考图");
    expect(modelCompatibilityError(config, encodeChannelModel(channel.id, model), { ...requirements, input: { ...requirements.input, imageCount: 0 } })).toBe("");
});

test("disabled channels are excluded and unsupported video references have a reason", () => {
    const model = "atlas/video";
    const defaults = defaultModelCapabilityConfig();
    const channel = createModelChannel({ id: "atlas", models: [model], modelProfiles: [{ model, capability: "video", capabilityConfig: { ...defaults, video: { ...defaults.video!, references: { ...defaults.video!.references, maxVideos: 0 } } } }] });
    const config = { ...defaultConfig, channels: [channel, createModelChannel({ id: "pending", enabled: false, models: ["pending/model"] })] };
    expect(selectableModelsByCapability(config)).toEqual([encodeChannelModel(channel.id, model)]);
    expect(modelCompatibilityError(config, encodeChannelModel(channel.id, model), { capability: "video", input: { textCount: 1, imageCount: 0, videoCount: 1, audioCount: 0, characterCount: 0 } })).toContain("参考视频");
});

test("video task and cost request both resolve stale image mode to text mode without references", async () => {
    const model = "doubao-seedance-2-0-260128";
    const channel = createModelChannel({ id: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "test-key", interfaceType: "volcengine-ark-video", models: [model] });
    const config = { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, model), videoSeconds: "5", size: "16:9", vquality: "720p" };
    const task = await prepareBackendGenerationTask({ mode: "video", prompt: "A forest", config, metadata: { videoEditOperation: "image_to_video" } });
    expect(task.operation).toBe("text_to_video");
    expect(task.input?.metadata).toMatchObject({ videoEditOperation: "text_to_video" });
});

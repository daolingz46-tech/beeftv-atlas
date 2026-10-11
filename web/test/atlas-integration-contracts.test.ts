import { expect, test } from "bun:test";
import { defaultImageCapabilityConfig, normalizeImageValue } from "../src/lib/model-capabilities";
import { imageQualityForSelection, imageResolutionUsesQuality, imageSizePresets, imageTierAvailable } from "../src/lib/image-size-presets";
import { audioSpeechProfile, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "../src/lib/audio-generation";

test("Atlas image resolution and rendering quality remain independent", () => {
    const profile = {
        ...defaultImageCapabilityConfig(),
        size: { parameter: "aspect_ratio" as const, values: ["1:1", "3:4"], default: "3:4", allowCustom: false },
        quality: { supported: true, values: ["low", "medium"], default: "medium" },
        resolution: { supported: true, values: ["1k", "2k"], default: "1k" },
    };
    expect(imageResolutionUsesQuality(profile)).toBe(false);
    expect(imageQualityForSelection(profile, "2k")).toBeUndefined();
    expect(imageTierAvailable(profile, "2k")).toBe(true);
    expect(imageTierAvailable(profile, "4k")).toBe(false);
    expect(imageSizePresets(profile).filter((preset) => preset.ratio === "3:4").map((preset) => preset.tier)).toEqual(["1k", "2k"]);
    const selected = normalizeImageValue(profile, { size: "3:4", quality: "low", imageResolution: "2k" });
    expect(selected.quality).toBe("low");
    expect(selected.imageResolution).toBe("2k");
    expect(normalizeImageValue(profile, { imageResolution: "4k" }).imageResolution).toBe("1k");
});

test("Atlas voice lists and speed limits match the selected speech model", () => {
    const model = "atlascloud-audio::minimax/speech-2.6-hd";
    const profile = audioSpeechProfile(model);
    expect(profile.kind).toBe("atlas");
    const voice = profile.voices[1].value;
    expect(normalizeAudioVoiceValue(voice, model)).toBe(voice);
    expect(normalizeAudioVoiceValue("alloy", model)).toBe(profile.defaultVoice);
    expect(normalizeAudioSpeedValue("1.25", model)).toBe("1.25");
    expect(audioSpeechProfile("atlascloud-audio::google/gemini-3.1-flash-tts").showSpeed).toBe(false);
    expect(normalizeAudioVoiceValue("Kore", "atlascloud-audio::google/gemini-3.1-flash-tts")).toBe("Kore");
    expect(audioSpeechProfile("atlascloud-audio::minimax/music-3.0").showVoice).toBe(false);
    expect(normalizeAudioSpeedValue("2", "atlascloud-audio::xai/tts-v1")).toBe("1.5");
});

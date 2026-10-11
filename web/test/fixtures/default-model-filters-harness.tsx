import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import { ModelDefaultGrid, type DefaultModelKey } from "@/pages/settings/model-default-grid";
import { createModelChannel, defaultConfig, normalizeConfigSnapshot, type ModelCapability } from "@/stores/use-config-store";
import "@/styles/workspace-product.css";

const profiles = [
    { model: "gpt-image-2.5", capability: "image", displayName: "GPT Image 2.5" },
    { model: "seedream-5.0", capability: "image", displayName: "Seedream 5.0" },
    ...Array.from({ length: 160 }, (_, index) => ({ model: `flux-2-${index}`, capability: "image", displayName: `FLUX 2 Variant ${index}` })),
    { model: "seedance-2.0/text-to-video", capability: "video", displayName: "Seedance 2.0 Text-to-Video" },
    { model: "kling-v3/image-to-video", capability: "video", displayName: "Kling v3 Image-to-Video" },
    { model: "deepseek-v4.1-flash", capability: "text", protocol: "chat-completion", displayName: "DeepSeek V4.1 Flash" },
    { model: "gpt-6", capability: "text", protocol: "chat-completion", displayName: "GPT 6" },
    { model: "unsupported-text", capability: "text", protocol: "unsupported", displayName: "Unsupported Text" },
    { model: "seed-audio-1.0", capability: "audio", displayName: "Seed Audio 1.0" },
    { model: "minimax/speech-2.6", capability: "audio", displayName: "MiniMax Speech 2.6" },
].map((profile) => ({ ...profile, capability: profile.capability as ModelCapability }));
const channels = ["a", "b"].map((id) =>
    createModelChannel({ id, name: id === "a" ? "Atlas Fixture" : "Alternate Fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic-only", models: profiles.map((profile) => profile.model), modelProfiles: profiles }),
);
const initial = normalizeConfigSnapshot({
    config: { ...defaultConfig, channels, imageModel: "a::gpt-image-2.5", videoModel: "a::seedance-2.0/text-to-video", textModel: "a::deepseek-v4.1-flash", audioModel: "a::seed-audio-1.0", assistantModel: "" },
}).config;

function Harness() {
    const [config, setConfig] = useState(initial);
    const [changes, setChanges] = useState<Array<{ key: DefaultModelKey; value: string }>>([]);
    const [dark, setDark] = useState(true);
    return (
        <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
            <main style={{ maxWidth: 1200, margin: "auto", padding: 24, color: dark ? "#eee" : "#222", background: dark ? "#111" : "#fff" }}>
                <h2>默认模型</h2>
                <ModelDefaultGrid
                    config={config}
                    onChange={(key, value) => {
                        setConfig((current) => ({ ...current, [key]: value }));
                        setChanges((current) => [...current, { key, value }]);
                    }}
                />
                <button onClick={() => setConfig((current) => ({ ...current, imageModel: "a::seedream-5.0" }))}>外部更新图片默认模型</button>
                <button onClick={() => setConfig((current) => ({ ...current, assistantModel: "gone::gpt-6" }))}>助手选择失效</button>
                <button onClick={() => setDark(!dark)}>切换主题</button>
                <output aria-label="saved changes">{JSON.stringify(changes)}</output>
            </main>
        </ConfigProvider>
    );
}
createRoot(document.getElementById("root")!).render(<Harness />);

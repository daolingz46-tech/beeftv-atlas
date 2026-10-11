import { AudioLines, Bot, Film, Image, MessageSquareText } from "lucide-react";
import { Button, Select } from "antd";
import { useMemo, useState } from "react";

import { assistantModelOptions, normalizeAssistantModel } from "@/lib/assistant-model";
import { groupModelsByDisplayName, groupModelsByFamily } from "@/lib/model-selection";
import { filterModelsByCapability, isBuiltinBeefAPIChannel, modelDisplayName, resolveModelChannel, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { workspaceCapabilities } from "@/services/workspace-mode";

export type DefaultModelKey = "imageModel" | "videoModel" | "textModel" | "audioModel" | "assistantModel";

type CapabilityRow = {
    kind: "capability";
    id: string;
    capability: ModelCapability;
    modelKey: DefaultModelKey;
    title: string;
    icon: typeof Image;
};

type AssistantRow = {
    kind: "assistant";
    id: string;
    modelKey: DefaultModelKey;
    title: string;
    icon: typeof Image;
};

const rows: Array<CapabilityRow | AssistantRow> = [
    { kind: "capability", id: "image", capability: "image", modelKey: "imageModel", title: "默认生图模型", icon: Image },
    { kind: "capability", id: "video", capability: "video", modelKey: "videoModel", title: "默认视频模型", icon: Film },
    { kind: "capability", id: "text", capability: "text", modelKey: "textModel", title: "默认文本模型", icon: MessageSquareText },
    { kind: "assistant", id: "assistant", modelKey: "assistantModel", title: "助手模型", icon: Bot },
    { kind: "capability", id: "audio", capability: "audio", modelKey: "audioModel", title: "默认音频模型", icon: AudioLines },
];

export function ModelDefaultGrid({ config, onChange, onOpenChannels }: { config: AiConfig; onChange: (key: DefaultModelKey, model: string) => void; onOpenChannels?: () => void }) {
    return (
        <div className="model-default-settings">
            {rows.map((row) => (
                <DefaultModelRow key={row.id} row={row} config={config} onChange={onChange} onOpenChannels={onOpenChannels} />
            ))}
        </div>
    );
}

function DefaultModelRow({ row, config, onChange, onOpenChannels }: { row: CapabilityRow | AssistantRow; config: AiConfig; onChange: (key: DefaultModelKey, model: string) => void; onOpenChannels?: () => void }) {
    const localMode = workspaceCapabilities().local;
    const isAssistant = row.kind === "assistant";
    const capability = isAssistant ? "text" : row.capability;
    const selected = isAssistant ? normalizeAssistantModel(config, config.assistantModel) : config[row.modelKey];
    const channels = useMemo(() => {
        const models = isAssistant ? assistantModelOptions(config) : filterModelsByCapability(config.models, capability, config.channels);
        const groups = capability === "video" ? groupModelsByDisplayName(config, models) : models.map((model) => ({ key: model, label: modelDisplayName(config, model), models: [model] }));
        return config.channels
            .map((channel) => {
                const families = groupModelsByFamily(
                    config,
                    groups.filter((group) => resolveModelChannel(config, group.models[0]).id === channel.id),
                    capability,
                    { capability },
                );
                return { key: channel.id, label: isBuiltinBeefAPIChannel(channel) ? "BeefTV" : channel.name || "未命名渠道", families, availableCount: families.reduce((sum, family) => sum + family.availableCount, 0) };
            })
            .filter((channel) => channel.families.length)
            .sort((a, b) => Number(b.availableCount > 0) - Number(a.availableCount > 0));
    }, [config, capability, isAssistant]);
    const allOptions = channels.flatMap((channel) =>
        channel.families.flatMap((family) =>
            family.models.map((group) => {
                const model = group.models.includes(selected) ? selected : group.models[0];
                const label = modelDisplayName(config, model);
                return {
                    value: model,
                    label,
                    searchLabel: `${label} ${channel.label} ${family.label} ${group.models.join(" ")}`,
                    channel: channel.label,
                    channelId: channel.key,
                    family: family.key,
                };
            }),
        ),
    );
    const anchor = isAssistant && !config.assistantModel ? `follow:${config.textModel}` : config[row.modelKey];
    const [filter, setFilter] = useState<{ anchor: string; channel: string; family: string } | null>(null);
    const currentOption = allOptions.find((option) => option.value === (selected || (isAssistant && !config.assistantModel ? config.textModel : "")));
    const activeFilter = filter?.anchor === anchor ? filter : { channel: currentOption?.channelId || "", family: currentOption?.family || "" };
    const channelValue = channels.some((channel) => channel.key === activeFilter.channel) ? activeFilter.channel : "";
    const families = Array.from(new Set(allOptions.filter((option) => !channelValue || option.channelId === channelValue).map((option) => option.family)));
    const familyValue = families.includes(activeFilter.family) ? activeFilter.family : "";
    const options = allOptions.filter((option) => (!channelValue || option.channelId === channelValue) && (!familyValue || option.family === familyValue));
    if (isAssistant) options.unshift({ value: "", label: "跟随默认文本模型", searchLabel: "跟随默认文本模型", channel: "", channelId: "", family: "" });
    const unavailable = isAssistant ? Boolean(config.assistantModel && !selected) : Boolean(selected && !allOptions.some((option) => option.value === selected));
    const value = unavailable ? undefined : isAssistant && !config.assistantModel ? "" : allOptions.some((option) => option.value === selected) ? selected : undefined;
    const Icon = row.icon;
    const empty = !allOptions.length && !isAssistant;
    return (
        <section key={row.id} className="model-default-setting-row" aria-labelledby={`default-${row.id}-title`}>
            <div className="model-default-setting-label">
                <Icon className="size-4 shrink-0 text-foreground/50" />
                <h3 id={`default-${row.id}-title`}>{row.title}</h3>
            </div>
            <div className="model-default-setting-control">
                <div className="model-default-filters">
                    <label className="model-default-filter">
                        <span>渠道</span>
                        <Select
                            aria-label={`${row.title}渠道`}
                            className="model-default-filter-select"
                            value={channelValue}
                            options={[{ value: "", label: "全部渠道" }, ...channels.map((channel) => ({ value: channel.key, label: channel.label }))]}
                            disabled={!channels.length}
                            showSearch={{ optionFilterProp: "label" }}
                            onChange={(channel) => setFilter({ anchor, channel, family: "" })}
                        />
                    </label>
                    <label className="model-default-filter">
                        <span>系列</span>
                        <Select
                            aria-label={`${row.title}系列`}
                            className="model-default-filter-select"
                            value={familyValue}
                            options={[{ value: "", label: "全部系列" }, ...families.map((family) => ({ value: family, label: family }))]}
                            disabled={!families.length}
                            showSearch={{ optionFilterProp: "label" }}
                            onChange={(family) => setFilter({ anchor, channel: channelValue, family })}
                        />
                    </label>
                </div>
                <Select
                    aria-label={row.title}
                    className="model-default-select"
                    value={value}
                    labelRender={(option) => (option.value === "" && isAssistant ? "跟随默认文本模型" : allOptions.find((item) => item.value === option.value)?.label || option.label)}
                    options={options}
                    placeholder={unavailable ? "已选模型不可用，请重新选择" : empty ? "暂无可用模型" : "选择模型"}
                    disabled={empty}
                    showSearch={{ optionFilterProp: "searchLabel" }}
                    listHeight={256}
                    popupMatchSelectWidth
                    classNames={{ popup: { root: "model-default-select-popup" } }}
                    optionRender={(option) => (
                        <div className="model-default-select-option">
                            <span>{option.data.label}</span>
                            {option.data.channel ? <span className="model-default-select-channel">{option.data.channel}</span> : null}
                        </div>
                    )}
                    onChange={(model) => onChange(row.modelKey, model)}
                />
                {empty && localMode && onOpenChannels ? (
                    <Button type="link" size="small" onClick={onOpenChannels}>
                        添加模型渠道
                    </Button>
                ) : null}
            </div>
        </section>
    );
}

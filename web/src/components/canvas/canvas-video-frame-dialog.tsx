import { useEffect, useRef, useState, type CSSProperties } from "react";
import { App, Button, InputNumber, Modal, Radio, Slider } from "antd";
import { Check, Image as ImageIcon, SkipBack, SkipForward, Trash2 } from "lucide-react";
import { nanoid } from "nanoid";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatVideoFrameTime, normalizeVideoFrameTimes, planVideoFrameInterval, MAX_VIDEO_FRAME_BATCH } from "@/lib/canvas/canvas-video-frame";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

type SelectedVideoFrame = {
    id: string;
    timeMs: number;
};

export type CanvasVideoFrameParams = {
    timesMs: number[];
};

type CanvasVideoFrameDialogProps = {
    node: CanvasNodeData;
    open: boolean;
    onClose: () => void;
    onConfirm: (params: CanvasVideoFrameParams) => void;
};

const MAX_SELECTED_FRAMES = MAX_VIDEO_FRAME_BATCH;

export function CanvasVideoFrameDialog({ node, open, onClose, onConfirm }: CanvasVideoFrameDialogProps) {
    const { message } = App.useApp();
    const theme = canvasThemes[useActiveTheme()];
    const videoRef = useRef<HTMLVideoElement>(null);
    const [videoUrl, setVideoUrl] = useState("");
    const [videoError, setVideoError] = useState(false);
    const [durationMs, setDurationMs] = useState(0);
    const [currentTimeMs, setCurrentTimeMs] = useState(0);
    const [frames, setFrames] = useState<SelectedVideoFrame[]>([]);
    const [mode, setMode] = useState<"interval" | "manual">("interval");
    const [intervalSeconds, setIntervalSeconds] = useState<number | null>(1);
    const intervalPlan = planVideoFrameInterval(durationMs, (intervalSeconds ?? 0) * 1000);
    const selectedTimes = mode === "interval" ? intervalPlan.timesMs : frames.map((frame) => frame.timeMs);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setVideoUrl("");
        setVideoError(false);
        setDurationMs(0);
        setCurrentTimeMs(0);
        setFrames([]);
        setMode("interval");
        setIntervalSeconds(1);
        const storageKey = node.metadata?.storageKey || "";
        const fallback = node.metadata?.content || "";
        const applyUrl = (url: string) => {
            if (!cancelled) setVideoUrl(url);
        };
        void (async () => {
            const cached = resourceIdFromStorageKey(storageKey) ? await cacheResourceObjectUrl(storageKey).catch(() => null) : null;
            const url = cached || await resolveMediaUrl(storageKey, fallback);
            if (!url) throw new Error("视频地址不可用");
            applyUrl(url);
        })().catch(() => { if (!cancelled) setVideoError(true); });
        return () => {
            cancelled = true;
        };
    }, [node.id, node.metadata?.content, node.metadata?.storageKey, open]);

    const seekTo = (timeMs: number) => {
        const normalized = normalizeVideoFrameTimes([timeMs], durationMs)[0];
        if (normalized === undefined) return;
        setCurrentTimeMs(normalized);
        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.currentTime = normalized / 1000;
        }
    };

    const addFrame = (timeMs: number) => {
        const normalized = normalizeVideoFrameTimes([timeMs], durationMs)[0];
        if (normalized === undefined) {
            message.warning("视频时长未就绪，请稍候再试");
            return;
        }
        if (frames.some((frame) => frame.timeMs === normalized)) {
            message.info("该时间点已经添加");
            return;
        }
        if (frames.length >= MAX_SELECTED_FRAMES) {
            message.warning(`单次最多提取 ${MAX_SELECTED_FRAMES} 帧，请先完成当前批次`);
            return;
        }
        setMode("manual");
        setFrames((current) => [...current, { id: nanoid(), timeMs: normalized }].sort((left, right) => left.timeMs - right.timeMs));
    };

    const removeFrame = (id: string) => setFrames((current) => current.filter((frame) => frame.id !== id));
    const lastFrameMs = Math.max(0, durationMs - 1);

    const title = (
        <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                <ImageIcon className="size-4" />
            </span>
            <div className="min-w-0">
                <div className="truncate font-semibold leading-6">视频抽帧</div>
                <div className="truncate text-xs opacity-45">{node.title || "视频节点"}</div>
            </div>
        </div>
    );

    return (
        <Modal title={title} open={open} onCancel={onClose} footer={null} width={760} centered destroyOnHidden>
            <div className="thin-scrollbar max-h-[75vh] space-y-4 overflow-y-auto" data-canvas-no-zoom data-canvas-wheel-scroll>
                <div className="flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-black">
                    {videoUrl ? (
                        <video
                            ref={videoRef}
                            src={videoUrl}
                            controls
                            playsInline
                            preload="metadata"
                            className="block max-h-[var(--video-segment-preview-max-height)] w-full"
                            onLoadedMetadata={(event) => {
                                const video = event.currentTarget;
                                if (!Number.isFinite(video.duration) || video.duration <= 0) return;
                                setDurationMs(Math.round(video.duration * 1000));
                                setIntervalSeconds((value) => Math.min(value ?? 1, Math.round(video.duration * 1000) / 1000));
                                setCurrentTimeMs(Math.round(video.currentTime * 1000));
                            }}
                            onTimeUpdate={(event) => setCurrentTimeMs(Math.round(event.currentTarget.currentTime * 1000))}
                            onSeeked={(event) => setCurrentTimeMs(Math.round(event.currentTarget.currentTime * 1000))}
                            onError={() => setVideoError(true)}
                        />
                    ) : (
                        <div className="grid h-44 w-full place-items-center text-xs opacity-60">{videoError ? "视频预览加载失败，请检查素材是否仍然可用" : "正在加载视频…"}</div>
                    )}
                </div>
                {videoError && <div role="alert">视频预览加载失败，请检查素材是否仍然可用</div>}

                <div className="flex items-center gap-3">
                    <span className="shrink-0 text-xs">定位画面</span>
                    <Slider className="flex-1" min={0} max={durationMs / 1000 || 1} step={0.001}
                        value={currentTimeMs / 1000} disabled={!durationMs || videoError}
                        tooltip={{ formatter: (value) => `${value?.toFixed(3)} 秒` }}
                        onChange={(value) => seekTo(value * 1000)} />
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: theme.toolbar.itemHover }}>
                    <span className="text-xs font-medium opacity-60">当前时间</span>
                    <InputNumber
                        size="small"
                        min={0}
                        max={durationMs / 1000}
                        step={0.001}
                        precision={3}
                        value={currentTimeMs / 1000}
                        className="w-28"
                        aria-label="当前取帧时间（秒）"
                        disabled={!durationMs || videoError}
                        onChange={(value) => seekTo(Math.round((value || 0) * 1000))}
                    />
                    <span className="mr-auto text-xs opacity-45">/ {durationMs ? formatVideoFrameTime(durationMs) : "--:--.---"}</span>
                    <Button
                        size="small"
                        icon={<SkipBack className="size-3.5" />}
                        disabled={!durationMs}
                        onClick={() => {
                            seekTo(0);
                            addFrame(0);
                        }}
                    >
                        首帧
                    </Button>
                    <Button size="small" type="primary" icon={<ImageIcon className="size-3.5" />} disabled={!durationMs} onClick={() => addFrame(currentTimeMs)}>
                            当前帧
                    </Button>
                    <Button
                        size="small"
                        icon={<SkipForward className="size-3.5" />}
                        disabled={!durationMs}
                        onClick={() => {
                            seekTo(lastFrameMs);
                            addFrame(lastFrameMs);
                        }}
                    >
                        尾帧
                    </Button>
                </div>

                <Radio.Group value={mode} onChange={(event) => setMode(event.target.value)} optionType="button"
                    options={[{ label: "按间隔抽取整段视频", value: "interval" }, { label: "手动选择时间点", value: "manual" }]} />

                {mode === "interval" ? <section className="space-y-3 rounded-xl p-3" style={{ background: theme.toolbar.itemHover }}>
                    <div className="flex items-center gap-3">
                        <span className="shrink-0 text-sm">每隔</span>
                        <Slider className="flex-1" min={Math.min(0.1, durationMs / 1000 || 0.1)} max={durationMs / 1000 || 1}
                            step={0.001} value={intervalSeconds ?? 1} disabled={!durationMs || videoError}
                            onChange={setIntervalSeconds} tooltip={{ formatter: (value) => `${value} 秒` }} />
                        <InputNumber aria-label="抽帧间隔（秒）" min={Math.min(0.1, durationMs / 1000 || 0.1)} max={durationMs / 1000 || 1}
                            step={0.1} precision={3} value={intervalSeconds} onChange={setIntervalSeconds}
                            disabled={!durationMs || videoError} className="w-28" />
                        <span className="shrink-0 text-sm">秒一张</span>
                    </div>
                    <div className="text-xs opacity-60">时长 {durationMs ? `${durationMs / 1000} 秒` : "读取中"} · 预计 {intervalPlan.count} 张。从 0 秒起按间隔抽取，不重复截取视频终点。</div>
                    {durationMs > 0 && intervalPlan.error && <div role="alert" className="text-xs">{intervalPlan.error}</div>}
                </section> : <>

                <section aria-labelledby="selected-video-frames-title">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <div id="selected-video-frames-title" className="text-sm font-medium">
                            已选画面
                        </div>
                        <div className="text-xs opacity-45">
                            {frames.length}/{MAX_SELECTED_FRAMES}
                        </div>
                    </div>
                    {frames.length ? (
                        <div className="thin-scrollbar grid max-h-52 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
                            {frames.map((frame, index) => (
                                <div key={frame.id} className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: theme.toolbar.itemHover }}>
                                    <button type="button" className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2" style={{ "--tw-ring-color": theme.node.activeStroke } as CSSProperties} onClick={() => seekTo(frame.timeMs)}>
                                        <span className="block text-[var(--fs-micro)] opacity-45">画面 {index + 1}</span>
                                        <span className="block truncate font-mono text-xs font-medium">{formatVideoFrameTime(frame.timeMs)}</span>
                                    </button>
                                    <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={`删除画面 ${index + 1}`} onClick={() => removeFrame(frame.id)} />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-lg px-3 py-5 text-center text-xs opacity-50" style={{ background: theme.toolbar.itemHover }}>
                            播放或拖动到需要的位置，然后添加当前画面。可以连续添加多个时间点。
                        </div>
                    )}
                </section>
                </>}

                <div className="flex items-center justify-between gap-3">
                    <div className="text-xs opacity-45">提取后只创建图片节点，不会自动发起生成任务。</div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button onClick={onClose}>取消</Button>
                        <Button type="primary" icon={<Check className="size-4" />} disabled={!selectedTimes.length || videoError} onClick={() => onConfirm({ timesMs: selectedTimes })}>
                            {selectedTimes.length ? `提取 ${selectedTimes.length} 张图片` : "提取画面"}
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

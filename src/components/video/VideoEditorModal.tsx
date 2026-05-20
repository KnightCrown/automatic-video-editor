import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Check,
  ChevronDown,
  Minus,
  Plus,
  RotateCcw,
  Save,
  Settings,
  UploadCloud,
  X,
} from "lucide-react";
import type { OverlayClipLayout, VideoJob, VideoOverlayClip } from "../../types/pipeline";
import { getOverlayImageDisplayUrl } from "../../services/pipelineService";
import { clipEndMs, formatTimeMs } from "../../utils/overlayClips";
import {
  editorRectToLayout,
  layoutToEditorRect,
  overlayHeightPct,
} from "../../utils/overlayLayout";
import {
  VideoPreviewWithOverlays,
  type VideoPreviewHandle,
} from "./VideoPreviewWithOverlays";
import { VideoTimelineEditor } from "./VideoTimelineEditor";

const TIME_STEP_MS = 500;

type Props = {
  video: VideoJob;
  rootPath: string;
  initialClips: VideoOverlayClip[];
  onSave: (clips: VideoOverlayClip[]) => Promise<void>;
  onClose: () => void;
  isQueued?: boolean;
  onAddToRenderQueue?: () => void;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function normalizeClip(clip: VideoOverlayClip): VideoOverlayClip {
  return {
    ...clip,
    opacityPct: clip.opacityPct ?? 100,
    entrance: clip.entrance ?? "fade-in",
    exit: clip.exit ?? "fade-out",
  };
}

function formatTimecodeMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const hundredths = Math.floor((safe % 1000) / 10);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${hundredths
    .toString()
    .padStart(2, "0")}`;
}

function estimateFileSizeMb(durationMs: number, overlayCount: number, quality: string): number {
  const minutes = Math.max(1, durationMs / 60_000);
  const qualityFactor = quality === "high" ? 16 : quality === "draft" ? 8 : 12;
  return Math.round(minutes * qualityFactor + overlayCount * 3 + 24);
}

export function VideoEditorModal({
  video,
  rootPath,
  initialClips,
  onSave,
  onClose,
  isQueued = false,
  onAddToRenderQueue,
}: Props) {
  const previewRef = useRef<VideoPreviewHandle>(null);
  const [clips, setClips] = useState<VideoOverlayClip[]>(() =>
    initialClips.map(normalizeClip),
  );
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialClips[0]?.suggestionId ?? null,
  );
  const [pxPerMs, setPxPerMs] = useState(0.05);
  const [saving, setSaving] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [draggedOverlayId, setDraggedOverlayId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("1080p");
  const [fps, setFps] = useState("30");
  const [format, setFormat] = useState("MP4");
  const [quality, setQuality] = useState("high");
  const [includeIntroOutro, setIncludeIntroOutro] = useState(true);

  useEffect(() => {
    const nextClips = initialClips.map(normalizeClip);
    const first = nextClips[0] ?? null;
    setClips(nextClips);
    setSelectedId(first?.suggestionId ?? null);
    setCurrentMs(first?.startMs ?? 0);
    window.setTimeout(() => {
      if (first) previewRef.current?.seekToMs(first.startMs);
    }, 0);
  }, [video.id, initialClips]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        clips.map(async (clip) => {
          const url = await getOverlayImageDisplayUrl(rootPath, clip.imageRelativePath);
          return [clip.suggestionId, url] as const;
        }),
      );
      if (!cancelled) setImageUrls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [clips, rootPath]);

  const safeDurationMs = useMemo(() => {
    const clipMax = clips.reduce((max, clip) => Math.max(max, clipEndMs(clip)), 0);
    return Math.max(durationMs || 0, clipMax, 60_000);
  }, [clips, durationMs]);

  const selectedClip = useMemo(
    () => clips.find((clip) => clip.suggestionId === selectedId) ?? null,
    [clips, selectedId],
  );

  const handleSeek = useCallback(
    (ms: number) => {
      const nextMs = clamp(ms, 0, safeDurationMs);
      previewRef.current?.seekToMs(nextMs);
      setCurrentMs(nextMs);
    },
    [safeDurationMs],
  );

  const updateClip = useCallback((clipId: string, patch: Partial<VideoOverlayClip>) => {
    setClips((current) =>
      current.map((clip) => (clip.suggestionId === clipId ? { ...clip, ...patch } : clip)),
    );
  }, []);

  const updateSelectedClip = useCallback(
    (patch: Partial<VideoOverlayClip>) => {
      if (!selectedClip) return;
      updateClip(selectedClip.suggestionId, patch);
    },
    [selectedClip, updateClip],
  );

  const saveTimeline = useCallback(
    async (closeAfterSave: boolean) => {
      setSaving(true);
      try {
        await onSave(clips);
        if (closeAfterSave) onClose();
      } finally {
        setSaving(false);
      }
    },
    [clips, onClose, onSave],
  );

  const handleAddToRenderQueue = useCallback(async () => {
    await saveTimeline(false);
    onAddToRenderQueue?.();
  }, [onAddToRenderQueue, saveTimeline]);

  const handleOverlayCardClick = useCallback(
    (clip: VideoOverlayClip) => {
      setSelectedId(clip.suggestionId);
      handleSeek(clip.startMs);
    },
    [handleSeek],
  );

  const handleOverlayDrop = useCallback(
    (targetId: string) => {
      if (!draggedOverlayId || draggedOverlayId === targetId) return;
      setClips((current) => {
        const from = current.findIndex((clip) => clip.suggestionId === draggedOverlayId);
        const to = current.findIndex((clip) => clip.suggestionId === targetId);
        if (from < 0 || to < 0) return current;
        const next = [...current];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
      setDraggedOverlayId(null);
    },
    [draggedOverlayId],
  );

  const adjustSelectedStart = useCallback(
    (deltaMs: number) => {
      if (!selectedClip) return;
      const maxStart = Math.max(0, safeDurationMs - selectedClip.durationMs);
      updateSelectedClip({
        startMs: clamp(selectedClip.startMs + deltaMs, 0, maxStart),
      });
    },
    [safeDurationMs, selectedClip, updateSelectedClip],
  );

  const adjustSelectedDuration = useCallback(
    (deltaMs: number) => {
      if (!selectedClip) return;
      updateSelectedClip({
        durationMs: clamp(
          selectedClip.durationMs + deltaMs,
          TIME_STEP_MS,
          safeDurationMs - selectedClip.startMs,
        ),
      });
    },
    [safeDurationMs, selectedClip, updateSelectedClip],
  );

  const adjustSelectedEnd = useCallback(
    (deltaMs: number) => {
      if (!selectedClip) return;
      const nextEnd = clamp(clipEndMs(selectedClip) + deltaMs, selectedClip.startMs + TIME_STEP_MS, safeDurationMs);
      updateSelectedClip({ durationMs: nextEnd - selectedClip.startMs });
    },
    [safeDurationMs, selectedClip, updateSelectedClip],
  );

  const applyPositionPreset = useCallback(
    (x: "left" | "center" | "right", y: "top" | "center" | "bottom") => {
      if (!selectedClip) return;
      const widthPct = selectedClip.layout.widthPct;
      const heightPct = overlayHeightPct(widthPct);
      const xPct =
        x === "left"
          ? 3
          : x === "center"
            ? (100 - widthPct) / 2
            : 100 - widthPct - 3;
      const yPct =
        y === "top"
          ? 3
          : y === "center"
            ? (100 - heightPct) / 2
            : 100 - heightPct - 3;
      updateSelectedClip({
        layout: editorRectToLayout({ xPct, yPct, widthPct }),
      });
    },
    [selectedClip, updateSelectedClip],
  );

  const updateClipLayout = useCallback(
    (clipId: string, layout: OverlayClipLayout) => {
      updateClip(clipId, { layout });
    },
    [updateClip],
  );

  const updateSelectedScale = useCallback(
    (widthPct: number) => {
      if (!selectedClip) return;
      const rect = layoutToEditorRect(selectedClip.layout);
      updateSelectedClip({
        layout: editorRectToLayout({ ...rect, widthPct }),
      });
    },
    [selectedClip, updateSelectedClip],
  );

  const resetSelectedClip = useCallback(() => {
    if (!selectedClip) return;
    const original = initialClips.find((clip) => clip.suggestionId === selectedClip.suggestionId);
    if (original) updateClip(selectedClip.suggestionId, normalizeClip(original));
  }, [initialClips, selectedClip, updateClip]);

  const estimatedMb = estimateFileSizeMb(safeDurationMs, clips.length, quality);

  return (
    <div className="video-editor-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="video-editor-modal video-editor-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-editor-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="video-editor-shell-header">
          <div className="video-editor-title-block">
            <h2 id="video-editor-title">Edit</h2>
            <p>Fine-tune your timeline and export your final video.</p>
            <button type="button" className="video-editor-file-select">
              <span>{video.fileName}</span>
              <ChevronDown size={16} />
            </button>
          </div>

          <div className="video-editor-header-actions">
            <span className="video-editor-save-state">
              <Check size={14} />
              {saving ? "Saving changes" : "Timeline draft ready"}
            </span>
            <button type="button" className="video-editor-icon-button" title="Editor settings" aria-label="Editor settings">
              <Settings size={18} />
            </button>
            <button type="button" className="video-editor-secondary-button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="video-editor-primary-button"
              onClick={() => void saveTimeline(true)}
              disabled={saving}
            >
              <Save size={16} />
              {saving ? "Saving" : "Save timeline"}
            </button>
            <button type="button" className="video-editor-icon-button" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="video-editor-workspace">
          <main className="video-editor-main">
            <VideoPreviewWithOverlays
              ref={previewRef}
              videoPath={video.path}
              rootPath={rootPath}
              clips={clips}
              large
              className="video-editor-preview"
              onTimeUpdate={setCurrentMs}
              onDurationChange={setDurationMs}
              showSeekMarkers
              interactiveOverlays
              selectedClipId={selectedId}
              onSelectClip={setSelectedId}
              onClipLayoutChange={updateClipLayout}
            />

            <VideoTimelineEditor
              clips={clips}
              durationMs={safeDurationMs}
              currentMs={currentMs}
              selectedId={selectedId}
              pxPerMs={pxPerMs}
              imageUrls={imageUrls}
              fitToWidth
              onClipsChange={setClips}
              onSelect={setSelectedId}
              onSeek={handleSeek}
              onPxPerMsChange={setPxPerMs}
            />

            <section className="video-overlay-list-panel">
              <div className="video-overlay-list-header">
                <h3>Overlay list ({clips.length})</h3>
                <span>Drag cards to change layer order</span>
              </div>
              <div className="video-overlay-list" role="list" aria-label="Overlay list">
                {clips.map((clip, index) => (
                  <div
                    key={clip.suggestionId}
                    className={`video-overlay-card ${
                      selectedId === clip.suggestionId ? "selected" : ""
                    }`}
                    role="listitem"
                    draggable
                    onClick={() => handleOverlayCardClick(clip)}
                    onDragStart={(e: DragEvent<HTMLDivElement>) => {
                      setDraggedOverlayId(clip.suggestionId);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleOverlayDrop(clip.suggestionId);
                    }}
                    onDragEnd={() => setDraggedOverlayId(null)}
                  >
                    <span className="video-overlay-card-index">{index + 1}</span>
                    <div className="video-overlay-card-thumb">
                      {imageUrls[clip.suggestionId] ? (
                        <img src={imageUrls[clip.suggestionId]} alt={clip.title} draggable={false} />
                      ) : null}
                    </div>
                    <div className="video-overlay-card-meta">
                      <strong>{clip.title}</strong>
                      <span>
                        {formatTimeMs(clip.startMs)} - {formatTimeMs(clipEndMs(clip))}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </main>

          <aside className="video-editor-inspector">
            <section className="video-editor-panel">
              <h3>Overlay Settings</h3>
              {selectedClip ? (
                <>
                  <TimeStepper
                    label="Start time"
                    value={formatTimecodeMs(selectedClip.startMs)}
                    onDecrement={() => adjustSelectedStart(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedStart(TIME_STEP_MS)}
                  />
                  <TimeStepper
                    label="End time"
                    value={formatTimecodeMs(clipEndMs(selectedClip))}
                    onDecrement={() => adjustSelectedEnd(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedEnd(TIME_STEP_MS)}
                  />
                  <TimeStepper
                    label="Duration"
                    value={formatTimecodeMs(selectedClip.durationMs)}
                    onDecrement={() => adjustSelectedDuration(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedDuration(TIME_STEP_MS)}
                  />

                  <div className="video-editor-control-row align-start">
                    <span>Position</span>
                    <div className="video-editor-position-grid" aria-label="Overlay position presets">
                      {(["top", "center", "bottom"] as const).map((y) =>
                        (["left", "center", "right"] as const).map((x) => (
                          <button
                            key={`${x}-${y}`}
                            type="button"
                            onClick={() => applyPositionPreset(x, y)}
                            aria-label={`${y} ${x}`}
                          />
                        )),
                      )}
                    </div>
                  </div>

                  <SliderRow
                    label="Scale"
                    value={Math.round(selectedClip.layout.widthPct)}
                    min={12}
                    max={85}
                    suffix="%"
                    onChange={updateSelectedScale}
                  />
                  <SliderRow
                    label="Opacity"
                    value={Math.round(selectedClip.opacityPct ?? 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => updateSelectedClip({ opacityPct: value })}
                  />
                  <EditorSelect
                    label="Entrance"
                    value={selectedClip.entrance ?? "fade-in"}
                    onChange={(value) =>
                      updateSelectedClip({
                        entrance: value as VideoOverlayClip["entrance"],
                      })
                    }
                    options={[
                      ["fade-in", "Fade In"],
                      ["none", "None"],
                    ]}
                  />
                  <EditorSelect
                    label="Exit"
                    value={selectedClip.exit ?? "fade-out"}
                    onChange={(value) =>
                      updateSelectedClip({
                        exit: value as VideoOverlayClip["exit"],
                      })
                    }
                    options={[
                      ["fade-out", "Fade Out"],
                      ["none", "None"],
                    ]}
                  />
                  <button type="button" className="video-editor-reset-button" onClick={resetSelectedClip}>
                    <RotateCcw size={15} />
                    Reset changes
                  </button>
                </>
              ) : (
                <p className="video-editor-empty-panel">Select an overlay on the timeline or list.</p>
              )}
            </section>

            <section className="video-editor-panel">
              <h3>Export Settings</h3>
              <EditorSelect
                label="Resolution"
                value={resolution}
                onChange={setResolution}
                options={[
                  ["1080p", "1080p (1920 x 1080)"],
                  ["720p", "720p (1280 x 720)"],
                ]}
              />
              <EditorSelect
                label="FPS"
                value={fps}
                onChange={setFps}
                options={[
                  ["30", "30"],
                  ["24", "24"],
                  ["60", "60"],
                ]}
              />
              <EditorSelect
                label="Format"
                value={format}
                onChange={setFormat}
                options={[
                  ["MP4", "MP4"],
                  ["MOV", "MOV"],
                ]}
              />
              <EditorSelect
                label="Quality"
                value={quality}
                onChange={setQuality}
                options={[
                  ["high", "High (Recommended)"],
                  ["balanced", "Balanced"],
                  ["draft", "Draft"],
                ]}
              />
              <label className="video-editor-toggle-row">
                <span>Include intro & outro</span>
                <input
                  type="checkbox"
                  checked={includeIntroOutro}
                  onChange={(e) => setIncludeIntroOutro(e.target.checked)}
                />
                <b aria-hidden="true" />
              </label>
              <button
                type="button"
                className="video-editor-render-button"
                onClick={() => void handleAddToRenderQueue()}
                disabled={saving || isQueued || !onAddToRenderQueue}
              >
                {isQueued ? <Check size={17} /> : <UploadCloud size={17} />}
                {isQueued ? "Added to render queue" : saving ? "Saving timeline" : "Add to render queue"}
              </button>
              <p className="video-editor-estimate">Estimated file size: ~{estimatedMb} MB</p>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function TimeStepper({
  label,
  value,
  onDecrement,
  onIncrement,
}: {
  label: string;
  value: string;
  onDecrement: () => void;
  onIncrement: () => void;
}) {
  return (
    <div className="video-editor-control-row">
      <span>{label}</span>
      <div className="video-editor-stepper">
        <strong>{value}</strong>
        <button type="button" onClick={onDecrement} aria-label={`Decrease ${label}`}>
          <Minus size={14} />
        </button>
        <button type="button" onClick={onIncrement} aria-label={`Increase ${label}`}>
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="video-editor-control-row">
      <span>{label}</span>
      <div className="video-editor-slider">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <strong>
          {value}
          {suffix}
        </strong>
      </div>
    </div>
  );
}

function EditorSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="video-editor-control-row">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

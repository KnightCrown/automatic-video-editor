import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AudioWaveform,
  FinalVideoTimeline,
  OverlayClipLayout,
  TimelineVideoClip,
  VideoJob,
  VideoOverlayClip,
} from "../../types/pipeline";
import { getOverlayImageDisplayUrl, generatePlayheadAiOverlay, importTimelineVideo } from "../../services/pipelineService";
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
import {
  VideoTimelineEditor,
  type TimelineEditorSelection,
} from "./VideoTimelineEditor";
import {
  maxVideoTrackIndex,
  normalizeVideoClip,
  videoClipEndMs,
} from "../../utils/timelineVideoClips";
import {
  buildTimelineInsertPlan,
  finalToSourceMs,
  sourceToFinalMs,
} from "../../utils/timelineInserts";
import { VIDEO_FILE_DIALOG_FILTER } from "../../utils/videoExtensions";

const TIME_STEP_MS = 500;

type Props = {
  video: VideoJob;
  rootPath: string;
  initialClips: VideoOverlayClip[];
  initialVideoClips?: TimelineVideoClip[];
  contentStartMs?: number;
  contentEndMs?: number;
  onSave: (timeline: Pick<FinalVideoTimeline, "clips" | "videoClips">) => Promise<void>;
  onClose: () => void;
  isQueued?: boolean;
  onAddToRenderQueue?: () => void;
  audioWaveform?: AudioWaveform | null;
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
  initialVideoClips = [],
  contentStartMs,
  contentEndMs,
  onSave,
  onClose,
  isQueued = false,
  onAddToRenderQueue,
  audioWaveform = null,
}: Props) {
  const previewRef = useRef<VideoPreviewHandle>(null);
  const overlayListRef = useRef<HTMLDivElement>(null);
  const overlayScrollRef = useRef<{
    startX: number;
    scrollLeft: number;
    moved: boolean;
  } | null>(null);
  const suppressOverlayClickRef = useRef(false);
  const [clips, setClips] = useState<VideoOverlayClip[]>(() =>
    initialClips.map(normalizeClip),
  );
  const [videoClips, setVideoClips] = useState<TimelineVideoClip[]>(() =>
    initialVideoClips.map(normalizeVideoClip),
  );
  const [emptyTrackIndices, setEmptyTrackIndices] = useState<number[]>([]);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [selected, setSelected] = useState<TimelineEditorSelection | null>(() => {
    const first = initialClips[0];
    return first ? { kind: "overlay", id: first.suggestionId } : null;
  });
  const [pxPerMs, setPxPerMs] = useState(0.001);
  const [saving, setSaving] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [resolution, setResolution] = useState("1080p");
  const [fps, setFps] = useState("30");
  const [format, setFormat] = useState("MP4");
  const [quality, setQuality] = useState("high");
  const [includeIntroOutro, setIncludeIntroOutro] = useState(true);
  const [showAiOverlayConfirm, setShowAiOverlayConfirm] = useState(false);
  const [addingAiOverlay, setAddingAiOverlay] = useState(false);
  const [aiOverlayError, setAiOverlayError] = useState<string | null>(null);

  useEffect(() => {
    const nextClips = initialClips.map(normalizeClip);
    const nextVideoClips = initialVideoClips.map(normalizeVideoClip);
    const first = nextClips[0] ?? null;
    setClips(nextClips);
    setVideoClips(nextVideoClips);
    setEmptyTrackIndices([]);
    setSelected(first ? { kind: "overlay", id: first.suggestionId } : null);
    const plan = buildTimelineInsertPlan(
      nextVideoClips,
      contentStartMs ?? 0,
      Math.max((contentStartMs ?? 0) + 1, contentEndMs ?? durationMs),
    );
    const initialFinalMs = first
      ? sourceToFinalMs(first.startMs, plan.contentStartMs, plan.insertOffsets)
      : 0;
    setCurrentMs(initialFinalMs);
    window.setTimeout(() => {
      if (first) previewRef.current?.seekToMs(initialFinalMs);
    }, 0);
  }, [video.id, initialClips, initialVideoClips, contentStartMs, contentEndMs, durationMs]);

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

  const insertPlan = useMemo(() => {
    const start = contentStartMs ?? 0;
    const end = Math.max(start + 1, contentEndMs ?? durationMs);
    return buildTimelineInsertPlan(videoClips, start, end);
  }, [contentEndMs, contentStartMs, durationMs, videoClips]);

  const toFinalMs = useCallback(
    (sourceMs: number) => sourceToFinalMs(sourceMs, insertPlan.contentStartMs, insertPlan.insertOffsets),
    [insertPlan.contentStartMs, insertPlan.insertOffsets],
  );

  const toSourceMs = useCallback(
    (finalMs: number) => finalToSourceMs(finalMs, insertPlan.contentStartMs, insertPlan.insertOffsets),
    [insertPlan.contentStartMs, insertPlan.insertOffsets],
  );

  const safeDurationMs = useMemo(() => {
    const overlayMax = clips.reduce((max, clip) => Math.max(max, clipEndMs(clip)), 0);
    const videoMax = videoClips.reduce((max, clip) => Math.max(max, videoClipEndMs(clip)), 0);
    return Math.max(durationMs || 0, overlayMax, videoMax, 60_000);
  }, [clips, durationMs, videoClips]);

  const selectedOverlay = useMemo(
    () =>
      selected?.kind === "overlay"
        ? (clips.find((clip) => clip.suggestionId === selected.id) ?? null)
        : null,
    [clips, selected],
  );

  const selectedVideoClip = useMemo(
    () =>
      selected?.kind === "video"
        ? (videoClips.find((clip) => clip.id === selected.id) ?? null)
        : null,
    [selected, videoClips],
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

  const updateSelectedOverlay = useCallback(
    (patch: Partial<VideoOverlayClip>) => {
      if (!selectedOverlay) return;
      updateClip(selectedOverlay.suggestionId, patch);
    },
    [selectedOverlay, updateClip],
  );

  const updateVideoClip = useCallback((clipId: string, patch: Partial<TimelineVideoClip>) => {
    setVideoClips((current) =>
      current.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
    );
  }, []);

  const updateSelectedVideoClip = useCallback(
    (patch: Partial<TimelineVideoClip>) => {
      if (!selectedVideoClip) return;
      updateVideoClip(selectedVideoClip.id, patch);
    },
    [selectedVideoClip, updateVideoClip],
  );

  const saveTimeline = useCallback(
    async (closeAfterSave: boolean) => {
      setSaving(true);
      try {
        await onSave({ clips, videoClips });
        if (closeAfterSave) onClose();
      } finally {
        setSaving(false);
      }
    },
    [clips, onClose, onSave, videoClips],
  );

  const handleAddToRenderQueue = useCallback(async () => {
    await saveTimeline(false);
    onAddToRenderQueue?.();
  }, [onAddToRenderQueue, saveTimeline]);

  const handleOverlayCardClick = useCallback(
    (clip: VideoOverlayClip) => {
      if (suppressOverlayClickRef.current) {
        suppressOverlayClickRef.current = false;
        return;
      }
      setSelected({ kind: "overlay", id: clip.suggestionId });
      handleSeek(toFinalMs(clip.startMs));
    },
    [handleSeek, toFinalMs],
  );

  const handleOverlayListPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const list = overlayListRef.current;
      if (!list) return;
      overlayScrollRef.current = {
        startX: e.clientX,
        scrollLeft: list.scrollLeft,
        moved: false,
      };
      list.setPointerCapture?.(e.pointerId);
    },
    [],
  );

  const handleOverlayListPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = overlayScrollRef.current;
      const list = overlayListRef.current;
      if (!drag || !list) return;
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 4) {
        drag.moved = true;
        list.classList.add("dragging");
        e.preventDefault();
      }
      list.scrollLeft = drag.scrollLeft - dx;
    },
    [],
  );

  const handleOverlayListPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = overlayScrollRef.current;
      const list = overlayListRef.current;
      if (drag?.moved) {
        suppressOverlayClickRef.current = true;
        window.setTimeout(() => {
          suppressOverlayClickRef.current = false;
        }, 0);
      }
      overlayScrollRef.current = null;
      list?.classList.remove("dragging");
      list?.releasePointerCapture?.(e.pointerId);
    },
    [],
  );

  const adjustSelectedStart = useCallback(
    (deltaMs: number) => {
      if (selectedOverlay) {
        const maxStart = Math.max(0, safeDurationMs - selectedOverlay.durationMs);
        updateSelectedOverlay({
          startMs: clamp(selectedOverlay.startMs + deltaMs, 0, maxStart),
        });
        return;
      }
      if (!selectedVideoClip) return;
      const maxStart = Math.max(0, safeDurationMs - selectedVideoClip.durationMs);
      updateSelectedVideoClip({
        startMs: clamp(selectedVideoClip.startMs + deltaMs, 0, maxStart),
      });
    },
    [safeDurationMs, selectedOverlay, selectedVideoClip, updateSelectedOverlay, updateSelectedVideoClip],
  );

  const adjustSelectedDuration = useCallback(
    (deltaMs: number) => {
      if (selectedOverlay) {
        updateSelectedOverlay({
          durationMs: clamp(
            selectedOverlay.durationMs + deltaMs,
            TIME_STEP_MS,
            safeDurationMs - selectedOverlay.startMs,
          ),
        });
        return;
      }
      if (!selectedVideoClip) return;
      const trimStart = selectedVideoClip.trimStartMs ?? 0;
      const maxDuration = Math.min(
        selectedVideoClip.sourceDurationMs - trimStart,
        safeDurationMs - selectedVideoClip.startMs,
      );
      updateSelectedVideoClip({
        durationMs: clamp(selectedVideoClip.durationMs + deltaMs, TIME_STEP_MS, maxDuration),
      });
    },
    [safeDurationMs, selectedOverlay, selectedVideoClip, updateSelectedOverlay, updateSelectedVideoClip],
  );

  const adjustSelectedEnd = useCallback(
    (deltaMs: number) => {
      if (selectedOverlay) {
        const nextEnd = clamp(
          clipEndMs(selectedOverlay) + deltaMs,
          selectedOverlay.startMs + TIME_STEP_MS,
          safeDurationMs,
        );
        updateSelectedOverlay({ durationMs: nextEnd - selectedOverlay.startMs });
        return;
      }
      if (!selectedVideoClip) return;
      const trimStart = selectedVideoClip.trimStartMs ?? 0;
      const maxEnd = Math.min(
        safeDurationMs,
        selectedVideoClip.startMs +
          Math.min(
            selectedVideoClip.sourceDurationMs - trimStart,
            safeDurationMs - selectedVideoClip.startMs,
          ),
      );
      const nextEnd = clamp(
        videoClipEndMs(selectedVideoClip) + deltaMs,
        selectedVideoClip.startMs + TIME_STEP_MS,
        maxEnd,
      );
      updateSelectedVideoClip({ durationMs: nextEnd - selectedVideoClip.startMs });
    },
    [safeDurationMs, selectedOverlay, selectedVideoClip, updateSelectedOverlay, updateSelectedVideoClip],
  );

  const applyPositionPreset = useCallback(
    (x: "left" | "center" | "right", y: "top" | "center" | "bottom") => {
      if (!selectedOverlay) return;
      const widthPct = selectedOverlay.layout.widthPct;
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
      updateSelectedOverlay({
        layout: editorRectToLayout({ xPct, yPct, widthPct }),
      });
    },
    [selectedOverlay, updateSelectedOverlay],
  );

  const updateClipLayout = useCallback(
    (clipId: string, layout: OverlayClipLayout) => {
      updateClip(clipId, { layout });
    },
    [updateClip],
  );

  const updateSelectedScale = useCallback(
    (widthPct: number) => {
      if (!selectedOverlay) return;
      const rect = layoutToEditorRect(selectedOverlay.layout);
      updateSelectedOverlay({
        layout: editorRectToLayout({ ...rect, widthPct }),
      });
    },
    [selectedOverlay, updateSelectedOverlay],
  );

  const resetSelectedClip = useCallback(() => {
    if (selectedOverlay) {
      const original = initialClips.find(
        (clip) => clip.suggestionId === selectedOverlay.suggestionId,
      );
      if (original) updateClip(selectedOverlay.suggestionId, normalizeClip(original));
      return;
    }
    if (!selectedVideoClip) return;
    const original = initialVideoClips.find((clip) => clip.id === selectedVideoClip.id);
    if (original) updateVideoClip(selectedVideoClip.id, normalizeVideoClip(original));
  }, [initialClips, initialVideoClips, selectedOverlay, selectedVideoClip, updateClip, updateVideoClip]);

  const handleVideoClipsChange = useCallback((next: TimelineVideoClip[]) => {
    setVideoClips(next);
    const usedTracks = new Set(next.map((clip) => clip.trackIndex));
    setEmptyTrackIndices((current) => current.filter((idx) => !usedTracks.has(idx)));
  }, []);

  const handleAddTrack = useCallback(() => {
    const nextIndex = maxVideoTrackIndex(videoClips, emptyTrackIndices) + 1;
    setEmptyTrackIndices((current) => [...current, nextIndex]);
  }, [emptyTrackIndices, videoClips]);

  const handleAddMedia = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [VIDEO_FILE_DIALOG_FILTER],
    });
    if (!selected || typeof selected !== "string") return;

    try {
      const imported = await importTimelineVideo(rootPath, video.id, selected);
      const nextTrackIndex = maxVideoTrackIndex(videoClips, emptyTrackIndices) + 1;
      const clip: TimelineVideoClip = {
        ...normalizeVideoClip(imported),
        trackIndex: nextTrackIndex,
        startMs: toSourceMs(currentMs),
        durationMs: Math.min(imported.sourceDurationMs, safeDurationMs - currentMs),
      };
      setVideoClips((current) => [...current, clip]);
      setEmptyTrackIndices((current) => current.filter((idx) => idx !== nextTrackIndex));
      setSelected({ kind: "video", id: clip.id });
    } catch (err) {
      console.error("Failed to import timeline video:", err);
    }
  }, [currentMs, emptyTrackIndices, rootPath, safeDurationMs, toSourceMs, video.id, videoClips]);

  const handleConfirmAiOverlay = useCallback(async () => {
    setShowAiOverlayConfirm(false);
    setAiOverlayError(null);
    setAddingAiOverlay(true);
    try {
      const result = await generatePlayheadAiOverlay(rootPath, video.id, toSourceMs(currentMs));
      const newClip = normalizeClip(result.clip);
      const nextClips = [...clips, newClip];
      setClips(nextClips);
      const url = await getOverlayImageDisplayUrl(rootPath, newClip.imageRelativePath);
      setImageUrls((current) => ({ ...current, [newClip.suggestionId]: url }));
      setSelected({ kind: "overlay", id: newClip.suggestionId });
      handleSeek(toFinalMs(newClip.startMs));
      setSaving(true);
      try {
        await onSave({ clips: nextClips, videoClips });
      } finally {
        setSaving(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAiOverlayError(message);
      console.error("Failed to generate AI overlay:", err);
    } finally {
      setAddingAiOverlay(false);
    }
  }, [clips, currentMs, handleSeek, onSave, rootPath, toFinalMs, toSourceMs, video.id, videoClips]);

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
        <header className="video-editor-shell-header video-editor-shell-header-inline">
          <h2 id="video-editor-title">Edit</h2>
          <p className="video-editor-header-subtitle">
            Fine-tune your timeline and export your final video.
          </p>
          <button type="button" className="video-editor-file-select">
            <span>{video.fileName}</span>
            <ChevronDown size={16} />
          </button>

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
              videoClips={videoClips}
              contentStartMs={contentStartMs}
              contentEndMs={contentEndMs}
              enableKeyboardShortcuts
              large
              className="video-editor-preview"
              onTimeUpdate={setCurrentMs}
              onDurationChange={setDurationMs}
              showSeekMarkers
              interactiveOverlays
              selectedClipId={selected?.kind === "overlay" ? selected.id : null}
              selectedVideoClipId={selected?.kind === "video" ? selected.id : null}
              onSelectClip={(id) => setSelected(id ? { kind: "overlay", id } : null)}
              onSelectVideoClip={(id) => setSelected({ kind: "video", id })}
              onClipLayoutChange={updateClipLayout}
              onVideoClipChange={(id, patch) => updateVideoClip(id, patch)}
            />

            <VideoTimelineEditor
              clips={clips}
              videoClips={videoClips}
              emptyTrackIndices={emptyTrackIndices}
              durationMs={safeDurationMs}
              currentMs={currentMs}
              selected={selected}
              pxPerMs={pxPerMs}
              baseVideoLabel={video.fileName}
              imageUrls={imageUrls}
              audioWaveform={audioWaveform}
              contentStartMs={contentStartMs}
              contentEndMs={contentEndMs}
              fitToWidth
              onClipsChange={setClips}
              onVideoClipsChange={handleVideoClipsChange}
              onSelect={setSelected}
              onSeek={handleSeek}
              onPxPerMsChange={setPxPerMs}
              onAddTrack={handleAddTrack}
              onAddMedia={() => void handleAddMedia()}
              onAddAiOverlay={() => setShowAiOverlayConfirm(true)}
              addingAiOverlay={addingAiOverlay}
            />

            {aiOverlayError ? (
              <p className="video-editor-ai-overlay-error" role="alert">
                {aiOverlayError}
              </p>
            ) : null}

            <section className="video-overlay-list-panel">
              <div className="video-overlay-list-header">
                <h3>Overlay list ({clips.length})</h3>
                <span>Drag sideways to scroll</span>
              </div>
              <div
                ref={overlayListRef}
                className="video-overlay-list"
                role="list"
                aria-label="Overlay list"
                onPointerDown={handleOverlayListPointerDown}
                onPointerMove={handleOverlayListPointerMove}
                onPointerUp={handleOverlayListPointerUp}
                onPointerCancel={handleOverlayListPointerUp}
                onWheel={(e) => {
                  const list = overlayListRef.current;
                  if (!list || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
                  list.scrollLeft += e.deltaY;
                }}
              >
                {clips.map((clip, index) => (
                  <div
                    key={clip.suggestionId}
                    className={`video-overlay-card ${
                      selected?.kind === "overlay" && selected.id === clip.suggestionId
                        ? "selected"
                        : ""
                    }`}
                    role="listitem"
                    onClick={() => handleOverlayCardClick(clip)}
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
                        {formatTimeMs(toFinalMs(clip.startMs))} -{" "}
                        {formatTimeMs(toFinalMs(clip.startMs) + clip.durationMs)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </main>

          <aside className="video-editor-inspector">
            <section className="video-editor-panel">
              <h3>{selectedVideoClip ? "Video Settings" : "Overlay Settings"}</h3>
              {selectedVideoClip ? (
                <>
                  <TimeStepper
                    label="Start time"
                    value={formatTimecodeMs(selectedVideoClip.startMs)}
                    onDecrement={() => adjustSelectedStart(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedStart(TIME_STEP_MS)}
                  />
                  <TimeStepper
                    label="End time"
                    value={formatTimecodeMs(videoClipEndMs(selectedVideoClip))}
                    onDecrement={() => adjustSelectedEnd(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedEnd(TIME_STEP_MS)}
                  />
                  <TimeStepper
                    label="Duration"
                    value={formatTimecodeMs(selectedVideoClip.durationMs)}
                    onDecrement={() => adjustSelectedDuration(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedDuration(TIME_STEP_MS)}
                  />
                  <SliderRow
                    label="Scale"
                    value={Math.round(selectedVideoClip.scalePct ?? 100)}
                    min={12}
                    max={100}
                    suffix="%"
                    onChange={(value) => updateSelectedVideoClip({ scalePct: value })}
                  />
                  <SliderRow
                    label="Opacity"
                    value={Math.round(selectedVideoClip.opacityPct ?? 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => updateSelectedVideoClip({ opacityPct: value })}
                  />
                  <SliderRow
                    label="Volume"
                    value={Math.round(selectedVideoClip.volumePct ?? 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => updateSelectedVideoClip({ volumePct: value })}
                  />
                  <button type="button" className="video-editor-reset-button" onClick={resetSelectedClip}>
                    <RotateCcw size={15} />
                    Reset changes
                  </button>
                </>
              ) : selectedOverlay ? (
                <>
                  <TimeStepper
                    label="Start time"
                    value={formatTimecodeMs(selectedOverlay.startMs)}
                    onDecrement={() => adjustSelectedStart(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedStart(TIME_STEP_MS)}
                  />
                  <TimeStepper
                    label="End time"
                    value={formatTimecodeMs(clipEndMs(selectedOverlay))}
                    onDecrement={() => adjustSelectedEnd(-TIME_STEP_MS)}
                    onIncrement={() => adjustSelectedEnd(TIME_STEP_MS)}
                  />
                  <TimeStepper
                    label="Duration"
                    value={formatTimecodeMs(selectedOverlay.durationMs)}
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
                    value={Math.round(selectedOverlay.layout.widthPct)}
                    min={12}
                    max={85}
                    suffix="%"
                    onChange={updateSelectedScale}
                  />
                  <SliderRow
                    label="Opacity"
                    value={Math.round(selectedOverlay.opacityPct ?? 100)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => updateSelectedOverlay({ opacityPct: value })}
                  />
                  <EditorSelect
                    label="Entrance"
                    value={selectedOverlay.entrance ?? "fade-in"}
                    onChange={(value) =>
                      updateSelectedOverlay({
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
                    value={selectedOverlay.exit ?? "fade-out"}
                    onChange={(value) =>
                      updateSelectedOverlay({
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
                <p className="video-editor-empty-panel">Select a clip on the timeline or list.</p>
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
                <span>Include scheduled assets</span>
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

      {showAiOverlayConfirm ? (
        <div
          className="video-editor-confirm-backdrop"
          role="presentation"
          onClick={() => setShowAiOverlayConfirm(false)}
        >
          <div
            className="video-editor-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-overlay-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="ai-overlay-confirm-title">Generate AI overlay?</h3>
            <p>
              Do you want to generate an AI overlay at the playhead (
              {formatTimeMs(currentMs)}) using the transcript at that moment?
            </p>
            <div className="video-editor-confirm-actions">
              <button
                type="button"
                className="video-editor-secondary-button"
                onClick={() => setShowAiOverlayConfirm(false)}
                disabled={addingAiOverlay}
              >
                No
              </button>
              <button
                type="button"
                className="video-editor-primary-button"
                onClick={() => void handleConfirmAiOverlay()}
                disabled={addingAiOverlay}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      ) : null}
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

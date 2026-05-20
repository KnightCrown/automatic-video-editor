import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Eye, Film, Music2, Plus, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import type { AudioWaveform, TimelineVideoClip, VideoOverlayClip } from "../../types/pipeline";
import { formatTimeMs } from "../../utils/overlayClips";
import { videoClipEndMs } from "../../utils/timelineVideoClips";

const MIN_DURATION_MS = 500;
const SNAP_THRESHOLD_MS = 100;
const LABEL_WIDTH_PX = 148;

export type TimelineEditorSelection =
  | { kind: "overlay"; id: string }
  | { kind: "video"; id: string };

type DragMode =
  | { kind: "move"; target: TimelineEditorSelection; startX: number; origStartMs: number }
  | {
      kind: "resize-left";
      target: TimelineEditorSelection;
      startX: number;
      origStartMs: number;
      origDurationMs: number;
      origTrimStartMs?: number;
    }
  | {
      kind: "resize-right";
      target: TimelineEditorSelection;
      startX: number;
      origStartMs: number;
      origDurationMs: number;
    }
  | { kind: "scrub"; startX: number; origMs: number };

type Props = {
  clips: VideoOverlayClip[];
  videoClips: TimelineVideoClip[];
  emptyTrackIndices: number[];
  durationMs: number;
  currentMs: number;
  selected: TimelineEditorSelection | null;
  pxPerMs: number;
  baseVideoLabel: string;
  imageUrls?: Record<string, string>;
  audioWaveform?: AudioWaveform | null;
  onClipsChange: (clips: VideoOverlayClip[]) => void;
  onVideoClipsChange: (clips: TimelineVideoClip[]) => void;
  onSelect: (selection: TimelineEditorSelection | null) => void;
  onSeek: (ms: number) => void;
  onPxPerMsChange: (px: number) => void;
  onAddTrack: () => void;
  onAddMedia: () => void;
  fitToWidth?: boolean;
};

function tickIntervalMs(durationMs: number): number {
  if (durationMs <= 90_000) return 10_000;
  if (durationMs <= 240_000) return 30_000;
  if (durationMs <= 900_000) return 60_000;
  return 300_000;
}

function fallbackAudioBarHeight(index: number): number {
  return 18 + ((index * 37) % 42);
}

function waveformBarCount(timelineWidth: number): number {
  return Math.max(80, Math.min(1800, Math.round(timelineWidth / 3)));
}

function buildDisplayPeaks(
  waveform: AudioWaveform | null | undefined,
  barCount: number,
): number[] {
  const source = waveform?.peaks ?? [];
  if (source.length === 0) return [];
  if (source.length <= barCount) return source;

  return Array.from({ length: barCount }, (_, i) => {
    const start = Math.floor((i * source.length) / barCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * source.length) / barCount));
    let peak = 0;
    for (let j = start; j < end; j++) {
      peak = Math.max(peak, source[j] ?? 0);
    }
    return peak;
  });
}

function selectionMatches(a: TimelineEditorSelection | null, b: TimelineEditorSelection): boolean {
  return a?.kind === b.kind && a.id === b.id;
}

export function VideoTimelineEditor({
  clips,
  videoClips,
  emptyTrackIndices,
  durationMs,
  currentMs,
  selected,
  pxPerMs,
  baseVideoLabel,
  imageUrls = {},
  audioWaveform = null,
  onClipsChange,
  onVideoClipsChange,
  onSelect,
  onSeek,
  onPxPerMsChange,
  onAddTrack,
  onAddMedia,
  fitToWidth = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const [trackAreaWidth, setTrackAreaWidth] = useState(640);
  const [drag, setDrag] = useState<DragMode | null>(null);

  useLayoutEffect(() => {
    const el = trackAreaRef.current;
    if (!el) return;
    const apply = () => setTrackAreaWidth(Math.max(1, el.clientWidth));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!fitToWidth || durationMs <= 0) return;
    const w = trackAreaWidth;
    if (w <= 0) return;
    const fit = Math.max(0.0003, Math.min(0.25, w / durationMs));
    onPxPerMsChange(fit);
  }, [durationMs, fitToWidth, onPxPerMsChange, trackAreaWidth]);

  const timelineWidth = fitToWidth
    ? trackAreaWidth
    : Math.max(durationMs * pxPerMs, trackAreaWidth);
  const totalWidth = timelineWidth + LABEL_WIDTH_PX;
  const tickStep = tickIntervalMs(durationMs);
  const displayPeaks = useMemo(
    () => buildDisplayPeaks(audioWaveform, waveformBarCount(timelineWidth)),
    [audioWaveform, timelineWidth],
  );
  const ticks = useMemo(
    () =>
      Array.from({ length: Math.ceil(durationMs / tickStep) + 1 }, (_, i) =>
        Math.min(durationMs, i * tickStep),
      ),
    [durationMs, tickStep],
  );

  const extraTrackIndices = useMemo(() => {
    const fromClips = videoClips.map((clip) => clip.trackIndex);
    const merged = new Set([...fromClips, ...emptyTrackIndices]);
    return Array.from(merged).sort((a, b) => b - a);
  }, [emptyTrackIndices, videoClips]);

  const snapMs = useCallback((ms: number, playheadMs: number): number => {
    if (Math.abs(ms - playheadMs) <= SNAP_THRESHOLD_MS) return playheadMs;
    return ms;
  }, []);

  const pxToMs = useCallback((dx: number) => Math.round(dx / pxPerMs), [pxPerMs]);

  const updateOverlayClip = useCallback(
    (clipId: string, patch: Partial<VideoOverlayClip>) => {
      onClipsChange(
        clips.map((c) => (c.suggestionId === clipId ? { ...c, ...patch } : c)),
      );
    },
    [clips, onClipsChange],
  );

  const updateVideoClip = useCallback(
    (clipId: string, patch: Partial<TimelineVideoClip>) => {
      onVideoClipsChange(
        videoClips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      );
    },
    [onVideoClipsChange, videoClips],
  );

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - drag.startX;

      if (drag.kind === "scrub") {
        const ms = Math.max(0, Math.min(durationMs, drag.origMs + pxToMs(dx)));
        onSeek(ms);
        return;
      }

      if (drag.target.kind === "overlay") {
        const clip = clips.find((c) => c.suggestionId === drag.target.id);
        if (!clip) return;

        if (drag.kind === "move") {
          let start = Math.max(
            0,
            Math.min(durationMs - clip.durationMs, drag.origStartMs + pxToMs(dx)),
          );
          start = snapMs(start, currentMs);
          updateOverlayClip(drag.target.id, { startMs: start });
        } else if (drag.kind === "resize-left") {
          const delta = pxToMs(dx);
          let start = Math.max(0, drag.origStartMs + delta);
          let duration = Math.max(MIN_DURATION_MS, drag.origDurationMs - delta);
          if (start + duration > durationMs) duration = durationMs - start;
          start = snapMs(start, currentMs);
          updateOverlayClip(drag.target.id, { startMs: start, durationMs: duration });
        } else if (drag.kind === "resize-right") {
          let duration = Math.max(MIN_DURATION_MS, drag.origDurationMs + pxToMs(dx));
          let end = drag.origStartMs + duration;
          end = snapMs(end, currentMs);
          duration = Math.max(MIN_DURATION_MS, end - drag.origStartMs);
          if (drag.origStartMs + duration > durationMs) {
            duration = durationMs - drag.origStartMs;
          }
          updateOverlayClip(drag.target.id, { durationMs: duration });
        }
        return;
      }

      const clip = videoClips.find((c) => c.id === drag.target.id);
      if (!clip) return;
      const trimStart = clip.trimStartMs ?? 0;
      const maxDuration = clip.sourceDurationMs - trimStart;

      if (drag.kind === "move") {
        let start = Math.max(
          0,
          Math.min(durationMs - clip.durationMs, drag.origStartMs + pxToMs(dx)),
        );
        start = snapMs(start, currentMs);
        updateVideoClip(drag.target.id, { startMs: start });
      } else if (drag.kind === "resize-left") {
        const delta = pxToMs(dx);
        let start = Math.max(0, drag.origStartMs + delta);
        let duration = Math.max(MIN_DURATION_MS, drag.origDurationMs - delta);
        let nextTrim = Math.max(0, (drag.origTrimStartMs ?? trimStart) + delta);
        if (nextTrim + duration > clip.sourceDurationMs) {
          duration = clip.sourceDurationMs - nextTrim;
        }
        if (start + duration > durationMs) duration = durationMs - start;
        start = snapMs(start, currentMs);
        updateVideoClip(drag.target.id, {
          startMs: start,
          durationMs: duration,
          trimStartMs: nextTrim,
        });
      } else if (drag.kind === "resize-right") {
        let duration = Math.max(MIN_DURATION_MS, drag.origDurationMs + pxToMs(dx));
        duration = Math.min(duration, maxDuration);
        let end = drag.origStartMs + duration;
        end = snapMs(end, currentMs);
        duration = Math.max(MIN_DURATION_MS, end - drag.origStartMs);
        if (drag.origStartMs + duration > durationMs) {
          duration = durationMs - drag.origStartMs;
        }
        updateVideoClip(drag.target.id, { durationMs: duration });
      }
    };

    const onUp = () => setDrag(null);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [
    clips,
    currentMs,
    drag,
    durationMs,
    onSeek,
    pxToMs,
    snapMs,
    updateOverlayClip,
    updateVideoClip,
    videoClips,
  ]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    if (selected.kind === "overlay") {
      onClipsChange(clips.filter((c) => c.suggestionId !== selected.id));
    } else {
      onVideoClipsChange(videoClips.filter((c) => c.id !== selected.id));
    }
    onSelect(null);
  }, [clips, onClipsChange, onSelect, onVideoClipsChange, selected, videoClips]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (
          selected &&
          (e.target === document.body ||
            (e.target as HTMLElement).closest(".video-timeline-editor"))
        ) {
          e.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, selected]);

  const seekFromTrackClick = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest(".timeline-clip")) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ms = Math.max(0, Math.min(durationMs, x / pxPerMs));
      onSeek(ms);
      onSelect(null);
    },
    [durationMs, onSeek, onSelect, pxPerMs],
  );

  const startScrub = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      setDrag({
        kind: "scrub",
        startX: e.clientX,
        origMs: currentMs,
      });
    },
    [currentMs],
  );

  const renderVideoClip = (clip: TimelineVideoClip) => {
    const left = clip.startMs * pxPerMs;
    const width = Math.max(clip.durationMs * pxPerMs, 22);
    const isSelected = selectionMatches(selected, { kind: "video", id: clip.id });
    const target: TimelineEditorSelection = { kind: "video", id: clip.id };

    return (
      <div
        key={clip.id}
        className={`timeline-clip video-clip ${isSelected ? "selected" : ""}`}
        style={{ left, width }}
        title={`${clip.fileName} - ${formatTimeMs(clip.startMs)}`}
        onMouseDown={(e) => {
          e.stopPropagation();
          onSelect(target);
          setDrag({
            kind: "move",
            target,
            startX: e.clientX,
            origStartMs: clip.startMs,
          });
        }}
      >
        <div
          className="timeline-clip-handle left"
          onMouseDown={(e) => {
            e.stopPropagation();
            onSelect(target);
            setDrag({
              kind: "resize-left",
              target,
              startX: e.clientX,
              origStartMs: clip.startMs,
              origDurationMs: clip.durationMs,
              origTrimStartMs: clip.trimStartMs ?? 0,
            });
          }}
        />
        <span className="timeline-clip-label">{clip.fileName}</span>
        <div
          className="timeline-clip-handle right"
          onMouseDown={(e) => {
            e.stopPropagation();
            onSelect(target);
            setDrag({
              kind: "resize-right",
              target,
              startX: e.clientX,
              origStartMs: clip.startMs,
              origDurationMs: clip.durationMs,
            });
          }}
        />
      </div>
    );
  };

  return (
    <div className={`video-timeline-editor${fitToWidth ? " fit-width" : ""}`}>
      <div className="video-timeline-toolbar">
        <div className="video-timeline-toolgroup">
          <button
            type="button"
            className="video-editor-icon-button"
            onClick={() => onPxPerMsChange(Math.min(0.2, pxPerMs * 1.25))}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            className="video-editor-icon-button"
            onClick={() => onPxPerMsChange(Math.max(0.0003, pxPerMs / 1.25))}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="video-editor-icon-button"
            disabled={!selected}
            onClick={deleteSelected}
            title="Delete selected clip"
            aria-label="Delete selected clip"
          >
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            className="video-editor-icon-button"
            disabled
            title="Split clip"
            aria-label="Split clip"
          >
            <Scissors size={16} />
          </button>
        </div>
        <div className="video-timeline-toolgroup">
          <button type="button" className="video-timeline-action-button" onClick={onAddTrack}>
            <Plus size={15} />
            Add track
          </button>
          <button type="button" className="video-timeline-action-button primary" onClick={onAddMedia}>
            <Plus size={15} />
            Add media
          </button>
        </div>
        <span className="video-timeline-playhead-label">
          Playhead {formatTimeMs(currentMs)}
        </span>
      </div>

      <div className="video-timeline-shell">
        <div className="video-timeline-scroll" ref={scrollRef}>
          <div
            className="video-timeline-inner"
            style={fitToWidth ? { width: "100%" } : { width: totalWidth }}
          >
            <div
              className="video-timeline-ruler"
              style={{ marginLeft: LABEL_WIDTH_PX, width: timelineWidth }}
              onMouseDown={seekFromTrackClick}
            >
              {ticks.map((ms) => (
                <span
                  key={ms}
                  className="video-timeline-tick"
                  style={{ left: ms * pxPerMs }}
                >
                  {formatTimeMs(ms)}
                </span>
              ))}
            </div>

            <div
              className="video-timeline-playhead"
              style={{ left: LABEL_WIDTH_PX + currentMs * pxPerMs }}
              onMouseDown={startScrub}
            >
              <span>{formatTimeMs(currentMs)}</span>
            </div>

            {extraTrackIndices.map((trackIndex) => (
              <div className="video-timeline-row" key={`track-${trackIndex}`}>
                <div className="video-timeline-lane-label">
                  <Film size={16} />
                  <span>Video {trackIndex + 1}</span>
                </div>
                <div
                  className="video-timeline-track-area video extra"
                  style={{ width: timelineWidth }}
                  onMouseDown={seekFromTrackClick}
                >
                  {videoClips
                    .filter((clip) => clip.trackIndex === trackIndex)
                    .map(renderVideoClip)}
                </div>
              </div>
            ))}

            <div className="video-timeline-row">
              <div className="video-timeline-lane-label">
                <Eye size={16} />
                <span>Overlays</span>
                <b>{clips.length}</b>
              </div>
              <div
                className="video-timeline-track-area overlays"
                style={{ width: timelineWidth }}
                ref={trackAreaRef}
                onMouseDown={seekFromTrackClick}
              >
                {clips.map((clip) => {
                  const left = clip.startMs * pxPerMs;
                  const width = Math.max(clip.durationMs * pxPerMs, 22);
                  const isSelected = selectionMatches(selected, {
                    kind: "overlay",
                    id: clip.suggestionId,
                  });
                  const target: TimelineEditorSelection = {
                    kind: "overlay",
                    id: clip.suggestionId,
                  };
                  const imageUrl = imageUrls[clip.suggestionId];
                  return (
                    <div
                      key={clip.suggestionId}
                      className={`timeline-clip ${isSelected ? "selected" : ""}`}
                      style={{ left, width }}
                      title={`${clip.title} - ${formatTimeMs(clip.startMs)}`}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        onSelect(target);
                        setDrag({
                          kind: "move",
                          target,
                          startX: e.clientX,
                          origStartMs: clip.startMs,
                        });
                      }}
                    >
                      <div
                        className="timeline-clip-handle left"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          onSelect(target);
                          setDrag({
                            kind: "resize-left",
                            target,
                            startX: e.clientX,
                            origStartMs: clip.startMs,
                            origDurationMs: clip.durationMs,
                          });
                        }}
                      />
                      {imageUrl ? (
                        <img
                          src={imageUrl}
                          alt=""
                          className="timeline-clip-thumb"
                          draggable={false}
                        />
                      ) : null}
                      <span className="timeline-clip-label">{clip.title}</span>
                      <div
                        className="timeline-clip-handle right"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          onSelect(target);
                          setDrag({
                            kind: "resize-right",
                            target,
                            startX: e.clientX,
                            origStartMs: clip.startMs,
                            origDurationMs: clip.durationMs,
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="video-timeline-row">
              <div className="video-timeline-lane-label">
                <Film size={16} />
                <span>Video</span>
              </div>
              <div
                className="video-timeline-track-area video"
                style={{ width: timelineWidth }}
                onMouseDown={seekFromTrackClick}
              >
                <div className="timeline-base-video-clip" style={{ width: timelineWidth }}>
                  <span>{baseVideoLabel}</span>
                </div>
              </div>
            </div>

            <div className="video-timeline-row">
              <div className="video-timeline-lane-label">
                <Music2 size={16} />
                <span>Audio</span>
              </div>
              <div
                className="video-timeline-track-area audio"
                style={{ width: timelineWidth }}
                onMouseDown={seekFromTrackClick}
              >
                <div className="timeline-audio-wave" style={{ width: timelineWidth }}>
                  {displayPeaks.length > 0
                    ? displayPeaks.map((peak, i) => (
                        <span
                          key={i}
                          style={{ height: 5 + Math.max(0.02, peak) * 35 }}
                        />
                      ))
                    : Array.from({ length: 96 }).map((_, i) => (
                        <span key={i} style={{ height: fallbackAudioBarHeight(i) }} />
                      ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { videoClipEndMs };

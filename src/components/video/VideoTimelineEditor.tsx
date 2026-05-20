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
import type { VideoOverlayClip } from "../../types/pipeline";
import { formatTimeMs } from "../../utils/overlayClips";

const MIN_DURATION_MS = 500;
const SNAP_THRESHOLD_MS = 100;
const LABEL_WIDTH_PX = 148;

type DragMode =
  | { kind: "move"; clipId: string; startX: number; origStartMs: number }
  | {
      kind: "resize-left";
      clipId: string;
      startX: number;
      origStartMs: number;
      origDurationMs: number;
    }
  | {
      kind: "resize-right";
      clipId: string;
      startX: number;
      origStartMs: number;
      origDurationMs: number;
    }
  | { kind: "scrub"; startX: number; origMs: number };

type Props = {
  clips: VideoOverlayClip[];
  durationMs: number;
  currentMs: number;
  selectedId: string | null;
  pxPerMs: number;
  imageUrls?: Record<string, string>;
  onClipsChange: (clips: VideoOverlayClip[]) => void;
  onSelect: (id: string | null) => void;
  onSeek: (ms: number) => void;
  onPxPerMsChange: (px: number) => void;
  /** Scale timeline so full duration fits the visible track width. */
  fitToWidth?: boolean;
};

function tickIntervalMs(durationMs: number): number {
  if (durationMs <= 90_000) return 10_000;
  if (durationMs <= 240_000) return 30_000;
  if (durationMs <= 900_000) return 60_000;
  return 300_000;
}

function audioBarHeight(index: number): number {
  return 18 + ((index * 37) % 42);
}

export function VideoTimelineEditor({
  clips,
  durationMs,
  currentMs,
  selectedId,
  pxPerMs,
  imageUrls = {},
  onClipsChange,
  onSelect,
  onSeek,
  onPxPerMsChange,
  fitToWidth = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragMode | null>(null);

  useLayoutEffect(() => {
    if (!fitToWidth || durationMs <= 0) return;
    const el = trackAreaRef.current;
    if (!el) return;

    const applyFit = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const fit = Math.max(0.002, Math.min(0.25, (w - 16) / durationMs));
      onPxPerMsChange(fit);
    };

    applyFit();
    const ro = new ResizeObserver(applyFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [durationMs, fitToWidth, onPxPerMsChange]);

  const timelineWidth = Math.max(
    durationMs * pxPerMs,
    trackAreaRef.current?.clientWidth ?? 640,
  );
  const totalWidth = timelineWidth + LABEL_WIDTH_PX;
  const tickStep = tickIntervalMs(durationMs);
  const ticks = useMemo(
    () =>
      Array.from({ length: Math.ceil(durationMs / tickStep) + 1 }, (_, i) =>
        Math.min(durationMs, i * tickStep),
      ),
    [durationMs, tickStep],
  );

  const snapMs = useCallback((ms: number, playheadMs: number): number => {
    if (Math.abs(ms - playheadMs) <= SNAP_THRESHOLD_MS) return playheadMs;
    return ms;
  }, []);

  const updateClip = useCallback(
    (clipId: string, patch: Partial<VideoOverlayClip>) => {
      onClipsChange(
        clips.map((c) => (c.suggestionId === clipId ? { ...c, ...patch } : c)),
      );
    },
    [clips, onClipsChange],
  );

  const pxToMs = useCallback((dx: number) => Math.round(dx / pxPerMs), [pxPerMs]);

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - drag.startX;

      if (drag.kind === "scrub") {
        const ms = Math.max(0, Math.min(durationMs, drag.origMs + pxToMs(dx)));
        onSeek(ms);
        return;
      }

      const clip = clips.find((c) => c.suggestionId === drag.clipId);
      if (!clip) return;

      if (drag.kind === "move") {
        let start = Math.max(0, Math.min(durationMs - clip.durationMs, drag.origStartMs + pxToMs(dx)));
        start = snapMs(start, currentMs);
        updateClip(drag.clipId, { startMs: start });
      } else if (drag.kind === "resize-left") {
        const delta = pxToMs(dx);
        let start = Math.max(0, drag.origStartMs + delta);
        let duration = Math.max(MIN_DURATION_MS, drag.origDurationMs - delta);
        if (start + duration > durationMs) {
          duration = durationMs - start;
        }
        start = snapMs(start, currentMs);
        updateClip(drag.clipId, { startMs: start, durationMs: duration });
      } else if (drag.kind === "resize-right") {
        let duration = Math.max(MIN_DURATION_MS, drag.origDurationMs + pxToMs(dx));
        let end = drag.origStartMs + duration;
        end = snapMs(end, currentMs);
        duration = Math.max(MIN_DURATION_MS, end - drag.origStartMs);
        if (drag.origStartMs + duration > durationMs) {
          duration = durationMs - drag.origStartMs;
        }
        updateClip(drag.clipId, { durationMs: duration });
      }
    };

    const onUp = () => setDrag(null);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clips, currentMs, drag, durationMs, onSeek, pxToMs, snapMs, updateClip]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    onClipsChange(clips.filter((c) => c.suggestionId !== selectedId));
    onSelect(null);
  }, [clips, onClipsChange, onSelect, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (
          selectedId &&
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
  }, [deleteSelected, selectedId]);

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
            onClick={() => onPxPerMsChange(Math.max(0.002, pxPerMs / 1.25))}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="video-editor-icon-button"
            disabled={!selectedId}
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
        <span className="video-timeline-playhead-label">
          Playhead {formatTimeMs(currentMs)}
        </span>
      </div>

      <div className="video-timeline-shell">
        <div className="video-timeline-scroll" ref={scrollRef}>
          <div className="video-timeline-inner" style={{ width: totalWidth }}>
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

            <div className="video-timeline-row">
              <div className="video-timeline-lane-label">
                <Film size={16} />
                <span>Video</span>
              </div>
              <div
                className="video-timeline-track-area video"
                style={{ width: timelineWidth }}
                ref={trackAreaRef}
                onMouseDown={seekFromTrackClick}
              >
                <div className="timeline-video-strip" style={{ width: timelineWidth }}>
                  {Array.from({ length: 18 }).map((_, i) => (
                    <span key={i} />
                  ))}
                </div>
              </div>
            </div>

            <div className="video-timeline-row">
              <div className="video-timeline-lane-label">
                <Eye size={16} />
                <span>Overlays</span>
                <b>{clips.length}</b>
              </div>
              <div
                className="video-timeline-track-area overlays"
                style={{ width: timelineWidth }}
                onMouseDown={seekFromTrackClick}
              >
                {clips.map((clip) => {
                  const left = clip.startMs * pxPerMs;
                  const width = Math.max(clip.durationMs * pxPerMs, 22);
                  const selected = clip.suggestionId === selectedId;
                  const imageUrl = imageUrls[clip.suggestionId];
                  return (
                    <div
                      key={clip.suggestionId}
                      className={`timeline-clip ${selected ? "selected" : ""}`}
                      style={{ left, width }}
                      title={`${clip.title} - ${formatTimeMs(clip.startMs)}`}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        onSelect(clip.suggestionId);
                        setDrag({
                          kind: "move",
                          clipId: clip.suggestionId,
                          startX: e.clientX,
                          origStartMs: clip.startMs,
                        });
                      }}
                    >
                      <div
                        className="timeline-clip-handle left"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          onSelect(clip.suggestionId);
                          setDrag({
                            kind: "resize-left",
                            clipId: clip.suggestionId,
                            startX: e.clientX,
                            origStartMs: clip.startMs,
                            origDurationMs: clip.durationMs,
                          });
                        }}
                      />
                      {imageUrl ? (
                        <img src={imageUrl} alt="" className="timeline-clip-thumb" draggable={false} />
                      ) : null}
                      <span className="timeline-clip-label">{clip.title}</span>
                      <div
                        className="timeline-clip-handle right"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          onSelect(clip.suggestionId);
                          setDrag({
                            kind: "resize-right",
                            clipId: clip.suggestionId,
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
                <Music2 size={16} />
                <span>Audio</span>
              </div>
              <div
                className="video-timeline-track-area audio"
                style={{ width: timelineWidth }}
                onMouseDown={seekFromTrackClick}
              >
                <div className="timeline-audio-wave" style={{ width: timelineWidth }}>
                  {Array.from({ length: 96 }).map((_, i) => (
                    <span key={i} style={{ height: audioBarHeight(i) }} />
                  ))}
                </div>
              </div>
            </div>

            <div className="video-timeline-row add-track-row">
              <div className="video-timeline-lane-label" />
              <div className="video-timeline-add-track">
                <button type="button" disabled>
                  <Plus size={15} />
                  Add track
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

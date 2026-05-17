import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { VideoOverlayClip } from "../../types/pipeline";
import { formatTimeMs } from "../../utils/overlayClips";

const MIN_DURATION_MS = 500;
const SNAP_THRESHOLD_MS = 100;

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
  onClipsChange: (clips: VideoOverlayClip[]) => void;
  onSelect: (id: string | null) => void;
  onSeek: (ms: number) => void;
  onPxPerMsChange: (px: number) => void;
  /** Scale timeline so full duration fits the visible track width. */
  fitToWidth?: boolean;
};

export function VideoTimelineEditor({
  clips,
  durationMs,
  currentMs,
  selectedId,
  pxPerMs,
  onClipsChange,
  onSelect,
  onSeek,
  onPxPerMsChange,
  fitToWidth = false,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragMode | null>(null);

  useLayoutEffect(() => {
    if (!fitToWidth || durationMs <= 0) return;
    const el = trackRef.current;
    if (!el) return;

    const applyFit = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const fit = Math.max(0.002, Math.min(0.25, (w - 32) / durationMs));
      onPxPerMsChange(fit);
    };

    applyFit();
    const ro = new ResizeObserver(applyFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [durationMs, fitToWidth, onPxPerMsChange]);

  const timelineWidth = Math.max(durationMs * pxPerMs, trackRef.current?.clientWidth ?? 400);

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
        let start = Math.max(0, drag.origStartMs + pxToMs(dx));
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

  const onTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".timeline-clip")) return;
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left + (trackRef.current?.scrollLeft ?? 0);
      const ms = Math.max(0, Math.min(durationMs, x / pxPerMs));
      onSeek(ms);
    },
    [durationMs, onSeek, pxPerMs],
  );

  return (
    <div className={`video-timeline-editor${fitToWidth ? " fit-width" : ""}`}>
      <div className="video-timeline-toolbar">
        <button
          type="button"
          className="btn small"
          onClick={() => onPxPerMsChange(Math.min(0.2, pxPerMs * 1.25))}
        >
          Zoom in
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => onPxPerMsChange(Math.max(0.02, pxPerMs / 1.25))}
        >
          Zoom out
        </button>
        <button
          type="button"
          className="btn small"
          disabled={!selectedId}
          onClick={deleteSelected}
        >
          Delete clip
        </button>
        <span className="muted">Playhead: {formatTimeMs(currentMs)}</span>
      </div>

      <div className="video-timeline-scroll" ref={trackRef}>
        <div
          className="video-timeline-inner"
          style={{ width: timelineWidth }}
          onMouseDown={onTrackClick}
        >
          <div className="video-timeline-ruler" style={{ width: timelineWidth }}>
            {Array.from({ length: Math.ceil(durationMs / 5000) + 1 }).map((_, i) => (
              <span
                key={i}
                className="video-timeline-tick"
                style={{ left: i * 5000 * pxPerMs }}
              >
                {formatTimeMs(i * 5000)}
              </span>
            ))}
          </div>

          <div
            className="video-timeline-playhead"
            style={{ left: currentMs * pxPerMs }}
          />

          <div className="video-timeline-track-label">Overlays</div>
          <div className="video-timeline-track" style={{ width: timelineWidth }}>
            {clips.map((clip) => {
              const left = clip.startMs * pxPerMs;
              const width = Math.max(clip.durationMs * pxPerMs, 8);
              const selected = clip.suggestionId === selectedId;
              return (
                <div
                  key={clip.suggestionId}
                  className={`timeline-clip ${selected ? "selected" : ""}`}
                  style={{ left, width }}
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
      </div>
    </div>
  );
}

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getOverlayImageDisplayUrl } from "../../services/pipelineService";
import type { TimelineVideoClip, VideoOverlayClip } from "../../types/pipeline";
import { VideoSeekWithMarkers } from "./VideoSeekWithMarkers";
import {
  formatTimeMs,
  getActiveClips,
  layoutStyle,
} from "../../utils/overlayClips";
import {
  buildTimelineInsertPlan,
  clipInsertAtMs,
  effectiveClipDurationMs,
  isInsertClip,
  sourceToFinalMs,
} from "../../utils/timelineInserts";
import {
  clampOverlayEditorRect,
  editorRectToLayout,
  layoutToEditorRect,
  type OverlayEditorRect,
} from "../../utils/overlayLayout";

export type VideoPreviewHandle = {
  seekToMs: (ms: number) => void;
  getCurrentTimeMs: () => number;
  getVideoElement: () => HTMLVideoElement | null;
};

type Props = {
  videoPath: string;
  rootPath: string;
  clips: VideoOverlayClip[];
  videoClips?: TimelineVideoClip[];
  contentStartMs?: number;
  contentEndMs?: number;
  className?: string;
  large?: boolean;
  onTimeUpdate?: (ms: number) => void;
  onDurationChange?: (durationMs: number) => void;
  showSeekMarkers?: boolean;
  hideControls?: boolean;
  enableKeyboardShortcuts?: boolean;
  interactiveOverlays?: boolean;
  selectedClipId?: string | null;
  onSelectClip?: (clipId: string) => void;
  onClipLayoutChange?: (clipId: string, layout: VideoOverlayClip["layout"]) => void;
};

type OverlayDragMode = "move" | "resize";

type PreviewSegment = {
  key: string;
  src: string;
  finalStartMs: number;
  finalEndMs: number;
  mediaStartMs: number;
};

function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function resolveTimelineVideoSrc(rootPath: string, relativePath: string): string {
  if (isAbsolutePath(relativePath)) return convertFileSrc(relativePath);
  const root = rootPath.replace(/[\\/]+$/, "");
  const rel = relativePath.replace(/\//g, "\\").replace(/^[\\/]+/, "");
  return convertFileSrc(`${root}\\${rel}`);
}

function isImageTimelineClip(clip: TimelineVideoClip): boolean {
  if (clip.assetKind === "image") return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(clip.fileName) || /\.(png|jpe?g|gif|webp)$/i.test(clip.sourceRelativePath);
}

export const VideoPreviewWithOverlays = forwardRef<VideoPreviewHandle, Props>(
  function VideoPreviewWithOverlays(
    {
      videoPath,
      rootPath,
      clips,
      videoClips = [],
      contentStartMs,
      contentEndMs,
      className = "",
      large = false,
      onTimeUpdate,
      onDurationChange,
      showSeekMarkers = true,
      hideControls = false,
      enableKeyboardShortcuts = true,
      interactiveOverlays = false,
      selectedClipId = null,
      onSelectClip,
      onClipLayoutChange,
    },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const baseSrc = useMemo(() => convertFileSrc(videoPath), [videoPath]);
    const [playing, setPlaying] = useState(false);
    const [currentMs, setCurrentMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [sourceDurationMs, setSourceDurationMs] = useState(0);
    const [mediaSrc, setMediaSrc] = useState(baseSrc);
    const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
    const videoClipUrls = useMemo(
      () =>
        Object.fromEntries(
          videoClips.map((clip) => [
            clip.id,
            resolveTimelineVideoSrc(rootPath, clip.sourceRelativePath),
          ]),
        ),
      [rootPath, videoClips],
    );
    const rafRef = useRef<number | null>(null);
    const activeSegmentRef = useRef<PreviewSegment | null>(null);
    const pendingSeekRef = useRef<{ ms: number; play: boolean } | null>(null);
    const overlayDragRef = useRef<{
      clipId: string;
      mode: OverlayDragMode;
      startX: number;
      startY: number;
      startRect: OverlayEditorRect;
    } | null>(null);

    useEffect(() => {
      setMediaSrc(baseSrc);
      setCurrentMs(0);
      setSourceDurationMs(0);
      activeSegmentRef.current = null;
      pendingSeekRef.current = null;
    }, [baseSrc]);

    const contentWindow = useMemo(() => {
      const start = contentStartMs ?? 0;
      const end = Math.max(start + 1, contentEndMs ?? sourceDurationMs);
      return { start, end };
    }, [contentEndMs, contentStartMs, sourceDurationMs]);

    const insertClips = useMemo(
      () =>
        videoClips
          .filter(isInsertClip)
          .map((clip) => ({
            clip,
            insertAtMs: clipInsertAtMs(clip, contentWindow.start, contentWindow.end),
            durationMs: effectiveClipDurationMs(clip),
          }))
          .sort((a, b) => {
            return a.insertAtMs - b.insertAtMs || a.clip.trackIndex - b.clip.trackIndex;
          }),
      [contentWindow.end, contentWindow.start, videoClips],
    );

    const previewSegments = useMemo<PreviewSegment[]>(() => {
      const segments: PreviewSegment[] = [];
      let cursor = contentWindow.start;
      let finalCursor = 0;

      for (const insert of insertClips) {
        if (insert.insertAtMs > cursor) {
          const duration = insert.insertAtMs - cursor;
          segments.push({
            key: `base-${cursor}`,
            src: baseSrc,
            finalStartMs: finalCursor,
            finalEndMs: finalCursor + duration,
            mediaStartMs: cursor,
          });
          finalCursor += duration;
          cursor = insert.insertAtMs;
        }
        const src = videoClipUrls[insert.clip.id];
        if (src) {
          segments.push({
            key: insert.clip.id,
            src,
            finalStartMs: finalCursor,
            finalEndMs: finalCursor + insert.durationMs,
            mediaStartMs: insert.clip.trimStartMs ?? 0,
          });
          finalCursor += insert.durationMs;
        }
      }

      if (contentWindow.end > cursor) {
        const duration = contentWindow.end - cursor;
        segments.push({
          key: `base-${cursor}`,
          src: baseSrc,
          finalStartMs: finalCursor,
          finalEndMs: finalCursor + duration,
          mediaStartMs: cursor,
        });
      }

      if (segments.length === 0) {
        segments.push({
          key: "base",
          src: baseSrc,
          finalStartMs: 0,
          finalEndMs: sourceDurationMs || 1,
          mediaStartMs: 0,
        });
      }
      return segments;
    }, [baseSrc, contentWindow.end, contentWindow.start, insertClips, sourceDurationMs, videoClipUrls]);

    const previewDurationMs = useMemo(
      () => previewSegments[previewSegments.length - 1]?.finalEndMs ?? sourceDurationMs,
      [previewSegments, sourceDurationMs],
    );

    useEffect(() => {
      if (previewDurationMs > 0) {
        setDurationMs(previewDurationMs);
        onDurationChange?.(previewDurationMs);
      }
    }, [onDurationChange, previewDurationMs]);

    const segmentForFinalMs = useCallback(
      (ms: number) =>
        previewSegments.find((segment) => ms >= segment.finalStartMs && ms < segment.finalEndMs) ??
        previewSegments[previewSegments.length - 1],
      [previewSegments],
    );

    const applyPreviewTime = useCallback(
      (ms: number, play = false) => {
        const v = videoRef.current;
        const clamped = Math.max(0, Math.min(previewDurationMs || 0, ms));
        const segment = segmentForFinalMs(clamped);
        if (!v || !segment) {
          setCurrentMs(clamped);
          onTimeUpdate?.(clamped);
          return;
        }
        const mediaMs = segment.mediaStartMs + (clamped - segment.finalStartMs);
        activeSegmentRef.current = segment;
        if (mediaSrc !== segment.src) {
          pendingSeekRef.current = { ms: mediaMs, play };
          setMediaSrc(segment.src);
        } else {
          v.currentTime = mediaMs / 1000;
          if (play) void v.play();
        }
        setCurrentMs(clamped);
        onTimeUpdate?.(clamped);
      },
      [mediaSrc, onTimeUpdate, previewDurationMs, segmentForFinalMs],
    );

    useEffect(() => {
      activeSegmentRef.current = segmentForFinalMs(currentMs);
    }, [currentMs, segmentForFinalMs]);

    useImperativeHandle(ref, () => ({
      seekToMs(ms: number) {
        applyPreviewTime(ms);
      },
      getCurrentTimeMs() {
        return currentMs;
      },
      getVideoElement() {
        return videoRef.current;
      },
    }));

    useEffect(() => {
      let cancelled = false;
      (async () => {
        const entries = await Promise.all(
          clips.map(async (c) => {
            const url = await getOverlayImageDisplayUrl(rootPath, c.imageRelativePath);
            return [c.suggestionId, url] as const;
          }),
        );
        if (!cancelled) {
          setImageUrls(Object.fromEntries(entries));
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [clips, rootPath]);

    const insertOffsets = useMemo(() => {
      const end = Math.max(contentWindow.start + 1, contentWindow.end);
      return buildTimelineInsertPlan(videoClips, contentWindow.start, end).insertOffsets;
    }, [contentWindow.end, contentWindow.start, videoClips]);

    const displayClips = useMemo(
      () =>
        clips.map((clip) => ({
          ...clip,
          startMs: sourceToFinalMs(clip.startMs, contentWindow.start, insertOffsets),
        })),
      [clips, contentWindow.start, insertOffsets],
    );

    const activeClips = useMemo(
      () => getActiveClips(displayClips, currentMs),
      [displayClips, currentMs],
    );

    const activeOverlayVideoClips = useMemo(
      () =>
        videoClips
          .filter((clip) => !isInsertClip(clip))
          .map((clip) => ({
            clip,
            finalStartMs: sourceToFinalMs(clip.startMs, contentWindow.start, insertOffsets),
            durationMs: effectiveClipDurationMs(clip),
          }))
          .filter(({ finalStartMs, durationMs }) => currentMs >= finalStartMs && currentMs < finalStartMs + durationMs),
      [contentWindow.start, currentMs, insertOffsets, videoClips],
    );

    const pointerPercent = useCallback((clientX: number, clientY: number) => {
      const stage = stageRef.current;
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        xPct: ((clientX - rect.left) / rect.width) * 100,
        yPct: ((clientY - rect.top) / rect.height) * 100,
      };
    }, []);

    useEffect(() => {
      if (!interactiveOverlays) return;

      const onPointerMove = (e: PointerEvent) => {
        const drag = overlayDragRef.current;
        if (!drag) return;
        const pt = pointerPercent(e.clientX, e.clientY);
        if (!pt) return;

        if (drag.mode === "move") {
          const dx = pt.xPct - drag.startX;
          const dy = pt.yPct - drag.startY;
          onClipLayoutChange?.(
            drag.clipId,
            editorRectToLayout(
              clampOverlayEditorRect({
                xPct: drag.startRect.xPct + dx,
                yPct: drag.startRect.yPct + dy,
                widthPct: drag.startRect.widthPct,
              }),
            ),
          );
          return;
        }

        const widthPct = pt.xPct - drag.startRect.xPct;
        onClipLayoutChange?.(
          drag.clipId,
          editorRectToLayout(
            clampOverlayEditorRect({
              xPct: drag.startRect.xPct,
              yPct: drag.startRect.yPct,
              widthPct,
            }),
          ),
        );
      };

      const onPointerUp = () => {
        overlayDragRef.current = null;
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      return () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      };
    }, [interactiveOverlays, onClipLayoutChange, pointerPercent]);

    const tick = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (pendingSeekRef.current) {
        if (playing) rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const segment = activeSegmentRef.current ?? segmentForFinalMs(currentMs);
      if (!segment) return;
      const mediaMs = v.currentTime * 1000;
      const ms = segment.finalStartMs + (mediaMs - segment.mediaStartMs);
      if (ms >= segment.finalEndMs - 30 && segment.finalEndMs < previewDurationMs - 1) {
        applyPreviewTime(segment.finalEndMs + 1, true);
        return;
      }
      const clamped = Math.max(0, Math.min(previewDurationMs, ms));
      setCurrentMs(clamped);
      onTimeUpdate?.(clamped);
      if (!v.paused) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }, [applyPreviewTime, currentMs, onTimeUpdate, playing, previewDurationMs, segmentForFinalMs]);

    useEffect(() => {
      if (playing) {
        rafRef.current = requestAnimationFrame(tick);
      }
      return () => {
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
        }
      };
    }, [playing, tick]);

    const togglePlay = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) {
        applyPreviewTime(currentMs, true);
        setPlaying(true);
      } else {
        v.pause();
        setPlaying(false);
      }
    }, [applyPreviewTime, currentMs]);

    useEffect(() => {
      if (!enableKeyboardShortcuts) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.code !== "Space" || e.target !== document.body) return;
        e.preventDefault();
        togglePlay();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [enableKeyboardShortcuts, togglePlay]);

    const seekToMs = useCallback(
      (ms: number) => {
        applyPreviewTime(ms);
      },
      [applyPreviewTime],
    );

    const startOverlayDrag = useCallback(
      (clip: VideoOverlayClip, mode: OverlayDragMode, e: ReactPointerEvent) => {
        if (!interactiveOverlays || !onClipLayoutChange) return;
        e.preventDefault();
        e.stopPropagation();
        const pt = pointerPercent(e.clientX, e.clientY);
        if (!pt) return;
        onSelectClip?.(clip.suggestionId);
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        overlayDragRef.current = {
          clipId: clip.suggestionId,
          mode,
          startX: pt.xPct,
          startY: pt.yPct,
          startRect: layoutToEditorRect(clip.layout),
        };
      },
      [interactiveOverlays, onClipLayoutChange, onSelectClip, pointerPercent],
    );

    return (
      <div
        className={`video-preview ${large ? "video-preview-large" : ""} ${className}`.trim()}
      >
        <div className="video-preview-stage" ref={stageRef}>
          <video
            ref={videoRef}
            className="video-preview-video"
            src={mediaSrc}
            preload="metadata"
            onLoadedMetadata={() => {
              const v = videoRef.current;
              if (!v) return;
              if (mediaSrc === baseSrc && v.duration > 0) {
                setSourceDurationMs(v.duration * 1000);
              }
              const pending = pendingSeekRef.current;
              if (pending) {
                v.currentTime = pending.ms / 1000;
                if (pending.play) void v.play();
                pendingSeekRef.current = null;
              }
            }}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (pendingSeekRef.current) return;
              if (v && v.paused) {
                const segment = activeSegmentRef.current ?? segmentForFinalMs(currentMs);
                if (!segment) return;
                const ms = Math.max(
                  0,
                  Math.min(
                    previewDurationMs,
                    segment.finalStartMs + (v.currentTime * 1000 - segment.mediaStartMs),
                  ),
                );
                setCurrentMs(ms);
                onTimeUpdate?.(ms);
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              if (pendingSeekRef.current) return;
              setPlaying(false);
            }}
            onEnded={() => {
              const segment = activeSegmentRef.current;
              if (segment && segment.finalEndMs < previewDurationMs - 1) {
                applyPreviewTime(segment.finalEndMs + 1, true);
              } else {
                setPlaying(false);
              }
            }}
          />
          <div className="video-preview-overlays">
            {activeOverlayVideoClips.map(({ clip, finalStartMs }) => {
              const src = videoClipUrls[clip.id];
              if (!src) return null;
              const scale = Math.max(12, Math.min(100, clip.scalePct ?? 100));
              const opacity = Math.max(0, Math.min(1, (clip.opacityPct ?? 100) / 100));
              const full = scale >= 99.5;
              const style: CSSProperties = full
                ? { inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity }
                : {
                    left: "50%",
                    top: "50%",
                    width: `${scale}%`,
                    transform: "translate(-50%, -50%)",
                    opacity,
                  };
              if (isImageTimelineClip(clip)) {
                return (
                  <img
                    key={clip.id}
                    className="video-preview-overlay-img"
                    src={src}
                    alt={clip.fileName}
                    style={style}
                    draggable={false}
                  />
                );
              }
              return (
                <video
                  key={clip.id}
                  className="video-preview-overlay-img"
                  src={src}
                  muted
                  autoPlay
                  playsInline
                  style={style}
                  onLoadedMetadata={(e) => {
                    const media = e.currentTarget;
                    media.currentTime =
                      ((clip.trimStartMs ?? 0) + (currentMs - finalStartMs)) / 1000;
                    void media.play();
                  }}
                />
              );
            })}
            {activeClips.map((clip) => {
              const url = imageUrls[clip.suggestionId];
              if (!url) return null;
              const opacity = Math.max(0, Math.min(1, (clip.opacityPct ?? 100) / 100));
              if (interactiveOverlays) {
                const rect = layoutToEditorRect(clip.layout);
                const selected = clip.suggestionId === selectedClipId;
                return (
                  <div
                    key={clip.suggestionId}
                    className={`video-preview-overlay-editor-item ${
                      selected ? "selected" : ""
                    }`}
                    style={{
                      left: `${rect.xPct}%`,
                      top: `${rect.yPct}%`,
                      width: `${rect.widthPct}%`,
                      opacity,
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Move overlay: ${clip.title}`}
                    onPointerDown={(e) => startOverlayDrag(clip, "move", e)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectClip?.(clip.suggestionId);
                    }}
                  >
                    <img
                      src={url}
                      alt={clip.title}
                      className="video-preview-overlay-img"
                      draggable={false}
                    />
                    {selected ? (
                      <button
                        type="button"
                        className="video-preview-overlay-resize"
                        aria-label={`Resize overlay: ${clip.title}`}
                        onPointerDown={(e) => startOverlayDrag(clip, "resize", e)}
                      />
                    ) : null}
                  </div>
                );
              }
              return (
                <img
                  key={clip.suggestionId}
                  src={url}
                  alt={clip.title}
                  className="video-preview-overlay-img"
                  style={{ ...layoutStyle(clip.layout), opacity }}
                  draggable={false}
                />
              );
            })}
          </div>
        </div>

        {!hideControls ? (
        <div className="video-preview-controls">
          <button type="button" className="btn small" onClick={togglePlay}>
            {playing ? "Pause" : "Play"}
          </button>
          {showSeekMarkers && displayClips.length > 0 ? (
            <VideoSeekWithMarkers
              durationMs={durationMs}
              currentMs={currentMs}
              clips={displayClips}
              onSeek={seekToMs}
            />
          ) : (
            <input
              type="range"
              className="video-preview-seek"
              min={0}
              max={1000}
              value={
                durationMs > 0
                  ? Math.round((currentMs / durationMs) * 1000)
                  : 0
              }
              onChange={(e) => {
                if (!durationMs) return;
                seekToMs((Number(e.target.value) / 1000) * durationMs);
              }}
              aria-label="Seek"
            />
          )}
          <span className="video-preview-time muted">
            {formatTimeMs(currentMs)} / {formatTimeMs(durationMs)}
          </span>
        </div>
        ) : null}
      </div>
    );
  },
);

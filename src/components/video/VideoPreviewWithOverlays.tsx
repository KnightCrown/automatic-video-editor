import { convertFileSrc } from "@tauri-apps/api/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getOverlayImageDisplayUrl } from "../../services/pipelineService";
import type { VideoOverlayClip } from "../../types/pipeline";
import { VideoSeekWithMarkers } from "./VideoSeekWithMarkers";
import {
  formatTimeMs,
  getActiveClips,
  layoutStyle,
} from "../../utils/overlayClips";
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
  className?: string;
  large?: boolean;
  onTimeUpdate?: (ms: number) => void;
  onDurationChange?: (durationMs: number) => void;
  showSeekMarkers?: boolean;
  hideControls?: boolean;
  interactiveOverlays?: boolean;
  selectedClipId?: string | null;
  onSelectClip?: (clipId: string) => void;
  onClipLayoutChange?: (clipId: string, layout: VideoOverlayClip["layout"]) => void;
};

type OverlayDragMode = "move" | "resize";

export const VideoPreviewWithOverlays = forwardRef<VideoPreviewHandle, Props>(
  function VideoPreviewWithOverlays(
    {
      videoPath,
      rootPath,
      clips,
      className = "",
      large = false,
      onTimeUpdate,
      onDurationChange,
      showSeekMarkers = true,
      hideControls = false,
      interactiveOverlays = false,
      selectedClipId = null,
      onSelectClip,
      onClipLayoutChange,
    },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const [playing, setPlaying] = useState(false);
    const [currentMs, setCurrentMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
    const rafRef = useRef<number | null>(null);
    const overlayDragRef = useRef<{
      clipId: string;
      mode: OverlayDragMode;
      startX: number;
      startY: number;
      startRect: OverlayEditorRect;
    } | null>(null);

    useImperativeHandle(ref, () => ({
      seekToMs(ms: number) {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = ms / 1000;
        setCurrentMs(ms);
      },
      getCurrentTimeMs() {
        return (videoRef.current?.currentTime ?? 0) * 1000;
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

    const activeClips = useMemo(
      () => getActiveClips(clips, currentMs),
      [clips, currentMs],
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
      const ms = v.currentTime * 1000;
      setCurrentMs(ms);
      onTimeUpdate?.(ms);
      if (!v.paused) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }, [onTimeUpdate]);

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
        void v.play();
        setPlaying(true);
      } else {
        v.pause();
        setPlaying(false);
      }
    }, []);

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.code === "Space" && e.target === document.body) {
          e.preventDefault();
          togglePlay();
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [togglePlay]);

    const seekToMs = useCallback(
      (ms: number) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = ms / 1000;
        setCurrentMs(ms);
        onTimeUpdate?.(ms);
      },
      [onTimeUpdate],
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
            src={convertFileSrc(videoPath)}
            preload="metadata"
            onLoadedMetadata={() => {
              const v = videoRef.current;
              if (v && v.duration > 0) {
                const d = v.duration * 1000;
                setDurationMs(d);
                onDurationChange?.(d);
              }
            }}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (v && v.paused) {
                const ms = v.currentTime * 1000;
                setCurrentMs(ms);
                onTimeUpdate?.(ms);
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
          <div className="video-preview-overlays">
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
          {showSeekMarkers && clips.length > 0 ? (
            <VideoSeekWithMarkers
              durationMs={durationMs}
              currentMs={currentMs}
              clips={clips}
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

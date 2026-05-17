import { convertFileSrc } from "@tauri-apps/api/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { getOverlayImageDisplayUrl } from "../../services/pipelineService";
import type { VideoOverlayClip } from "../../types/pipeline";
import { VideoSeekWithMarkers } from "./VideoSeekWithMarkers";
import {
  formatTimeMs,
  getActiveClips,
  layoutStyle,
} from "../../utils/overlayClips";

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
};

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
    },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [playing, setPlaying] = useState(false);
    const [currentMs, setCurrentMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
    const rafRef = useRef<number | null>(null);

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

    return (
      <div
        className={`video-preview ${large ? "video-preview-large" : ""} ${className}`.trim()}
      >
        <div className="video-preview-stage">
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
              return (
                <img
                  key={clip.suggestionId}
                  src={url}
                  alt={clip.title}
                  className="video-preview-overlay-img"
                  style={layoutStyle(clip.layout)}
                  draggable={false}
                />
              );
            })}
          </div>
        </div>

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
      </div>
    );
  },
);

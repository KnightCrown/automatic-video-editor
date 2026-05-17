import type { VideoOverlayClip } from "../../types/pipeline";
import { formatTimeMs } from "../../utils/overlayClips";

type Props = {
  durationMs: number;
  currentMs: number;
  clips: VideoOverlayClip[];
  onSeek: (ms: number) => void;
};

export function VideoSeekWithMarkers({
  durationMs,
  currentMs,
  clips,
  onSeek,
}: Props) {
  const progressPct = durationMs > 0 ? (currentMs / durationMs) * 100 : 0;

  return (
    <div className="video-preview-seek-wrap">
      <input
        type="range"
        className="video-preview-seek"
        min={0}
        max={1000}
        value={Math.round((progressPct / 100) * 1000)}
        onChange={(e) => {
          if (!durationMs) return;
          const ms = (Number(e.target.value) / 1000) * durationMs;
          onSeek(ms);
        }}
        aria-label="Seek"
      />
      {durationMs > 0
        ? clips.map((clip) => {
            const pct = (clip.startMs / durationMs) * 100;
            if (pct < 0 || pct > 100) return null;
            return (
              <button
                key={clip.suggestionId}
                type="button"
                className="video-seek-marker"
                style={{ left: `${pct}%` }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSeek(clip.startMs);
                }}
                title={`${clip.title} — ${formatTimeMs(clip.startMs)}`}
                aria-label={`Jump to overlay: ${clip.title}`}
              />
            );
          })
        : null}
    </div>
  );
}

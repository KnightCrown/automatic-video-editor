import type { CSSProperties } from "react";
import type {
  OverlayClipLayout,
  OverlayImagesManifest,
  OverlaySuggestion,
  TranscriptAnalysis,
  VideoOverlayClip,
} from "../types/pipeline";
import { DEFAULT_OVERLAY_LAYOUT } from "../types/pipeline";

const MIN_DISPLAY_MS = 500;
const MAX_DISPLAY_MS = 15_000;

export function defaultDurationMs(suggestion: OverlaySuggestion): number {
  if (suggestion.idealDisplayMs != null) {
    return Math.min(MAX_DISPLAY_MS, Math.max(MIN_DISPLAY_MS, suggestion.idealDisplayMs));
  }
  if (
    suggestion.startMs != null &&
    suggestion.endMs != null &&
    suggestion.endMs > suggestion.startMs
  ) {
    return Math.min(
      MAX_DISPLAY_MS,
      Math.max(MIN_DISPLAY_MS, suggestion.endMs - suggestion.startMs),
    );
  }
  return MAX_DISPLAY_MS;
}

export function buildClipsFromAnalysisAndManifest(
  analysis: TranscriptAnalysis,
  manifest: OverlayImagesManifest,
  layout: OverlayClipLayout = DEFAULT_OVERLAY_LAYOUT,
): VideoOverlayClip[] {
  const byId = new Map(analysis.suggestions.map((s) => [s.id, s]));
  const clips: VideoOverlayClip[] = [];

  for (const img of manifest.images) {
    const suggestion = byId.get(img.suggestionId);
    if (!suggestion) continue;
    clips.push({
      suggestionId: img.suggestionId,
      imageRelativePath: img.relativePath,
      title: img.title,
      startMs: suggestion.startMs ?? 0,
      durationMs: defaultDurationMs(suggestion),
      layout: { ...layout },
    });
  }

  clips.sort((a, b) => a.startMs - b.startMs);
  return clips;
}

export function getActiveClips(
  clips: VideoOverlayClip[],
  currentTimeMs: number,
): VideoOverlayClip[] {
  return clips.filter(
    (c) =>
      currentTimeMs >= c.startMs &&
      currentTimeMs < c.startMs + c.durationMs,
  );
}

export function formatTimeMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function clipEndMs(clip: VideoOverlayClip): number {
  return clip.startMs + clip.durationMs;
}

export function layoutStyle(layout: OverlayClipLayout): CSSProperties {
  const base: CSSProperties = {
    position: "absolute",
    width: `${layout.widthPct}%`,
    maxWidth: `${layout.widthPct}%`,
    height: "auto",
    objectFit: "contain",
    pointerEvents: "none",
  };
  if (layout.anchor === "top-right") {
    return {
      ...base,
      top: `${layout.marginYPct}%`,
      right: `${layout.marginXPct}%`,
    };
  }
  return {
    ...base,
    top: `${layout.marginYPct}%`,
    left: `${layout.marginXPct}%`,
  };
}

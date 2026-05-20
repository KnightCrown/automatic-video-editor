import type { TimelineVideoClip } from "../types/pipeline";

export function videoClipEndMs(clip: TimelineVideoClip): number {
  return clip.startMs + clip.durationMs;
}

export function normalizeVideoClip(clip: TimelineVideoClip): TimelineVideoClip {
  return {
    ...clip,
    trimStartMs: clip.trimStartMs ?? 0,
    scalePct: clip.scalePct ?? 100,
    opacityPct: clip.opacityPct ?? 100,
    volumePct: clip.volumePct ?? 100,
  };
}

export function maxVideoTrackIndex(
  videoClips: TimelineVideoClip[],
  emptyTrackIndices: number[],
): number {
  const fromClips = videoClips.reduce((max, clip) => Math.max(max, clip.trackIndex), 0);
  const fromEmpty = emptyTrackIndices.reduce((max, idx) => Math.max(max, idx), 0);
  return Math.max(fromClips, fromEmpty, 0);
}

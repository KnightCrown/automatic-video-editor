import type { ImageGenerationProgress, PipelineProgress } from "../types/pipeline";

export function mergeEpisodeBatch(
  prevIndex: number,
  prevTotal: number,
  progress: PipelineProgress,
): { episodeIndex: number; episodeTotal: number } {
  return {
    episodeIndex: progress.episodeIndex ?? prevIndex,
    episodeTotal: progress.episodeTotal ?? prevTotal,
  };
}

/** Combined percent across a multi-episode transcription batch. */
export function transcriptionOverallPercent(
  episodeIndex: number,
  episodeTotal: number,
  progress: PipelineProgress | null,
): number {
  const inner = progress?.percent ?? 0;
  if (episodeTotal <= 1) return Math.min(100, inner);
  const index = Math.max(1, episodeIndex);
  const episodeStart = ((index - 1) / episodeTotal) * 100;
  return Math.min(100, episodeStart + inner / episodeTotal);
}

export function transcriptionHeadline(
  episodeIndex: number,
  episodeTotal: number,
): string {
  if (episodeTotal > 1) {
    return `Transcribing episode ${episodeIndex} of ${episodeTotal}`;
  }
  return "Transcribing";
}

export function imageGenerationHeadline(progress: ImageGenerationProgress | null): string {
  if (!progress || progress.total <= 0) return "Generating images";
  return `Generating images (${progress.index} of ${progress.total})`;
}

export function imageGenerationOverallPercent(
  progress: ImageGenerationProgress | null,
): number {
  if (!progress || progress.total <= 0) return 0;
  if (progress.stage === "done") return 100;
  const perItem = 100 / progress.total;
  const completed = Math.max(0, progress.index - 1);
  return Math.min(100, completed * perItem + perItem * 0.5);
}

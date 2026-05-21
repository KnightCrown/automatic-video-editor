import type {
  OverlayImagesManifest,
  Transcript,
  TranscriptAnalysis,
} from "../types/pipeline";

export interface EditingEpisodeSnapshot {
  analysis: TranscriptAnalysis | null;
  manifest: OverlayImagesManifest | null;
  transcript: Transcript | null;
  approvedSuggestionIds: string[];
  selectedSuggestionId: string | null;
  promptDrafts: Record<string, string>;
}

const episodeCache = new Map<string, EditingEpisodeSnapshot>();
const lastActiveVideoIdByProject = new Map<string, string>();

function episodeCacheKey(rootPath: string, videoId: string): string {
  return `${rootPath}\0${videoId}`;
}

export function rememberActiveVideoId(rootPath: string, videoId: string): void {
  lastActiveVideoIdByProject.set(rootPath, videoId);
}

export function getLastActiveVideoId(rootPath: string): string | undefined {
  return lastActiveVideoIdByProject.get(rootPath);
}

export function getCachedEpisode(
  rootPath: string,
  videoId: string,
): EditingEpisodeSnapshot | undefined {
  const cached = episodeCache.get(episodeCacheKey(rootPath, videoId));
  if (!cached) return undefined;
  return {
    ...cached,
    approvedSuggestionIds: [...cached.approvedSuggestionIds],
    promptDrafts: { ...cached.promptDrafts },
  };
}

export function setCachedEpisode(
  rootPath: string,
  videoId: string,
  snapshot: EditingEpisodeSnapshot,
): void {
  episodeCache.set(episodeCacheKey(rootPath, videoId), {
    ...snapshot,
    approvedSuggestionIds: [...snapshot.approvedSuggestionIds],
    promptDrafts: { ...snapshot.promptDrafts },
  });
}

export function invalidateEpisodeCache(rootPath: string, videoId: string): void {
  episodeCache.delete(episodeCacheKey(rootPath, videoId));
}

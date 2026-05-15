export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  videoId: string;
  videoPath: string;
  fullText: string;
  segments: TranscriptSegment[];
  words?: { startMs: number; endMs: number; text: string }[];
  /** From ffprobe — container stream start_time (s). */
  probedVideoStreamStartSec?: number;
  probedAudioStreamStartSec?: number;
  /** Project setting applied when this file was saved (ms). */
  appliedTranscriptTimingOffsetMs?: number;
}

export type OverlayCandidateStatus =
  | "pending"
  | "approved"
  | "skipped"
  | "prompt_ready"
  | "image_ready";

export interface OverlayCandidate {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  transcriptExcerpt: string;
  score: number;
  reasons: string[];
  status: OverlayCandidateStatus;
}

export interface OverlaySuggestion {
  id: string;
  title: string;
  imagePrompt: string;
  overlayText?: string;
  transcriptExcerpt: string;
  startMs?: number;
  endMs?: number;
  /** Suggested duration the image stays on screen (ms), typically ≤ 15000. */
  idealDisplayMs?: number;
  bibleStory?: string;
  rationale: string;
}

export interface TranscriptAnalysis {
  videoId: string;
  bibleStories: string[];
  suggestions: OverlaySuggestion[];
  analyzedAt: string;
  model: string;
}

export interface GeneratedOverlayImage {
  suggestionId: string;
  title: string;
  imagePrompt: string;
  transcriptExcerpt: string;
  relativePath: string;
  generatedAt: string;
}

export interface OverlayImagesManifest {
  videoId: string;
  model: string;
  generatedAt: string;
  images: GeneratedOverlayImage[];
}

export interface ImageGenerationProgress {
  videoId: string;
  index: number;
  total: number;
  suggestionId: string;
  stage: string;
  message?: string;
}

export interface OverlayPromptResult {
  imagePrompt: string;
  overlayText?: string;
  styleTags?: string[];
  rationale: string;
}

export interface VideoJob {
  id: string;
  path: string;
  fileName: string;
  status: string;
  error?: string;
}

export interface TranscriptionPreflight {
  ffmpegAvailable: boolean;
  ffmpegPath?: string;
  ffmpegError?: string;
  parakeetModelReady: boolean;
  parakeetMissingFiles: string[];
}

export interface PipelineProgress {
  jobId: string;
  stage: string;
  percent: number;
  message?: string;
}

export interface ProjectSettings {
  showContext: string;
  maxCandidatesPerVideo: number;
  openaiTextModel: string;
  openaiImageModel: string;
  imageProvider: string;
  /** xAI Grok Imagine model id */
  grokImagineModel: string;
  /** Added to every timestamp after transcribe. Positive = shift later if cues are early. */
  transcriptTimingOffsetMs?: number;
}

export interface ProjectManifest {
  rootPath: string;
  settings: ProjectSettings;
  videos: VideoJob[];
  updatedAt: string;
}

export interface ParakeetModelFile {
  fileName: string;
  url: string;
  sizeLabel: string;
}

export interface ParakeetDownloadProgress {
  fileName: string;
  downloaded: number;
  total?: number;
  progress?: number;
  fileIndex: number;
  fileCount: number;
}

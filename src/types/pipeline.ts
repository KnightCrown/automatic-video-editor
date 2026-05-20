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

export interface EpisodeContentBounds {
  contentStartMs: number;
  contentEndMs: number;
  videoDurationMs?: number;
  rationale: string;
}

export interface AssetPlacement {
  id: string;
  assetFileName: string;
  triggerWord?: string;
  placementKind: "intro" | "outro" | "trigger" | string;
  timelineMode: "insert" | "overlay" | string;
  startMs: number;
  durationMs: number;
  transcriptExcerpt?: string;
  verified: boolean;
  rationale: string;
  trackIndex: number;
  fullScreen: boolean;
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
  contentBounds?: EpisodeContentBounds;
  assetPlacements?: AssetPlacement[];
}

export interface OverlayImageVersion {
  relativePath: string;
  generatedAt: string;
}

export interface GeneratedOverlayImage {
  suggestionId: string;
  title: string;
  imagePrompt: string;
  transcriptExcerpt: string;
  /** Active version for timeline/export (latest after regenerate). */
  relativePath: string;
  generatedAt: string;
  versions?: OverlayImageVersion[];
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
  /** 1-based index in the current batch run (e.g. episode 2 of 10). */
  episodeIndex?: number;
  episodeTotal?: number;
}

export interface ProjectScanProgress {
  index: number;
  total: number;
  fileName: string;
  stage: string;
  message?: string;
}

export type VideoExportMode = "auto" | "software" | "hardware";
export type VideoExportQuality = "fast" | "balanced";

export type VideoExportEncoderKind =
  | "software"
  | "nvenc"
  | "qsv"
  | "amf"
  | "videoToolbox";

export interface VideoExportEncoderInfo {
  kind: VideoExportEncoderKind;
  name: string;
  listed: boolean;
  verified: boolean;
  error?: string;
}

export interface VideoExportPreflight {
  ffmpegPath?: string;
  ffmpegError?: string;
  encoders: VideoExportEncoderInfo[];
  recommendedEncoder?: VideoExportEncoderKind;
  cudaOverlayAvailable: boolean;
  overlayCudaFilter: boolean;
  scaleCudaFilter: boolean;
}

export interface ProjectSettings {
  showContext: string;
  /** Folder containing reusable user assets referenced by the master prompt. */
  assetFolderPath?: string;
  maxCandidatesPerVideo: number;
  openaiTextModel: string;
  openaiImageModel: string;
  imageProvider: string;
  /** xAI Grok Imagine model id */
  grokImagineModel: string;
  /** Added to every timestamp after transcribe. Positive = shift later if cues are early. */
  transcriptTimingOffsetMs?: number;
  /** auto | software | hardware */
  videoExportMode?: VideoExportMode;
  /** fast | balanced */
  videoExportQuality?: VideoExportQuality;
  /** Default position/size for overlay images on export and preview. */
  defaultOverlayLayout?: OverlayClipLayout;
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

export interface OverlayClipLayout {
  anchor: string;
  marginXPct: number;
  marginYPct: number;
  widthPct: number;
}

export interface VideoOverlayClip {
  suggestionId: string;
  imageRelativePath: string;
  title: string;
  startMs: number;
  durationMs: number;
  layout: OverlayClipLayout;
  opacityPct?: number;
  entrance?: "none" | "fade-in";
  exit?: "none" | "fade-out";
}

/** An extra video clip placed on a timeline track above the base episode. */
export interface TimelineVideoClip {
  id: string;
  /** Path relative to the project root. */
  sourceRelativePath: string;
  fileName: string;
  /** insert = spliced into the base episode; overlay = composited above it. */
  timelineMode?: "insert" | "overlay" | string;
  placementKind?: "intro" | "outro" | "trigger" | string;
  startMs: number;
  durationMs: number;
  sourceDurationMs: number;
  trimStartMs?: number;
  scalePct?: number;
  opacityPct?: number;
  volumePct?: number;
  /** 1 = first track above base video; higher = further up the stack. */
  trackIndex: number;
}

export interface PlayheadOverlayResult {
  clip: VideoOverlayClip;
}

export interface FinalVideoTimeline {
  videoId: string;
  clips: VideoOverlayClip[];
  videoClips?: TimelineVideoClip[];
  contentStartMs?: number;
  contentEndMs?: number;
  updatedAt: string;
}

export interface AudioWaveform {
  videoId: string;
  generatedAt: string;
  sourcePath: string;
  sourceModifiedMs?: number;
  durationMs: number;
  bucketDurationMs: number;
  peaks: number[];
}

export interface FinalVideoExport {
  id: string;
  outputPath: string;
  fileName: string;
  exportedAt: string;
  clipCount: number;
}

export interface FinalVideoExportsManifest {
  videoId: string;
  exports: FinalVideoExport[];
}

export interface VideoExportProgress {
  videoId: string;
  stage: string;
  percent: number;
  message?: string;
}

export const DEFAULT_OVERLAY_LAYOUT: OverlayClipLayout = {
  anchor: "top-right",
  marginXPct: 3,
  marginYPct: 3,
  widthPct: 38,
};

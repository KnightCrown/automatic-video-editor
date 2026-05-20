use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub video_id: String,
    pub video_path: String,
    pub full_text: String,
    pub segments: Vec<TranscriptSegment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<TranscriptWord>>,
    /// Container metadata (seconds). Helps debug drift vs timeline; FFmpeg extract is not trimmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probed_video_stream_start_sec: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probed_audio_stream_start_sec: Option<f64>,
    /// Added to every segment/word when saving (project setting).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_transcript_timing_offset_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OverlayCandidateStatus {
    Pending,
    Approved,
    Skipped,
    PromptReady,
    ImageReady,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCandidate {
    pub id: String,
    pub video_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub transcript_excerpt: String,
    pub score: u32,
    pub reasons: Vec<String>,
    pub status: OverlayCandidateStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySuggestion {
    pub id: String,
    pub title: String,
    pub image_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_text: Option<String>,
    pub transcript_excerpt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    /// Recommended on-screen duration for this overlay (ms). Editors should honor this ceiling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ideal_display_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bible_story: Option<String>,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAnalysis {
    pub video_id: String,
    pub bible_stories: Vec<String>,
    pub suggestions: Vec<OverlaySuggestion>,
    pub analyzed_at: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayImageVersion {
    /// Path relative to project root using forward slashes.
    pub relative_path: String,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedOverlayImage {
    pub suggestion_id: String,
    pub title: String,
    pub image_prompt: String,
    pub transcript_excerpt: String,
    /// Active version used for final video / gallery (latest unless changed later).
    pub relative_path: String,
    pub generated_at: String,
    #[serde(default)]
    pub versions: Vec<OverlayImageVersion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayImagesManifest {
    pub video_id: String,
    pub model: String,
    pub generated_at: String,
    pub images: Vec<GeneratedOverlayImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationProgress {
    pub video_id: String,
    pub index: u32,
    pub total: u32,
    pub suggestion_id: String,
    pub stage: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPromptResult {
    pub image_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlay_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub style_tags: Vec<String>,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJob {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionPreflight {
    pub ffmpeg_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ffmpeg_error: Option<String>,
    pub parakeet_model_ready: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parakeet_missing_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgress {
    pub job_id: String,
    pub stage: String,
    pub percent: f32,
    pub message: Option<String>,
    /// 1-based index within the current batch (e.g. transcribing episode 2 of 10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_total: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub show_context: String,
    pub max_candidates_per_video: u32,
    pub openai_text_model: String,
    pub openai_image_model: String,
    pub image_provider: String,
    /// xAI Grok Imagine model id (see [`DEFAULT_GROK_IMAGINE_MODEL`]).
    #[serde(default = "default_grok_imagine_model")]
    pub grok_imagine_model: String,
    /// Positive shifts transcript later vs video (milliseconds). Tune if overlays cue early.
    #[serde(default)]
    pub transcript_timing_offset_ms: i64,
    /// `auto`, `software`, or `hardware` for H.264 export encoder selection.
    #[serde(default = "default_video_export_mode")]
    pub video_export_mode: String,
    /// `fast` or `balanced` export quality preset.
    #[serde(default = "default_video_export_quality")]
    pub video_export_quality: String,
    /// Default overlay position for export and new timelines.
    #[serde(default)]
    pub default_overlay_layout: OverlayClipLayout,
}

pub fn default_video_export_mode() -> String {
    "auto".to_string()
}

pub fn default_video_export_quality() -> String {
    "balanced".to_string()
}

/// Default xAI Grok Imagine model for overlay image generation.
pub const DEFAULT_GROK_IMAGINE_MODEL: &str = "grok-imagine-image";

/// Previously shipped default; migrate saved projects to [`DEFAULT_GROK_IMAGINE_MODEL`].
pub const LEGACY_GROK_IMAGINE_MODEL_QUALITY: &str = "grok-imagine-image-quality";

fn default_grok_imagine_model() -> String {
    DEFAULT_GROK_IMAGINE_MODEL.to_string()
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            show_context: "Christian kids YouTube show. Friendly, colorful, simple overlays. No scary or violent imagery.".to_string(),
            max_candidates_per_video: 10,
            openai_text_model: "gpt-4.1-mini".to_string(),
            openai_image_model: "gpt-image-1".to_string(),
            image_provider: "xai".to_string(),
            grok_imagine_model: default_grok_imagine_model(),
            transcript_timing_offset_ms: 0,
            video_export_mode: default_video_export_mode(),
            video_export_quality: default_video_export_quality(),
            default_overlay_layout: OverlayClipLayout::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub root_path: String,
    pub settings: ProjectSettings,
    pub videos: Vec<VideoJob>,
    pub updated_at: String,
}

/// Where overlay images sit on the frame (percent-based margins and width).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayClipLayout {
    pub anchor: String,
    pub margin_x_pct: f64,
    pub margin_y_pct: f64,
    pub width_pct: f64,
}

impl Default for OverlayClipLayout {
    fn default() -> Self {
        Self {
            anchor: "top-right".to_string(),
            margin_x_pct: 3.0,
            margin_y_pct: 3.0,
            width_pct: 38.0,
        }
    }
}

/// One timed overlay image on the final video timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOverlayClip {
    pub suggestion_id: String,
    pub image_relative_path: String,
    pub title: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub layout: OverlayClipLayout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entrance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<String>,
}

/// Extra video placed on a timeline track above the base episode.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineVideoClip {
    pub id: String,
    pub source_relative_path: String,
    pub file_name: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub source_duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim_start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume_pct: Option<f64>,
    pub track_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalVideoTimeline {
    pub video_id: String,
    pub clips: Vec<VideoOverlayClip>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub video_clips: Vec<TimelineVideoClip>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveform {
    pub video_id: String,
    pub generated_at: String,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_modified_ms: Option<u64>,
    pub duration_ms: u64,
    pub bucket_duration_ms: f64,
    pub peaks: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalVideoExport {
    pub id: String,
    pub output_path: String,
    pub file_name: String,
    pub exported_at: String,
    pub clip_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalVideoExportsManifest {
    pub video_id: String,
    pub exports: Vec<FinalVideoExport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportProgress {
    pub video_id: String,
    pub stage: String,
    pub percent: f32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoExportEncoderKind {
    Software,
    Nvenc,
    Qsv,
    Amf,
    VideoToolbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportEncoderInfo {
    pub kind: VideoExportEncoderKind,
    pub name: String,
    pub listed: bool,
    pub verified: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportPreflight {
    pub ffmpeg_path: Option<String>,
    pub ffmpeg_error: Option<String>,
    pub encoders: Vec<VideoExportEncoderInfo>,
    pub recommended_encoder: Option<VideoExportEncoderKind>,
    pub cuda_overlay_available: bool,
    pub overlay_cuda_filter: bool,
    pub scale_cuda_filter: bool,
}

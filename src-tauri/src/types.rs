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
pub struct GeneratedOverlayImage {
    pub suggestion_id: String,
    pub title: String,
    pub image_prompt: String,
    pub transcript_excerpt: String,
    /// Path relative to project root using forward slashes.
    pub relative_path: String,
    pub generated_at: String,
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

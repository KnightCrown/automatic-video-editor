use std::time::Duration;

use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::types::{
    OverlayCandidate, OverlayPromptResult, OverlaySuggestion, ProjectSettings, Transcript,
    TranscriptAnalysis,
};

use crate::store::secrets;

/// Full production brief for overlay planning and image-prompt style (see `overlay_master_prompt.txt`).
const OVERLAY_MASTER_PROMPT: &str = include_str!("overlay_master_prompt.txt");

const MAX_TRANSCRIPT_CHARS: usize = 80_000;

pub fn save_openai_api_key(api_key: &str) -> Result<(), String> {
    secrets::save_openai_api_key(api_key)
}

pub fn get_openai_api_key() -> Result<String, String> {
    secrets::get_openai_api_key()
}

pub fn clear_openai_api_key() -> Result<(), String> {
    secrets::clear_openai_api_key()
}

pub fn has_openai_api_key() -> bool {
    secrets::has_openai_api_key()
}

pub fn api_key_storage_hint() -> Option<&'static str> {
    secrets::api_key_storage_hint()
}

fn require_openai_api_key() -> Result<String, String> {
    get_openai_api_key().map_err(|e| {
        if e == "api_key_not_set" {
            "OpenAI API key is not set. Open Settings, enter your key, and click Save API key."
                .to_string()
        } else {
            e
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiAnalysisPayload {
    bible_stories: Vec<String>,
    suggestions: Vec<OpenAiSuggestionPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiSuggestionPayload {
    title: String,
    image_prompt: String,
    #[serde(default)]
    overlay_text: Option<String>,
    transcript_excerpt: String,
    #[serde(default)]
    start_ms: Option<u64>,
    #[serde(default)]
    end_ms: Option<u64>,
    #[serde(default)]
    bible_story: Option<String>,
    rationale: String,
}

pub async fn analyze_transcript_for_overlays(
    transcript: &Transcript,
    settings: &ProjectSettings,
) -> Result<TranscriptAnalysis, String> {
    if transcript.full_text.chars().count() > MAX_TRANSCRIPT_CHARS {
        return Err(format!(
            "transcript_too_long: {} characters (max {}). Try a shorter clip.",
            transcript.full_text.chars().count(),
            MAX_TRANSCRIPT_CHARS
        ));
    }

    let api_key = require_openai_api_key()?;
    let model = settings.openai_text_model.clone();

    let system_prompt = format!(
        "{master}\n\n\
         ---\n\
         SHOW-SPECIFIC CONTEXT (from the production team)\n\
         {show}\n\n\
         ---\n\
         STRUCTURED JSON OUTPUT\n\
         Follow every rule in the master brief above. Maximum 30 suggestions per episode (fewer is fine).\n\n\
         1) bibleStories: string array — every Bible story or biblical narrative discussed or referenced.\n\
         2) suggestions: array of objects, one per meaningful visual beat (not every sentence).\n\n\
         For each suggestion:\n\
         - title: short, specific label for that visual beat (avoid generic titles like \"Scene 1\").\n\
         - imagePrompt: one detailed text-to-image prompt that ALREADY reflects the MASTER VISUAL STYLE \
         (clean 2D educational storybook Bible art: bold outlines, flat bright colors, believable adult vs child proportions; not chibi or super-deformed). \
         Describe characters, setting, action, and mood so an image model can render one clear scene. No photorealism.\n\
         - overlayText: optional string — max 8 words. Short line a child reads at a glance: emotionally clear, warm, simple. \
         Must not repeat the title verbatim. Avoid scripture typography or verse dumps unless the host explicitly reads that text as on-screen wording. \
         Prefer a feeling, invitation, or plain-language takeaway rather than label-style text.\n\
         - transcriptExcerpt: quote from the transcript this beat supports.\n\
         - startMs / endMs: use segment timestamps when possible (milliseconds).\n\
         - bibleStory: optional — which biblical narrative this ties to, if any.\n\
         - rationale: one sentence on why this beat earns an overlay and how it follows segmentation / skip rules.\n\n\
         Return ONLY valid JSON: {{ \"bibleStories\": string[], \"suggestions\": [...] }}.",
        master = OVERLAY_MASTER_PROMPT,
        show = settings.show_context
    );

    let mut segments_text = String::new();
    for (i, seg) in transcript.segments.iter().enumerate() {
        segments_text.push_str(&format!(
            "[{}] {}ms–{}ms: {}\n",
            i + 1,
            seg.start_ms,
            seg.end_ms,
            seg.text
        ));
    }

    let user_prompt = format!(
        "Full transcript:\n\n{}\n\n---\nTimestamped segments:\n{}\n\n\
         Analyze this episode using the master brief. Return bibleStories and suggestions only \
         for meaningful visual storytelling moments; skip prayers, sign-offs, CTAs, sponsors, and filler per the rules.",
        transcript.full_text, segments_text
    );

    let body = json!({
        "model": model,
        "input": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "text": {
            "format": {
                "type": "json_object"
            }
        }
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("http_client_failed:{}", e))?;

    let resp = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("openai_network:{}", e))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("openai_read_body:{}", e))?;

    if !status.is_success() {
        return Err(format!("openai_error:{}:{}", status, body_text));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|e| format!("openai_parse_response:{}", e))?;

    let text = extract_response_text(&parsed)
        .ok_or_else(|| format!("openai_no_output_text:{}", body_text))?;

    let json_text = extract_json_block(&text);
    let payload: OpenAiAnalysisPayload = serde_json::from_str(&json_text)
        .map_err(|e| format!("openai_parse_analysis_json:{}:{}", e, json_text))?;

    let suggestions: Vec<OverlaySuggestion> = payload
        .suggestions
        .into_iter()
        .filter(|s| !s.title.trim().is_empty() && !s.image_prompt.trim().is_empty())
        .map(|s| OverlaySuggestion {
            id: Uuid::new_v4().to_string(),
            title: s.title.trim().to_string(),
            image_prompt: s.image_prompt.trim().to_string(),
            overlay_text: s.overlay_text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
            transcript_excerpt: s.transcript_excerpt.trim().to_string(),
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            bible_story: s.bible_story.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
            rationale: s.rationale.trim().to_string(),
        })
        .collect();

    Ok(TranscriptAnalysis {
        video_id: transcript.video_id.clone(),
        bible_stories: payload.bible_stories,
        suggestions,
        analyzed_at: Utc::now().to_rfc3339(),
        model,
    })
}

pub async fn generate_overlay_image_prompt(
    candidate: &OverlayCandidate,
    settings: &ProjectSettings,
) -> Result<OverlayPromptResult, String> {
    let api_key = require_openai_api_key()?;
    let system_prompt = format!(
        "{master}\n\n\
         ---\n\
         SINGLE-MOMENT TASK\n\
         Show context: {show}\n\n\
         For this ONE overlay moment, produce a refined imagePrompt and overlayText that obey the master visual style \
         and segmentation intent (one coherent scene; educational children's Bible storybook illustration; no chibi; no photorealism).\n\n\
         Return ONLY valid JSON with keys: \
         imagePrompt (detailed text-to-image prompt including style cues: line art, proportions, age of figures), \
         overlayText (short on-screen text, max 8 words — punchy, child-friendly, not redundant with common titles), \
         styleTags (array of short strings, e.g. \"educational Bible illustration\", \"storybook line art\"), \
         rationale (brief explanation tying the image to the excerpt).",
        master = OVERLAY_MASTER_PROMPT,
        show = settings.show_context
    );

    let user_prompt = format!(
        "Transcript excerpt ({}ms - {}ms):\n\"{}\"\n\n\
         Create an overlay image prompt for this moment.",
        candidate.start_ms, candidate.end_ms, candidate.transcript_excerpt
    );

    let body = json!({
        "model": settings.openai_text_model,
        "input": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "text": {
            "format": {
                "type": "json_object"
            }
        }
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http_client_failed:{}", e))?;

    let resp = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("openai_network:{}", e))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("openai_read_body:{}", e))?;

    if !status.is_success() {
        return Err(format!("openai_error:{}:{}", status, body_text));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body_text).map_err(|e| format!("openai_parse_response:{}", e))?;

    let text = extract_response_text(&parsed)
        .ok_or_else(|| format!("openai_no_output_text:{}", body_text))?;

    let json_text = extract_json_block(&text);
    let result: OverlayPromptResult = serde_json::from_str(&json_text)
        .map_err(|e| format!("openai_parse_prompt_json:{}:{}", e, json_text))?;

    if result.image_prompt.trim().is_empty() {
        return Err("openai_empty_image_prompt".to_string());
    }

    Ok(result)
}

fn extract_response_text(value: &serde_json::Value) -> Option<String> {
    if let Some(output) = value.get("output").and_then(|o| o.as_array()) {
        for item in output {
            if item.get("type").and_then(|t| t.as_str()) == Some("message") {
                if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                    for part in content {
                        if part.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                return Some(text.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    value
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
}

fn extract_json_block(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        return trimmed.to_string();
    }
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            return trimmed[start..=end].to_string();
        }
    }
    trimmed.to_string()
}

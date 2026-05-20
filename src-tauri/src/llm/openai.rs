use std::time::Duration;

use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::pipeline::assets::{
    list_video_assets, propose_asset_triggers, provisional_content_end_ms,
};
use crate::types::{
    AssetPlacement, EpisodeContentBounds, OverlayCandidate, OverlayPromptResult, OverlaySuggestion,
    ProjectSettings, ProposedAssetTrigger, Transcript, TranscriptAnalysis, TranscriptSegment,
};

use crate::store::secrets;
use crate::video::encoders::probe_video_duration_sec;

/// Full production brief for overlay planning and image-prompt style (see `overlay_master_prompt.txt`).
const OVERLAY_MASTER_PROMPT: &str = include_str!("overlay_master_prompt.txt");

const MAX_TRANSCRIPT_CHARS: usize = 80_000;

/// Slice Parakeet "sentence" segments this small for LLM transcript context (~≤10 s each).
const MAX_LLM_SEGMENT_SLICE_MS: u64 = 10_000;
/// Hard cap per suggestion transcript alignment (speech span referenced by overlay).
const MAX_TRANSCRIPT_ALIGN_MS: u64 = 15_000;
/// Ceiling for suggested on-screen overlay duration returned by the model.
const MAX_IDEAL_DISPLAY_MS: u64 = 15_000;

/// Maps UI preset ids to the OpenAI model id used for text/LLM calls.
pub fn resolve_openai_text_model(settings: &ProjectSettings) -> String {
    match settings.openai_text_model.trim() {
        "gpt-5.4-mini" | "gpt-5.4" => "gpt-5.4-mini".to_string(),
        "gpt-4.1-mini" => "gpt-4.1-mini".to_string(),
        _ => "gpt-4.1-mini".to_string(),
    }
}

/// Which time bucket a word occupies when spreading `n_words` evenly across `[0,dur_ms)`.
fn word_mid_bucket(word_i: usize, n_words: usize, num_chunks: usize, dur_ms: u64) -> usize {
    let nc = num_chunks.max(1);
    debug_assert!(n_words > 0);
    debug_assert!(word_i < n_words);
    let denom = ((2 * n_words) as u64).max(1);
    let mid_rel_ms = dur_ms.saturating_mul((2 * word_i + 1) as u64) / denom;
    let bi = (((mid_rel_ms as u128) * (nc as u128)) / ((dur_ms.max(1)) as u128)) as usize;
    bi.min(nc.saturating_sub(1)).max(0)
}

/// Subdivide Parakeet segments — each emitted slice spans at most max_ms except degenerate tails.
fn split_segment_max_duration(seg: &TranscriptSegment, max_ms: u64) -> Vec<TranscriptSegment> {
    let start = seg.start_ms;
    let end = seg.end_ms;
    if end <= start {
        return vec![seg.clone()];
    }
    let dur = end - start;
    if dur <= max_ms {
        return vec![seg.clone()];
    }
    let words: Vec<&str> = seg.text.split_whitespace().collect();
    let n_words = words.len();
    let num_chunks = (((dur.saturating_sub(1)) / max_ms) + 1).max(1) as usize;

    if words.is_empty() {
        let mut out = Vec::new();
        let mut t = start;
        while t < end {
            let e = (t + max_ms).min(end);
            out.push(TranscriptSegment {
                start_ms: t,
                end_ms: e,
                text: seg.text.trim().to_string(),
            });
            t = e;
        }
        return out;
    }

    let mut buckets: Vec<Vec<&str>> = vec![Vec::new(); num_chunks.max(1)];
    for wi in 0..n_words {
        let ci = word_mid_bucket(wi, n_words, num_chunks, dur);
        buckets[ci].push(words[wi]);
    }

    let nc = buckets.len().max(1);
    buckets
        .into_iter()
        .enumerate()
        .filter_map(|(ci, wds)| {
            let text = wds.join(" ");
            if text.trim().is_empty() {
                return None;
            }
            let t0 = start + dur * (ci as u64) / (nc as u64);
            let t1 = if ci + 1 == nc {
                end
            } else {
                start + dur * ((ci + 1) as u64) / (nc as u64)
            };
            Some(TranscriptSegment {
                start_ms: t0,
                end_ms: t1,
                text,
            })
        })
        .collect()
}

fn sentence_slices_for_llm(segments: &[TranscriptSegment]) -> Vec<TranscriptSegment> {
    segments
        .iter()
        .flat_map(|s| split_segment_max_duration(s, MAX_LLM_SEGMENT_SLICE_MS))
        .collect()
}

/// Clamp GPT timing output to sane editor bounds (≤15 s speech span / display hint).
fn normalize_overlay_timing(
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    ideal_display_ms: Option<u64>,
) -> (Option<u64>, Option<u64>, Option<u64>) {
    let (a, mut b) = match (start_ms, end_ms) {
        (Some(sa), Some(eb)) if eb > sa => (Some(sa), Some(eb)),
        _ => (start_ms, end_ms),
    };
    if let (Some(sa), Some(eb)) = (a, b) {
        if eb - sa > MAX_TRANSCRIPT_ALIGN_MS {
            b = Some(sa + MAX_TRANSCRIPT_ALIGN_MS);
        }
    }
    let span_after = match (a, b) {
        (Some(sa), Some(eb)) if eb > sa => Some(eb - sa),
        _ => None,
    };
    let mut ideal = ideal_display_ms.unwrap_or_else(|| span_after.unwrap_or(MAX_IDEAL_DISPLAY_MS));
    ideal = ideal.min(MAX_IDEAL_DISPLAY_MS).max(500);
    if let Some(sp) = span_after {
        ideal = ideal.min(sp);
    }
    (a, b, Some(ideal))
}

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
struct OpenAiContentBoundsPayload {
    content_start_ms: u64,
    content_end_ms: u64,
    rationale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiAssetReviewPayload {
    asset_file_name: String,
    #[serde(default)]
    trigger_word: Option<String>,
    proposed_start_ms: u64,
    duration_ms: u64,
    verified: bool,
    rationale: String,
    #[serde(default)]
    full_screen: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiAnalysisPayload {
    bible_stories: Vec<String>,
    suggestions: Vec<OpenAiSuggestionPayload>,
    #[serde(default)]
    content_bounds: Option<OpenAiContentBoundsPayload>,
    #[serde(default)]
    asset_reviews: Vec<OpenAiAssetReviewPayload>,
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
    ideal_display_ms: Option<u64>,
    #[serde(default)]
    bible_story: Option<String>,
    rationale: String,
}

fn merge_asset_placements(
    proposed: &[ProposedAssetTrigger],
    reviews: &[OpenAiAssetReviewPayload],
) -> Vec<AssetPlacement> {
    if reviews.is_empty() {
        return proposed
            .iter()
            .map(|p| AssetPlacement {
                id: Uuid::new_v4().to_string(),
                asset_file_name: p.asset_file_name.clone(),
                trigger_word: p.trigger_word.clone(),
                placement_kind: p.placement_kind.clone(),
                timeline_mode: p.timeline_mode.clone(),
                start_ms: p.start_ms,
                duration_ms: p.duration_ms,
                transcript_excerpt: Some(p.transcript_excerpt.clone()),
                verified: true,
                rationale: "Accepted from transcript word match.".to_string(),
                track_index: if p.timeline_mode == "insert"
                    || p.placement_kind == "intro"
                    || p.placement_kind == "outro"
                {
                    2
                } else {
                    1
                },
                full_screen: p.full_screen,
            })
            .collect();
    }

    reviews
        .iter()
        .filter(|r| r.verified)
        .map(|r| {
            let from_proposed = proposed
                .iter()
                .filter(|p| p.asset_file_name.eq_ignore_ascii_case(&r.asset_file_name))
                .min_by_key(|p| p.start_ms.abs_diff(r.proposed_start_ms));
            AssetPlacement {
                id: Uuid::new_v4().to_string(),
                asset_file_name: r.asset_file_name.clone(),
                trigger_word: r.trigger_word.clone(),
                placement_kind: from_proposed
                    .map(|p| p.placement_kind.clone())
                    .unwrap_or_else(|| "trigger".to_string()),
                timeline_mode: from_proposed
                    .map(|p| p.timeline_mode.clone())
                    .unwrap_or_else(|| "overlay".to_string()),
                start_ms: r.proposed_start_ms,
                duration_ms: r.duration_ms,
                transcript_excerpt: from_proposed.map(|p| p.transcript_excerpt.clone()),
                verified: true,
                rationale: r.rationale.trim().to_string(),
                track_index: from_proposed
                    .map(|p| {
                        if p.timeline_mode == "insert"
                            || p.placement_kind == "intro"
                            || p.placement_kind == "outro"
                        {
                            2
                        } else {
                            1
                        }
                    })
                    .unwrap_or(1),
                full_screen: from_proposed
                    .map(|p| p.full_screen)
                    .unwrap_or(r.full_screen),
            }
        })
        .collect()
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
    let model = resolve_openai_text_model(settings);

    let video_duration_ms = probe_video_duration_sec(&transcript.video_path)
        .map(|s| (s * 1000.0).round().max(1.0) as u64)
        .unwrap_or_else(|_| transcript.segments.last().map(|s| s.end_ms).unwrap_or(0));

    let asset_folder = settings
        .asset_folder_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(std::path::Path::new);

    let provisional_end = provisional_content_end_ms(transcript, video_duration_ms);
    let proposed_triggers = propose_asset_triggers(
        transcript,
        &settings.show_context,
        asset_folder,
        video_duration_ms,
        provisional_end,
    );

    let asset_files = asset_folder.map(list_video_assets).unwrap_or_default();

    let asset_context = asset_folder
        .map(|path| {
            let listing = if asset_files.is_empty() {
                "(no video files found)".to_string()
            } else {
                asset_files.join(", ")
            };
            format!(
                "Configured asset folder: {path}\nAvailable video assets: {listing}\n\
                 ASSET RULES: When the show context names an asset file, do NOT create an AI image suggestion for that moment. \
                 Instead verify the proposed asset trigger in assetReviews. Use real asset files only — never invent filenames.",
                path = path.display(),
            )
        })
        .unwrap_or_else(|| "No asset folder configured.".to_string());

    let proposed_json =
        serde_json::to_string_pretty(&proposed_triggers).unwrap_or_else(|_| "[]".to_string());

    let system_prompt = format!(
        "{master}\n\n\
         ---\n\
         SHOW-SPECIFIC CONTEXT (from the production team)\n\
         {show}\n\n\
         ---\n\
         ASSET FOLDER CONTEXT\n\
         {asset_context}\n\n\
         ---\n\
         STRUCTURED JSON OUTPUT\n\
         Follow every rule in the master brief above. Maximum 30 AI image suggestions per episode (fewer is fine).\n\n\
         Return ONLY valid JSON with keys:\n\
         - bibleStories: string[]\n\
         - contentBounds: {{ contentStartMs, contentEndMs, rationale }} — when the episode **actually** begins and ends for viewers \
         (skip dead air, false starts, mic checks, and rambling before the real intro like \"hello/good morning\"; \
         trim trailing dead space and sign-offs after the episode ends). Use slice timings; video file duration is {video_duration_ms} ms.\n\
         - assetReviews: array — double-check each **Proposed asset trigger** from the user message. \
         For each: {{ assetFileName, triggerWord (optional), proposedStartMs, durationMs, verified (bool), rationale, fullScreen (bool) }}. \
         Set verified=false if the timestamp does not match the show context, wrong word, rehearsal/false take, or dead air.\n\
         - suggestions: AI **image** overlays only — never for moments covered by assetReviews with verified=true.\n\n\
         TIMESTAMPED CONTEXT\n\
         The user message lists **Timestamped sentence slices** (~Parakeet ASR sentences, each slice roughly ≤ {slice_ms} ms of audio).\n\
         Each line `[n]` has exact start/end times and text — use those milliseconds only when returning startMs/endMs.\n\
         IMPORTANT: Prefer **narrow** spans: each suggestion's **(endMs - startMs)** must stay **≤ {align_ms} ms** (~{align_s} s).\n\n\
         For each AI suggestion:\n\
         - title, imagePrompt, overlayText (optional), transcriptExcerpt, startMs, endMs, idealDisplayMs (required, ≤ {max_display} ms), bibleStory (optional), rationale.\n\n\
         Do NOT suggest AI images for asset-file moments (intro/outro/trigger clips). Those belong in assetReviews only.",
        master = OVERLAY_MASTER_PROMPT,
        show = settings.show_context,
        asset_context = asset_context,
        video_duration_ms = video_duration_ms,
        slice_ms = MAX_LLM_SEGMENT_SLICE_MS,
        align_ms = MAX_TRANSCRIPT_ALIGN_MS,
        align_s = MAX_TRANSCRIPT_ALIGN_MS / 1000,
        max_display = MAX_IDEAL_DISPLAY_MS,
    );

    let sliced = sentence_slices_for_llm(&transcript.segments);
    let mut segments_text = String::new();
    for (i, seg) in sliced.iter().enumerate() {
        segments_text.push_str(&format!(
            "[{}] {}ms–{}ms: {}\n",
            i + 1,
            seg.start_ms,
            seg.end_ms,
            seg.text
        ));
    }

    let user_prompt = format!(
        "Video file duration: {video_duration_ms} ms\n\n\
         Full transcript (reference only):\n\n{full}\n\n---\n\
         Timestamped sentence slices (authoritative timings for startMs/endMs and contentBounds):\n{segments}\n\n---\n\
         Proposed asset triggers (verify each in assetReviews; timestamps from transcript word search):\n{proposed}\n\n\
         Analyze this episode. Return contentBounds, assetReviews, bibleStories, and AI image suggestions only \
         for meaningful visual storytelling moments not covered by verified assets.",
        full = transcript.full_text,
        segments = segments_text,
        proposed = proposed_json,
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

    let asset_placements = merge_asset_placements(&proposed_triggers, &payload.asset_reviews);
    let asset_names: Vec<String> = asset_placements
        .iter()
        .map(|a| a.asset_file_name.to_lowercase())
        .collect();

    let suggestions: Vec<OverlaySuggestion> = payload
        .suggestions
        .into_iter()
        .filter(|s| !s.title.trim().is_empty() && !s.image_prompt.trim().is_empty())
        .filter(|s| {
            let blob = format!(
                "{} {} {}",
                s.title.to_lowercase(),
                s.rationale.to_lowercase(),
                s.transcript_excerpt.to_lowercase()
            );
            !asset_names.iter().any(|name| blob.contains(name))
        })
        .map(|s| {
            let (start_ms, end_ms, ideal_display_ms) =
                normalize_overlay_timing(s.start_ms, s.end_ms, s.ideal_display_ms);
            OverlaySuggestion {
                id: Uuid::new_v4().to_string(),
                title: s.title.trim().to_string(),
                image_prompt: s.image_prompt.trim().to_string(),
                overlay_text: s
                    .overlay_text
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty()),
                transcript_excerpt: s.transcript_excerpt.trim().to_string(),
                start_ms,
                end_ms,
                ideal_display_ms,
                bible_story: s
                    .bible_story
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty()),
                rationale: s.rationale.trim().to_string(),
            }
        })
        .collect();

    let content_bounds = payload.content_bounds.map(|b| {
        let start = b.content_start_ms.min(video_duration_ms);
        let end = b
            .content_end_ms
            .clamp(start.saturating_add(500), video_duration_ms);
        EpisodeContentBounds {
            content_start_ms: start,
            content_end_ms: end,
            video_duration_ms: Some(video_duration_ms),
            rationale: b.rationale.trim().to_string(),
        }
    });

    Ok(TranscriptAnalysis {
        video_id: transcript.video_id.clone(),
        bible_stories: payload.bible_stories,
        suggestions,
        analyzed_at: Utc::now().to_rfc3339(),
        model,
        content_bounds,
        asset_placements,
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
        "model": resolve_openai_text_model(settings),
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

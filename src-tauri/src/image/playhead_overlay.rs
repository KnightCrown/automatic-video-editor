use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::image::overlay_images::{
    find_or_insert_image_entry, normalize_manifest_versions, sanitize_filename_component,
};
use crate::image::xai_imagine::generate_imagine_png;
use crate::llm::openai::{generate_overlay_image_prompt, resolve_openai_text_model};
use crate::store::project::{
    load_overlay_images_manifest_for_video, load_project, load_transcript_analysis_for_video,
    load_transcript_for_video, overlay_video_image_dir, project_paths,
    save_overlay_images_manifest, save_transcript_analysis,
};
use crate::store::secrets::get_xai_api_key;
use crate::types::{
    GeneratedOverlayImage, ImageGenerationProgress, OverlayCandidate, OverlayCandidateStatus,
    OverlayImageVersion, OverlayImagesManifest, OverlaySuggestion, PlayheadOverlayResult,
    ProjectSettings, Transcript, TranscriptAnalysis, VideoOverlayClip, DEFAULT_GROK_IMAGINE_MODEL,
};
use crate::video::timeline::default_duration_ms;

const CONTEXT_PAD_MS: u64 = 4000;
const DEFAULT_PLAYHEAD_DURATION_MS: u64 = 8_000;

fn transcript_window_at_ms(
    transcript: &Transcript,
    playhead_ms: u64,
) -> Result<(String, u64, u64), String> {
    let window_start = playhead_ms.saturating_sub(CONTEXT_PAD_MS);
    let window_end = playhead_ms.saturating_add(CONTEXT_PAD_MS);

    let mut excerpt_parts: Vec<String> = transcript
        .segments
        .iter()
        .filter(|s| s.end_ms > window_start && s.start_ms < window_end)
        .map(|s| s.text.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    if excerpt_parts.is_empty() {
        let nearest = transcript
            .segments
            .iter()
            .min_by_key(|s| {
                if playhead_ms >= s.start_ms && playhead_ms <= s.end_ms {
                    0
                } else if playhead_ms < s.start_ms {
                    s.start_ms - playhead_ms
                } else {
                    playhead_ms - s.end_ms
                }
            })
            .ok_or_else(|| "transcript_empty_at_playhead".to_string())?;
        excerpt_parts.push(nearest.text.trim().to_string());
        return Ok((
            nearest.text.trim().to_string(),
            nearest.start_ms,
            nearest.end_ms.max(nearest.start_ms + 500),
        ));
    }

    let excerpt = excerpt_parts.join(" ");
    Ok((excerpt, window_start, window_end.max(window_start + 500)))
}

fn title_from_prompt(overlay_text: Option<&str>, excerpt: &str) -> String {
    if let Some(text) = overlay_text.map(str::trim).filter(|t| !t.is_empty()) {
        return text.to_string();
    }
    let words: Vec<&str> = excerpt.split_whitespace().take(6).collect();
    if words.is_empty() {
        "AI overlay".to_string()
    } else {
        words.join(" ")
    }
}

pub async fn generate_playhead_ai_overlay(
    app: &AppHandle,
    root_path: String,
    video_id: String,
    playhead_ms: u64,
    settings: &ProjectSettings,
) -> Result<PlayheadOverlayResult, String> {
    let paths = project_paths(&root_path)?;
    let project = load_project(&root_path)?;
    let video = project
        .videos
        .iter()
        .find(|v| v.id == video_id)
        .ok_or_else(|| "video_not_found".to_string())?;

    let transcript = load_transcript_for_video(&paths, &video_id, &video.path)?
        .ok_or_else(|| "transcript_not_found: Transcribe this episode first.".to_string())?;

    let (excerpt, window_start, window_end) = transcript_window_at_ms(&transcript, playhead_ms)?;

    let _ = app.emit(
        "image_generation_progress",
        ImageGenerationProgress {
            video_id: video_id.clone(),
            index: 0,
            total: 1,
            suggestion_id: String::new(),
            stage: "prompt".to_string(),
            message: Some("Drafting overlay prompt from transcript…".to_string()),
        },
    );

    let candidate = OverlayCandidate {
        id: Uuid::new_v4().to_string(),
        video_id: video_id.clone(),
        start_ms: window_start,
        end_ms: window_end,
        transcript_excerpt: excerpt.clone(),
        score: 100,
        reasons: vec!["playhead".to_string()],
        status: OverlayCandidateStatus::Pending,
    };

    let prompt_result = generate_overlay_image_prompt(&candidate, settings).await?;

    let suggestion_id = Uuid::new_v4().to_string();
    let title = title_from_prompt(prompt_result.overlay_text.as_deref(), &excerpt);
    let ideal_display_ms = DEFAULT_PLAYHEAD_DURATION_MS;

    let suggestion = OverlaySuggestion {
        id: suggestion_id.clone(),
        title: title.clone(),
        image_prompt: prompt_result.image_prompt.clone(),
        overlay_text: prompt_result.overlay_text.clone(),
        transcript_excerpt: excerpt,
        start_ms: Some(playhead_ms),
        end_ms: Some(playhead_ms.saturating_add(ideal_display_ms)),
        ideal_display_ms: Some(ideal_display_ms),
        bible_story: None,
        rationale: prompt_result.rationale,
    };

    let mut analysis = load_transcript_analysis_for_video(&paths, &video_id, &video.path)?
        .unwrap_or(TranscriptAnalysis {
            video_id: video_id.clone(),
            bible_stories: Vec::new(),
            suggestions: Vec::new(),
            analyzed_at: Utc::now().to_rfc3339(),
            model: resolve_openai_text_model(settings),
            content_bounds: None,
            asset_placements: Vec::new(),
        });
    analysis.suggestions.push(suggestion.clone());
    analysis.analyzed_at = Utc::now().to_rfc3339();
    save_transcript_analysis(&paths, &analysis)?;

    let api_key = get_xai_api_key().map_err(|e| {
        if e == "xai_api_key_not_set" {
            "xAI API key is not set. Open Settings and save your Grok Imagine (xAI) API key."
                .to_string()
        } else {
            e
        }
    })?;

    let model = settings.grok_imagine_model.trim();
    let model = if model.is_empty() {
        DEFAULT_GROK_IMAGINE_MODEL
    } else {
        model
    };

    let _ = app.emit(
        "image_generation_progress",
        ImageGenerationProgress {
            video_id: video_id.clone(),
            index: 1,
            total: 1,
            suggestion_id: suggestion_id.clone(),
            stage: "generating".to_string(),
            message: Some(format!("Rendering {title} with Grok Imagine…")),
        },
    );

    let bytes = generate_imagine_png(&api_key, model, &suggestion.image_prompt).await?;

    let img_root = overlay_video_image_dir(&paths, &video_id)?;
    fs::create_dir_all(&img_root).map_err(|e| format!("create_image_dir:{e}"))?;

    let file_stem = sanitize_filename_component(&suggestion_id);
    let png_name = format!("{file_stem}.png");
    let rel = format!(".devotiontime/images/{video_id}/{png_name}");
    let root_buf = PathBuf::from(&root_path);
    let abs = root_buf
        .join(".devotiontime")
        .join("images")
        .join(&video_id)
        .join(&png_name);
    fs::write(&abs, bytes).map_err(|e| format!("write_png:{e}"))?;

    let generated_at = Utc::now().to_rfc3339();
    let generated = GeneratedOverlayImage {
        suggestion_id: suggestion_id.clone(),
        title: title.clone(),
        image_prompt: suggestion.image_prompt.clone(),
        transcript_excerpt: suggestion.transcript_excerpt.clone(),
        relative_path: rel.clone(),
        generated_at: generated_at.clone(),
        versions: vec![OverlayImageVersion {
            relative_path: rel.clone(),
            generated_at,
        }],
    };

    let mut manifest = load_overlay_images_manifest_for_video(&paths, &video_id, &video.path)?
        .unwrap_or(OverlayImagesManifest {
            video_id: video_id.clone(),
            model: model.to_string(),
            generated_at: Utc::now().to_rfc3339(),
            images: Vec::new(),
        });

    {
        let entry = find_or_insert_image_entry(&mut manifest.images, &suggestion);
        *entry = generated;
    }
    manifest.model = model.to_string();
    manifest.generated_at = Utc::now().to_rfc3339();
    normalize_manifest_versions(&mut manifest);
    save_overlay_images_manifest(&paths, &manifest)?;

    let duration_ms = default_duration_ms(&suggestion);
    let clip = VideoOverlayClip {
        suggestion_id: suggestion_id.clone(),
        image_relative_path: rel,
        title,
        start_ms: playhead_ms,
        duration_ms,
        layout: settings.default_overlay_layout.clone(),
        opacity_pct: None,
        entrance: Some("fade-in".to_string()),
        exit: Some("fade-out".to_string()),
    };

    let _ = app.emit(
        "image_generation_progress",
        ImageGenerationProgress {
            video_id,
            index: 1,
            total: 1,
            suggestion_id,
            stage: "done".to_string(),
            message: Some("Overlay image ready".to_string()),
        },
    );

    Ok(PlayheadOverlayResult { clip })
}

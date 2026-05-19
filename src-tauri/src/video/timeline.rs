use std::collections::HashMap;

use chrono::Utc;

use crate::store::project::{
    load_final_video_timeline, load_overlay_images_manifest_for_video,
    load_project, load_transcript_analysis_for_video,
    project_paths, save_final_video_timeline,
};
use crate::types::{
    FinalVideoTimeline, OverlayClipLayout, OverlayImagesManifest, OverlaySuggestion,
    TranscriptAnalysis, VideoOverlayClip,
};

const MIN_DISPLAY_MS: u64 = 500;
const MAX_DISPLAY_MS: u64 = 15_000;

pub fn default_duration_ms(suggestion: &OverlaySuggestion) -> u64 {
    if let Some(ideal) = suggestion.ideal_display_ms {
        return ideal.clamp(MIN_DISPLAY_MS, MAX_DISPLAY_MS);
    }
    match (suggestion.start_ms, suggestion.end_ms) {
        (Some(start), Some(end)) if end > start => {
            (end - start).clamp(MIN_DISPLAY_MS, MAX_DISPLAY_MS)
        }
        _ => MAX_DISPLAY_MS,
    }
}

pub fn build_clips_from_analysis_and_manifest(
    analysis: &TranscriptAnalysis,
    manifest: &OverlayImagesManifest,
) -> Vec<VideoOverlayClip> {
    let by_id: HashMap<&str, &OverlaySuggestion> = analysis
        .suggestions
        .iter()
        .map(|s| (s.id.as_str(), s))
        .collect();

    let mut clips: Vec<VideoOverlayClip> = Vec::with_capacity(manifest.images.len());

    for img in &manifest.images {
        let suggestion = by_id
            .get(img.suggestion_id.as_str())
            .copied()
            .or_else(|| {
                analysis.suggestions.iter().find(|s| {
                    s.title == img.title
                        || s.transcript_excerpt == img.transcript_excerpt
                        || s.image_prompt == img.image_prompt
                })
            });

        let Some(suggestion) = suggestion else {
            continue;
        };

        let start_ms = suggestion.start_ms.unwrap_or(0);
        let duration_ms = default_duration_ms(suggestion);
        clips.push(VideoOverlayClip {
            suggestion_id: img.suggestion_id.clone(),
            image_relative_path: img.relative_path.clone(),
            title: img.title.clone(),
            start_ms,
            duration_ms,
            layout: OverlayClipLayout::default(),
        });
    }

    clips.sort_by_key(|c| c.start_ms);
    clips
}

/// Load saved timeline or build from analysis + images. Rebuilds when saved file is missing clips
/// but images and analysis are available (e.g. stale cache or re-analyzed transcript).
pub fn resolve_final_video_timeline(
    root_path: &str,
    video_id: &str,
) -> Result<FinalVideoTimeline, String> {
    let paths = project_paths(root_path)?;
    let built = build_default_timeline(root_path, video_id)?;

    let Some(saved) = load_final_video_timeline(&paths, video_id)? else {
        return Ok(built);
    };

    if saved.clips.is_empty() && !built.clips.is_empty() {
        save_final_video_timeline(&paths, &built)?;
        return Ok(built);
    }

    if !saved.clips.is_empty() && built.clips.len() > saved.clips.len() {
        save_final_video_timeline(&paths, &built)?;
        return Ok(built);
    }

    Ok(saved)
}

pub fn build_default_timeline(
    root_path: &str,
    video_id: &str,
) -> Result<FinalVideoTimeline, String> {
    let paths = project_paths(root_path)?;
    let video_path = load_project(root_path)?
        .videos
        .into_iter()
        .find(|v| v.id == video_id)
        .map(|v| v.path)
        .unwrap_or_default();
    let analysis = load_transcript_analysis_for_video(&paths, video_id, &video_path)?
        .ok_or_else(|| "analysis_not_found".to_string())?;
    let manifest = load_overlay_images_manifest_for_video(&paths, video_id, &video_path)?
        .ok_or_else(|| "overlay_images_not_found".to_string())?;
    let clips = build_clips_from_analysis_and_manifest(&analysis, &manifest);
    Ok(FinalVideoTimeline {
        video_id: video_id.to_string(),
        clips,
        updated_at: Utc::now().to_rfc3339(),
    })
}

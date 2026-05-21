use std::path::Path;

use chrono::Utc;

use crate::pipeline::assets::{propose_asset_placements_from_settings, resolve_asset_absolute};
use crate::pipeline::sign_off::resolve_content_end_ms;
use crate::store::project::{
    load_final_video_timeline, load_overlay_images_manifest_for_video, load_project,
    load_transcript_analysis_for_video, load_transcript_for_video, project_paths,
    save_final_video_timeline, save_transcript_analysis,
};
use crate::types::{
    AssetPlacement, EpisodeContentBounds, FinalVideoTimeline, OverlayClipLayout,
    OverlayImagesManifest, OverlaySuggestion, TimelineVideoClip, TranscriptAnalysis,
    VideoOverlayClip,
};
use crate::video::encoders::probe_video_duration_sec;
use crate::video::timeline_media::import_asset_clip;

const MIN_DISPLAY_MS: u64 = 500;
const MAX_DISPLAY_MS: u64 = 15_000;

fn is_insert_timeline_clip(clip: &TimelineVideoClip) -> bool {
    clip.timeline_mode == "insert"
        || clip.render_mode == "insert"
        || matches!(
            clip.placement_kind.as_deref(),
            Some("scheduled_start" | "scheduled_end" | "intro" | "outro")
        )
}

fn insert_clip_names(clips: &[TimelineVideoClip]) -> Vec<String> {
    let mut names: Vec<String> = clips
        .iter()
        .filter(|clip| is_insert_timeline_clip(clip))
        .map(|clip| clip.file_name.to_ascii_lowercase())
        .collect();
    names.sort();
    names.dedup();
    names
}

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
    layout: &OverlayClipLayout,
) -> Vec<VideoOverlayClip> {
    let asset_names: Vec<String> = analysis
        .asset_placements
        .iter()
        .map(|a| a.asset_file_name.to_lowercase())
        .collect();

    let by_id: std::collections::HashMap<&str, &OverlaySuggestion> = analysis
        .suggestions
        .iter()
        .map(|s| (s.id.as_str(), s))
        .collect();

    let mut clips: Vec<VideoOverlayClip> = Vec::with_capacity(manifest.images.len());

    for img in &manifest.images {
        let suggestion = by_id.get(img.suggestion_id.as_str()).copied().or_else(|| {
            analysis.suggestions.iter().find(|s| {
                s.title == img.title
                    || s.transcript_excerpt == img.transcript_excerpt
                    || s.image_prompt == img.image_prompt
            })
        });

        let Some(suggestion) = suggestion else {
            continue;
        };

        let title_blob = format!("{} {}", suggestion.title, suggestion.rationale).to_lowercase();
        if asset_names.iter().any(|name| title_blob.contains(name)) {
            continue;
        }

        let start_ms = suggestion.start_ms.unwrap_or(0);
        let duration_ms = default_duration_ms(suggestion);
        clips.push(VideoOverlayClip {
            suggestion_id: img.suggestion_id.clone(),
            image_relative_path: img.relative_path.clone(),
            title: img.title.clone(),
            start_ms,
            duration_ms,
            layout: layout.clone(),
            opacity_pct: None,
            entrance: None,
            exit: None,
        });
    }

    clips.sort_by_key(|c| c.start_ms);
    clips
}

pub fn build_asset_video_clips(
    root_path: &str,
    video_id: &str,
    placements: &[AssetPlacement],
    asset_folder: Option<&Path>,
) -> Result<Vec<crate::types::TimelineVideoClip>, String> {
    let Some(folder) = asset_folder.filter(|p| p.is_dir()) else {
        return Ok(Vec::new());
    };

    let mut clips = Vec::new();
    for placement in placements.iter().filter(|p| p.verified) {
        let asset_path = resolve_asset_absolute(folder, &placement.asset_file_name)?;
        let clip = import_asset_clip(root_path, video_id, &asset_path, placement)?;
        clips.push(clip);
    }
    Ok(clips)
}

pub fn refresh_asset_placements_from_current_prompt(
    root_path: &str,
    video_id: &str,
) -> Result<(), String> {
    let paths = project_paths(root_path)?;
    let project = load_project(root_path)?;
    let Some(video) = project.videos.iter().find(|v| v.id == video_id) else {
        return Err("video_not_found".to_string());
    };
    let Some(mut analysis) = load_transcript_analysis_for_video(&paths, video_id, &video.path)?
    else {
        return Ok(());
    };
    let Some(transcript) = load_transcript_for_video(&paths, video_id, &video.path)? else {
        return Ok(());
    };

    let video_duration_ms = probe_video_duration_sec(&transcript.video_path)
        .map(|s| (s * 1000.0).round().max(1.0) as u64)
        .unwrap_or_else(|_| transcript.segments.last().map(|s| s.end_ms).unwrap_or(0));
    let content_start_ms = analysis
        .content_bounds
        .as_ref()
        .map(|b| b.content_start_ms)
        .unwrap_or_else(|| transcript.segments.first().map(|s| s.start_ms).unwrap_or(0));
    let content_end_hint = analysis.content_bounds.as_ref().map(|b| b.content_end_ms);
    let resolved_content_end = resolve_content_end_ms(
        &transcript,
        video_duration_ms,
        content_end_hint,
        content_start_ms,
    );
    if let Some(bounds) = analysis.content_bounds.as_mut() {
        bounds.content_end_ms = resolved_content_end;
        bounds.video_duration_ms = Some(video_duration_ms);
    } else {
        analysis.content_bounds = Some(EpisodeContentBounds {
            content_start_ms,
            content_end_ms: resolved_content_end,
            video_duration_ms: Some(video_duration_ms),
            rationale: "Content end aligned to detected host sign-off.".to_string(),
        });
    }
    analysis.asset_placements = propose_asset_placements_from_settings(
        &transcript,
        &project.settings,
        Some(resolved_content_end),
    );
    save_transcript_analysis(&paths, &analysis)
}

/// Load saved timeline or build from analysis + images. Rebuilds when saved file is missing clips
/// but images and analysis are available (e.g. stale cache or re-analyzed transcript).
pub fn resolve_final_video_timeline(
    root_path: &str,
    video_id: &str,
) -> Result<FinalVideoTimeline, String> {
    let paths = project_paths(root_path)?;

    if let Some(saved) = load_final_video_timeline(&paths, video_id)? {
        if !saved.clips.is_empty() || !saved.video_clips.is_empty() {
            return Ok(saved);
        }
    }

    let built = build_default_timeline(root_path, video_id)?;

    let Some(saved) = load_final_video_timeline(&paths, video_id)? else {
        if !built.clips.is_empty() || !built.video_clips.is_empty() {
            save_final_video_timeline(&paths, &built)?;
        }
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

    if saved.video_clips.is_empty() && !built.video_clips.is_empty() {
        save_final_video_timeline(&paths, &built)?;
        return Ok(built);
    }

    if insert_clip_names(&built.video_clips) != insert_clip_names(&saved.video_clips) {
        let mut updated = saved;
        updated.video_clips = built.video_clips;
        save_final_video_timeline(&paths, &updated)?;
        return Ok(updated);
    }

    Ok(saved)
}

pub fn build_default_timeline(
    root_path: &str,
    video_id: &str,
) -> Result<FinalVideoTimeline, String> {
    let paths = project_paths(root_path)?;
    let project = load_project(root_path)?;
    let video_path = project
        .videos
        .iter()
        .find(|v| v.id == video_id)
        .map(|v| v.path.clone())
        .unwrap_or_default();
    let analysis = load_transcript_analysis_for_video(&paths, video_id, &video_path)?
        .ok_or_else(|| "analysis_not_found".to_string())?;
    let manifest = load_overlay_images_manifest_for_video(&paths, video_id, &video_path)?;
    let layout = project.settings.default_overlay_layout.clone();
    let clips = manifest
        .as_ref()
        .map(|m| build_clips_from_analysis_and_manifest(&analysis, m, &layout))
        .unwrap_or_default();

    let asset_folder = project.settings.asset_folder_path.as_deref().map(Path::new);
    let video_clips = build_asset_video_clips(
        root_path,
        video_id,
        &analysis.asset_placements,
        asset_folder,
    )?;

    let (content_start_ms, content_end_ms) = analysis
        .content_bounds
        .as_ref()
        .map(|b| (Some(b.content_start_ms), Some(b.content_end_ms)))
        .unwrap_or((None, None));

    Ok(FinalVideoTimeline {
        video_id: video_id.to_string(),
        clips,
        video_clips,
        content_start_ms,
        content_end_ms,
        updated_at: Utc::now().to_rfc3339(),
    })
}

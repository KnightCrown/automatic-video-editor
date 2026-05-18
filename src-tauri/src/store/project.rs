use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::types::{
    FinalVideoTimeline, OverlayCandidate, OverlayCandidateStatus, ProjectManifest,
    ProjectSettings, Transcript, TranscriptAnalysis, VideoJob, OverlayImagesManifest,
    DEFAULT_GROK_IMAGINE_MODEL, LEGACY_GROK_IMAGINE_MODEL_QUALITY,
};

pub const DEVOTIONTIME_DIR: &str = ".devotiontime";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPaths {
    pub root: PathBuf,
    pub meta: PathBuf,
    pub transcripts: PathBuf,
    pub candidates: PathBuf,
    pub suggestions: PathBuf,
    pub outputs: PathBuf,
    pub cache: PathBuf,
}

pub fn project_paths(root: &str) -> Result<ProjectPaths, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err("project_root_not_found".to_string());
    }
    let meta = root_path.join(DEVOTIONTIME_DIR);
    Ok(ProjectPaths {
        root: root_path.clone(),
        transcripts: meta.join("transcripts"),
        candidates: meta.join("candidates"),
        suggestions: meta.join("suggestions"),
        outputs: meta.join("outputs"),
        cache: meta.join("cache"),
        meta: meta.join("project.json"),
    })
}

pub fn ensure_project_dirs(paths: &ProjectPaths) -> Result<(), String> {
    let base = paths.meta.parent().ok_or("invalid_meta_path")?;
    for dir in [
        base,
        &paths.transcripts,
        &paths.candidates,
        &paths.suggestions,
        &paths.outputs,
        &paths.cache,
    ] {
        fs::create_dir_all(dir).map_err(|e| format!("create_dir_failed:{}:{}", dir.display(), e))?;
    }
    Ok(())
}

pub fn load_project(root: &str) -> Result<ProjectManifest, String> {
    let paths = project_paths(root)?;
    if !paths.meta.exists() {
        return Ok(ProjectManifest {
            root_path: root.to_string(),
            settings: ProjectSettings::default(),
            videos: Vec::new(),
            updated_at: Utc::now().to_rfc3339(),
        });
    }
    let raw = fs::read_to_string(&paths.meta).map_err(|e| format!("read_project_failed:{}", e))?;
    let mut manifest: ProjectManifest =
        serde_json::from_str(&raw).map_err(|e| format!("parse_project_failed:{}", e))?;

    if manifest.settings.grok_imagine_model == LEGACY_GROK_IMAGINE_MODEL_QUALITY {
        manifest.settings.grok_imagine_model = DEFAULT_GROK_IMAGINE_MODEL.to_string();
        let _ = save_project(&manifest);
    }

    Ok(manifest)
}

pub fn save_project(manifest: &ProjectManifest) -> Result<(), String> {
    let paths = project_paths(&manifest.root_path)?;
    ensure_project_dirs(&paths)?;
    let mut manifest = manifest.clone();
    manifest.updated_at = Utc::now().to_rfc3339();
    let raw =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("serialize_project:{}", e))?;
    fs::write(&paths.meta, raw).map_err(|e| format!("write_project_failed:{}", e))
}

pub fn transcript_path(paths: &ProjectPaths, video_id: &str) -> PathBuf {
    paths.transcripts.join(format!("{video_id}.transcript.json"))
}

pub fn candidates_path(paths: &ProjectPaths, video_id: &str) -> PathBuf {
    paths
        .candidates
        .join(format!("{video_id}.candidates.json"))
}

pub fn analysis_path(paths: &ProjectPaths, video_id: &str) -> PathBuf {
    paths
        .suggestions
        .join(format!("{video_id}.analysis.json"))
}

fn devotiontime_base(paths: &ProjectPaths) -> Result<PathBuf, String> {
    paths
        .meta
        .parent()
        .ok_or_else(|| "invalid_meta_path".to_string())
        .map(|p| p.to_path_buf())
}

pub fn overlay_video_image_dir(paths: &ProjectPaths, video_id: &str) -> Result<PathBuf, String> {
    Ok(devotiontime_base(paths)?.join("images").join(video_id))
}

pub fn overlay_images_manifest_path(paths: &ProjectPaths, video_id: &str) -> Result<PathBuf, String> {
    Ok(devotiontime_base(paths)?
        .join("images")
        .join(format!("{video_id}.manifest.json")))
}

pub fn final_video_timeline_path(paths: &ProjectPaths, video_id: &str) -> Result<PathBuf, String> {
    Ok(devotiontime_base(paths)?
        .join("final-video")
        .join(format!("{video_id}.timeline.json")))
}

pub fn save_final_video_timeline(
    paths: &ProjectPaths,
    timeline: &FinalVideoTimeline,
) -> Result<(), String> {
    let path = final_video_timeline_path(paths, &timeline.video_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_final_video_dir:{e}"))?;
    }
    let raw = serde_json::to_string_pretty(timeline)
        .map_err(|e| format!("serialize_final_video_timeline:{e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write_final_video_timeline:{e}"))
}

pub fn load_final_video_timeline(
    paths: &ProjectPaths,
    video_id: &str,
) -> Result<Option<FinalVideoTimeline>, String> {
    let path = final_video_timeline_path(paths, video_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read_final_video_timeline:{e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("parse_final_video_timeline:{e}"))
}

pub fn save_overlay_images_manifest(
    paths: &ProjectPaths,
    manifest: &OverlayImagesManifest,
) -> Result<(), String> {
    let path = overlay_images_manifest_path(paths, &manifest.video_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_images_dir:{e}"))?;
    }
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("serialize_overlay_images:{e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write_overlay_manifest:{e}"))
}

pub fn load_overlay_images_manifest(
    paths: &ProjectPaths,
    video_id: &str,
) -> Result<Option<OverlayImagesManifest>, String> {
    let path = overlay_images_manifest_path(paths, video_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read_overlay_manifest:{e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("parse_overlay_manifest:{e}"))
}

pub fn save_transcript_analysis(
    paths: &ProjectPaths,
    analysis: &TranscriptAnalysis,
) -> Result<(), String> {
    ensure_project_dirs(paths)?;
    let path = analysis_path(paths, &analysis.video_id);
    let raw =
        serde_json::to_string_pretty(analysis).map_err(|e| format!("serialize_analysis:{}", e))?;
    fs::write(path, raw).map_err(|e| format!("write_analysis_failed:{}", e))
}

pub fn load_transcript_analysis(
    paths: &ProjectPaths,
    video_id: &str,
) -> Result<Option<TranscriptAnalysis>, String> {
    let path = analysis_path(paths, video_id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read_analysis_failed:{}", e))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("parse_analysis_failed:{}", e))
}

pub fn output_dir(paths: &ProjectPaths, candidate_id: &str) -> PathBuf {
    paths.outputs.join(candidate_id)
}

pub fn save_transcript(paths: &ProjectPaths, transcript: &Transcript) -> Result<(), String> {
    ensure_project_dirs(paths)?;
    let path = transcript_path(paths, &transcript.video_id);
    let raw =
        serde_json::to_string_pretty(transcript).map_err(|e| format!("serialize_transcript:{}", e))?;
    fs::write(path, raw).map_err(|e| format!("write_transcript_failed:{}", e))
}

pub fn load_transcript(paths: &ProjectPaths, video_id: &str) -> Result<Option<Transcript>, String> {
    let path = transcript_path(paths, video_id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read_transcript_failed:{}", e))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("parse_transcript_failed:{}", e))
}

/// Resolve transcript by content id, migrating legacy filename-based saves when found.
pub fn load_transcript_for_video(
    paths: &ProjectPaths,
    video_id: &str,
    video_path: &str,
) -> Result<Option<Transcript>, String> {
    if let Some(transcript) = load_transcript(paths, video_id)? {
        return Ok(Some(transcript));
    }

    let legacy_id = video_id_from_path(video_path);
    if legacy_id == video_id {
        return Ok(None);
    }

    let Some(mut transcript) = load_transcript(paths, &legacy_id)? else {
        return Ok(None);
    };

    transcript.video_id = video_id.to_string();
    transcript.video_path = video_path.to_string();
    save_transcript(paths, &transcript)?;
    let legacy_path = transcript_path(paths, &legacy_id);
    if legacy_path.is_file() {
        let _ = fs::remove_file(legacy_path);
    }
    Ok(Some(transcript))
}

pub fn has_transcript_for_video(
    paths: &ProjectPaths,
    video_id: &str,
    video_path: &str,
) -> Result<bool, String> {
    Ok(load_transcript_for_video(paths, video_id, video_path)?.is_some())
}

pub fn save_candidates(
    paths: &ProjectPaths,
    video_id: &str,
    candidates: &[OverlayCandidate],
) -> Result<(), String> {
    ensure_project_dirs(paths)?;
    let path = candidates_path(paths, video_id);
    let raw = serde_json::to_string_pretty(candidates)
        .map_err(|e| format!("serialize_candidates:{}", e))?;
    fs::write(path, raw).map_err(|e| format!("write_candidates_failed:{}", e))
}

pub fn load_candidates(
    paths: &ProjectPaths,
    video_id: &str,
) -> Result<Vec<OverlayCandidate>, String> {
    let path = candidates_path(paths, video_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read_candidates_failed:{}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse_candidates_failed:{}", e))
}

pub fn update_candidate_status(
    paths: &ProjectPaths,
    video_id: &str,
    candidate_id: &str,
    status: OverlayCandidateStatus,
) -> Result<Vec<OverlayCandidate>, String> {
    let mut candidates = load_candidates(paths, video_id)?;
    let Some(candidate) = candidates.iter_mut().find(|c| c.id == candidate_id) else {
        return Err("candidate_not_found".to_string());
    };
    candidate.status = status;
    save_candidates(paths, video_id, &candidates)?;
    Ok(candidates)
}

pub fn video_id_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_string()
}

/// Derive pipeline stage from artifacts on disk (transcript → analysis → images).
pub fn resolve_video_status_from_artifacts(
    paths: &ProjectPaths,
    video_id: &str,
    video_path: &str,
) -> Result<String, String> {
    if let Some(img_manifest) = load_overlay_images_manifest(paths, video_id)? {
        if !img_manifest.images.is_empty() {
            return Ok("images_generated".to_string());
        }
    }
    if load_transcript_analysis(paths, video_id)?.is_some() {
        return Ok("analyzed".to_string());
    }
    if has_transcript_for_video(paths, video_id, video_path)? {
        return Ok("transcribed".to_string());
    }
    Ok("pending".to_string())
}

pub fn set_video_pipeline_status(
    root: &str,
    video_id: &str,
    status: &str,
) -> Result<ProjectManifest, String> {
    let mut manifest = load_project(root)?;
    if let Some(video) = manifest.videos.iter_mut().find(|v| v.id == video_id) {
        video.status = status.to_string();
        if status != "failed" {
            video.error = None;
        }
    }
    save_project(&manifest)?;
    Ok(manifest)
}

/// Reconcile each video's status with saved pipeline artifacts (fixes legacy projects).
pub fn refresh_video_statuses_in_manifest(root: &str) -> Result<ProjectManifest, String> {
    let paths = project_paths(root)?;
    let mut manifest = load_project(root)?;
    for video in manifest.videos.iter_mut() {
        if video.status == "failed" {
            continue;
        }
        if matches!(
            video.status.as_str(),
            "processing" | "transcribing" | "analyzing" | "generating_images"
        ) {
            continue;
        }
        video.status = resolve_video_status_from_artifacts(&paths, &video.id, &video.path)?;
    }
    save_project(&manifest)?;
    Ok(manifest)
}

pub fn sync_videos_in_manifest(
    root: &str,
    discovered: Vec<VideoJob>,
) -> Result<ProjectManifest, String> {
    let paths = project_paths(root)?;
    let mut manifest = load_project(root)?;
    let previous: HashMap<String, VideoJob> = manifest
        .videos
        .into_iter()
        .map(|video| (video.id.clone(), video))
        .collect();

    let mut merged = Vec::with_capacity(discovered.len());
    for mut video in discovered {
        if let Some(prev) = previous.get(&video.id) {
            if prev.path != video.path {
                video.status = "pending".to_string();
                video.error = None;
            } else if prev.status == "failed" {
                video.status = "failed".to_string();
                video.error = prev.error.clone();
            } else {
                video.status = resolve_video_status_from_artifacts(&paths, &video.id, &video.path)?;
                video.error = None;
            }
        } else {
            video.status = resolve_video_status_from_artifacts(&paths, &video.id, &video.path)?;
            video.error = None;
        }
        merged.push(video);
    }

    manifest.videos = merged;
    save_project(&manifest)?;
    Ok(manifest)
}

pub fn save_prompt_json(
    paths: &ProjectPaths,
    candidate_id: &str,
    prompt: &crate::types::OverlayPromptResult,
) -> Result<PathBuf, String> {
    let dir = output_dir(paths, candidate_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create_output_dir:{}", e))?;
    let path = dir.join("prompt.json");
    let raw = serde_json::to_string_pretty(prompt).map_err(|e| format!("serialize_prompt:{}", e))?;
    fs::write(&path, raw).map_err(|e| format!("write_prompt_failed:{}", e))?;
    Ok(path)
}

pub fn save_image_bytes(
    paths: &ProjectPaths,
    candidate_id: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let dir = output_dir(paths, candidate_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create_output_dir:{}", e))?;
    let path = dir.join("overlay.png");
    fs::write(&path, bytes).map_err(|e| format!("write_image_failed:{}", e))?;
    Ok(path)
}

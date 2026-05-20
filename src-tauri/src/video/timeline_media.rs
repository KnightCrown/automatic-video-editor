use std::path::{Path, PathBuf};

use crate::store::project::{project_paths, timeline_media_dir};
use crate::types::{AssetPlacement, TimelineVideoClip};
use crate::video::encoders::probe_video_duration_sec;

pub fn resolve_timeline_media_absolute(root_path: &str, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    Ok(Path::new(root_path).join(relative))
}

fn copy_into_timeline_media(
    root_path: &str,
    video_id: &str,
    source: &Path,
) -> Result<(String, String, u64), String> {
    if !source.is_file() {
        return Err(format!("source_not_found:{}", source.display()));
    }

    let duration_sec = probe_video_duration_sec(source.to_string_lossy().as_ref())?;
    let source_duration_ms = (duration_sec * 1000.0).round().max(1.0) as u64;

    let paths = project_paths(root_path)?;
    let media_dir = timeline_media_dir(&paths, video_id)?;
    std::fs::create_dir_all(&media_dir).map_err(|e| format!("create_media_dir_failed:{e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let dest_name = format!("{id}.{ext}");
    let dest_abs = media_dir.join(&dest_name);
    std::fs::copy(source, &dest_abs).map_err(|e| format!("copy_media_failed:{e}"))?;

    let root = Path::new(root_path);
    let relative = dest_abs
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| dest_abs.to_string_lossy().replace('\\', "/"));

    Ok((id, relative, source_duration_ms))
}

pub fn import_timeline_video(
    root_path: &str,
    video_id: &str,
    source_path: &str,
) -> Result<TimelineVideoClip, String> {
    let source = Path::new(source_path);
    let (id, relative, source_duration_ms) = copy_into_timeline_media(root_path, video_id, source)?;
    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "clip".to_string());

    Ok(TimelineVideoClip {
        id,
        source_relative_path: relative,
        file_name,
        timeline_mode: "overlay".to_string(),
        placement_kind: None,
        start_ms: 0,
        duration_ms: source_duration_ms,
        source_duration_ms,
        trim_start_ms: Some(0),
        scale_pct: Some(100.0),
        opacity_pct: Some(100.0),
        volume_pct: Some(100.0),
        track_index: 1,
    })
}

pub fn import_asset_clip(
    root_path: &str,
    video_id: &str,
    asset_source: &Path,
    placement: &AssetPlacement,
) -> Result<TimelineVideoClip, String> {
    let (id, relative, source_duration_ms) =
        copy_into_timeline_media(root_path, video_id, asset_source)?;
    let duration_ms = placement.duration_ms.min(source_duration_ms).max(500);
    let scale = if placement.full_screen { 100.0 } else { 38.0 };

    Ok(TimelineVideoClip {
        id,
        source_relative_path: relative,
        file_name: placement.asset_file_name.clone(),
        timeline_mode: placement.timeline_mode.clone(),
        placement_kind: Some(placement.placement_kind.clone()),
        start_ms: placement.start_ms,
        duration_ms,
        source_duration_ms,
        trim_start_ms: Some(0),
        scale_pct: Some(scale),
        opacity_pct: Some(100.0),
        volume_pct: Some(100.0),
        track_index: placement.track_index,
    })
}

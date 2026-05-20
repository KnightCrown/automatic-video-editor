use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::audio::ffmpeg::is_video_file;
use crate::store::fingerprint::content_fingerprint;
use crate::store::project::disambiguate_video_job_ids;
use crate::types::{ProjectScanProgress, VideoJob};

const MAX_DEPTH: u32 = 2;

pub fn scan_video_folder(root: &str) -> Result<Vec<VideoJob>, String> {
    scan_video_folder_with_progress(root, |_| {})
}

pub fn scan_video_folder_with_progress(
    root: &str,
    mut on_progress: impl FnMut(ProjectScanProgress),
) -> Result<Vec<VideoJob>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err("project_root_not_found".to_string());
    }

    on_progress(ProjectScanProgress {
        index: 0,
        total: 0,
        file_name: String::new(),
        stage: "discover".to_string(),
        message: Some("Scanning folder for video files…".to_string()),
    });

    let mut paths: Vec<PathBuf> = Vec::new();
    collect_video_paths(&root_path, &root_path, 0, &mut paths)?;
    paths.sort_by(|a, b| {
        a.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .cmp(b.file_name().and_then(|n| n.to_str()).unwrap_or(""))
    });

    let total = paths.len().max(1) as u32;
    let root_str = root_path.to_string_lossy().to_string();
    let mut jobs = Vec::with_capacity(paths.len());

    for (i, path) in paths.iter().enumerate() {
        let path_str = path.to_string_lossy().to_string();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("video")
            .to_string();

        on_progress(ProjectScanProgress {
            index: (i + 1) as u32,
            total,
            file_name: file_name.clone(),
            stage: "fingerprint".to_string(),
            message: Some(format!(
                "Indexing episode {} of {} ({file_name})…",
                i + 1,
                paths.len()
            )),
        });

        let id = content_fingerprint(&root_str, &path_str)?;
        jobs.push(VideoJob {
            id,
            path: path_str,
            file_name,
            status: "pending".to_string(),
            error: None,
        });
    }

    on_progress(ProjectScanProgress {
        index: total,
        total,
        file_name: String::new(),
        stage: "merge".to_string(),
        message: Some("Updating project manifest…".to_string()),
    });

    disambiguate_video_job_ids(&mut jobs);
    Ok(jobs)
}

fn collect_video_paths(
    root: &Path,
    current: &Path,
    depth: u32,
    paths: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(current).map_err(|e| format!("read_dir_failed:{}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read_entry_failed:{}", e))?;
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str())
                == Some(crate::store::project::DEVOTIONTIME_DIR)
            {
                continue;
            }
            collect_video_paths(root, &path, depth + 1, paths)?;
        } else if is_video_file(&path) {
            paths.push(path);
        }
    }
    Ok(())
}

pub fn new_job_id() -> String {
    Uuid::new_v4().to_string()
}

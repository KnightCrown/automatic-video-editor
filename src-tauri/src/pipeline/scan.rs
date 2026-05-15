use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::audio::ffmpeg::is_video_file;
use crate::store::fingerprint::content_fingerprint;
use crate::types::VideoJob;

const MAX_DEPTH: u32 = 2;

pub fn scan_video_folder(root: &str) -> Result<Vec<VideoJob>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err("project_root_not_found".to_string());
    }

    let mut jobs = Vec::new();
    collect_videos(&root_path, &root_path, 0, &mut jobs)?;
    jobs.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(jobs)
}

fn collect_videos(
    root: &Path,
    current: &Path,
    depth: u32,
    jobs: &mut Vec<VideoJob>,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(current).map_err(|e| format!("read_dir_failed:{}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read_entry_failed:{}", e))?;
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some(crate::store::project::DEVOTIONTIME_DIR) {
                continue;
            }
            collect_videos(root, &path, depth + 1, jobs)?;
        } else if is_video_file(&path) {
            let path_str = path.to_string_lossy().to_string();
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("video")
                .to_string();
            let root_str = root.to_string_lossy().to_string();
            let id = content_fingerprint(&root_str, &path_str)?;
            jobs.push(VideoJob {
                id,
                path: path_str,
                file_name,
                status: "pending".to_string(),
                error: None,
            });
        }
    }
    Ok(())
}

pub fn new_job_id() -> String {
    Uuid::new_v4().to_string()
}

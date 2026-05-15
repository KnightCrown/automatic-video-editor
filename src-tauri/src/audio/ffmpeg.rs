use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};
use tokio::process::Command as TokioCommand;

use crate::types::PipelineProgress;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv", "webm", "m4v"];

pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| VIDEO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Locate ffmpeg.exe / ffmpeg on this machine (GUI apps often have a minimal PATH).
pub fn resolve_ffmpeg_executable() -> Result<PathBuf, String> {
    if let Ok(path) = which::which("ffmpeg") {
        return Ok(path);
    }

    #[cfg(windows)]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files = std::env::var("ProgramFiles").unwrap_or_default();
        let candidates = [
            PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"),
            PathBuf::from(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"),
            PathBuf::from(program_files).join("ffmpeg\\bin\\ffmpeg.exe"),
            PathBuf::from(local_app_data).join("Microsoft\\WinGet\\Links\\ffmpeg.exe"),
        ];
        for path in candidates {
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let candidates = [
            PathBuf::from("/opt/homebrew/bin/ffmpeg"),
            PathBuf::from("/usr/local/bin/ffmpeg"),
            PathBuf::from("/usr/bin/ffmpeg"),
        ];
        for path in candidates {
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    Err(
        "FFmpeg was not found. Install FFmpeg from https://ffmpeg.org/download.html, \
         add it to your system PATH, then fully quit and restart DevotionTime. \
         On Windows you can also install via winget: winget install Gyan.FFmpeg"
            .to_string(),
    )
}

pub fn check_ffmpeg() -> Result<String, String> {
    let path = resolve_ffmpeg_executable()?;
    Ok(path.to_string_lossy().to_string())
}

pub async fn extract_audio_for_transcription(
    app: AppHandle,
    video_path: String,
    output_wav: String,
    job_id: String,
) -> Result<String, String> {
    let input = PathBuf::from(&video_path);
    if !input.is_file() {
        return Err(format!(
            "Video file not found: {}",
            input.display()
        ));
    }
    let output = PathBuf::from(&output_wav);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_cache_dir:{}", e))?;
    }

    let ffmpeg = resolve_ffmpeg_executable()?;

    let _ = app.emit(
        "pipeline_progress",
        PipelineProgress {
            job_id: job_id.clone(),
            stage: "extract".to_string(),
            percent: 5.0,
            message: Some(format!(
                "Extracting audio with FFmpeg ({})…",
                ffmpeg.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("ffmpeg")
            )),
        },
    );

    let output = TokioCommand::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            &video_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            &output_wav,
        ])
        .output()
        .await
        .map_err(|e| {
            format!(
                "Failed to run FFmpeg at {}: {}. \
                 Install FFmpeg and restart the app if you recently added it to PATH.",
                ffmpeg.display(),
                e
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exit code {:?}", output.status.code())
        };
        return Err(format!("FFmpeg failed while extracting audio: {detail}"));
    }

    if !PathBuf::from(&output_wav).is_file() {
        return Err(
            "FFmpeg finished but the output WAV file was not created. Check disk space and write permissions.".to_string(),
        );
    }

    let _ = app.emit(
        "pipeline_progress",
        PipelineProgress {
            job_id,
            stage: "extract".to_string(),
            percent: 100.0,
            message: Some("Audio extraction complete".to_string()),
        },
    );

    Ok(output_wav)
}

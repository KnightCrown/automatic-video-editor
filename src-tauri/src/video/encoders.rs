use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::audio::ffmpeg::{resolve_ffmpeg_executable, resolve_ffprobe_executable};
use crate::types::{VideoExportEncoderInfo, VideoExportEncoderKind, VideoExportPreflight};

static ENCODER_LIST_CACHE: OnceLock<Result<Vec<String>, String>> = OnceLock::new();
static FILTER_LIST_CACHE: OnceLock<Result<Vec<String>, String>> = OnceLock::new();
static PREFLIGHT_CACHE: Mutex<Option<VideoExportPreflight>> = Mutex::new(None);

/// How long a per-encoder smoke encode may run before we treat it as failed (avoids QSV/AMF hangs).
const SMOKE_TEST_TIMEOUT: Duration = Duration::from_secs(12);

fn ffmpeg_encoder_list() -> Result<&'static Vec<String>, String> {
    ENCODER_LIST_CACHE
        .get_or_init(|| {
            let ffmpeg = resolve_ffmpeg_executable()?;
            let output = Command::new(&ffmpeg)
                .args(["-hide_banner", "-encoders"])
                .output()
                .map_err(|e| format!("ffmpeg_encoders_failed:{e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "ffmpeg_encoders_failed:{}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            let text = String::from_utf8_lossy(&output.stdout);
            Ok(text
                .lines()
                .filter_map(|line| {
                    let token = line.split_whitespace().nth(1)?;
                    Some(token.to_string())
                })
                .collect())
        })
        .as_ref()
        .map_err(|e| e.clone())
}

fn ffmpeg_filter_list() -> Result<&'static Vec<String>, String> {
    FILTER_LIST_CACHE
        .get_or_init(|| {
            let ffmpeg = resolve_ffmpeg_executable()?;
            let output = Command::new(&ffmpeg)
                .args(["-hide_banner", "-filters"])
                .output()
                .map_err(|e| format!("ffmpeg_filters_failed:{e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "ffmpeg_filters_failed:{}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            let text = String::from_utf8_lossy(&output.stdout);
            Ok(text
                .lines()
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    parts.last().map(|s| s.to_string())
                })
                .collect())
        })
        .as_ref()
        .map_err(|e| e.clone())
}

fn listed(encoders: &[String], name: &str) -> bool {
    encoders.iter().any(|e| e == name)
}

/// NVENC and other HW encoders reject very small frames (64×64 fails with "minimum supported value").
const SMOKE_TEST_LAVFI_SIZE: &str = "1280x720";

fn smoke_test_encoder(encoder: &str) -> (bool, Option<String>) {
    let ffmpeg = match resolve_ffmpeg_executable() {
        Ok(p) => p,
        Err(e) => return (false, Some(e)),
    };
    let lavfi = format!("color=c=black:s={SMOKE_TEST_LAVFI_SIZE}:d=0.1");
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        lavfi.as_str(),
        "-frames:v",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "null",
        "-c:v",
        encoder,
    ]);
    for arg in encoder_video_args(encoder, false) {
        cmd.arg(arg);
    }
    cmd.arg("-");

    let mut child = match cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (false, Some(e.to_string())),
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return (true, None);
                }
                let mut stderr = String::new();
                if let Some(mut err) = child.stderr.take() {
                    use std::io::Read;
                    let _ = err.read_to_string(&mut stderr);
                }
                let msg = stderr.trim();
                return (
                    false,
                    if msg.is_empty() {
                        Some("smoke test failed".to_string())
                    } else {
                        Some(msg.to_string())
                    },
                );
            }
            Ok(None) => {
                if started.elapsed() > SMOKE_TEST_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return (
                        false,
                        Some(format!(
                            "smoke test timed out after {}s",
                            SMOKE_TEST_TIMEOUT.as_secs()
                        )),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return (false, Some(e.to_string())),
        }
    }
}

/// On Windows, once NVENC passes we skip slow/hanging QSV and AMF probes (common on NVIDIA-only PCs).
fn should_run_smoke_test(kind: VideoExportEncoderKind, nvenc_verified: bool) -> bool {
    #[cfg(windows)]
    {
        if nvenc_verified {
            return !matches!(
                kind,
                VideoExportEncoderKind::Qsv | VideoExportEncoderKind::Amf
            );
        }
    }
    let _ = nvenc_verified;
    true
}

/// Extra encoder flags for lavfi smoke test (minimal).
fn encoder_video_args(encoder: &str, fast: bool) -> Vec<&'static str> {
    match encoder {
        "h264_nvenc" => {
            if fast {
                vec!["-preset", "p1", "-rc", "vbr", "-cq", "28"]
            } else {
                vec!["-preset", "p4", "-rc", "vbr", "-cq", "23"]
            }
        }
        "h264_qsv" => {
            if fast {
                vec!["-preset", "veryfast"]
            } else {
                vec!["-preset", "medium"]
            }
        }
        "h264_amf" => {
            if fast {
                vec!["-quality", "speed"]
            } else {
                vec!["-quality", "balanced"]
            }
        }
        "h264_videotoolbox" => {
            if fast {
                vec!["-q:v", "55"]
            } else {
                vec!["-q:v", "65"]
            }
        }
        _ => {
            if fast {
                vec!["-preset", "veryfast", "-crf", "26"]
            } else {
                vec!["-preset", "fast", "-crf", "23"]
            }
        }
    }
}

pub fn probe_video_duration_sec(video_path: &str) -> Result<f64, String> {
    let ffprobe = resolve_ffprobe_executable()?;
    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            video_path,
        ])
        .output()
        .map_err(|e| format!("ffprobe_duration_failed:{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe_duration_failed:{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    s.parse::<f64>()
        .map_err(|_| format!("invalid_duration:{s}"))
}

/// Returns true when audio can be stream-copied into MP4.
pub fn probe_audio_copy_safe(video_path: &str) -> bool {
    let ffprobe = match resolve_ffprobe_executable() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let output = match Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
            video_path,
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    let codec = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    matches!(
        codec.as_str(),
        "aac" | "mp3" | "mp4a" | "alac" | "flac" | "opus"
    )
}

fn build_video_export_preflight() -> VideoExportPreflight {
    let (ffmpeg_path, ffmpeg_error) = match resolve_ffmpeg_executable() {
        Ok(p) => (Some(p.to_string_lossy().into_owned()), None),
        Err(e) => (None, Some(e)),
    };

    if ffmpeg_path.is_none() {
        return VideoExportPreflight {
            ffmpeg_path,
            ffmpeg_error,
            encoders: vec![],
            recommended_encoder: Some(VideoExportEncoderKind::Software),
            cuda_overlay_available: false,
            overlay_cuda_filter: false,
            scale_cuda_filter: false,
        };
    }

    let encoder_names = ffmpeg_encoder_list().cloned().unwrap_or_default();
    let filters = ffmpeg_filter_list().cloned().unwrap_or_default();
    let overlay_cuda = filters.iter().any(|f| f == "overlay_cuda");
    let scale_cuda = filters.iter().any(|f| f == "scale_cuda");

    let candidates: &[(&str, VideoExportEncoderKind)] = &[
        ("h264_nvenc", VideoExportEncoderKind::Nvenc),
        ("h264_qsv", VideoExportEncoderKind::Qsv),
        ("h264_amf", VideoExportEncoderKind::Amf),
        ("h264_videotoolbox", VideoExportEncoderKind::VideoToolbox),
        ("libx264", VideoExportEncoderKind::Software),
    ];

    let mut encoders: Vec<VideoExportEncoderInfo> = Vec::new();
    let mut nvenc_verified = false;

    // Probe NVENC first so we can skip QSV/AMF on NVIDIA-only Windows boxes.
    for (name, kind) in candidates {
        if *kind != VideoExportEncoderKind::Nvenc {
            continue;
        }
        let is_listed = listed(&encoder_names, name);
        let (verified, error) = if is_listed {
            let (ok, err) = smoke_test_encoder(name);
            if ok {
                nvenc_verified = true;
            }
            (ok, err.filter(|s| !s.is_empty()))
        } else {
            (false, None)
        };
        encoders.push(VideoExportEncoderInfo {
            kind: *kind,
            name: name.to_string(),
            listed: is_listed,
            verified,
            error,
        });
    }

    for (name, kind) in candidates {
        if *kind == VideoExportEncoderKind::Nvenc {
            continue;
        }
        let is_listed = listed(&encoder_names, name);
        let (verified, error) = if is_listed && *kind != VideoExportEncoderKind::Software {
            if should_run_smoke_test(*kind, nvenc_verified) {
                let (ok, err) = smoke_test_encoder(name);
                (ok, err.filter(|s| !s.is_empty()))
            } else {
                (false, Some("Skipped (NVENC available)".to_string()))
            }
        } else if is_listed {
            (true, None)
        } else {
            (false, None)
        };
        encoders.push(VideoExportEncoderInfo {
            kind: *kind,
            name: name.to_string(),
            listed: is_listed,
            verified,
            error,
        });
    }

    let recommended_encoder =
        pick_recommended_hardware(&encoders).or(Some(VideoExportEncoderKind::Software));

    let nvenc_ok = encoders
        .iter()
        .any(|e| e.kind == VideoExportEncoderKind::Nvenc && e.listed && e.verified);
    let cuda_overlay_available = overlay_cuda && scale_cuda && nvenc_ok;

    VideoExportPreflight {
        ffmpeg_path,
        ffmpeg_error,
        encoders,
        recommended_encoder,
        cuda_overlay_available,
        overlay_cuda_filter: overlay_cuda,
        scale_cuda_filter: scale_cuda,
    }
}

/// Cached encoder probe (includes one-time smoke tests). Safe to call from export hot path.
pub fn discover_video_export_capabilities() -> VideoExportPreflight {
    if let Ok(guard) = PREFLIGHT_CACHE.lock() {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }
    let built = build_video_export_preflight();
    if let Ok(mut guard) = PREFLIGHT_CACHE.lock() {
        *guard = Some(built.clone());
    }
    built
}

/// Force a fresh probe (Settings screen). Replaces the session cache.
pub fn refresh_video_export_preflight_cache() -> VideoExportPreflight {
    let built = build_video_export_preflight();
    if let Ok(mut guard) = PREFLIGHT_CACHE.lock() {
        *guard = Some(built.clone());
    }
    built
}

fn pick_recommended_hardware(
    encoders: &[VideoExportEncoderInfo],
) -> Option<VideoExportEncoderKind> {
    #[cfg(target_os = "macos")]
    {
        if let Some(e) = encoders
            .iter()
            .find(|e| e.kind == VideoExportEncoderKind::VideoToolbox && e.listed && e.verified)
        {
            return Some(e.kind);
        }
    }

    #[cfg(windows)]
    {
        for kind in [
            VideoExportEncoderKind::Nvenc,
            VideoExportEncoderKind::Qsv,
            VideoExportEncoderKind::Amf,
        ] {
            if let Some(e) = encoders
                .iter()
                .find(|e| e.kind == kind && e.listed && e.verified)
            {
                return Some(e.kind);
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        for kind in [VideoExportEncoderKind::Nvenc, VideoExportEncoderKind::Qsv] {
            if let Some(e) = encoders
                .iter()
                .find(|e| e.kind == kind && e.listed && e.verified)
            {
                return Some(e.kind);
            }
        }
    }

    None
}

/// First platform-priority encoder that is listed (even if smoke test failed).
fn pick_listed_hardware(encoders: &[VideoExportEncoderInfo]) -> Option<VideoExportEncoderKind> {
    #[cfg(target_os = "macos")]
    {
        if encoders
            .iter()
            .any(|e| e.kind == VideoExportEncoderKind::VideoToolbox && e.listed)
        {
            return Some(VideoExportEncoderKind::VideoToolbox);
        }
    }

    #[cfg(windows)]
    {
        for kind in [
            VideoExportEncoderKind::Nvenc,
            VideoExportEncoderKind::Qsv,
            VideoExportEncoderKind::Amf,
        ] {
            if encoders.iter().any(|e| e.kind == kind && e.listed) {
                return Some(kind);
            }
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        for kind in [VideoExportEncoderKind::Nvenc, VideoExportEncoderKind::Qsv] {
            if encoders.iter().any(|e| e.kind == kind && e.listed) {
                return Some(kind);
            }
        }
    }

    None
}

fn resolve_hardware_encoder(preflight: &VideoExportPreflight) -> VideoExportEncoderKind {
    pick_recommended_hardware(&preflight.encoders)
        .or_else(|| pick_listed_hardware(&preflight.encoders))
        .unwrap_or(VideoExportEncoderKind::Software)
}

pub fn encoder_kind_to_name(kind: VideoExportEncoderKind) -> &'static str {
    match kind {
        VideoExportEncoderKind::Software => "libx264",
        VideoExportEncoderKind::Nvenc => "h264_nvenc",
        VideoExportEncoderKind::Qsv => "h264_qsv",
        VideoExportEncoderKind::Amf => "h264_amf",
        VideoExportEncoderKind::VideoToolbox => "h264_videotoolbox",
    }
}

pub fn resolve_encoder_for_export(
    settings: &crate::types::ProjectSettings,
    preflight: &VideoExportPreflight,
) -> VideoExportEncoderKind {
    let mode = settings.video_export_mode.as_str();
    match mode {
        "software" => VideoExportEncoderKind::Software,
        "hardware" => resolve_hardware_encoder(preflight),
        _ => preflight
            .recommended_encoder
            .unwrap_or(VideoExportEncoderKind::Software),
    }
}

pub fn build_video_encoder_args(kind: VideoExportEncoderKind, fast: bool) -> Vec<String> {
    let name = encoder_kind_to_name(kind);
    let mut args = vec![
        "-c:v".into(),
        name.to_string(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    match kind {
        VideoExportEncoderKind::Nvenc => {
            args.push("-preset".into());
            args.push(if fast { "p1" } else { "p4" }.into());
            args.push("-rc".into());
            args.push("vbr".into());
            args.push("-cq".into());
            args.push(if fast { "28" } else { "23" }.into());
        }
        VideoExportEncoderKind::Qsv => {
            args.push("-preset".into());
            args.push(if fast { "veryfast" } else { "medium" }.into());
        }
        VideoExportEncoderKind::Amf => {
            args.push("-quality".into());
            args.push(if fast { "speed" } else { "balanced" }.into());
        }
        VideoExportEncoderKind::VideoToolbox => {
            args.push("-q:v".into());
            args.push(if fast { "55" } else { "65" }.into());
        }
        VideoExportEncoderKind::Software => {
            args.push("-preset".into());
            args.push(if fast { "veryfast" } else { "fast" }.into());
            args.push("-crf".into());
            args.push(if fast { "26" } else { "23" }.into());
            args.push("-threads".into());
            args.push("0".into());
        }
    }
    args
}

pub fn use_cuda_overlay_path(
    settings: &crate::types::ProjectSettings,
    preflight: &VideoExportPreflight,
    encoder: VideoExportEncoderKind,
) -> bool {
    if !preflight.cuda_overlay_available {
        return false;
    }
    if encoder != VideoExportEncoderKind::Nvenc {
        return false;
    }
    !matches!(settings.video_export_mode.as_str(), "software")
}

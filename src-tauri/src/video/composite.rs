use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;

use crate::audio::ffmpeg::resolve_ffmpeg_executable;
use crate::image::overlay_images::resolve_project_image_absolute_path;
use crate::types::{ProjectSettings, VideoExportEncoderKind, VideoExportProgress, VideoOverlayClip};
use crate::video::encoders::{
    build_video_encoder_args, discover_video_export_capabilities, probe_audio_copy_safe,
    probe_video_duration_sec, resolve_encoder_for_export, use_cuda_overlay_path,
};
use crate::video::export_session::{wait_child_or_cancel, VideoExportController};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExportPathKind {
    CudaOverlay,
    CpuOverlayHw,
    CpuOverlaySw,
}

struct ExportRun {
    #[allow(dead_code)]
    path_kind: ExportPathKind,
    stage: &'static str,
    args: Vec<String>,
    duration_sec: f64,
}

fn probe_video_dimensions(video_path: &str) -> Result<(u32, u32), String> {
    let ffprobe = crate::audio::ffmpeg::resolve_ffprobe_executable()?;
    let output = std::process::Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            video_path,
        ])
        .output()
        .map_err(|e| format!("ffprobe_failed:{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe_dimensions_failed:{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = line.split('x');
    let w: u32 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .ok_or_else(|| format!("invalid_width:{line}"))?;
    let h: u32 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .ok_or_else(|| format!("invalid_height:{line}"))?;
    Ok((w, h))
}

fn ms_to_sec(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

fn clip_opacity_alpha(clip: &VideoOverlayClip) -> f64 {
    (clip.opacity_pct.unwrap_or(100.0) / 100.0).clamp(0.0, 1.0)
}

fn overlay_x_expr(clip: &VideoOverlayClip, margin_x: i32) -> String {
    if clip.layout.anchor == "top-left" {
        margin_x.to_string()
    } else {
        format!("main_w-overlay_w-{margin_x}")
    }
}

fn overlay_input_filter(
    input_idx: usize,
    overlay_w: u32,
    clip: &VideoOverlayClip,
    label: &str,
    upload_cuda: bool,
) -> String {
    let start = ms_to_sec(clip.start_ms);
    let duration = ms_to_sec(clip.duration_ms).max(0.001);
    let fade_dur = duration.min(0.35).min(duration / 2.0);
    let opacity = clip_opacity_alpha(clip);
    let mut filters = vec!["format=rgba".to_string(), format!("scale={overlay_w}:-1")];

    if clip.entrance.as_deref() == Some("fade-in") && fade_dur > 0.0 {
        filters.push(format!("fade=t=in:st=0:d={fade_dur:.3}:alpha=1"));
    }
    if clip.exit.as_deref() == Some("fade-out") && fade_dur > 0.0 {
        let fade_start = (duration - fade_dur).max(0.0);
        filters.push(format!(
            "fade=t=out:st={fade_start:.3}:d={fade_dur:.3}:alpha=1"
        ));
    }

    filters.push(format!("colorchannelmixer=aa={opacity:.3}"));
    filters.push(format!("setpts=PTS+{start:.6}/TB"));
    if upload_cuda {
        filters.push("hwupload_cuda".to_string());
    }

    format!("[{input_idx}:v]{}[{label}]", filters.join(","))
}

fn build_cpu_filter_complex(clips: &[VideoOverlayClip], video_w: u32, video_h: u32) -> String {
    if clips.is_empty() {
        return "[0:v]copy[vout]".to_string();
    }

    let mut filter_parts: Vec<String> = Vec::new();
    let mut last_label = "[0:v]".to_string();

    for (i, clip) in clips.iter().enumerate() {
        let input_idx = i + 1;
        let start = ms_to_sec(clip.start_ms);
        let end = ms_to_sec(clip.start_ms.saturating_add(clip.duration_ms));
        let overlay_w = ((video_w as f64) * (clip.layout.width_pct / 100.0)).round() as u32;
        let margin_x =
            ((video_w as f64) * (clip.layout.margin_x_pct / 100.0)).round() as i32;
        let margin_y =
            ((video_h as f64) * (clip.layout.margin_y_pct / 100.0)).round() as i32;
        let x_expr = overlay_x_expr(clip, margin_x);

        filter_parts.push(overlay_input_filter(
            input_idx,
            overlay_w,
            clip,
            &format!("ov{i}"),
            false,
        ));
        let out_label = if i == clips.len() - 1 {
            "vout".to_string()
        } else {
            format!("v{i}")
        };
        filter_parts.push(format!(
            "{last}[ov{i}]overlay=x={x_expr}:y={margin_y}:enable='between(t,{start},{end})'[{out_label}]",
            last = last_label,
            x_expr = x_expr,
            margin_y = margin_y,
            start = start,
            end = end,
            out_label = out_label
        ));
        last_label = format!("[{out_label}]");
    }

    filter_parts.join(";")
}

fn build_cuda_filter_complex(clips: &[VideoOverlayClip], video_w: u32, video_h: u32) -> String {
    if clips.is_empty() {
        return "[0:v]scale_cuda=format=yuv420p[vout]".to_string();
    }

    let mut parts = vec!["[0:v]scale_cuda=format=yuv420p[base0]".to_string()];
    let mut last = "base0".to_string();

    for (i, clip) in clips.iter().enumerate() {
        let input_idx = i + 1;
        let start = ms_to_sec(clip.start_ms);
        let end = ms_to_sec(clip.start_ms.saturating_add(clip.duration_ms));
        let overlay_w = ((video_w as f64) * (clip.layout.width_pct / 100.0)).round() as u32;
        let margin_x =
            ((video_w as f64) * (clip.layout.margin_x_pct / 100.0)).round() as i32;
        let margin_y =
            ((video_h as f64) * (clip.layout.margin_y_pct / 100.0)).round() as i32;
        let x_expr = overlay_x_expr(clip, margin_x);

        parts.push(overlay_input_filter(
            input_idx,
            overlay_w,
            clip,
            &format!("ov{i}"),
            true,
        ));
        let out = if i == clips.len() - 1 {
            "vout".to_string()
        } else {
            format!("base{}", i + 1)
        };
        parts.push(format!(
            "[{last}][ov{i}]overlay_cuda=x={x_expr}:y={margin_y}:enable='between(t,{start},{end})'[{out}]",
            last = last,
            x_expr = x_expr,
            margin_y = margin_y,
            start = start,
            end = end,
            out = out
        ));
        last = out;
    }

    parts.join(";")
}

fn audio_args(copy_safe: bool) -> Vec<String> {
    if copy_safe {
        vec!["-map".into(), "0:a?".into(), "-c:a".into(), "copy".into()]
    } else {
        vec![
            "-map".into(),
            "0:a?".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]
    }
}

fn push_overlay_inputs(args: &mut Vec<String>, image_paths: &[PathBuf]) {
    for p in image_paths {
        args.push("-loop".into());
        args.push("1".into());
        args.push("-i".into());
        args.push(p.to_string_lossy().into_owned());
    }
}

fn build_export_runs(
    video_path: &str,
    image_paths: &[PathBuf],
    clips: &[VideoOverlayClip],
    video_w: u32,
    video_h: u32,
    output_path: &str,
    settings: &ProjectSettings,
    encoder: VideoExportEncoderKind,
    preflight: &crate::types::VideoExportPreflight,
    audio_copy: bool,
) -> Vec<ExportRun> {
    let fast = settings.video_export_quality == "fast";
    let duration_sec = probe_video_duration_sec(video_path).unwrap_or(1.0).max(0.1);
    let mode = settings.video_export_mode.as_str();
    let mut runs: Vec<ExportRun> = Vec::new();

    let hw_encoder = if encoder == VideoExportEncoderKind::Software {
        None
    } else {
        Some(encoder)
    };

    let try_hw_paths = mode != "software";

    if try_hw_paths && use_cuda_overlay_path(settings, preflight, encoder) && !clips.is_empty() {
        let mut args = vec![
            "-y".into(),
            "-hwaccel".into(),
            "cuda".into(),
            "-hwaccel_output_format".into(),
            "cuda".into(),
            "-i".into(),
            video_path.to_string(),
        ];
        push_overlay_inputs(&mut args, image_paths);
        args.push("-filter_complex".into());
        args.push(build_cuda_filter_complex(clips, video_w, video_h));
        args.push("-map".into());
        args.push("[vout]".into());
        args.extend(audio_args(audio_copy));
        args.extend(build_video_encoder_args(VideoExportEncoderKind::Nvenc, fast));
        args.push("-shortest".into());
        args.push(output_path.to_string());

        runs.push(ExportRun {
            path_kind: ExportPathKind::CudaOverlay,
            stage: "encode_cuda",
            args,
            duration_sec,
        });
    }

    if try_hw_paths {
        if let Some(hw) = hw_encoder {
        let mut args = vec!["-y".into(), "-i".into(), video_path.to_string()];
        push_overlay_inputs(&mut args, image_paths);
        if clips.is_empty() {
            args.push("-map".into());
            args.push("0:v".into());
            args.extend(build_video_encoder_args(hw, fast));
            args.extend(audio_args(audio_copy));
            args.push(output_path.to_string());
        } else {
            args.push("-filter_complex".into());
            args.push(build_cpu_filter_complex(clips, video_w, video_h));
            args.push("-map".into());
            args.push("[vout]".into());
            args.extend(audio_args(audio_copy));
            args.extend(build_video_encoder_args(hw, fast));
            args.push("-shortest".into());
            args.push(output_path.to_string());
        }
        runs.push(ExportRun {
            path_kind: ExportPathKind::CpuOverlayHw,
            stage: "encode_hw",
            args,
            duration_sec,
        });
        }
    }

    let mut args = vec!["-y".into(), "-i".into(), video_path.to_string()];
    push_overlay_inputs(&mut args, image_paths);
    if clips.is_empty() {
        args.push("-map".into());
        args.push("0:v".into());
        args.extend(build_video_encoder_args(VideoExportEncoderKind::Software, fast));
        args.extend(audio_args(audio_copy));
        args.push(output_path.to_string());
    } else {
        args.push("-filter_complex".into());
        args.push(build_cpu_filter_complex(clips, video_w, video_h));
        args.push("-map".into());
        args.push("[vout]".into());
        args.extend(audio_args(audio_copy));
        args.extend(build_video_encoder_args(VideoExportEncoderKind::Software, fast));
        args.push("-shortest".into());
        args.push(output_path.to_string());
    }
    runs.push(ExportRun {
        path_kind: ExportPathKind::CpuOverlaySw,
        stage: "encode_sw",
        args,
        duration_sec,
    });

    runs
}

fn parse_hms_time_token(token: &str) -> Option<f64> {
    let mut parts = token.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Parse `time=HH:MM:SS.xx` or `out_time_ms=N` from an FFmpeg stderr/progress fragment.
fn parse_ffmpeg_progress_sec(fragment: &str) -> Option<f64> {
    if let Some(idx) = fragment.find("out_time_ms=") {
        let rest = &fragment[idx + 12..];
        let num: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        return num.parse::<u64>().ok().map(|ms| ms as f64 / 1_000_000.0);
    }
    let idx = fragment.find("time=")?;
    let rest = &fragment[idx + 5..];
    let token: String = rest
        .chars()
        .take_while(|c| *c != ' ' && *c != '\r' && *c != '\n')
        .collect();
    parse_hms_time_token(&token)
}

fn spawn_ffmpeg_stderr_progress(
    app: AppHandle,
    video_id: String,
    stage: String,
    duration_sec: f64,
    stderr: impl tokio::io::AsyncRead + Unpin + Send + 'static,
) {
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut read_buf = [0u8; 4096];
        let mut carry = String::new();

        let emit = |percent: f32, message: Option<String>| {
            let _ = app.emit(
                "video_export_progress",
                VideoExportProgress {
                    video_id: video_id.clone(),
                    stage: stage.clone(),
                    percent,
                    message,
                },
            );
        };

        loop {
            let n = match stderr.read(&mut read_buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };

            carry.push_str(&String::from_utf8_lossy(&read_buf[..n]));
            let ends_with_sep = carry.ends_with('\r') || carry.ends_with('\n');
            let parts: Vec<String> = carry
                .split(|c| c == '\r' || c == '\n')
                .map(|s| s.to_string())
                .collect();

            let (complete, incomplete) = if ends_with_sep {
                (parts, String::new())
            } else if parts.len() > 1 {
                let inc = parts.last().cloned().unwrap_or_default();
                (parts[..parts.len() - 1].to_vec(), inc)
            } else {
                (Vec::new(), parts.first().cloned().unwrap_or_default())
            };

            carry = incomplete;

            for fragment in &complete {
                if fragment.is_empty() {
                    continue;
                }
                if let Some(t) = parse_ffmpeg_progress_sec(fragment) {
                    let pct = ((t / duration_sec.max(0.1)) * 85.0 + 10.0).clamp(10.0, 95.0) as f32;
                    emit(pct, None);
                }
            }

            if let Some(t) = parse_ffmpeg_progress_sec(&carry) {
                let pct = ((t / duration_sec.max(0.1)) * 85.0 + 10.0).clamp(10.0, 95.0) as f32;
                emit(pct, None);
            }
        }
    });
}

async fn run_ffmpeg_export(
    app: &AppHandle,
    controller: &VideoExportController,
    video_id: &str,
    run: &ExportRun,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg_executable()?;
    let duration_sec = run.duration_sec;

    let emit = |percent: f32, message: Option<String>| {
        let _ = app.emit(
            "video_export_progress",
            VideoExportProgress {
                video_id: video_id.to_string(),
                stage: run.stage.to_string(),
                percent,
                message,
            },
        );
    };

    emit(10.0, Some(format!("Encoding ({})…", run.stage)));

    let mut cmd = TokioCommand::new(&ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-stats_period")
        .arg("0.5")
        .args(&run.args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("ffmpeg_spawn_failed:{e}"))?;

    if let Some(stderr) = child.stderr.take() {
        spawn_ffmpeg_stderr_progress(
            app.clone(),
            video_id.to_string(),
            run.stage.to_string(),
            duration_sec,
            stderr,
        );
    }

    let status = wait_child_or_cancel(controller, video_id, &mut child).await?;

    if !status.success() {
        return Err(format!(
            "FFmpeg export failed during {}. Try Software mode in Settings.",
            run.stage
        ));
    }

    Ok(())
}

pub async fn export_video_with_overlays(
    app: AppHandle,
    controller: &VideoExportController,
    root_path: String,
    settings: ProjectSettings,
    video_path: String,
    video_id: String,
    output_path: String,
    clips: Vec<VideoOverlayClip>,
) -> Result<String, String> {
    let emit = |stage: &str, percent: f32, message: Option<String>| {
        let _ = app.emit(
            "video_export_progress",
            VideoExportProgress {
                video_id: video_id.clone(),
                stage: stage.to_string(),
                percent,
                message,
            },
        );
    };

    controller.begin(&video_id).await;

    let export_result = async {
        emit("prepare", 0.0, Some("Preparing export…".to_string()));
        tokio::task::yield_now().await;

        if !Path::new(&video_path).is_file() {
            return Err(format!("Video file not found: {video_path}"));
        }

        emit("prepare", 1.0, Some("Reading video info…".to_string()));
        let (video_w, video_h) = probe_video_dimensions(&video_path)?;

        emit("prepare", 2.0, Some("Detecting encoders (first run may take a moment)…".to_string()));
        let preflight = tokio::task::spawn_blocking(discover_video_export_capabilities)
            .await
            .map_err(|e| format!("preflight_task_failed:{e}"))?;

        let encoder = resolve_encoder_for_export(&settings, &preflight);
        let audio_copy = probe_audio_copy_safe(&video_path);

        emit("prepare", 4.0, Some("Resolving overlay images…".to_string()));
        let mut image_abs_paths: Vec<PathBuf> = Vec::new();
        for clip in &clips {
            let abs = resolve_project_image_absolute_path(&root_path, &clip.image_relative_path)?;
            image_abs_paths.push(PathBuf::from(abs));
        }

        if let Some(parent) = Path::new(&output_path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create_output_dir_failed:{e}"))?;
            }
        }

        let encoder_label = crate::video::encoders::encoder_kind_to_name(encoder);
        emit(
            "prepare",
            5.0,
            Some(format!(
                "Encoder: {encoder_label} · audio {}",
                if audio_copy { "copy" } else { "AAC" }
            )),
        );

        let runs = build_export_runs(
            &video_path,
            &image_abs_paths,
            &clips,
            video_w,
            video_h,
            &output_path,
            &settings,
            encoder,
            &preflight,
            audio_copy,
        );

        let mut last_err: Option<String> = None;
        for (i, run) in runs.iter().enumerate() {
            if controller.is_cancelled(&video_id).await {
                return Err(VideoExportController::cancelled_error());
            }
            match run_ffmpeg_export(&app, controller, &video_id, run).await {
                Ok(()) => {
                    emit(
                        run.stage,
                        100.0,
                        Some(format!("Export complete ({})", run.stage)),
                    );
                    return Ok(output_path);
                }
                Err(e) => {
                    if e == VideoExportController::cancelled_error() {
                        return Err(e);
                    }
                    last_err = Some(e.clone());
                    if i + 1 < runs.len() {
                        emit(
                            "fallback",
                            0.0,
                            Some(format!("{} failed, trying fallback…", run.stage)),
                        );
                    }
                }
            }
        }

        Err(last_err.unwrap_or_else(|| "Export failed.".to_string()))
    }
    .await;

    if controller.is_cancelled(&video_id).await {
        emit(
            "cancelled",
            0.0,
            Some("Export cancelled.".to_string()),
        );
        controller.end(&video_id).await;
        return Err(VideoExportController::cancelled_error());
    }

    controller.end(&video_id).await;
    export_result
}

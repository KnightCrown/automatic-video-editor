use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;

use crate::audio::ffmpeg::resolve_ffmpeg_executable;
use crate::image::overlay_images::resolve_project_image_absolute_path;
use crate::types::{
    ProjectSettings, TimelineVideoClip, VideoExportEncoderKind, VideoExportProgress,
    VideoOverlayClip,
};
use crate::video::encoders::{
    build_video_encoder_args, discover_video_export_capabilities, probe_audio_copy_safe,
    probe_video_duration_sec, resolve_encoder_for_export, use_cuda_overlay_path,
};
use crate::video::export_session::{wait_child_or_cancel, VideoExportController};
use crate::video::timeline_media::resolve_timeline_media_absolute;

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

fn probe_has_audio_stream(video_path: &Path) -> bool {
    let Ok(ffprobe) = crate::audio::ffmpeg::resolve_ffprobe_executable() else {
        return false;
    };
    let Ok(output) = std::process::Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            video_path.to_string_lossy().as_ref(),
        ])
        .output()
    else {
        return false;
    };
    output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
}

fn ms_to_sec(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

fn is_insert_video_clip(clip: &TimelineVideoClip) -> bool {
    clip.timeline_mode == "insert"
        || clip.render_mode == "insert"
        || matches!(
            clip.placement_kind.as_deref(),
            Some("scheduled_start" | "scheduled_end" | "intro" | "outro")
        )
}

fn shift_clips_for_content_window(
    clips: &mut Vec<VideoOverlayClip>,
    video_clips: &mut Vec<TimelineVideoClip>,
    content_start_ms: u64,
    content_end_ms: u64,
) {
    if content_end_ms <= content_start_ms {
        return;
    }
    clips.retain_mut(|c| {
        if c.start_ms >= content_end_ms
            || c.start_ms.saturating_add(c.duration_ms) <= content_start_ms
        {
            return false;
        }
        c.start_ms = c.start_ms.saturating_sub(content_start_ms);
        true
    });
    video_clips.retain_mut(|c| {
        if is_insert_video_clip(c) {
            return true;
        }
        if c.start_ms >= content_end_ms
            || c.start_ms.saturating_add(c.duration_ms) <= content_start_ms
        {
            return false;
        }
        c.start_ms = c.start_ms.saturating_sub(content_start_ms);
        true
    });
}

#[derive(Clone, Debug)]
struct InsertTimelineOffset {
    insert_at_ms: u64,
    duration_ms: u64,
}

fn effective_video_clip_duration_ms(clip: &TimelineVideoClip) -> u64 {
    let trim_start = clip.trim_start_ms.unwrap_or(0).min(clip.source_duration_ms);
    let available = clip.source_duration_ms.saturating_sub(trim_start);
    clip.duration_ms.min(available).max(1)
}

fn normalized_insert_at_ms(
    clip: &TimelineVideoClip,
    content_start_ms: u64,
    content_end_ms: u64,
) -> u64 {
    if clip.start_ms <= content_start_ms {
        return content_start_ms;
    }
    if clip.start_ms >= content_end_ms {
        return content_end_ms;
    }
    clip.start_ms.clamp(content_start_ms, content_end_ms)
}

fn output_time_for_episode_ms(
    episode_ms: u64,
    content_start_ms: u64,
    offsets: &[InsertTimelineOffset],
) -> u64 {
    let mut out = episode_ms.saturating_sub(content_start_ms);
    for offset in offsets {
        if offset.insert_at_ms <= episode_ms {
            out = out.saturating_add(offset.duration_ms);
        }
    }
    out
}

fn shift_clips_for_inserted_timeline(
    clips: &mut Vec<VideoOverlayClip>,
    video_clips: &mut Vec<TimelineVideoClip>,
    content_start_ms: u64,
    content_end_ms: u64,
    offsets: &[InsertTimelineOffset],
) {
    clips.retain_mut(|c| {
        if c.start_ms >= content_end_ms
            || c.start_ms.saturating_add(c.duration_ms) <= content_start_ms
        {
            return false;
        }
        c.start_ms =
            output_time_for_episode_ms(c.start_ms.max(content_start_ms), content_start_ms, offsets);
        true
    });
    video_clips.retain_mut(|c| {
        if is_insert_video_clip(c) {
            return false;
        }
        if c.start_ms >= content_end_ms
            || c.start_ms.saturating_add(c.duration_ms) <= content_start_ms
        {
            return false;
        }
        c.start_ms =
            output_time_for_episode_ms(c.start_ms.max(content_start_ms), content_start_ms, offsets);
        true
    });
}

fn normalized_segment_filter(video_w: u32, video_h: u32) -> String {
    format!(
        "scale={video_w}:{video_h}:force_original_aspect_ratio=decrease,pad={video_w}:{video_h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
    )
}

fn run_ffmpeg_blocking(ffmpeg: &Path, args: &[String], context: &str) -> Result<(), String> {
    let output = std::process::Command::new(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| format!("{context}_spawn_failed:{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{context}_failed:{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn render_normalized_segment(
    ffmpeg: &Path,
    source: &Path,
    output: &Path,
    asset_kind: &str,
    start_ms: u64,
    duration_ms: u64,
    video_w: u32,
    video_h: u32,
) -> Result<(), String> {
    let filter = normalized_segment_filter(video_w, video_h);
    if asset_kind == "image" {
        let dur = format!("{:.3}", ms_to_sec(duration_ms).max(0.001));
        let args = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-y".to_string(),
            "-loop".to_string(),
            "1".to_string(),
            "-t".to_string(),
            dur.clone(),
            "-i".to_string(),
            source.to_string_lossy().into_owned(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-t".to_string(),
            dur,
            "-i".to_string(),
            "anullsrc=channel_layout=stereo:sample_rate=48000".to_string(),
            "-map".to_string(),
            "0:v".to_string(),
            "-map".to_string(),
            "1:a".to_string(),
            "-vf".to_string(),
            filter,
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "20".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
            "-shortest".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            output.to_string_lossy().into_owned(),
        ];
        return run_ffmpeg_blocking(ffmpeg, &args, "render_insert_image_segment");
    }
    let args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-ss".to_string(),
        format!("{:.3}", ms_to_sec(start_ms)),
        "-t".to_string(),
        format!("{:.3}", ms_to_sec(duration_ms).max(0.001)),
        "-i".to_string(),
        source.to_string_lossy().into_owned(),
        "-vf".to_string(),
        filter,
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "veryfast".to_string(),
        "-crf".to_string(),
        "20".to_string(),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output.to_string_lossy().into_owned(),
    ];
    run_ffmpeg_blocking(ffmpeg, &args, "render_insert_segment")
}

fn concat_list_line(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    format!("file '{escaped}'\n")
}

fn render_concatenated_base_with_inserts(
    ffmpeg: &Path,
    base_video_path: &str,
    insert_clips: &[(TimelineVideoClip, PathBuf)],
    content_start_ms: u64,
    content_end_ms: u64,
    video_w: u32,
    video_h: u32,
    video_id: &str,
) -> Result<(PathBuf, Vec<InsertTimelineOffset>), String> {
    let temp_dir = std::env::temp_dir().join("devotiontime").join(video_id);
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("create_temp_dir_failed:{e}"))?;

    let base_path = Path::new(base_video_path);
    let mut inserts: Vec<(u64, TimelineVideoClip, PathBuf)> = insert_clips
        .iter()
        .map(|(clip, path)| {
            (
                normalized_insert_at_ms(clip, content_start_ms, content_end_ms),
                clip.clone(),
                path.clone(),
            )
        })
        .collect();
    inserts.sort_by_key(|(insert_at, clip, _)| (*insert_at, clip.track_index));

    let mut segment_paths = Vec::new();
    let mut offsets = Vec::new();
    let mut cursor = content_start_ms;
    let mut index = 0usize;

    for (insert_at, clip, path) in inserts {
        if insert_at > cursor {
            let duration = insert_at.saturating_sub(cursor);
            let segment = temp_dir.join(format!("segment-{index:03}-base.mp4"));
            render_normalized_segment(
                ffmpeg, base_path, &segment, "video", cursor, duration, video_w, video_h,
            )?;
            segment_paths.push(segment);
            index += 1;
            cursor = insert_at;
        }

        let duration = effective_video_clip_duration_ms(&clip);
        let segment = temp_dir.join(format!("segment-{index:03}-insert.mp4"));
        render_normalized_segment(
            ffmpeg,
            &path,
            &segment,
            &clip.asset_kind,
            clip.trim_start_ms.unwrap_or(0),
            duration,
            video_w,
            video_h,
        )?;
        segment_paths.push(segment);
        offsets.push(InsertTimelineOffset {
            insert_at_ms: insert_at,
            duration_ms: duration,
        });
        index += 1;
    }

    if content_end_ms > cursor {
        let duration = content_end_ms.saturating_sub(cursor);
        let segment = temp_dir.join(format!("segment-{index:03}-base.mp4"));
        render_normalized_segment(
            ffmpeg, base_path, &segment, "video", cursor, duration, video_w, video_h,
        )?;
        segment_paths.push(segment);
    }

    if segment_paths.is_empty() {
        return Err("insert_concat_no_segments".to_string());
    }

    let list_path = temp_dir.join("concat-list.txt");
    let list_body = segment_paths
        .iter()
        .map(|p| concat_list_line(p))
        .collect::<String>();
    std::fs::write(&list_path, list_body).map_err(|e| format!("write_concat_list_failed:{e}"))?;

    let output = temp_dir.join("base-with-inserts.mp4");
    let args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().into_owned(),
        "-c".to_string(),
        "copy".to_string(),
        output.to_string_lossy().into_owned(),
    ];
    run_ffmpeg_blocking(ffmpeg, &args, "concat_insert_segments")?;

    Ok((output, offsets))
}

fn push_base_video_input(args: &mut Vec<String>, video_path: &str, trim: Option<(f64, f64)>) {
    if let Some((start, end)) = trim {
        args.push("-ss".into());
        args.push(format!("{start:.3}"));
        args.push("-to".into());
        args.push(format!("{end:.3}"));
    }
    args.push("-i".into());
    args.push(video_path.to_string());
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
    build_cpu_filter_complex_on_base(clips, video_w, video_h, "[0:v]", "vout")
}

fn build_cpu_filter_complex_on_base(
    clips: &[VideoOverlayClip],
    video_w: u32,
    video_h: u32,
    base_video_label: &str,
    final_out_label: &str,
) -> String {
    if clips.is_empty() {
        return format!("{base_video_label}copy[{final_out_label}]");
    }

    let mut filter_parts: Vec<String> = Vec::new();
    let mut last_label = base_video_label.to_string();

    for (i, clip) in clips.iter().enumerate() {
        let input_idx = i + 1;
        let start = ms_to_sec(clip.start_ms);
        let end = ms_to_sec(clip.start_ms.saturating_add(clip.duration_ms));
        let overlay_w = ((video_w as f64) * (clip.layout.width_pct / 100.0)).round() as u32;
        let margin_x = ((video_w as f64) * (clip.layout.margin_x_pct / 100.0)).round() as i32;
        let margin_y = ((video_h as f64) * (clip.layout.margin_y_pct / 100.0)).round() as i32;
        let x_expr = overlay_x_expr(clip, margin_x);

        filter_parts.push(overlay_input_filter(
            input_idx,
            overlay_w,
            clip,
            &format!("ov{i}"),
            false,
        ));
        let out_label = if i == clips.len() - 1 {
            final_out_label.to_string()
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

fn extra_video_scale_pct(clip: &TimelineVideoClip) -> f64 {
    clip.scale_pct.unwrap_or(100.0).clamp(12.0, 100.0)
}

fn extra_video_opacity(clip: &TimelineVideoClip) -> f64 {
    (clip.opacity_pct.unwrap_or(100.0) / 100.0).clamp(0.0, 1.0)
}

fn build_extra_video_video_chain(
    video_clips: &[TimelineVideoClip],
    extra_input_start: usize,
    video_w: u32,
    video_h: u32,
    base_video_label: &str,
    final_out_label: &str,
) -> Vec<String> {
    if video_clips.is_empty() {
        return Vec::new();
    }

    let mut sorted: Vec<&TimelineVideoClip> = video_clips.iter().collect();
    sorted.sort_by_key(|c| c.track_index);

    let mut parts: Vec<String> = Vec::new();
    let mut last_label = base_video_label.to_string();

    for (i, clip) in sorted.iter().enumerate() {
        let input_idx = extra_input_start + i;
        let trim_start = ms_to_sec(clip.trim_start_ms.unwrap_or(0));
        let duration = ms_to_sec(clip.duration_ms).max(0.001);
        let start = ms_to_sec(clip.start_ms);
        let end = ms_to_sec(clip.start_ms.saturating_add(clip.duration_ms));
        let scale_pct = extra_video_scale_pct(clip);
        let opacity = extra_video_opacity(clip);
        let prep = format!("vclip{i}");
        let center_x = clip.center_x_pct.unwrap_or(50.0).clamp(0.0, 100.0);
        let center_y = clip.center_y_pct.unwrap_or(50.0).clamp(0.0, 100.0);
        let (overlay_x, overlay_y) = if scale_pct >= 99.5 {
            ("0".to_string(), "0".to_string())
        } else {
            (
                format!("(main_w*{center_x}/100-overlay_w/2)"),
                format!("(main_h*{center_y}/100-overlay_h/2)"),
            )
        };

        if scale_pct >= 99.5 {
            parts.push(format!(
                "[{input_idx}:v]trim=start={trim_start}:duration={duration},setpts=PTS-STARTPTS,scale={video_w}:{video_h}:force_original_aspect_ratio=decrease,pad={video_w}:{video_h}:(ow-iw)/2:(oh-ih)/2,format=rgba,colorchannelmixer=aa={opacity:.3},setpts=PTS+{start}/TB[{prep}]"
            ));
        } else {
            let overlay_w = ((video_w as f64) * (scale_pct / 100.0)).round().max(1.0) as u32;
            parts.push(format!(
                "[{input_idx}:v]trim=start={trim_start}:duration={duration},setpts=PTS-STARTPTS,scale={overlay_w}:-1,format=rgba,colorchannelmixer=aa={opacity:.3},setpts=PTS+{start}/TB[{prep}]"
            ));
        }

        let out = if i == sorted.len() - 1 {
            final_out_label.to_string()
        } else {
            format!("vb{i}")
        };
        parts.push(format!(
            "{last}[{prep}]overlay=x={overlay_x}:y={overlay_y}:enable='between(t,{start},{end})'[{out}]",
            last = last_label,
            prep = prep,
            overlay_x = overlay_x,
            overlay_y = overlay_y,
            start = start,
            end = end,
            out = out,
        ));
        last_label = format!("[{out}]");
    }

    parts
}

fn extra_video_volume(clip: &TimelineVideoClip) -> f64 {
    (clip.volume_pct.unwrap_or(100.0) / 100.0).clamp(0.0, 2.0)
}

fn build_extra_video_audio_chain(
    video_clips: &[TimelineVideoClip],
    extra_input_start: usize,
    extra_has_audio: &[bool],
    base_has_audio: bool,
    total_duration_sec: f64,
) -> Option<String> {
    let audio_clips: Vec<(usize, &TimelineVideoClip)> = video_clips
        .iter()
        .enumerate()
        .filter(|(i, clip)| {
            extra_has_audio.get(*i).copied().unwrap_or(false) && extra_video_volume(clip) > 0.0
        })
        .collect();
    if audio_clips.is_empty() {
        return None;
    }

    let total_duration_sec = total_duration_sec.max(0.1);
    let mut parts = if base_has_audio {
        vec!["[0:a]aresample=48000,aformat=channel_layouts=stereo[abase]".to_string()]
    } else {
        vec![format!(
            "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={total_duration_sec:.3},asetpts=PTS-STARTPTS[abase]"
        )]
    };
    let mut inputs = vec!["[abase]".to_string()];

    for (audio_i, (clip_i, clip)) in audio_clips.iter().enumerate() {
        let input_idx = extra_input_start + *clip_i;
        let trim_start = ms_to_sec(clip.trim_start_ms.unwrap_or(0));
        let duration = ms_to_sec(clip.duration_ms).max(0.001);
        let delay = clip.start_ms;
        let volume = extra_video_volume(clip);
        let label = format!("aud{audio_i}");
        // Do not use apad without whole_dur — infinite padding makes amix hang near EOF.
        parts.push(format!(
            "[{input_idx}:a]atrim=start={trim_start}:duration={duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={volume:.3},adelay={delay}|{delay}[{label}]"
        ));
        inputs.push(format!("[{label}]"));
    }

    parts.push(format!(
        "{}amix=inputs={}:duration=first:dropout_transition=0[aout]",
        inputs.join(""),
        inputs.len()
    ));
    Some(parts.join(";"))
}

fn build_full_cpu_filter_complex(
    overlay_clips: &[VideoOverlayClip],
    video_clips: &[TimelineVideoClip],
    _overlay_input_start: usize,
    extra_input_start: usize,
    video_w: u32,
    video_h: u32,
    extra_has_audio: &[bool],
    base_has_audio: bool,
    total_duration_sec: f64,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    let layer_after_overlays = if overlay_clips.is_empty() {
        "[0:v]".to_string()
    } else {
        let overlay_out = if video_clips.is_empty() {
            "vout"
        } else {
            "voverlays"
        };
        parts.push(build_cpu_filter_complex_on_base(
            overlay_clips,
            video_w,
            video_h,
            "[0:v]",
            overlay_out,
        ));
        format!("[{overlay_out}]")
    };

    if !video_clips.is_empty() {
        parts.extend(build_extra_video_video_chain(
            video_clips,
            extra_input_start,
            video_w,
            video_h,
            &layer_after_overlays,
            "vout",
        ));
    }

    if let Some(audio_chain) = build_extra_video_audio_chain(
        video_clips,
        extra_input_start,
        extra_has_audio,
        base_has_audio,
        total_duration_sec,
    ) {
        parts.push(audio_chain);
    }

    if parts.is_empty() {
        return "[0:v]copy[vout]".to_string();
    }

    parts.join(";")
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
        let margin_x = ((video_w as f64) * (clip.layout.margin_x_pct / 100.0)).round() as i32;
        let margin_y = ((video_h as f64) * (clip.layout.margin_y_pct / 100.0)).round() as i32;
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

fn filtered_audio_args() -> Vec<String> {
    vec![
        "-map".into(),
        "[aout]".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
    ]
}

fn push_overlay_inputs(args: &mut Vec<String>, image_paths: &[PathBuf]) {
    for p in image_paths {
        args.push("-loop".into());
        args.push("1".into());
        args.push("-i".into());
        args.push(p.to_string_lossy().into_owned());
    }
}

fn push_video_clip_inputs(
    args: &mut Vec<String>,
    video_clips: &[TimelineVideoClip],
    video_paths: &[PathBuf],
) {
    for (clip, p) in video_clips.iter().zip(video_paths.iter()) {
        if clip.asset_kind == "image" {
            args.push("-loop".into());
            args.push("1".into());
            args.push("-t".into());
            args.push(format!("{:.3}", ms_to_sec(clip.duration_ms).max(0.001)));
        }
        args.push("-i".into());
        args.push(p.to_string_lossy().into_owned());
    }
}

fn needs_filter_complex(clips: &[VideoOverlayClip], video_clips: &[TimelineVideoClip]) -> bool {
    !clips.is_empty() || !video_clips.is_empty()
}

fn build_export_runs(
    video_path: &str,
    image_paths: &[PathBuf],
    extra_video_paths: &[PathBuf],
    clips: &[VideoOverlayClip],
    video_clips: &[TimelineVideoClip],
    video_w: u32,
    video_h: u32,
    output_path: &str,
    settings: &ProjectSettings,
    encoder: VideoExportEncoderKind,
    preflight: &crate::types::VideoExportPreflight,
    audio_copy: bool,
    content_trim: Option<(f64, f64)>,
) -> Vec<ExportRun> {
    let fast = settings.video_export_quality == "fast";
    let duration_sec = match content_trim {
        Some((start, end)) => (end - start).max(0.1),
        None => probe_video_duration_sec(video_path).unwrap_or(1.0).max(0.1),
    };
    let mode = settings.video_export_mode.as_str();
    let mut runs: Vec<ExportRun> = Vec::new();
    let overlay_input_start = 1usize;
    let extra_input_start = 1 + image_paths.len();
    let use_filters = needs_filter_complex(clips, video_clips);
    let extra_has_audio: Vec<bool> = extra_video_paths
        .iter()
        .map(|path| probe_has_audio_stream(path))
        .collect();
    let has_extra_audio = extra_has_audio.iter().any(|has_audio| *has_audio);
    let base_has_audio = probe_has_audio_stream(Path::new(video_path));

    let hw_encoder = if encoder == VideoExportEncoderKind::Software {
        None
    } else {
        Some(encoder)
    };

    let try_hw_paths = mode != "software";

    if try_hw_paths
        && use_cuda_overlay_path(settings, preflight, encoder)
        && !clips.is_empty()
        && video_clips.is_empty()
    {
        let mut args = vec![
            "-y".into(),
            "-hwaccel".into(),
            "cuda".into(),
            "-hwaccel_output_format".into(),
            "cuda".into(),
        ];
        push_base_video_input(&mut args, video_path, content_trim);
        push_overlay_inputs(&mut args, image_paths);
        args.push("-filter_complex".into());
        args.push(build_cuda_filter_complex(clips, video_w, video_h));
        args.push("-map".into());
        args.push("[vout]".into());
        args.extend(audio_args(audio_copy));
        args.extend(build_video_encoder_args(
            VideoExportEncoderKind::Nvenc,
            fast,
        ));
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
            let mut args = vec!["-y".into()];
            push_base_video_input(&mut args, video_path, content_trim);
            push_overlay_inputs(&mut args, image_paths);
            push_video_clip_inputs(&mut args, video_clips, extra_video_paths);
            if !use_filters {
                args.push("-map".into());
                args.push("0:v".into());
                args.extend(build_video_encoder_args(hw, fast));
                args.extend(audio_args(audio_copy));
                args.push(output_path.to_string());
            } else {
                let video_filter = build_full_cpu_filter_complex(
                    clips,
                    video_clips,
                    overlay_input_start,
                    extra_input_start,
                    video_w,
                    video_h,
                    &extra_has_audio,
                    base_has_audio,
                    duration_sec,
                );
                args.push("-filter_complex".into());
                args.push(video_filter);
                args.push("-map".into());
                args.push("[vout]".into());
                if has_extra_audio {
                    args.extend(filtered_audio_args());
                } else {
                    args.extend(audio_args(audio_copy));
                }
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

    let mut args = vec!["-y".into()];
    push_base_video_input(&mut args, video_path, content_trim);
    push_overlay_inputs(&mut args, image_paths);
    push_video_clip_inputs(&mut args, video_clips, extra_video_paths);
    if !use_filters {
        args.push("-map".into());
        args.push("0:v".into());
        args.extend(build_video_encoder_args(
            VideoExportEncoderKind::Software,
            fast,
        ));
        args.extend(audio_args(audio_copy));
        args.push(output_path.to_string());
    } else {
        let video_filter = build_full_cpu_filter_complex(
            clips,
            video_clips,
            overlay_input_start,
            extra_input_start,
            video_w,
            video_h,
            &extra_has_audio,
            base_has_audio,
            duration_sec,
        );
        args.push("-filter_complex".into());
        args.push(video_filter);
        args.push("-map".into());
        args.push("[vout]".into());
        if has_extra_audio {
            args.extend(filtered_audio_args());
        } else {
            args.extend(audio_args(audio_copy));
        }
        args.extend(build_video_encoder_args(
            VideoExportEncoderKind::Software,
            fast,
        ));
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
        let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
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
                if fragment.contains("progress=end") {
                    emit(99.0, Some("Finalizing export…".to_string()));
                    continue;
                }
                if let Some(t) = parse_ffmpeg_progress_sec(fragment) {
                    let pct = ((t / duration_sec.max(0.1)) * 88.0 + 10.0).clamp(10.0, 98.0) as f32;
                    emit(pct, None);
                }
            }

            if carry.contains("progress=end") {
                emit(99.0, Some("Finalizing export…".to_string()));
            } else if let Some(t) = parse_ffmpeg_progress_sec(&carry) {
                let pct = ((t / duration_sec.max(0.1)) * 88.0 + 10.0).clamp(10.0, 98.0) as f32;
                emit(pct, None);
            }
        }

        emit(99.0, Some("Finalizing export…".to_string()));
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
        .arg("-max_muxing_queue_size")
        .arg("1024")
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

    emit(100.0, Some(format!("Encoding complete ({})", run.stage)));

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
    video_clips: Vec<TimelineVideoClip>,
    content_start_ms: Option<u64>,
    content_end_ms: Option<u64>,
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

    let mut clips = clips;
    let mut video_clips = video_clips;
    video_clips.sort_by_key(|c| c.track_index);

    let content_window_ms = match (content_start_ms, content_end_ms) {
        (Some(start), Some(end)) if end > start => Some((start, end)),
        _ => None,
    };

    let export_result = async {
        emit("prepare", 0.0, Some("Preparing export…".to_string()));
        tokio::task::yield_now().await;

        if !Path::new(&video_path).is_file() {
            return Err(format!("Video file not found: {video_path}"));
        }

        emit("prepare", 1.0, Some("Reading video info…".to_string()));
        let (video_w, video_h) = probe_video_dimensions(&video_path)?;
        let original_duration_ms = probe_video_duration_sec(&video_path)
            .map(|s| (s * 1000.0).round().max(1.0) as u64)
            .unwrap_or_else(|_| {
                clips
                    .iter()
                    .map(|c| c.start_ms.saturating_add(c.duration_ms))
                    .chain(
                        video_clips
                            .iter()
                            .map(|c| c.start_ms.saturating_add(c.duration_ms)),
                    )
                    .max()
                    .unwrap_or(1)
            });
        let mut export_video_path = video_path.clone();
        let mut content_trim =
            content_window_ms.map(|(start, end)| (ms_to_sec(start), ms_to_sec(end)));

        emit(
            "prepare",
            2.0,
            Some("Detecting encoders (first run may take a moment)…".to_string()),
        );
        let preflight = tokio::task::spawn_blocking(discover_video_export_capabilities)
            .await
            .map_err(|e| format!("preflight_task_failed:{e}"))?;

        let encoder = resolve_encoder_for_export(&settings, &preflight);
        let ffmpeg = resolve_ffmpeg_executable()?;

        let mut insert_video_clips: Vec<(TimelineVideoClip, PathBuf)> = Vec::new();
        let mut overlay_video_clips: Vec<TimelineVideoClip> = Vec::new();
        for clip in video_clips {
            let abs = resolve_timeline_media_absolute(&root_path, &clip.source_relative_path)?;
            if !abs.is_file() {
                return Err(format!("Timeline video not found: {}", clip.file_name));
            }
            if is_insert_video_clip(&clip) {
                insert_video_clips.push((clip, abs));
            } else {
                overlay_video_clips.push(clip);
            }
        }

        if !insert_video_clips.is_empty() {
            let (content_start, content_end) =
                content_window_ms.unwrap_or((0, original_duration_ms));
            let content_end = content_end.min(original_duration_ms).max(content_start);
            emit(
                "prepare",
                3.0,
                Some("Building inserted asset sequence…".to_string()),
            );
            let (concatenated, offsets) = render_concatenated_base_with_inserts(
                &ffmpeg,
                &video_path,
                &insert_video_clips,
                content_start,
                content_end,
                video_w,
                video_h,
                &video_id,
            )?;
            shift_clips_for_inserted_timeline(
                &mut clips,
                &mut overlay_video_clips,
                content_start,
                content_end,
                &offsets,
            );
            export_video_path = concatenated.to_string_lossy().into_owned();
            content_trim = None;
        } else if let Some((content_start, content_end)) = content_window_ms {
            let content_end = content_end.min(original_duration_ms).max(content_start);
            shift_clips_for_content_window(
                &mut clips,
                &mut overlay_video_clips,
                content_start,
                content_end,
            );
            content_trim = Some((ms_to_sec(content_start), ms_to_sec(content_end)));
        }

        let audio_copy = probe_audio_copy_safe(&export_video_path);

        emit(
            "prepare",
            4.0,
            Some("Resolving overlay images…".to_string()),
        );
        let mut image_abs_paths: Vec<PathBuf> = Vec::new();
        for clip in &clips {
            let abs = resolve_project_image_absolute_path(&root_path, &clip.image_relative_path)?;
            image_abs_paths.push(PathBuf::from(abs));
        }

        let mut extra_video_paths: Vec<PathBuf> = Vec::new();
        for clip in &overlay_video_clips {
            let abs = resolve_timeline_media_absolute(&root_path, &clip.source_relative_path)?;
            if !abs.is_file() {
                return Err(format!("Timeline video not found: {}", clip.file_name));
            }
            extra_video_paths.push(abs);
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
            &export_video_path,
            &image_abs_paths,
            &extra_video_paths,
            &clips,
            &overlay_video_clips,
            video_w,
            video_h,
            &output_path,
            &settings,
            encoder,
            &preflight,
            audio_copy,
            content_trim,
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
        emit("cancelled", 0.0, Some("Export cancelled.".to_string()));
        controller.end(&video_id).await;
        return Err(VideoExportController::cancelled_error());
    }

    controller.end(&video_id).await;
    export_result
}

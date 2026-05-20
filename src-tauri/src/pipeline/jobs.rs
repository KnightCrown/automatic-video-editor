use tauri::{AppHandle, Emitter};

use crate::asr::parakeet::transcribe_wav;
use crate::asr::{download_parakeet_model, parakeet_model_ready};
use crate::audio::ffmpeg::extract_audio_for_transcription;
use crate::audio::waveform::generate_and_save_waveform_from_transcription_wav;
use crate::pipeline::scan::scan_video_folder;
use crate::store::project::{
    ensure_project_dirs, has_transcript_for_video, load_project, project_paths, save_project,
    save_transcript, sync_videos_in_manifest, transcription_audio_path,
};
use crate::types::{PipelineProgress, ProjectManifest, VideoJob};

pub async fn run_transcription_pipeline(
    app: AppHandle,
    project_root: String,
) -> Result<ProjectManifest, String> {
    if !parakeet_model_ready(&app)? {
        return Err("parakeet_model_not_ready".to_string());
    }

    let videos = scan_video_folder(&project_root)?;
    let mut manifest = sync_videos_in_manifest(&project_root, videos)?;
    let paths = project_paths(&project_root)?;
    ensure_project_dirs(&paths)?;
    let mut episode_total = 0u32;
    for video in &manifest.videos {
        if !has_transcript_for_video(&paths, &video.id, &video.path)? {
            episode_total += 1;
        }
    }

    let mut episode_index = 0u32;
    let video_count = manifest.videos.len();
    for index in 0..video_count {
        let video = manifest.videos[index].clone();
        let job_id = video.id.clone();

        if has_transcript_for_video(&paths, &video.id, &video.path)? {
            manifest.videos[index].status = "transcribed".to_string();
            manifest.videos[index].error = None;
            let _ = save_project(&manifest);
            let _ = app.emit(
                "pipeline_progress",
                PipelineProgress {
                    job_id: job_id.clone(),
                    stage: "skipped".to_string(),
                    percent: 100.0,
                    message: Some(format!("Already transcribed — {}", video.file_name)),
                    episode_index: None,
                    episode_total: Some(episode_total),
                },
            );
            continue;
        }

        episode_index += 1;
        let batch = (episode_index, episode_total);

        manifest.videos[index].status = "processing".to_string();
        manifest.videos[index].error = None;
        let _ = save_project(&manifest);

        let _ = app.emit(
            "pipeline_progress",
            PipelineProgress {
                job_id: job_id.clone(),
                stage: "episode".to_string(),
                percent: ((episode_index.saturating_sub(1)) as f32 / episode_total.max(1) as f32)
                    * 100.0,
                message: Some(format!(
                    "Episode {} of {} — {}",
                    episode_index, episode_total, video.file_name
                )),
                episode_index: Some(episode_index),
                episode_total: Some(episode_total),
            },
        );

        let result =
            process_single_video(app.clone(), &project_root, &video, job_id, Some(batch)).await;

        match result {
            Ok(()) => {
                manifest.videos[index].status = "transcribed".to_string();
                manifest.videos[index].error = None;
            }
            Err(err) => {
                manifest.videos[index].status = "failed".to_string();
                manifest.videos[index].error = Some(err);
            }
        }
        let _ = save_project(&manifest);
    }

    manifest = load_project(&project_root)?;
    Ok(manifest)
}

pub async fn process_single_video(
    app: AppHandle,
    project_root: &str,
    video: &VideoJob,
    job_id: String,
    batch: Option<(u32, u32)>,
) -> Result<(), String> {
    let paths = project_paths(project_root)?;
    let manifest = load_project(project_root)?;
    let transcript_timing_offset_ms = manifest.settings.transcript_timing_offset_ms;

    let (episode_index, episode_total) = match batch {
        Some((i, t)) => (Some(i), Some(t)),
        None => (None, None),
    };

    if has_transcript_for_video(&paths, &video.id, &video.path)? {
        let _ = app.emit(
            "pipeline_progress",
            PipelineProgress {
                job_id: job_id.clone(),
                stage: "done".to_string(),
                percent: 100.0,
                message: Some(format!("Using saved transcript for {}", video.file_name)),
                episode_index,
                episode_total,
            },
        );
        return Ok(());
    }

    let wav_path = transcription_audio_path(&paths, &video.id)?
        .to_string_lossy()
        .into_owned();

    let _ = app.emit(
        "pipeline_progress",
        PipelineProgress {
            job_id: job_id.clone(),
            stage: "start".to_string(),
            percent: 0.0,
            message: Some(format!("Processing {}", video.file_name)),
            episode_index,
            episode_total,
        },
    );

    extract_audio_for_transcription(
        app.clone(),
        video.path.clone(),
        wav_path.clone(),
        job_id.clone(),
        batch,
    )
    .await
    .map_err(|e| format!("[Audio extraction] {e}"))?;

    let _ = app.emit(
        "pipeline_progress",
        PipelineProgress {
            job_id: job_id.clone(),
            stage: "transcribe".to_string(),
            percent: 40.0,
            message: Some("Transcribing with Parakeet…".to_string()),
            episode_index,
            episode_total,
        },
    );

    let transcript = transcribe_wav(
        &app,
        &job_id,
        &wav_path,
        &video.id,
        &video.path,
        transcript_timing_offset_ms,
        batch,
    )
    .map_err(|e| format!("[Speech recognition] {e}"))?;
    save_transcript(&paths, &transcript).map_err(|e| format!("[Save transcript] {e}"))?;

    let _ = generate_and_save_waveform_from_transcription_wav(
        project_root,
        &video.id,
        &video.path,
        &wav_path,
    );

    let _ = app.emit(
        "pipeline_progress",
        PipelineProgress {
            job_id,
            stage: "done".to_string(),
            percent: 100.0,
            message: Some("Complete".to_string()),
            episode_index,
            episode_total,
        },
    );

    Ok(())
}

pub async fn ensure_model_and_run(
    app: AppHandle,
    project_root: String,
    auto_download: bool,
) -> Result<ProjectManifest, String> {
    if !parakeet_model_ready(&app)? {
        if auto_download {
            download_parakeet_model(app.clone()).await?;
        } else {
            return Err("parakeet_model_not_ready".to_string());
        }
    }
    run_transcription_pipeline(app, project_root).await
}

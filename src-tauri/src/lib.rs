mod asr;
mod audio;
#[allow(dead_code)]
mod image;
mod llm;
mod pipeline;
mod store;
mod types;
mod video;

use crate::asr::{
    default_model_files, delete_parakeet_model, download_parakeet_model, invalidate_transcriber,
    missing_parakeet_files, parakeet_model_ready, ParakeetModelFile,
};
use crate::audio::ffmpeg::check_ffmpeg;
use crate::llm::openai::{
    analyze_transcript_for_overlays, api_key_storage_hint, clear_openai_api_key,
    has_openai_api_key, save_openai_api_key,
};
use crate::image::overlay_images;
use crate::pipeline::jobs::ensure_model_and_run;
use crate::pipeline::scan::scan_video_folder;
use crate::store::project::{
    load_overlay_images_manifest_for_video, load_project, load_transcript,
    load_transcript_analysis_for_video, load_transcript_for_video, project_paths,
    save_final_video_timeline,
    refresh_video_statuses_in_manifest, save_project, save_transcript_analysis,
    set_video_pipeline_status, sync_videos_in_manifest,
};
use crate::video::composite::export_video_with_overlays;
use crate::video::export_session::VideoExportController;
use crate::video::timeline::{build_default_timeline, resolve_final_video_timeline};
use crate::store::secrets::{
    clear_xai_api_key, has_xai_api_key, save_xai_api_key, xai_api_key_storage_hint,
};
use crate::types::{
    FinalVideoTimeline, OverlayImagesManifest, ProjectManifest, ProjectSettings, Transcript,
    TranscriptAnalysis, TranscriptionPreflight, VideoExportPreflight,
};
use crate::video::encoders::refresh_video_export_preflight_cache;
use tauri::Manager;

/// Preferred minimum window size (logical px); clamped to the current monitor in setup.
const PREFERRED_MIN_WIDTH: f64 = 1024.0;
const PREFERRED_MIN_HEIGHT: f64 = 600.0;
const ABSOLUTE_MIN_WIDTH: f64 = 800.0;
const ABSOLUTE_MIN_HEIGHT: f64 = 500.0;
const WINDOW_CHROME_MARGIN: f64 = 48.0;

fn work_area_logical(monitor: &tauri::Monitor) -> (f64, f64) {
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let w = area.size.width as f64 / scale;
    let h = area.size.height as f64 / scale;
    (w, h)
}

fn apply_window_size_limits(window: &tauri::WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());

    let (work_w, work_h) = monitor
        .as_ref()
        .map(work_area_logical)
        .unwrap_or((PREFERRED_MIN_WIDTH + WINDOW_CHROME_MARGIN, PREFERRED_MIN_HEIGHT + WINDOW_CHROME_MARGIN));

    let max_w = (work_w - WINDOW_CHROME_MARGIN).max(ABSOLUTE_MIN_WIDTH);
    let max_h = (work_h - WINDOW_CHROME_MARGIN).max(ABSOLUTE_MIN_HEIGHT);

    let min_w = PREFERRED_MIN_WIDTH.min(max_w).max(ABSOLUTE_MIN_WIDTH.min(max_w));
    let min_h = PREFERRED_MIN_HEIGHT
        .min(max_h)
        .max(ABSOLUTE_MIN_HEIGHT.min(max_h));

    let _ = window.set_min_size(Some(tauri::LogicalSize::new(min_w, min_h)));

    if let Ok(size) = window.inner_size() {
        let scale = window.scale_factor().unwrap_or(1.0);
        let logical = size.to_logical::<f64>(scale);
        if logical.width > max_w || logical.height > max_h {
            let _ = window.set_size(tauri::LogicalSize::new(
                logical.width.min(max_w),
                logical.height.min(max_h),
            ));
        }
    }
}

#[tauri::command]
fn get_parakeet_model_info() -> Vec<ParakeetModelFile> {
    default_model_files()
}

#[tauri::command]
async fn check_parakeet_model_ready(app: tauri::AppHandle) -> Result<bool, String> {
    parakeet_model_ready(&app)
}

#[tauri::command]
async fn download_parakeet_model_cmd(app: tauri::AppHandle) -> Result<String, String> {
    let path = download_parakeet_model(app.clone()).await?;
    invalidate_transcriber();
    Ok(path)
}

#[tauri::command]
fn delete_parakeet_model_cmd(app: tauri::AppHandle) -> Result<(), String> {
    delete_parakeet_model(&app)?;
    invalidate_transcriber();
    Ok(())
}

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    save_openai_api_key(&api_key)
}

#[tauri::command]
fn clear_api_key() -> Result<(), String> {
    clear_openai_api_key()
}

#[tauri::command]
fn check_api_key_set() -> bool {
    has_openai_api_key()
}

#[tauri::command]
fn get_api_key_storage_hint() -> Option<String> {
    api_key_storage_hint().map(str::to_string)
}

#[tauri::command]
fn save_xai_api_key_cmd(api_key: String) -> Result<(), String> {
    save_xai_api_key(&api_key)
}

#[tauri::command]
fn clear_xai_api_key_cmd() -> Result<(), String> {
    clear_xai_api_key()
}

#[tauri::command]
fn check_xai_api_key_set() -> bool {
    has_xai_api_key()
}

#[tauri::command]
fn get_xai_api_key_storage_hint() -> Option<String> {
    xai_api_key_storage_hint().map(str::to_string)
}

#[tauri::command]
async fn generate_overlay_images(
    app: tauri::AppHandle,
    root_path: String,
    video_id: String,
    suggestion_ids: Vec<String>,
) -> Result<OverlayImagesManifest, String> {
    let manifest = load_project(&root_path)?;
    overlay_images::generate_overlay_images_for_video(
        &app,
        root_path,
        video_id,
        suggestion_ids,
        &manifest.settings,
    )
    .await
}

#[tauri::command]
async fn regenerate_overlay_image(
    app: tauri::AppHandle,
    root_path: String,
    video_id: String,
    suggestion_id: String,
) -> Result<OverlayImagesManifest, String> {
    let manifest = load_project(&root_path)?;
    overlay_images::regenerate_overlay_image_for_video(
        &app,
        root_path,
        video_id,
        suggestion_id,
        &manifest.settings,
    )
    .await
}

#[tauri::command]
fn get_overlay_images_manifest(
    root_path: String,
    video_id: String,
) -> Result<Option<OverlayImagesManifest>, String> {
    let paths = project_paths(&root_path)?;
    let video_path = load_project(&root_path)?
        .videos
        .into_iter()
        .find(|v| v.id == video_id)
        .map(|v| v.path)
        .unwrap_or_default();
    load_overlay_images_manifest_for_video(&paths, &video_id, &video_path)
}

#[tauri::command]
fn resolve_overlay_image_path(root_path: String, relative_path: String) -> Result<String, String> {
    overlay_images::resolve_project_image_absolute_path(&root_path, &relative_path)
}

#[tauri::command]
fn read_overlay_image_data_url(
    root_path: String,
    relative_path: String,
) -> Result<String, String> {
    overlay_images::read_project_image_data_url(&root_path, &relative_path)
}

#[tauri::command]
fn open_project(root_path: String) -> Result<ProjectManifest, String> {
    let videos = scan_video_folder(&root_path)?;
    sync_videos_in_manifest(&root_path, videos)
}

#[tauri::command]
fn get_project(root_path: String) -> Result<ProjectManifest, String> {
    refresh_video_statuses_in_manifest(&root_path)
}

#[tauri::command]
fn update_project_settings(
    root_path: String,
    settings: ProjectSettings,
) -> Result<ProjectManifest, String> {
    let mut manifest = load_project(&root_path)?;
    manifest.settings = settings;
    save_project(&manifest)?;
    Ok(manifest)
}

#[tauri::command]
async fn run_transcription(
    app: tauri::AppHandle,
    root_path: String,
    auto_download_model: bool,
) -> Result<ProjectManifest, String> {
    ensure_model_and_run(app, root_path, auto_download_model).await
}

#[tauri::command]
async fn retry_video_transcription(
    app: tauri::AppHandle,
    root_path: String,
    video_id: String,
) -> Result<ProjectManifest, String> {
    if !parakeet_model_ready(&app)? {
        return Err("parakeet_model_not_ready".to_string());
    }
    let mut manifest = load_project(&root_path)?;
    let video = manifest
        .videos
        .iter()
        .find(|v| v.id == video_id)
        .cloned()
        .ok_or_else(|| "video_not_found".to_string())?;

    if let Some(slot) = manifest.videos.iter_mut().find(|v| v.id == video_id) {
        slot.status = "processing".to_string();
        slot.error = None;
    }
    save_project(&manifest)?;

    let result = pipeline::jobs::process_single_video(
        app.clone(),
        &root_path,
        &video,
        video_id.clone(),
        Some((1, 1)),
    )
    .await;

    manifest = load_project(&root_path)?;
    if let Some(slot) = manifest.videos.iter_mut().find(|v| v.id == video_id) {
        match result {
            Ok(()) => {
                slot.status = "transcribed".to_string();
                slot.error = None;
            }
            Err(err) => {
                slot.status = "failed".to_string();
                slot.error = Some(err);
            }
        }
    }
    save_project(&manifest)?;
    Ok(manifest)
}

#[tauri::command]
fn get_transcription_preflight(app: tauri::AppHandle) -> TranscriptionPreflight {
    let (ffmpeg_available, ffmpeg_path, ffmpeg_error) = match check_ffmpeg() {
        Ok(path) => (true, Some(path), None),
        Err(err) => (false, None, Some(err)),
    };

    let parakeet_missing = missing_parakeet_files(&app).unwrap_or_default();
    let parakeet_model_ready = parakeet_missing.is_empty()
        && parakeet_model_ready(&app).unwrap_or(false);

    TranscriptionPreflight {
        ffmpeg_available,
        ffmpeg_path,
        ffmpeg_error,
        parakeet_model_ready,
        parakeet_missing_files: parakeet_missing,
    }
}

#[tauri::command]
fn get_transcript(root_path: String, video_id: String) -> Result<Option<Transcript>, String> {
    let paths = project_paths(&root_path)?;
    let video = load_project(&root_path)?
        .videos
        .into_iter()
        .find(|v| v.id == video_id);
    match video {
        Some(v) => load_transcript_for_video(&paths, &video_id, &v.path),
        None => load_transcript(&paths, &video_id),
    }
}

#[tauri::command]
async fn analyze_transcript_with_openai(
    root_path: String,
    video_id: String,
) -> Result<TranscriptAnalysis, String> {
    let paths = project_paths(&root_path)?;
    let manifest = load_project(&root_path)?;
    let video = manifest
        .videos
        .iter()
        .find(|v| v.id == video_id)
        .ok_or_else(|| "video_not_found".to_string())?;
    let transcript = load_transcript_for_video(&paths, &video_id, &video.path)?
        .ok_or_else(|| "transcript_not_found".to_string())?;

    let analysis = analyze_transcript_for_overlays(&transcript, &manifest.settings).await?;
    save_transcript_analysis(&paths, &analysis)?;
    set_video_pipeline_status(&root_path, &video_id, "analyzed")?;
    Ok(analysis)
}

#[tauri::command]
fn get_transcript_analysis(
    root_path: String,
    video_id: String,
) -> Result<Option<TranscriptAnalysis>, String> {
    let paths = project_paths(&root_path)?;
    let video_path = load_project(&root_path)?
        .videos
        .into_iter()
        .find(|v| v.id == video_id)
        .map(|v| v.path)
        .unwrap_or_default();
    load_transcript_analysis_for_video(&paths, &video_id, &video_path)
}

#[tauri::command]
fn get_final_video_timeline(
    root_path: String,
    video_id: String,
) -> Result<FinalVideoTimeline, String> {
    resolve_final_video_timeline(&root_path, &video_id)
}

#[tauri::command]
fn rebuild_final_video_timeline(
    root_path: String,
    video_id: String,
) -> Result<FinalVideoTimeline, String> {
    let paths = project_paths(&root_path)?;
    let timeline = build_default_timeline(&root_path, &video_id)?;
    save_final_video_timeline(&paths, &timeline)?;
    Ok(timeline)
}

#[tauri::command]
fn save_final_video_timeline_cmd(
    root_path: String,
    timeline: FinalVideoTimeline,
) -> Result<(), String> {
    let paths = project_paths(&root_path)?;
    let mut timeline = timeline;
    timeline.updated_at = chrono::Utc::now().to_rfc3339();
    save_final_video_timeline(&paths, &timeline)
}

#[tauri::command]
fn get_video_export_preflight() -> VideoExportPreflight {
    refresh_video_export_preflight_cache()
}

#[tauri::command]
async fn cancel_video_export(
    video_id: String,
    controller: tauri::State<'_, VideoExportController>,
) -> Result<bool, String> {
    Ok(controller.request_cancel(&video_id).await)
}

#[tauri::command]
async fn export_video_with_overlays_cmd(
    app: tauri::AppHandle,
    controller: tauri::State<'_, VideoExportController>,
    root_path: String,
    video_id: String,
    output_path: String,
    clips: Vec<crate::types::VideoOverlayClip>,
) -> Result<String, String> {
    let manifest = load_project(&root_path)?;
    let video = manifest
        .videos
        .iter()
        .find(|v| v.id == video_id)
        .ok_or_else(|| "video_not_found".to_string())?;
    export_video_with_overlays(
        app,
        &controller,
        root_path,
        manifest.settings,
        video.path.clone(),
        video_id,
        output_path,
        clips,
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(VideoExportController::new())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                apply_window_size_limits(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_parakeet_model_info,
            check_parakeet_model_ready,
            download_parakeet_model_cmd,
            delete_parakeet_model_cmd,
            save_api_key,
            clear_api_key,
            check_api_key_set,
            get_api_key_storage_hint,
            open_project,
            get_project,
            update_project_settings,
            get_transcription_preflight,
            get_video_export_preflight,
            run_transcription,
            retry_video_transcription,
            get_transcript,
            analyze_transcript_with_openai,
            get_transcript_analysis,
            save_xai_api_key_cmd,
            clear_xai_api_key_cmd,
            check_xai_api_key_set,
            get_xai_api_key_storage_hint,
            generate_overlay_images,
            regenerate_overlay_image,
            get_overlay_images_manifest,
            resolve_overlay_image_path,
            read_overlay_image_data_url,
            get_final_video_timeline,
            rebuild_final_video_timeline,
            save_final_video_timeline_cmd,
            export_video_with_overlays_cmd,
            cancel_video_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

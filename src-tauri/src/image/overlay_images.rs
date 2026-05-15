use std::fs;
use std::path::PathBuf;

use base64::Engine;
use chrono::Utc;
use tauri::{AppHandle, Emitter};

use crate::image::xai_imagine::generate_imagine_png;
use crate::store::project::{
    load_transcript_analysis, overlay_video_image_dir, project_paths, save_overlay_images_manifest,
};
use crate::store::secrets::get_xai_api_key;
use crate::types::{
    GeneratedOverlayImage, ImageGenerationProgress, OverlayImagesManifest, ProjectSettings,
};

fn sanitize_filename_component(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => c,
            _ => '_',
        })
        .collect()
}

/// Read a project-relative file and return a data URL for the webview.
pub fn read_project_image_data_url(root_path: &str, relative_path: &str) -> Result<String, String> {
    if relative_path.contains("..") {
        return Err("invalid_relative_path".to_string());
    }
    let root = PathBuf::from(root_path);
    let rel = relative_path.trim().trim_start_matches("./");
    let full = root.join(rel);
    if !full.is_file() {
        return Err("image_not_found".to_string());
    }
    let bytes = fs::read(&full).map_err(|e| format!("read_image:{e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let ext = full
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{b64}"))
}

pub async fn generate_overlay_images_for_video(
    app: &AppHandle,
    root_path: String,
    video_id: String,
    settings: &ProjectSettings,
) -> Result<OverlayImagesManifest, String> {
    let api_key = get_xai_api_key().map_err(|e| {
        if e == "xai_api_key_not_set" {
            "xAI API key is not set. Open Settings and save your Grok Imagine (xAI) API key."
                .to_string()
        } else {
            e
        }
    })?;

    let paths = project_paths(&root_path)?;
    let analysis = load_transcript_analysis(&paths, &video_id)?.ok_or_else(|| {
        "analysis_not_found: Run Overlays → Analyze transcript first.".to_string()
    })?;

    let suggestions = analysis.suggestions;
    let total = suggestions.len() as u32;
    if total == 0 {
        return Err(
            "no_suggestions: Nothing to render — run overlay analysis first.".to_string(),
        );
    }

    let model = settings.grok_imagine_model.trim();
    let model = if model.is_empty() {
        "grok-imagine-image-quality"
    } else {
        model
    };

    let img_root = overlay_video_image_dir(&paths, &video_id)?;
    fs::create_dir_all(&img_root).map_err(|e| format!("create_image_dir:{e}"))?;

    let mut images: Vec<GeneratedOverlayImage> = Vec::with_capacity(suggestions.len());
    let root_buf = PathBuf::from(&root_path);

    for (i, s) in suggestions.iter().enumerate() {
        let idx = (i + 1) as u32;
        let file_stem = sanitize_filename_component(&s.id);
        let png_name = format!("{file_stem}.png");
        let rel = format!(".devotiontime/images/{video_id}/{png_name}");

        let _ = app.emit(
            "image_generation_progress",
            ImageGenerationProgress {
                video_id: video_id.clone(),
                index: idx,
                total,
                suggestion_id: s.id.clone(),
                stage: "generating".to_string(),
                message: Some(format!("Rendering {} ({}/{})", s.title, idx, total)),
            },
        );

        let bytes = generate_imagine_png(&api_key, model, &s.image_prompt).await?;
        let abs = root_buf
            .join(".devotiontime")
            .join("images")
            .join(&video_id)
            .join(&png_name);
        fs::write(&abs, bytes).map_err(|e| format!("write_png:{e}"))?;

        images.push(GeneratedOverlayImage {
            suggestion_id: s.id.clone(),
            title: s.title.clone(),
            image_prompt: s.image_prompt.clone(),
            transcript_excerpt: s.transcript_excerpt.clone(),
            relative_path: rel,
            generated_at: Utc::now().to_rfc3339(),
        });

        if i + 1 < suggestions.len() {
            tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
        }
    }

    let manifest = OverlayImagesManifest {
        video_id: video_id.clone(),
        model: model.to_string(),
        generated_at: Utc::now().to_rfc3339(),
        images,
    };

    save_overlay_images_manifest(&paths, &manifest)?;

    let _ = app.emit(
        "image_generation_progress",
        ImageGenerationProgress {
            video_id: video_id.clone(),
            index: total,
            total,
            suggestion_id: String::new(),
            stage: "done".to_string(),
            message: Some("All images generated".to_string()),
        },
    );

    Ok(manifest)
}

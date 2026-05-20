use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use base64::Engine;
use chrono::Utc;
use tauri::{AppHandle, Emitter};

use crate::image::xai_imagine::generate_imagine_png;
use crate::store::project::{
    load_overlay_images_manifest_for_video, load_project, load_transcript_analysis_for_video,
    overlay_video_image_dir, project_paths, save_overlay_images_manifest,
    set_video_pipeline_status,
};
use crate::store::secrets::get_xai_api_key;
use crate::types::{
    GeneratedOverlayImage, ImageGenerationProgress, OverlayImageVersion, OverlayImagesManifest,
    OverlaySuggestion, ProjectSettings, DEFAULT_GROK_IMAGINE_MODEL,
};

fn normalized_versions(img: &GeneratedOverlayImage) -> Vec<OverlayImageVersion> {
    if !img.versions.is_empty() {
        return img.versions.clone();
    }
    if !img.relative_path.is_empty() {
        return vec![OverlayImageVersion {
            relative_path: img.relative_path.clone(),
            generated_at: img.generated_at.clone(),
        }];
    }
    Vec::new()
}

fn sync_image_active_version(img: &mut GeneratedOverlayImage) {
    let versions = normalized_versions(img);
    img.versions = versions.clone();
    if let Some(active) = versions.last() {
        img.relative_path = active.relative_path.clone();
        img.generated_at = active.generated_at.clone();
    }
}

pub(crate) fn normalize_manifest_versions(manifest: &mut OverlayImagesManifest) {
    for img in manifest.images.iter_mut() {
        sync_image_active_version(img);
    }
}

fn version_relative_path(video_id: &str, suggestion_id: &str, version_index: usize) -> String {
    let stem = sanitize_filename_component(suggestion_id);
    let file = if version_index <= 1 {
        format!("{stem}.png")
    } else {
        format!("{stem}-v{version_index}.png")
    };
    format!(".devotiontime/images/{video_id}/{file}")
}

pub(crate) fn find_or_insert_image_entry<'a>(
    images: &'a mut Vec<GeneratedOverlayImage>,
    suggestion: &OverlaySuggestion,
) -> &'a mut GeneratedOverlayImage {
    if let Some(idx) = images
        .iter()
        .position(|img| img.suggestion_id == suggestion.id)
    {
        return &mut images[idx];
    }
    images.push(GeneratedOverlayImage {
        suggestion_id: suggestion.id.clone(),
        title: suggestion.title.clone(),
        image_prompt: suggestion.image_prompt.clone(),
        transcript_excerpt: suggestion.transcript_excerpt.clone(),
        relative_path: String::new(),
        generated_at: String::new(),
        versions: Vec::new(),
    });
    let last = images.len() - 1;
    &mut images[last]
}

pub(crate) fn sanitize_filename_component(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => c,
            _ => '_',
        })
        .collect()
}

/// Normalize path for `convertFileSrc` (strip Windows `\\?\` prefix).
fn path_for_asset_url(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

/// Absolute filesystem path for a project-relative image (for `convertFileSrc` in the webview).
pub fn resolve_project_image_absolute_path(
    root_path: &str,
    relative_path: &str,
) -> Result<String, String> {
    if relative_path.contains("..") {
        return Err("invalid_relative_path".to_string());
    }
    let root = PathBuf::from(root_path);
    let rel = relative_path.trim().trim_start_matches("./");
    let full = root.join(rel);
    if !full.is_file() {
        return Err(format!("image_not_found:{}", full.display()));
    }
    let canon = fs::canonicalize(&full).map_err(|e| format!("canonicalize_image:{e}"))?;
    Ok(path_for_asset_url(&canon))
}

/// Read file as base64 data URL (legacy; large images can exceed IPC limits — prefer [`resolve_project_image_absolute_path`] + `convertFileSrc`).
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
    suggestion_ids: Vec<String>,
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
    let video_path = load_project(&root_path)?
        .videos
        .into_iter()
        .find(|v| v.id == video_id)
        .map(|v| v.path)
        .unwrap_or_default();
    let _ = set_video_pipeline_status(&root_path, &video_id, "generating_images");
    let analysis =
        load_transcript_analysis_for_video(&paths, &video_id, &video_path)?.ok_or_else(|| {
            "analysis_not_found: Run Overlays → Analyze transcript first.".to_string()
        })?;

    let filter: HashSet<&str> = suggestion_ids.iter().map(String::as_str).collect();
    let existing_manifest = load_overlay_images_manifest_for_video(&paths, &video_id, &video_path)?;
    let mut kept_images: Vec<GeneratedOverlayImage> = existing_manifest
        .as_ref()
        .map(|m| m.images.clone())
        .unwrap_or_default();
    let already_generated: HashSet<String> = kept_images
        .iter()
        .map(|img| img.suggestion_id.clone())
        .collect();

    let suggestions: Vec<_> = analysis
        .suggestions
        .into_iter()
        .filter(|s| filter.is_empty() || filter.contains(s.id.as_str()))
        .filter(|s| !already_generated.contains(&s.id))
        .collect();

    let total = suggestions.len() as u32;
    if total == 0 {
        if let Some(manifest) = existing_manifest {
            return Ok(manifest);
        }
        return Err(
            "no_suggestions: No approved overlays need images — approve suggestions on the Overlays tab or run analysis first.".to_string(),
        );
    }

    let model = settings.grok_imagine_model.trim();
    let model = if model.is_empty() {
        DEFAULT_GROK_IMAGINE_MODEL
    } else {
        model
    };

    let img_root = overlay_video_image_dir(&paths, &video_id)?;
    fs::create_dir_all(&img_root).map_err(|e| format!("create_image_dir:{e}"))?;

    let mut new_images: Vec<GeneratedOverlayImage> = Vec::with_capacity(suggestions.len());
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

        let generated_at = Utc::now().to_rfc3339();
        new_images.push(GeneratedOverlayImage {
            suggestion_id: s.id.clone(),
            title: s.title.clone(),
            image_prompt: s.image_prompt.clone(),
            transcript_excerpt: s.transcript_excerpt.clone(),
            relative_path: rel.clone(),
            generated_at: generated_at.clone(),
            versions: vec![OverlayImageVersion {
                relative_path: rel,
                generated_at,
            }],
        });

        if i + 1 < suggestions.len() {
            tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
        }
    }

    kept_images.extend(new_images);
    kept_images.sort_by(|a, b| a.suggestion_id.cmp(&b.suggestion_id));
    let mut manifest = OverlayImagesManifest {
        video_id: video_id.clone(),
        model: model.to_string(),
        generated_at: Utc::now().to_rfc3339(),
        images: kept_images,
    };
    normalize_manifest_versions(&mut manifest);

    save_overlay_images_manifest(&paths, &manifest)?;
    let _ = set_video_pipeline_status(&root_path, &video_id, "images_generated");

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

pub async fn regenerate_overlay_image_for_video(
    app: &AppHandle,
    root_path: String,
    video_id: String,
    suggestion_id: String,
    custom_image_prompt: Option<String>,
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
    let video_path = load_project(&root_path)?
        .videos
        .into_iter()
        .find(|v| v.id == video_id)
        .map(|v| v.path)
        .unwrap_or_default();

    let analysis = load_transcript_analysis_for_video(&paths, &video_id, &video_path)?
        .ok_or_else(|| "analysis_not_found: Run overlay analysis first.".to_string())?;
    let suggestion = analysis
        .suggestions
        .into_iter()
        .find(|s| s.id == suggestion_id)
        .ok_or_else(|| format!("suggestion_not_found:{suggestion_id}"))?;

    let prompt = custom_image_prompt
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| suggestion.image_prompt.clone());

    let model = settings.grok_imagine_model.trim();
    let model = if model.is_empty() {
        DEFAULT_GROK_IMAGINE_MODEL
    } else {
        model
    };

    let _ = app.emit(
        "image_generation_progress",
        ImageGenerationProgress {
            video_id: video_id.clone(),
            index: 1,
            total: 1,
            suggestion_id: suggestion_id.clone(),
            stage: "generating".to_string(),
            message: Some(format!("Regenerating {}", suggestion.title)),
        },
    );

    let img_root = overlay_video_image_dir(&paths, &video_id)?;
    fs::create_dir_all(&img_root).map_err(|e| format!("create_image_dir:{e}"))?;

    let mut manifest = load_overlay_images_manifest_for_video(&paths, &video_id, &video_path)?
        .unwrap_or(OverlayImagesManifest {
            video_id: video_id.clone(),
            model: model.to_string(),
            generated_at: Utc::now().to_rfc3339(),
            images: Vec::new(),
        });

    let entry = find_or_insert_image_entry(&mut manifest.images, &suggestion);
    sync_image_active_version(entry);
    let next_version_index = entry.versions.len() + 1;
    let rel = version_relative_path(&video_id, &suggestion_id, next_version_index);
    let abs = PathBuf::from(&root_path)
        .join(".devotiontime")
        .join("images")
        .join(&video_id)
        .join(
            rel.rsplit('/')
                .next()
                .unwrap_or(&format!("{suggestion_id}.png")),
        );

    let bytes = generate_imagine_png(&api_key, model, &prompt).await?;
    fs::write(&abs, bytes).map_err(|e| format!("write_png:{e}"))?;

    let generated_at = Utc::now().to_rfc3339();
    entry.versions.push(OverlayImageVersion {
        relative_path: rel.clone(),
        generated_at: generated_at.clone(),
    });
    entry.relative_path = rel;
    entry.generated_at = generated_at;
    entry.title = suggestion.title.clone();
    entry.image_prompt = prompt;
    entry.transcript_excerpt = suggestion.transcript_excerpt.clone();
    manifest.model = model.to_string();
    manifest.generated_at = Utc::now().to_rfc3339();
    normalize_manifest_versions(&mut manifest);

    save_overlay_images_manifest(&paths, &manifest)?;
    let _ = set_video_pipeline_status(&root_path, &video_id, "images_generated");

    let _ = app.emit(
        "image_generation_progress",
        ImageGenerationProgress {
            video_id,
            index: 1,
            total: 1,
            suggestion_id,
            stage: "done".to_string(),
            message: Some("Image regenerated".to_string()),
        },
    );

    Ok(manifest)
}

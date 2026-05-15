use std::path::PathBuf;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

pub const PARAKEET_MODEL_ID: &str = "parakeet-tdt-v3-int8";
pub const HF_BASE: &str = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParakeetModelFile {
    pub file_name: String,
    pub url: String,
    pub size_label: String,
}

pub fn default_model_files() -> Vec<ParakeetModelFile> {
    vec![
        ParakeetModelFile {
            file_name: "config.json".to_string(),
            url: format!("{HF_BASE}/config.json"),
            size_label: "1 KB".to_string(),
        },
        ParakeetModelFile {
            file_name: "vocab.txt".to_string(),
            url: format!("{HF_BASE}/vocab.txt"),
            size_label: "140 KB".to_string(),
        },
        ParakeetModelFile {
            file_name: "nemo128.onnx".to_string(),
            url: format!("{HF_BASE}/nemo128.onnx"),
            size_label: "140 KB".to_string(),
        },
        ParakeetModelFile {
            file_name: "decoder_joint-model.int8.onnx".to_string(),
            url: format!("{HF_BASE}/decoder_joint-model.int8.onnx"),
            size_label: "18 MB".to_string(),
        },
        ParakeetModelFile {
            file_name: "encoder-model.int8.onnx".to_string(),
            url: format!("{HF_BASE}/encoder-model.int8.onnx"),
            size_label: "652 MB".to_string(),
        },
    ]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParakeetDownloadProgress {
    pub file_name: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub progress: Option<f32>,
    pub file_index: usize,
    pub file_count: usize,
}

pub fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir_failed:{}", e))?;
    Ok(base.join("models").join("parakeet").join(PARAKEET_MODEL_ID))
}

pub fn parakeet_model_ready(app: &AppHandle) -> Result<bool, String> {
    Ok(missing_parakeet_files(app)?.is_empty())
}

pub fn missing_parakeet_files(app: &AppHandle) -> Result<Vec<String>, String> {
    let dir = model_dir(app)?;
    let missing: Vec<String> = default_model_files()
        .into_iter()
        .filter(|file| !dir.join(&file.file_name).is_file())
        .map(|file| file.file_name)
        .collect();
    Ok(missing)
}

pub async fn download_parakeet_model(app: AppHandle) -> Result<String, String> {
    let dir = model_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_model_dir:{}", e))?;

    let files = default_model_files();
    let file_count = files.len();
    let client = reqwest::Client::new();

    for (index, file) in files.iter().enumerate() {
        let path = dir.join(&file.file_name);
        if path.is_file() {
            continue;
        }

        let response = client
            .get(&file.url)
            .send()
            .await
            .map_err(|e| format!("download_failed:{}:{}", file.file_name, e))?;
        if !response.status().is_success() {
            return Err(format!(
                "download_failed_status:{}:{}",
                file.file_name,
                response.status()
            ));
        }

        let total = response.content_length();
        let mut downloaded: u64 = 0;
        let mut out = tokio::fs::File::create(&path)
            .await
            .map_err(|e| format!("create_model_file:{}:{}", file.file_name, e))?;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download_chunk:{}:{}", file.file_name, e))?;
            use tokio::io::AsyncWriteExt;
            out.write_all(&chunk)
                .await
                .map_err(|e| format!("write_model_file:{}:{}", file.file_name, e))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            let progress = total.map(|t| (downloaded as f32 / t as f32) * 100.0);
            let _ = app.emit(
                "parakeet_model_download_progress",
                ParakeetDownloadProgress {
                    file_name: file.file_name.clone(),
                    downloaded,
                    total,
                    progress,
                    file_index: index + 1,
                    file_count,
                },
            );
        }
        out.flush()
            .await
            .map_err(|e| format!("flush_model_file:{}:{}", file.file_name, e))?;
    }

    Ok(dir.to_string_lossy().to_string())
}

pub fn delete_parakeet_model(app: &AppHandle) -> Result<(), String> {
    let dir = model_dir(app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("delete_model_dir:{}", e))?;
    }
    Ok(())
}

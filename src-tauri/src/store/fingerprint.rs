use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store::project::DEVOTIONTIME_DIR;

/// Bytes read from the start/end of each file when building a new fingerprint (not the whole file).
const SAMPLE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintCacheEntry {
    path: String,
    size: u64,
    modified_ms: u128,
    fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    algorithm: Option<String>,
}

fn cache_dir(project_root: &str) -> PathBuf {
    PathBuf::from(project_root)
        .join(DEVOTIONTIME_DIR)
        .join("cache")
        .join("fingerprints")
}

fn cache_path(project_root: &str, path: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    cache_dir(project_root).join(format!("{digest}.json"))
}

fn file_modified_ms(path: &Path) -> Result<u128, String> {
    let meta = fs::metadata(path).map_err(|e| format!("metadata_failed:{e}"))?;
    let modified = meta
        .modified()
        .map_err(|e| format!("modified_time_failed:{e}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("modified_time_invalid:{e}"))?
        .as_millis();
    Ok(modified)
}

/// Fingerprint from file size plus samples from the start and end — avoids reading multi‑GB files whole.
fn hash_file_sample(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("metadata_failed:{e}"))?;
    let size = meta.len();

    let mut hasher = Sha256::new();
    hasher.update(b"devotiontime-sample-v1\0");
    hasher.update(size.to_le_bytes());

    let mut file = File::open(path).map_err(|e| format!("open_for_hash_failed:{e}"))?;
    let sample_len = SAMPLE_BYTES.min(size).max(0) as usize;
    let mut buffer = vec![0u8; sample_len.max(1)];

    let first_read = file
        .read(&mut buffer[..sample_len.max(1)])
        .map_err(|e| format!("read_for_hash_failed:{e}"))?;
    hasher.update((first_read as u64).to_le_bytes());
    hasher.update(&buffer[..first_read]);

    if size > SAMPLE_BYTES {
        if size > SAMPLE_BYTES * 2 {
            file.seek(SeekFrom::End(-(SAMPLE_BYTES as i64)))
                .map_err(|e| format!("seek_for_hash_failed:{e}"))?;
            let tail_read = file
                .read(&mut buffer)
                .map_err(|e| format!("read_for_hash_failed:{e}"))?;
            hasher.update((tail_read as u64).to_le_bytes());
            hasher.update(&buffer[..tail_read]);
        } else {
            let mut rest = vec![0u8; (size as usize).saturating_sub(first_read)];
            if !rest.is_empty() {
                let mid_read = file
                    .read(&mut rest)
                    .map_err(|e| format!("read_for_hash_failed:{e}"))?;
                hasher.update((mid_read as u64).to_le_bytes());
                hasher.update(&rest[..mid_read]);
            }
        }
    }

    Ok(format!("{:x}", hasher.finalize()))
}

pub fn content_fingerprint(project_root: &str, path: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    if !file_path.is_file() {
        return Err("video_file_not_found".to_string());
    }

    let meta = fs::metadata(file_path).map_err(|e| format!("metadata_failed:{e}"))?;
    let size = meta.len();
    let modified_ms = file_modified_ms(file_path)?;

    let cache_file = cache_path(project_root, path);
    if cache_file.is_file() {
        if let Ok(raw) = fs::read_to_string(&cache_file) {
            if let Ok(entry) = serde_json::from_str::<FingerprintCacheEntry>(&raw) {
                if entry.path == path && entry.size == size && entry.modified_ms == modified_ms {
                    return Ok(entry.fingerprint);
                }
            }
        }
    }

    let fingerprint = hash_file_sample(file_path)?;

    if let Some(parent) = cache_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_fingerprint_cache_dir:{e}"))?;
    }
    let entry = FingerprintCacheEntry {
        path: path.to_string(),
        size,
        modified_ms,
        fingerprint: fingerprint.clone(),
        algorithm: Some("sample-v1".to_string()),
    };
    let raw = serde_json::to_string_pretty(&entry)
        .map_err(|e| format!("serialize_fingerprint_cache:{e}"))?;
    if let Ok(mut file) = File::create(&cache_file) {
        let _ = file.write_all(raw.as_bytes());
    }

    Ok(fingerprint)
}

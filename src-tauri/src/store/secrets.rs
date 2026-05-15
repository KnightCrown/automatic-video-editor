use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "com.devotiontime.app";
const KEYRING_OPENAI: &str = "openai_api_key";
const KEYRING_XAI: &str = "xai_api_key";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretsFile {
    #[serde(default)]
    openai_api_key: String,
    #[serde(default)]
    xai_api_key: String,
}

impl Default for SecretsFile {
    fn default() -> Self {
        Self {
            openai_api_key: String::new(),
            xai_api_key: String::new(),
        }
    }
}

fn secrets_file_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("DevotionTime")
        .join("secrets.json")
}

fn ensure_secrets_dir(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_secrets_dir_failed:{e}"))?;
    }
    Ok(())
}

fn read_secrets_file() -> SecretsFile {
    let path = secrets_file_path();
    if !path.is_file() {
        return SecretsFile::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SecretsFile>(&raw).ok())
        .unwrap_or_default()
}

fn write_secrets_file(s: &SecretsFile) -> Result<(), String> {
    let path = secrets_file_path();
    ensure_secrets_dir(&path)?;
    let raw =
        serde_json::to_string_pretty(s).map_err(|e| format!("serialize_secrets:{e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write_secrets_failed:{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(&path, perms);
        }
    }
    Ok(())
}

fn remove_file_if_both_empty(s: &SecretsFile) -> Result<(), String> {
    if s.openai_api_key.trim().is_empty() && s.xai_api_key.trim().is_empty() {
        let path = secrets_file_path();
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("delete_secrets_failed:{e}"))?;
        }
    }
    Ok(())
}

fn try_keyring_save(user: &str, api_key: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, user)
        .map_err(|e| format!("keyring_entry_failed:{e}"))?
        .set_password(api_key)
        .map_err(|e| format!("keyring_set_failed:{e}"))
}

fn try_keyring_load(user: &str) -> Result<String, String> {
    keyring::Entry::new(KEYRING_SERVICE, user)
        .map_err(|e| format!("keyring_entry_failed:{e}"))?
        .get_password()
        .map_err(|_| "api_key_not_set".to_string())
}

fn try_keyring_clear(user: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, user)
        .map_err(|e| format!("keyring_entry_failed:{e}"))?
        .delete_credential()
        .map_err(|e| format!("keyring_delete_failed:{e}"))
}

pub fn save_openai_api_key(api_key: &str) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("api_key_empty".to_string());
    }

    let mut s = read_secrets_file();
    s.openai_api_key = trimmed.to_string();
    let file_ok = write_secrets_file(&s);
    let keyring_ok = try_keyring_save(KEYRING_OPENAI, trimmed);

    if file_ok.is_ok() || keyring_ok.is_ok() {
        if get_openai_api_key().is_err() {
            return Err(
                "API key was written but could not be read back. Check app data permissions."
                    .to_string(),
            );
        }
        return Ok(());
    }

    let file_err = file_ok.err().unwrap_or_default();
    let keyring_err = keyring_ok.err().unwrap_or_default();
    Err(format!(
        "Could not save API key (file: {file_err}; keychain: {keyring_err})"
    ))
}

pub fn get_openai_api_key() -> Result<String, String> {
    let s = read_secrets_file();
    let from_file = s.openai_api_key.trim();
    if !from_file.is_empty() {
        return Ok(from_file.to_string());
    }
    if let Ok(key) = try_keyring_load(KEYRING_OPENAI) {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Err("api_key_not_set".to_string())
}

pub fn clear_openai_api_key() -> Result<(), String> {
    let _ = try_keyring_clear(KEYRING_OPENAI);
    let mut s = read_secrets_file();
    s.openai_api_key = String::new();
    if s.xai_api_key.trim().is_empty() {
        remove_file_if_both_empty(&s)?;
    } else {
        write_secrets_file(&s)?;
    }
    Ok(())
}

pub fn has_openai_api_key() -> bool {
    get_openai_api_key().is_ok()
}

pub fn save_xai_api_key(api_key: &str) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("api_key_empty".to_string());
    }

    let mut s = read_secrets_file();
    s.xai_api_key = trimmed.to_string();
    let file_ok = write_secrets_file(&s);
    let keyring_ok = try_keyring_save(KEYRING_XAI, trimmed);

    if file_ok.is_ok() || keyring_ok.is_ok() {
        if get_xai_api_key().is_err() {
            return Err(
                "API key was written but could not be read back. Check app data permissions."
                    .to_string(),
            );
        }
        return Ok(());
    }

    let file_err = file_ok.err().unwrap_or_default();
    let keyring_err = keyring_ok.err().unwrap_or_default();
    Err(format!(
        "Could not save xAI API key (file: {file_err}; keychain: {keyring_err})"
    ))
}

pub fn get_xai_api_key() -> Result<String, String> {
    let s = read_secrets_file();
    let from_file = s.xai_api_key.trim();
    if !from_file.is_empty() {
        return Ok(from_file.to_string());
    }
    if let Ok(key) = try_keyring_load(KEYRING_XAI) {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Err("xai_api_key_not_set".to_string())
}

pub fn clear_xai_api_key() -> Result<(), String> {
    let _ = try_keyring_clear(KEYRING_XAI);
    let mut s = read_secrets_file();
    s.xai_api_key = String::new();
    if s.openai_api_key.trim().is_empty() {
        remove_file_if_both_empty(&s)?;
    } else {
        write_secrets_file(&s)?;
    }
    Ok(())
}

pub fn has_xai_api_key() -> bool {
    get_xai_api_key().is_ok()
}

pub fn api_key_storage_hint() -> Option<&'static str> {
    let file = read_secrets_file();
    let file_ok = !file.openai_api_key.trim().is_empty();
    let keyring_ok = try_keyring_load(KEYRING_OPENAI)
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);
    match (file_ok, keyring_ok) {
        (true, true) => Some("app data and system keychain"),
        (true, false) => Some("local app data"),
        (false, true) => Some("system keychain"),
        (false, false) => None,
    }
}

pub fn xai_api_key_storage_hint() -> Option<&'static str> {
    let file = read_secrets_file();
    let file_ok = !file.xai_api_key.trim().is_empty();
    let keyring_ok = try_keyring_load(KEYRING_XAI)
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);
    match (file_ok, keyring_ok) {
        (true, true) => Some("app data and system keychain"),
        (true, false) => Some("local app data"),
        (false, true) => Some("system keychain"),
        (false, false) => None,
    }
}

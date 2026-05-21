/// Common container extensions FFmpeg can read for episode scan, asset import, and timeline media.
pub const VIDEO_FILE_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "qt", "mkv", "webm", "avi", "wmv", "flv", "asf", "mpeg", "mpg", "mpe",
    "mp2", "3gp", "3g2", "ts", "m2ts", "mts", "vob", "ogv", "ogm",
];

pub const IMAGE_FILE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

pub const AUDIO_FILE_EXTENSIONS: &[&str] = &["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga"];

pub fn is_video_file_extension(ext: &str) -> bool {
    VIDEO_FILE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn is_image_file_extension(ext: &str) -> bool {
    IMAGE_FILE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn is_audio_file_extension(ext: &str) -> bool {
    AUDIO_FILE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn timeline_asset_kind_for_extension(ext: &str) -> Option<&'static str> {
    let ext = ext.to_ascii_lowercase();
    if is_video_file_extension(&ext) {
        Some("video")
    } else if is_image_file_extension(&ext) {
        Some("image")
    } else if is_audio_file_extension(&ext) {
        Some("audio")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_video_extensions_case_insensitive() {
        for ext in [
            "mp4", "MP4", "mov", "MOV", "mkv", "webm", "m4v", "avi", "wmv", "mpeg", "3gp", "ts",
        ] {
            assert!(
                is_video_file_extension(ext),
                "expected {ext} to be a video extension"
            );
        }
    }

    #[test]
    fn rejects_non_video_extensions() {
        for ext in ["txt", "png", "jpg", "mp3", "wav", "json"] {
            assert!(
                !is_video_file_extension(ext),
                "expected {ext} not to be a video extension"
            );
        }
    }

    #[test]
    fn classifies_timeline_asset_extensions() {
        assert_eq!(timeline_asset_kind_for_extension("mp4"), Some("video"));
        assert_eq!(timeline_asset_kind_for_extension("MOV"), Some("video"));
        assert_eq!(timeline_asset_kind_for_extension("png"), Some("image"));
        assert_eq!(timeline_asset_kind_for_extension("JPEG"), Some("image"));
        assert_eq!(timeline_asset_kind_for_extension("mp3"), Some("audio"));
        assert_eq!(timeline_asset_kind_for_extension("json"), None);
    }
}

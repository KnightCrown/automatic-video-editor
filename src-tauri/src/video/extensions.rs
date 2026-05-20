/// Common container extensions FFmpeg can read for episode scan, asset import, and timeline media.
pub const VIDEO_FILE_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "qt", "mkv", "webm", "avi", "wmv", "flv", "asf", "mpeg", "mpg", "mpe",
    "mp2", "3gp", "3g2", "ts", "m2ts", "mts", "vob", "ogv", "ogm",
];

pub fn is_video_file_extension(ext: &str) -> bool {
    VIDEO_FILE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
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
}

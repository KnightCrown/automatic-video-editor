/** Keep in sync with `src-tauri/src/video/extensions.rs` */
export const VIDEO_FILE_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "qt",
  "mkv",
  "webm",
  "avi",
  "wmv",
  "flv",
  "asf",
  "mpeg",
  "mpg",
  "mpe",
  "mp2",
  "3gp",
  "3g2",
  "ts",
  "m2ts",
  "mts",
  "vob",
  "ogv",
  "ogm",
] as const;

export const VIDEO_FILE_DIALOG_FILTER = {
  name: "Video",
  extensions: [...VIDEO_FILE_EXTENSIONS],
};

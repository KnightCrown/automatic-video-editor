/** Make stored pipeline errors easier to read in the UI. */
export function formatTranscriptionError(raw: string | undefined | null): string {
  if (!raw?.trim()) {
    return "Unknown error (no details were saved). Try Retry after fixing prerequisites below.";
  }

  let text = raw.trim();

  // Strip redundant stage prefixes for display when we show stage separately
  text = text.replace(/^\[(Audio extraction|Speech recognition|Save transcript)\]\s*/i, "");

  if (text.includes("FFmpeg was not found") || text.includes("ffmpeg_spawn_failed")) {
    return (
      "FFmpeg is not installed or not on your PATH. Install FFmpeg, add it to PATH, " +
      "then fully quit and restart DevotionTime. Windows: winget install Gyan.FFmpeg"
    );
  }

  if (text.includes("parakeet_model_not_ready") || text.includes("Parakeet model is not downloaded")) {
    return "Parakeet speech model is not downloaded. Open Settings and download the model.";
  }

  if (text.includes("Parakeet model is incomplete")) {
    return text;
  }

  if (text.includes("video_file_not_found")) {
    return "The video file could not be found. It may have been moved or deleted.";
  }

  if (
    text.includes("BroadcastIterator") ||
    text.includes("broadcast an axis") ||
    (text.includes("ONNX Runtime") && text.includes("Add node"))
  ) {
    return (
      "Speech recognition hit a length limit on a long clip. DevotionTime now transcribes in " +
      "4-minute chunks automatically — rebuild/restart the app and retry. If this still appears, " +
      "try Retry on one video or report the error details."
    );
  }

  return text;
}

export function errorStageLabel(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (raw.includes("[Audio extraction]")) return "Audio extraction";
  if (raw.includes("[Speech recognition]")) return "Speech recognition";
  if (raw.includes("[Save transcript]")) return "Save transcript";
  if (raw.toLowerCase().includes("ffmpeg")) return "Audio extraction";
  if (raw.toLowerCase().includes("parakeet")) return "Speech recognition";
  return null;
}

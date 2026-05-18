export function formatTimeMs(ms?: number): string {
  if (ms === undefined) return "—";
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatTimeRangeMs(startMs?: number, endMs?: number): string {
  if (startMs === undefined && endMs === undefined) return "—";
  return `${formatTimeMs(startMs)}–${formatTimeMs(endMs)}`;
}

export function formatIdealDisplayMs(ms?: number): string {
  if (ms === undefined) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function projectDisplayName(rootPath: string): string {
  const parts = rootPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? rootPath;
}

export function displayPipelineStatus(status: string): string {
  if (status === "pending") return "Ready";
  if (status === "failed") return "Failed";
  if (
    ["processing", "transcribing", "analyzing", "generating_images"].includes(status)
  ) {
    return "Processing";
  }
  if (status === "images_generated" || status === "done") return "Completed";
  if (status === "analyzed") return "Analyzed";
  if (status === "transcribed") return "Transcribed";
  return status;
}

export function excerptSnippet(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

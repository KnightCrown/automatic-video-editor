import { isTauri } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

const PNG_FILTERS = [{ name: "PNG image", extensions: ["png"] as string[] }];
const MP4_FILTERS = [{ name: "MP4 video", extensions: ["mp4"] as string[] }];

/** Trigger a browser download from a data URL (e.g. PNG from Tauri read). */
export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = sanitizeDownloadFilename(filename);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function readUrlAsBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not read image data (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Web fallback: fetch blob and use `<a download>`. */
async function triggerBrowserBlobDownload(url: string, filename: string): Promise<void> {
  const bytes = await readUrlAsBytes(url);
  const blob = new Blob([bytes], { type: "image/png" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = sanitizeDownloadFilename(filename);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Save a PNG from an asset URL (e.g. `convertFileSrc` result).
 * In the Tauri app: opens the system **Save as** dialog, then writes the file.
 * In a plain browser: falls back to a download via object URL.
 */
export async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const safeName = sanitizeDownloadFilename(filename);
  if (!isTauri()) {
    await triggerBrowserBlobDownload(url, safeName);
    return;
  }
  let defaultPath: string;
  try {
    defaultPath = await join(await downloadDir(), safeName);
  } catch {
    defaultPath = safeName;
  }
  const path = await save({
    title: "Save image",
    filters: PNG_FILTERS,
    defaultPath,
  });
  if (!path) return;
  const bytes = await readUrlAsBytes(url);
  await writeFile(path, bytes);
}

/**
 * Export several PNGs: one **folder** picker, then write each file into that folder.
 * In a plain browser: falls back to sequential blob downloads.
 */
export async function savePngListToChosenFolder(
  items: { url: string; filename: string }[],
): Promise<void> {
  if (items.length === 0) return;
  if (!isTauri()) {
    for (const item of items) {
      await triggerBrowserBlobDownload(item.url, sanitizeDownloadFilename(item.filename));
      await new Promise((r) => setTimeout(r, 220));
    }
    return;
  }
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose folder for exported images",
  });
  if (!selected || typeof selected !== "string") return;
  for (const item of items) {
    const name = sanitizeDownloadFilename(item.filename);
    const outPath = await join(selected, name);
    const bytes = await readUrlAsBytes(item.url);
    await writeFile(outPath, bytes);
  }
}

export function sanitizeDownloadFilename(name: string): string {
  const base = name.replace(/[/\\?%*:|"<>]/g, "-").trim() || "image";
  return base.length > 120 ? base.slice(0, 120) : base;
}

/**
 * Open system Save dialog for an MP4 and return the chosen path, or null if cancelled.
 */
export async function pickVideoSavePath(defaultName: string): Promise<string | null> {
  const safeName = sanitizeDownloadFilename(defaultName);
  if (!isTauri()) {
    return safeName.endsWith(".mp4") ? safeName : `${safeName}.mp4`;
  }
  let defaultPath: string;
  try {
    const base = safeName.endsWith(".mp4") ? safeName : `${safeName}.mp4`;
    defaultPath = await join(await downloadDir(), base);
  } catch {
    defaultPath = safeName.endsWith(".mp4") ? safeName : `${safeName}.mp4`;
  }
  const path = await save({
    title: "Export video",
    filters: MP4_FILTERS,
    defaultPath,
  });
  return path ?? null;
}

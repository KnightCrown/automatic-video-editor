import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ParakeetDownloadProgress,
  ParakeetModelFile,
} from "../types/pipeline";

const DOWNLOAD_EVENT = "parakeet_model_download_progress";

export async function getParakeetModelInfo(): Promise<ParakeetModelFile[]> {
  return invoke<ParakeetModelFile[]>("get_parakeet_model_info");
}

export async function isParakeetModelReady(): Promise<boolean> {
  return invoke<boolean>("check_parakeet_model_ready");
}

export async function downloadParakeetModel(
  onProgress?: (progress: ParakeetDownloadProgress) => void,
): Promise<string> {
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<ParakeetDownloadProgress>(DOWNLOAD_EVENT, (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return await invoke<string>("download_parakeet_model_cmd");
  } finally {
    if (unlisten) {
      await unlisten();
    }
  }
}

export async function deleteParakeetModel(): Promise<void> {
  await invoke("delete_parakeet_model_cmd");
}

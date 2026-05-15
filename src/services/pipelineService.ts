import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ImageGenerationProgress,
  OverlayImagesManifest,
  PipelineProgress,
  ProjectManifest,
  ProjectSettings,
  Transcript,
  TranscriptAnalysis,
  TranscriptionPreflight,
} from "../types/pipeline";

export async function getTranscriptionPreflight(): Promise<TranscriptionPreflight> {
  return invoke<TranscriptionPreflight>("get_transcription_preflight");
}

export async function openProject(rootPath: string): Promise<ProjectManifest> {
  return invoke<ProjectManifest>("open_project", { rootPath });
}

export async function getProject(rootPath: string): Promise<ProjectManifest> {
  return invoke<ProjectManifest>("get_project", { rootPath });
}

export async function updateProjectSettings(
  rootPath: string,
  settings: ProjectSettings,
): Promise<ProjectManifest> {
  return invoke<ProjectManifest>("update_project_settings", { rootPath, settings });
}

export async function runTranscription(
  rootPath: string,
  autoDownloadModel = false,
  onProgress?: (progress: PipelineProgress) => void,
): Promise<ProjectManifest> {
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<PipelineProgress>("pipeline_progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return invoke<ProjectManifest>("run_transcription", {
      rootPath,
      autoDownloadModel,
    });
  } finally {
    if (unlisten) {
      await unlisten();
    }
  }
}

export async function retryVideoTranscription(
  rootPath: string,
  videoId: string,
  onProgress?: (progress: PipelineProgress) => void,
): Promise<ProjectManifest> {
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<PipelineProgress>("pipeline_progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return invoke<ProjectManifest>("retry_video_transcription", { rootPath, videoId });
  } finally {
    if (unlisten) {
      await unlisten();
    }
  }
}

export async function getTranscript(
  rootPath: string,
  videoId: string,
): Promise<Transcript | null> {
  return invoke<Transcript | null>("get_transcript", { rootPath, videoId });
}

export async function analyzeTranscriptWithOpenai(
  rootPath: string,
  videoId: string,
): Promise<TranscriptAnalysis> {
  return invoke<TranscriptAnalysis>("analyze_transcript_with_openai", {
    rootPath,
    videoId,
  });
}

export async function getTranscriptAnalysis(
  rootPath: string,
  videoId: string,
): Promise<TranscriptAnalysis | null> {
  return invoke<TranscriptAnalysis | null>("get_transcript_analysis", {
    rootPath,
    videoId,
  });
}

export async function saveApiKey(apiKey: string): Promise<void> {
  await invoke("save_api_key", { apiKey });
}

export async function clearApiKey(): Promise<void> {
  await invoke("clear_api_key");
}

export async function isApiKeySet(): Promise<boolean> {
  return invoke<boolean>("check_api_key_set");
}

export async function getApiKeyStorageHint(): Promise<string | null> {
  return invoke<string | null>("get_api_key_storage_hint");
}

export async function saveXaiApiKey(apiKey: string): Promise<void> {
  await invoke("save_xai_api_key_cmd", { apiKey });
}

export async function clearXaiApiKey(): Promise<void> {
  await invoke("clear_xai_api_key_cmd");
}

export async function isXaiApiKeySet(): Promise<boolean> {
  return invoke<boolean>("check_xai_api_key_set");
}

export async function getXaiApiKeyStorageHint(): Promise<string | null> {
  return invoke<string | null>("get_xai_api_key_storage_hint");
}

export async function getOverlayImagesManifest(
  rootPath: string,
  videoId: string,
): Promise<OverlayImagesManifest | null> {
  return invoke<OverlayImagesManifest | null>("get_overlay_images_manifest", {
    rootPath,
    videoId,
  });
}

export async function readOverlayImageDataUrl(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  return invoke<string>("read_overlay_image_data_url", {
    rootPath,
    relativePath,
  });
}

export async function generateOverlayImages(
  rootPath: string,
  videoId: string,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<OverlayImagesManifest> {
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<ImageGenerationProgress>(
      "image_generation_progress",
      (event) => {
        onProgress(event.payload);
      },
    );
  }
  try {
    return invoke<OverlayImagesManifest>("generate_overlay_images", {
      rootPath,
      videoId,
    });
  } finally {
    if (unlisten) {
      await unlisten();
    }
  }
}

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  FinalVideoTimeline,
  ImageGenerationProgress,
  OverlayImagesManifest,
  PipelineProgress,
  ProjectManifest,
  ProjectSettings,
  Transcript,
  TranscriptAnalysis,
  TranscriptionPreflight,
  VideoExportPreflight,
  VideoExportProgress,
  VideoOverlayClip,
} from "../types/pipeline";

export async function getTranscriptionPreflight(): Promise<TranscriptionPreflight> {
  return invoke<TranscriptionPreflight>("get_transcription_preflight");
}

export async function getVideoExportPreflight(): Promise<VideoExportPreflight> {
  return invoke<VideoExportPreflight>("get_video_export_preflight");
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

/** Small IPC: absolute path from Rust, then webview loads bytes via the asset protocol (not base64). */
export async function getOverlayImageDisplayUrl(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const abs = await invoke<string>("resolve_overlay_image_path", {
    rootPath,
    relativePath,
  });
  return convertFileSrc(abs);
}

export async function regenerateOverlayImage(
  rootPath: string,
  videoId: string,
  suggestionId: string,
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
    return invoke<OverlayImagesManifest>("regenerate_overlay_image", {
      rootPath,
      videoId,
      suggestionId,
    });
  } finally {
    if (unlisten) {
      await unlisten();
    }
  }
}

export async function generateOverlayImages(
  rootPath: string,
  videoId: string,
  suggestionIds: string[] = [],
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
      suggestionIds,
    });
  } finally {
    if (unlisten) {
      await unlisten();
    }
  }
}

export async function getFinalVideoTimeline(
  rootPath: string,
  videoId: string,
): Promise<FinalVideoTimeline> {
  return invoke<FinalVideoTimeline>("get_final_video_timeline", {
    rootPath,
    videoId,
  });
}

export async function saveFinalVideoTimeline(
  rootPath: string,
  timeline: FinalVideoTimeline,
): Promise<void> {
  await invoke("save_final_video_timeline_cmd", { rootPath, timeline });
}

/** Rebuild timeline from current analysis + image manifest and persist it. */
export async function prepareFinalVideoTimeline(
  rootPath: string,
  videoId: string,
): Promise<FinalVideoTimeline> {
  return invoke<FinalVideoTimeline>("rebuild_final_video_timeline", {
    rootPath,
    videoId,
  });
}

export async function rebuildFinalVideoTimeline(
  rootPath: string,
  videoId: string,
): Promise<FinalVideoTimeline> {
  return prepareFinalVideoTimeline(rootPath, videoId);
}

/** Rebuild timeline, keep only selected overlay images, and persist. */
export async function prepareFinalVideoTimelineWithSelection(
  rootPath: string,
  videoId: string,
  suggestionIds: string[],
): Promise<FinalVideoTimeline> {
  const timeline = await rebuildFinalVideoTimeline(rootPath, videoId);
  const allowed = new Set(suggestionIds);
  const filtered: FinalVideoTimeline = {
    ...timeline,
    clips: timeline.clips.filter((c) => allowed.has(c.suggestionId)),
  };
  await saveFinalVideoTimeline(rootPath, filtered);
  return filtered;
}

export async function cancelVideoExport(videoId: string): Promise<boolean> {
  return invoke<boolean>("cancel_video_export", { videoId });
}

export async function exportFinalVideo(
  rootPath: string,
  videoId: string,
  outputPath: string,
  clips: VideoOverlayClip[],
  onProgress?: (progress: VideoExportProgress) => void,
): Promise<string> {
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<VideoExportProgress>("video_export_progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return invoke<string>("export_video_with_overlays_cmd", {
      rootPath,
      videoId,
      outputPath,
      clips,
    });
  } finally {
    if (unlisten) {
      await unlisten();
    }
  }
}

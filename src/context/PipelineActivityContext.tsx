import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { useProject } from "./ProjectContext";
import {
  analyzeTranscriptWithOpenai,
  generateOverlayImages,
  retryVideoTranscription,
  runTranscription,
} from "../services/pipelineService";
import type {
  ImageGenerationProgress,
  OverlayImagesManifest,
  PipelineProgress,
  ProjectManifest,
  TranscriptAnalysis,
} from "../types/pipeline";
import { mergeEpisodeBatch } from "../utils/pipelineProgress";

export type TranscriptionActivity = {
  kind: "batch" | "single";
  rootPath: string;
  videoId?: string;
  fileName?: string;
  episodeIndex: number;
  episodeTotal: number;
  progress: PipelineProgress | null;
};

export type ImageGenerationActivity = {
  rootPath: string;
  videoId: string;
  fileName?: string;
  progress: ImageGenerationProgress | null;
};

export type AnalyzeActivity = {
  rootPath: string;
  videoId: string;
  fileName?: string;
};

type PipelineActivityContextValue = {
  transcription: TranscriptionActivity | null;
  imageGeneration: ImageGenerationActivity | null;
  analyzingIds: Set<string>;
  analyzingForVideo: (videoId: string) => AnalyzeActivity | undefined;
  isBusy: boolean;
  isTranscriptionRunning: boolean;
  isImageGenerationRunning: boolean;
  startBatchTranscription: (
    rootPath: string,
    autoDownloadModel: boolean,
  ) => Promise<ProjectManifest>;
  startSingleTranscription: (
    rootPath: string,
    videoId: string,
    fileName?: string,
  ) => Promise<ProjectManifest>;
  startImageGeneration: (
    rootPath: string,
    videoId: string,
    suggestionIds: string[],
    fileName?: string,
  ) => Promise<OverlayImagesManifest>;
  startAnalyze: (
    rootPath: string,
    videoId: string,
    fileName?: string,
  ) => Promise<TranscriptAnalysis>;
  transcriptionForVideo: (videoId: string) => TranscriptionActivity | null;
  imageGenerationForVideo: (videoId: string) => ImageGenerationActivity | null;
  isAnalyzingVideo: (videoId: string) => boolean;
};

const PipelineActivityContext = createContext<PipelineActivityContextValue | null>(null);

export function PipelineActivityProvider({ children }: { children: ReactNode }) {
  const { setProject, refreshProject } = useProject();
  const [transcription, setTranscription] = useState<TranscriptionActivity | null>(null);
  const [imageGeneration, setImageGeneration] = useState<ImageGenerationActivity | null>(null);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  const [analyzingMeta, setAnalyzingMeta] = useState<Record<string, AnalyzeActivity>>({});

  const transcriptionRef = useRef(transcription);
  transcriptionRef.current = transcription;
  const imageGenerationRef = useRef(imageGeneration);
  imageGenerationRef.current = imageGeneration;

  useEffect(() => {
    let unlistenPipeline: (() => void) | undefined;
    let unlistenImages: (() => void) | undefined;

    void listen<PipelineProgress>("pipeline_progress", (event) => {
      const p = event.payload;
      setTranscription((prev) => {
        if (!prev) return prev;
        if (prev.kind === "single" && prev.videoId && p.jobId !== prev.videoId) {
          return prev;
        }
        const batch = mergeEpisodeBatch(prev.episodeIndex, prev.episodeTotal, p);
        return {
          ...prev,
          ...batch,
          progress: p,
          fileName:
            p.message?.replace(/^Episode \d+ of \d+ — /, "") ?? prev.fileName,
        };
      });
    }).then((fn) => {
      unlistenPipeline = fn;
    });

    void listen<ImageGenerationProgress>("image_generation_progress", (event) => {
      const p = event.payload;
      setImageGeneration((prev) => {
        if (!prev || prev.videoId !== p.videoId) return prev;
        return { ...prev, progress: p };
      });
    }).then((fn) => {
      unlistenImages = fn;
    });

    return () => {
      if (unlistenPipeline) void unlistenPipeline();
      if (unlistenImages) void unlistenImages();
    };
  }, []);

  const startBatchTranscription = useCallback(
    async (rootPath: string, autoDownloadModel: boolean) => {
      if (transcriptionRef.current) {
        throw new Error("Transcription is already running.");
      }
      setTranscription({
        kind: "batch",
        rootPath,
        episodeIndex: 0,
        episodeTotal: 0,
        progress: null,
      });
      try {
        const manifest = await runTranscription(rootPath, autoDownloadModel);
        setProject(manifest);
        return manifest;
      } finally {
        setTranscription(null);
        await refreshProject();
      }
    },
    [refreshProject, setProject],
  );

  const startSingleTranscription = useCallback(
    async (rootPath: string, videoId: string, fileName?: string) => {
      if (transcriptionRef.current) {
        throw new Error("Transcription is already running.");
      }
      setTranscription({
        kind: "single",
        rootPath,
        videoId,
        fileName,
        episodeIndex: 1,
        episodeTotal: 1,
        progress: null,
      });
      try {
        const manifest = await retryVideoTranscription(rootPath, videoId);
        setProject(manifest);
        return manifest;
      } finally {
        setTranscription(null);
        await refreshProject();
      }
    },
    [refreshProject, setProject],
  );

  const startImageGeneration = useCallback(
    async (
      rootPath: string,
      videoId: string,
      suggestionIds: string[],
      fileName?: string,
    ) => {
      if (imageGenerationRef.current) {
        throw new Error("Image generation is already running.");
      }
      setImageGeneration({
        rootPath,
        videoId,
        fileName,
        progress: null,
      });
      try {
        const manifest = await generateOverlayImages(rootPath, videoId, suggestionIds);
        await refreshProject();
        return manifest;
      } finally {
        setImageGeneration(null);
      }
    },
    [refreshProject],
  );

  const startAnalyze = useCallback(
    async (rootPath: string, videoId: string, fileName?: string) => {
      setAnalyzingIds((prev) => new Set(prev).add(videoId));
      setAnalyzingMeta((prev) => ({ ...prev, [videoId]: { rootPath, videoId, fileName } }));
      try {
        const result = await analyzeTranscriptWithOpenai(rootPath, videoId);
        await refreshProject();
        return result;
      } finally {
        setAnalyzingIds((prev) => {
          const next = new Set(prev);
          next.delete(videoId);
          return next;
        });
        setAnalyzingMeta((prev) => {
          const next = { ...prev };
          delete next[videoId];
          return next;
        });
      }
    },
    [refreshProject],
  );

  const transcriptionForVideo = useCallback(
    (videoId: string) => {
      const t = transcription;
      if (!t) return null;
      if (t.kind === "single") {
        return t.videoId === videoId ? t : null;
      }
      if (t.progress?.jobId === videoId) return t;
      return t;
    },
    [transcription],
  );

  const imageGenerationForVideo = useCallback(
    (videoId: string) => {
      if (imageGeneration?.videoId === videoId) return imageGeneration;
      return null;
    },
    [imageGeneration],
  );

  const analyzingForVideo = useCallback(
    (videoId: string) => analyzingMeta[videoId],
    [analyzingMeta],
  );

  const isAnalyzingVideo = useCallback(
    (videoId: string) => analyzingIds.has(videoId),
    [analyzingIds],
  );

  const value = useMemo(
    () => ({
      transcription,
      imageGeneration,
      analyzingIds,
      analyzingForVideo,
      isBusy: Boolean(
        transcription || imageGeneration || analyzingIds.size > 0,
      ),
      isTranscriptionRunning: Boolean(transcription),
      isImageGenerationRunning: Boolean(imageGeneration),
      startBatchTranscription,
      startSingleTranscription,
      startImageGeneration,
      startAnalyze,
      transcriptionForVideo,
      imageGenerationForVideo,
      isAnalyzingVideo,
    }),
    [
      transcription,
      imageGeneration,
      analyzingIds,
      analyzingMeta,
      startBatchTranscription,
      startSingleTranscription,
      startImageGeneration,
      startAnalyze,
      transcriptionForVideo,
      imageGenerationForVideo,
      isAnalyzingVideo,
    ],
  );

  return (
    <PipelineActivityContext.Provider value={value}>
      {children}
    </PipelineActivityContext.Provider>
  );
}

export function usePipelineActivity() {
  const ctx = useContext(PipelineActivityContext);
  if (!ctx) {
    throw new Error("usePipelineActivity must be used within PipelineActivityProvider");
  }
  return ctx;
}

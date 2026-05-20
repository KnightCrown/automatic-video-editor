import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Image as ImageIcon,
  Plus,
  Edit2,
  Wand2,
  Zap,
  Film,
  Mic,
  RefreshCw,
} from "lucide-react";
import { useProject } from "../context/ProjectContext";
import { usePipelineActivity } from "../context/PipelineActivityContext";
import {
  getOverlayImageDisplayUrl,
  getOverlayImagesManifest,
  getTranscript,
  getTranscriptAnalysis,
  ensureAudioWaveform,
  getFinalVideoTimeline,
  isApiKeySet,
  isXaiApiKeySet,
  openProject,
  prepareFinalVideoTimelineWithSelection,
  regenerateOverlayImage,
} from "../services/pipelineService";
import { isParakeetModelReady } from "../services/parakeetModelService";
import type {
  ImageGenerationProgress,
  OverlayImagesManifest,
  OverlaySuggestion,
  PipelineProgress,
  Transcript,
  TranscriptAnalysis,
} from "../types/pipeline";
import { formatTranscriptionError } from "../utils/transcriptionErrors";
import { ImageLightbox, type ImageLightboxPayload } from "../components/ImageLightbox";
import { sanitizeDownloadFilename } from "../utils/download";
import {
  displayPipelineStatus,
  excerptSnippet,
  formatIdealDisplayMs,
  formatTimeRangeMs,
  overlaySuggestionTimeLabel,
  videoHasTranscriptArtifact,
} from "../utils/format";
import {
  overlayImageVersionTiles,
  overlayImageVersions,
  type OverlayImageVersionTile,
} from "../utils/overlayImages";

type TabId = "overlays" | "images" | "transcript";

export function EditingPage() {
  const { project, setProject } = useProject();
  const {
    isTranscriptionRunning,
    isAnalyzingVideo,
    transcriptionForVideo,
    imageGenerationForVideo,
    startSingleTranscription,
    startImageGeneration,
    startAnalyze,
  } = usePipelineActivity();
  const location = useLocation();
  const navigate = useNavigate();
  const initialVideoId = (location.state as { videoId?: string } | null)?.videoId;

  const [activeVideoPath, setActiveVideoPath] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overlays");
  const [analysis, setAnalysis] = useState<TranscriptAnalysis | null>(null);
  const [manifest, setManifest] = useState<OverlayImagesManifest | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null);
  const [approvedSuggestionIds, setApprovedSuggestionIds] = useState<Set<string>>(new Set());
  const [displayUrls, setDisplayUrls] = useState<Record<string, string>>({});
  const [creatingVideo, setCreatingVideo] = useState(false);
  const [createVideoStatus, setCreateVideoStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKeySet, setApiKeySet] = useState<boolean | null>(null);
  const [xaiKeySet, setXaiKeySet] = useState<boolean | null>(null);
  const [lightbox, setLightbox] = useState<ImageLightboxPayload | null>(null);
  const [regeneratingOverlay, setRegeneratingOverlay] = useState(false);
  const [regeneratingAllImages, setRegeneratingAllImages] = useState(false);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});

  const activeVideo = useMemo(() => {
    if (!project?.videos.length || !activeVideoPath) return null;
    return project.videos.find((v) => v.path === activeVideoPath) ?? null;
  }, [project?.videos, activeVideoPath]);

  const episodeTranscription = activeVideo
    ? transcriptionForVideo(activeVideo.id)
    : null;
  const episodeImageGeneration = activeVideo
    ? imageGenerationForVideo(activeVideo.id)
    : null;
  const transcribingThisEpisode = Boolean(episodeTranscription);
  const transcriptionProgress = episodeTranscription?.progress ?? null;
  const transcribing = transcribingThisEpisode;
  const transcriptionBusy = isTranscriptionRunning;
  const analyzing = activeVideo ? isAnalyzingVideo(activeVideo.id) : false;
  const generating = Boolean(episodeImageGeneration);
  const imageProgress = episodeImageGeneration?.progress ?? null;

  const handleSelectEpisode = useCallback(
    (videoId: string) => {
      const video = project?.videos.find((v) => v.id === videoId);
      if (video) setActiveVideoPath(video.path);
    },
    [project?.videos],
  );

  useEffect(() => {
    isApiKeySet().then(setApiKeySet);
    isXaiApiKeySet().then(setXaiKeySet);
  }, []);

  const videoListKey = useMemo(
    () => project?.videos.map((v) => `${v.id}:${v.path}`).join("|") ?? "",
    [project?.videos],
  );

  useEffect(() => {
    if (!project?.videos.length) {
      setActiveVideoPath(null);
      return;
    }

    setActiveVideoPath((current) => {
      if (current && project.videos.some((v) => v.path === current)) {
        return current;
      }

      if (initialVideoId) {
        const fromNav = project.videos.find((v) => v.id === initialVideoId);
        if (fromNav) return fromNav.path;
      }

      return project.videos[0].path;
    });
  }, [videoListKey, initialVideoId]);

  useEffect(() => {
    if (!initialVideoId) return;
    navigate(location.pathname, { replace: true, state: null });
  }, [initialVideoId, location.pathname, navigate]);

  useEffect(() => {
    setAnalysis(null);
    setManifest(null);
    setTranscript(null);
    setDisplayUrls({});
    setSelectedSuggestionId(null);
    setApprovedSuggestionIds(new Set());
    setPromptDrafts({});
  }, [activeVideoPath]);

  const reloadEpisodeData = useCallback(async () => {
    if (!project || !activeVideo) return;
    const video = activeVideo;
    const [a, m, t, timeline] = await Promise.all([
      getTranscriptAnalysis(project.rootPath, video.id).catch(() => null),
      getOverlayImagesManifest(project.rootPath, video.id).catch(() => null),
      getTranscript(project.rootPath, video.id).catch(() => null),
      getFinalVideoTimeline(project.rootPath, video.id).catch(() => null),
    ]);
    setAnalysis(a);
    setManifest(m);
    setTranscript(t);
    if (a?.suggestions.length) {
      setSelectedSuggestionId((prev) =>
        prev && a.suggestions.some((s) => s.id === prev) ? prev : a.suggestions[0].id,
      );
    } else {
      setSelectedSuggestionId(null);
    }
    if (timeline?.clips.length) {
      setApprovedSuggestionIds(new Set(timeline.clips.map((c) => c.suggestionId)));
    } else if (a?.suggestions.length) {
      setApprovedSuggestionIds(new Set(a.suggestions.map((s) => s.id)));
    } else {
      setApprovedSuggestionIds(new Set());
    }
  }, [project, activeVideo]);

  useEffect(() => {
    void reloadEpisodeData();
  }, [reloadEpisodeData]);

  useEffect(() => {
    if (!project?.updatedAt) return;
    void reloadEpisodeData();
  }, [project?.updatedAt, reloadEpisodeData]);

  useEffect(() => {
    if (!project?.rootPath || !manifest?.images.length) {
      setDisplayUrls({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const urls: Record<string, string> = {};
      const loads: { key: string; relativePath: string }[] = [];
      for (const img of manifest.images) {
        for (const version of overlayImageVersions(img)) {
          loads.push({ key: version.relativePath, relativePath: version.relativePath });
        }
      }
      await Promise.all(
        loads.map(async ({ key, relativePath }) => {
          try {
            urls[key] = await getOverlayImageDisplayUrl(project.rootPath, relativePath);
          } catch {
            /* skip */
          }
        }),
      );
      for (const img of manifest.images) {
        const versions = overlayImageVersions(img);
        const latest = versions[versions.length - 1];
        if (latest && urls[latest.relativePath]) {
          urls[img.suggestionId] = urls[latest.relativePath];
        }
      }
      if (!cancelled) setDisplayUrls(urls);
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath, manifest]);

  const selectedSuggestion = useMemo(
    () => analysis?.suggestions.find((s) => s.id === selectedSuggestionId) ?? null,
    [analysis, selectedSuggestionId],
  );

  const originalPrompt = selectedSuggestion?.imagePrompt ?? "";
  const displayPrompt =
    selectedSuggestionId && selectedSuggestionId in promptDrafts
      ? promptDrafts[selectedSuggestionId]
      : originalPrompt;
  const isPromptEdited =
    Boolean(selectedSuggestionId) && displayPrompt.trim() !== originalPrompt.trim();

  const selectedManifestImage = useMemo(() => {
    if (!manifest || !selectedSuggestionId) return undefined;
    return manifest.images.find((img) => img.suggestionId === selectedSuggestionId);
  }, [manifest, selectedSuggestionId]);

  const versionTilesForSuggestion = useMemo(
    () => overlayImageVersionTiles(selectedManifestImage),
    [selectedManifestImage],
  );

  const generatedSuggestionIds = useMemo(
    () => new Set(manifest?.images.map((i) => i.suggestionId) ?? []),
    [manifest],
  );

  const approvedNeedingImagesCount = useMemo(
    () =>
      [...approvedSuggestionIds].filter((id) => !generatedSuggestionIds.has(id)).length,
    [approvedSuggestionIds, generatedSuggestionIds],
  );

  const approvedWithImagesCount = useMemo(
    () =>
      [...approvedSuggestionIds].filter((id) => generatedSuggestionIds.has(id)).length,
    [approvedSuggestionIds, generatedSuggestionIds],
  );

  async function handleAddEpisodes() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select video project folder",
    });
    if (!selected || typeof selected !== "string") return;
    try {
      const manifest = await openProject(selected);
      setProject(manifest);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleAnalyze() {
    if (!project || !activeVideo) return;
    setError(null);
    const keyReady = await isApiKeySet();
    setApiKeySet(keyReady);
    if (!keyReady) {
      setError("OpenAI API key is not set. Save your key in Settings first.");
      return;
    }
    try {
      const result = await startAnalyze(
        project.rootPath,
        activeVideo.id,
        activeVideo.fileName,
      );
      if (activeVideoPath === activeVideo.path) {
        setAnalysis(result);
        setApprovedSuggestionIds(new Set(result.suggestions.map((s) => s.id)));
        if (result.suggestions.length) setSelectedSuggestionId(result.suggestions[0].id);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleGenerateImages() {
    if (!project || !activeVideo) return;
    const toGenerate = [...approvedSuggestionIds].filter(
      (id) => !generatedSuggestionIds.has(id),
    );
    const toRegenerate = [...approvedSuggestionIds].filter((id) =>
      generatedSuggestionIds.has(id),
    );

    if (toGenerate.length === 0 && toRegenerate.length === 0) {
      setError(
        approvedSuggestionIds.size === 0
          ? "Approve at least one overlay on the Overlays tab before generating images."
          : "All approved overlays already have images.",
      );
      return;
    }

    setError(null);
    const keyOk = await isXaiApiKeySet();
    setXaiKeySet(keyOk);
    if (!keyOk) {
      setError("xAI API key is not set. Save your key in Settings first.");
      return;
    }
    const videoPath = activeVideo.path;

    if (toGenerate.length > 0) {
      try {
        const m = await startImageGeneration(
          project.rootPath,
          activeVideo.id,
          toGenerate,
          activeVideo.fileName,
        );
        if (activeVideoPath === videoPath) {
          setManifest(m);
          setApprovedSuggestionIds((prev) => {
            const next = new Set(prev);
            for (const img of m.images) next.add(img.suggestionId);
            return next;
          });
        }
      } catch (err) {
        setError(String(err));
      }
      return;
    }

    setRegeneratingAllImages(true);
    try {
      let m = manifest;
      for (const suggestionId of toRegenerate) {
        m = await regenerateOverlayImage(
          project.rootPath,
          activeVideo.id,
          suggestionId,
        );
      }
      if (activeVideoPath === videoPath && m) {
        setManifest(m);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRegeneratingAllImages(false);
    }
  }

  async function handleRegenerateImage() {
    if (!project || !activeVideo || !selectedSuggestionId) return;
    setError(null);
    const keyOk = await isXaiApiKeySet();
    setXaiKeySet(keyOk);
    if (!keyOk) {
      setError("xAI API key is not set. Save your key in Settings first.");
      return;
    }
    const videoPath = activeVideo.path;
    setRegeneratingOverlay(true);
    try {
      const m = await regenerateOverlayImage(
        project.rootPath,
        activeVideo.id,
        selectedSuggestionId,
        isPromptEdited ? { imagePrompt: displayPrompt.trim() } : undefined,
      );
      if (activeVideoPath === videoPath) {
        setManifest(m);
        setApprovedSuggestionIds((prev) => {
          const next = new Set(prev);
          next.add(selectedSuggestionId);
          return next;
        });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRegeneratingOverlay(false);
    }
  }

  async function handleCreateVideo() {
    const clipIds = [...approvedSuggestionIds].filter((id) =>
      generatedSuggestionIds.has(id),
    );
    if (!project || !activeVideo || clipIds.length === 0) return;
    setCreatingVideo(true);
    setCreateVideoStatus("Preparing final video timeline...");
    setError(null);
    try {
      await prepareFinalVideoTimelineWithSelection(project.rootPath, activeVideo.id, clipIds);
      setCreateVideoStatus("Generating audio peak waveform...");
      try {
        await ensureAudioWaveform(project.rootPath, activeVideo.id);
      } catch (waveformErr) {
        console.warn("Could not pre-generate audio waveform", waveformErr);
      }
      navigate("/videos", { state: { videoId: activeVideo.id } });
    } catch (err) {
      setError(String(err));
    } finally {
      setCreatingVideo(false);
      setCreateVideoStatus(null);
    }
  }

  function handlePromptChange(text: string) {
    if (!selectedSuggestionId) return;
    setPromptDrafts((prev) => ({ ...prev, [selectedSuggestionId]: text }));
  }

  function handleRevertPrompt() {
    if (!selectedSuggestionId) return;
    setPromptDrafts((prev) => {
      const next = { ...prev };
      delete next[selectedSuggestionId];
      return next;
    });
  }

  function toggleImageApproval(suggestionId: string) {
    setApprovedSuggestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(suggestionId)) next.delete(suggestionId);
      else next.add(suggestionId);
      return next;
    });
  }

  async function handleTranscribe() {
    if (!project || !activeVideo) return;
    setError(null);
    const videoPath = activeVideo.path;
    try {
      const ready = await isParakeetModelReady();
      if (!ready) {
        setError(
          "Parakeet speech model is not ready. Open Settings to download it, then try again.",
        );
        return;
      }
      const manifest = await startSingleTranscription(
        project.rootPath,
        activeVideo.id,
        activeVideo.fileName,
      );
      if (activeVideoPath === videoPath) {
        await reloadEpisodeData();
      }
      const video = manifest.videos.find((v) => v.path === videoPath);
      if (video?.status === "failed" && video.error) {
        setError(formatTranscriptionError(video.error));
      }
    } catch (err) {
      setError(formatTranscriptionError(String(err)));
    }
  }

  function editingDownloadFilename(title: string, suggestionId: string): string | undefined {
    if (!activeVideo) return undefined;
    const base = `${sanitizeDownloadFilename(title)}-${suggestionId.slice(0, 8)}.png`;
    return `${activeVideo.id}-${base}`;
  }

  function openSuggestionLightbox(suggestion: OverlaySuggestion, imageUrl?: string) {
    if (!imageUrl) return;
    setLightbox({
      imageUrl,
      title: suggestion.title,
      excerpt: suggestion.transcriptExcerpt,
      timeLabel: overlaySuggestionTimeLabel(suggestion),
      downloadFilename: editingDownloadFilename(suggestion.title, suggestion.id),
    });
  }

  function openImageLightbox(
    img: { suggestionId: string; title: string; transcriptExcerpt: string },
    imageUrl?: string,
  ) {
    if (!imageUrl) return;
    const suggestion = analysis?.suggestions.find((s) => s.id === img.suggestionId);
    setLightbox({
      imageUrl,
      title: img.title,
      excerpt: img.transcriptExcerpt,
      timeLabel: suggestion ? overlaySuggestionTimeLabel(suggestion) : undefined,
      downloadFilename: editingDownloadFilename(img.title, img.suggestionId),
    });
  }

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full">
        <h2 className="text-xl font-medium text-white mb-2">No Project Selected</h2>
        <p className="text-textMuted text-sm">Open a project folder in Overview first.</p>
      </div>
    );
  }

  const hasTranscript =
    Boolean(transcript) || videoHasTranscriptArtifact(activeVideo?.status);
  const hasAnalysis = !!(analysis && analysis.suggestions.length > 0);

  return (
    <div className="flex-1 flex flex-col p-6 h-full overflow-hidden">
      <div className="flex justify-between items-center mb-6 flex-shrink-0 gap-4">
        <div>
          <h1 className="text-2xl font-semibold mb-1 text-white">Editing</h1>
          <p className="text-textMuted text-sm">
            Review overlay suggestions, generate images, and build your final video.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            type="button"
            disabled={creatingVideo || approvedWithImagesCount === 0 || !activeVideo}
            onClick={() => void handleCreateVideo()}
            className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
          >
            <Film size={16} />
            {creatingVideo ? "Creating…" : `Create video (${approvedWithImagesCount})`}
          </button>
          <button
            type="button"
            onClick={() => navigate("/videos", { state: { videoId: activeVideo?.id } })}
            className="bg-surface border border-border px-3 py-2 rounded-lg text-sm text-textMuted hover:text-white"
          >
            Videos
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-danger bg-opacity-20 text-danger text-sm border border-danger border-opacity-30">
          {error}
        </div>
      )}

      {createVideoStatus && (
        <div className="mb-4 p-3 rounded-lg bg-primary bg-opacity-15 text-white text-sm border border-primary border-opacity-30">
          {createVideoStatus}
        </div>
      )}

      {apiKeySet === false && (
        <p className="text-sm text-danger mb-4">OpenAI API key missing — set it in Settings.</p>
      )}
      {xaiKeySet === false && activeTab === "images" && (
        <p className="text-sm text-danger mb-4">xAI API key missing — set it in Settings.</p>
      )}

      <div className="flex-1 flex gap-6 overflow-x-auto overflow-y-hidden min-h-0 min-w-0">
        <EpisodeListPanel
          videos={project.videos}
          activeVideoPath={activeVideoPath}
          onSelect={handleSelectEpisode}
          onAddEpisodes={() => void handleAddEpisodes()}
        />

        <div className="flex-1 min-w-0 flex flex-col bg-surface border border-border rounded-xl overflow-hidden">
          {activeVideo ? (
            <>
              <VideoHeaderWrap video={activeVideo} />

              <div className="flex px-5 border-b border-border bg-[#151821] flex-shrink-0">
                <TabButton
                  active={activeTab === "overlays"}
                  onClick={() => setActiveTab("overlays")}
                  label="Overlay Suggestions"
                  count={analysis?.suggestions.length ?? 0}
                />
                <TabButton
                  active={activeTab === "images"}
                  onClick={() => setActiveTab("images")}
                  label="Images"
                  count={manifest?.images.length ?? 0}
                  total={analysis?.suggestions.length}
                />
                <TabButton
                  active={activeTab === "transcript"}
                  onClick={() => setActiveTab("transcript")}
                  label="Transcript"
                />
              </div>

              <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background p-5">
                {activeTab === "overlays" && (
                  <OverlaysTabContent
                    hasTranscript={hasTranscript}
                    transcribing={transcribing}
                    transcriptionBusy={transcriptionBusy}
                    transcriptionProgress={transcriptionProgress}
                    analyzing={analyzing}
                    hasAnalysis={hasAnalysis}
                    analysis={analysis}
                    generatedSuggestionIds={generatedSuggestionIds}
                    displayUrls={displayUrls}
                    selectedSuggestionId={selectedSuggestionId}
                    approvedSuggestionIds={approvedSuggestionIds}
                    onTranscribe={() => void handleTranscribe()}
                    onAnalyze={() => void handleAnalyze()}
                    onSelectSuggestion={setSelectedSuggestionId}
                    onToggleApproval={toggleImageApproval}
                    onOpenLightbox={openSuggestionLightbox}
                  />
                )}
                {activeTab === "images" && (
                  <ImagesTabContent
                    hasTranscript={hasTranscript}
                    transcribing={transcribing}
                    transcriptionBusy={transcriptionBusy}
                    transcriptionProgress={transcriptionProgress}
                    hasAnalysis={hasAnalysis}
                    generating={generating || regeneratingAllImages}
                    imageProgress={imageProgress}
                    manifest={manifest}
                    displayUrls={displayUrls}
                    approvedSuggestionIds={approvedSuggestionIds}
                    selectedSuggestionId={selectedSuggestionId}
                    approvedNeedingImagesCount={approvedNeedingImagesCount}
                    approvedWithImagesCount={approvedWithImagesCount}
                    onTranscribe={() => void handleTranscribe()}
                    onGenerate={() => void handleGenerateImages()}
                    onToggleImage={toggleImageApproval}
                    onSelectImage={setSelectedSuggestionId}
                    onOpenLightbox={openImageLightbox}
                  />
                )}
                {activeTab === "transcript" && (
                  <TranscriptTabContent
                    transcript={transcript}
                    hasTranscript={hasTranscript}
                    transcribing={transcribing}
                    transcriptionBusy={transcriptionBusy}
                    transcriptionProgress={transcriptionProgress}
                    onTranscribe={() => void handleTranscribe()}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-textMuted">
              Select an episode to begin
            </div>
          )}
        </div>

        <PromptPanel
          suggestion={selectedSuggestion}
          promptText={displayPrompt}
          isPromptEdited={isPromptEdited}
          onPromptChange={handlePromptChange}
          onRevertPrompt={handleRevertPrompt}
          versionTiles={versionTilesForSuggestion}
          displayUrls={displayUrls}
          videoId={activeVideo?.id ?? ""}
          onRegenerateImage={() => void handleRegenerateImage()}
          regenerating={regeneratingOverlay || generating}
          hasAnalysis={hasAnalysis}
          onOpenLightbox={(img, url) => openImageLightbox(img, url)}
        />
      </div>

      <ImageLightbox payload={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

function VideoHeaderWrap({ video }: { video: { fileName: string; status: string } }) {
  return (
    <div className="p-5 border-b border-border flex-shrink-0">
      <VideoHeader video={video} />
    </div>
  );
}

function VideoHeader({ video }: { video: { fileName: string; status: string } }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-white">{video.fileName}</h2>
      <p className="text-sm text-textMuted mt-1 capitalize">{video.status.replace(/_/g, " ")}</p>
    </div>
  );
}

function TabEmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center min-h-[10rem] text-center px-6 py-8">
      <p className="text-sm text-textMuted max-w-md">{title}</p>
      {hint ? <p className="text-xs text-textMuted mt-2 max-w-sm opacity-80">{hint}</p> : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  total,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  total?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 flex items-center gap-2 transition-colors ${
        active ? "text-primary border-primary" : "text-textMuted border-transparent hover:text-white"
      }`}
    >
      {label}
      {count !== undefined && (
        <span className="text-xs bg-white bg-opacity-10 px-1.5 py-0.5 rounded-full">
          {total !== undefined ? `${count} / ${total}` : count}
        </span>
      )}
    </button>
  );
}

function EpisodeListPanel({
  videos,
  activeVideoPath,
  onSelect,
  onAddEpisodes,
}: {
  videos: { id: string; path: string; fileName: string; status: string }[];
  activeVideoPath: string | null;
  onSelect: (id: string) => void;
  onAddEpisodes: () => void;
}) {
  return (
    <div className="relative z-20 w-64 min-h-0 self-stretch flex flex-col bg-surface border border-border rounded-xl overflow-hidden flex-shrink-0">
      <div className="p-4 border-b border-border flex justify-between items-center bg-[#151821] flex-shrink-0">
        <h3 className="text-sm font-semibold text-white">Episodes ({videos.length})</h3>
        <button
          type="button"
          onClick={onAddEpisodes}
          className="flex items-center gap-1.5 text-xs text-textMuted hover:text-white font-medium px-2 py-1 bg-white bg-opacity-5 rounded border border-white border-opacity-10"
        >
          <Plus size={14} /> Add episodes
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {videos.map((video) => (
          <button
            key={video.id}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(video.id);
            }}
            className={`w-full text-left p-3 rounded-xl border transition-colors flex items-center justify-between cursor-pointer ${
              activeVideoPath === video.path
                ? "bg-[#3B82F6] bg-opacity-10 border-[#3B82F6] border-opacity-50"
                : "bg-background border-border hover:border-gray-600"
            }`}
          >
            <p
              className={`text-sm font-medium truncate ${
                activeVideoPath === video.path ? "text-white" : "text-textMain"
              }`}
            >
              {video.fileName}
            </p>
            <span className="text-[10px] text-textMuted uppercase ml-2 flex-shrink-0">
              {displayPipelineStatus(video.status)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

type OverlayRowStatus = "pending" | "generated" | "approved";

function overlayRowStatus(
  suggestionId: string,
  hasImage: boolean,
  approvedIds: Set<string>,
): OverlayRowStatus {
  if (approvedIds.has(suggestionId)) return "approved";
  return hasImage ? "generated" : "pending";
}

function EpisodeTranscribeBar({
  transcribing,
  transcriptionBusy,
  progress,
  onTranscribe,
}: {
  transcribing: boolean;
  transcriptionBusy: boolean;
  progress: PipelineProgress | null;
  onTranscribe: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 flex-shrink-0">
      <button
        type="button"
        disabled={transcriptionBusy}
        onClick={onTranscribe}
        className="self-start flex items-center gap-2 bg-[#3B82F6] hover:bg-[#2563EB] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
      >
        <Mic size={16} />
        {transcribing ? "Transcribing…" : "Transcribe"}
      </button>
      {transcriptionBusy && !transcribing && (
        <p className="text-sm text-textMuted">
          Another transcription is running — see the progress bar at the top.
        </p>
      )}
      {transcribing && progress && (
        <p className="text-sm text-textMuted">
          <strong className="text-white">{progress.stage}</strong>
          {progress.message ? ` — ${progress.message}` : ""}
        </p>
      )}
    </div>
  );
}

function OverlaysTabContent({
  hasTranscript,
  transcribing,
  transcriptionBusy,
  transcriptionProgress,
  analyzing,
  hasAnalysis,
  analysis,
  generatedSuggestionIds,
  displayUrls,
  selectedSuggestionId,
  approvedSuggestionIds,
  onTranscribe,
  onAnalyze,
  onSelectSuggestion,
  onToggleApproval,
  onOpenLightbox,
}: {
  hasTranscript: boolean;
  transcribing: boolean;
  transcriptionBusy: boolean;
  transcriptionProgress: PipelineProgress | null;
  analyzing: boolean;
  hasAnalysis: boolean;
  analysis: TranscriptAnalysis | null;
  generatedSuggestionIds: Set<string>;
  displayUrls: Record<string, string>;
  selectedSuggestionId: string | null;
  approvedSuggestionIds: Set<string>;
  onTranscribe: () => void;
  onAnalyze: () => void;
  onSelectSuggestion: (id: string) => void;
  onToggleApproval: (id: string) => void;
  onOpenLightbox: (suggestion: OverlaySuggestion, imageUrl?: string) => void;
}) {
  if (!hasTranscript) {
    return (
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <EpisodeTranscribeBar
          transcribing={transcribing}
          transcriptionBusy={transcriptionBusy}
          progress={transcriptionProgress}
          onTranscribe={onTranscribe}
        />
        <TabEmptyState
          title="Transcribe this episode to get started."
          hint='Click "Transcribe" above, then analyze the transcript to create overlay suggestions.'
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <button
        type="button"
        disabled={analyzing}
        onClick={onAnalyze}
        className="self-start flex-shrink-0 bg-primary hover:bg-primaryHover text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {analyzing ? "Analyzing transcript…" : "Generate overlay suggestions"}
      </button>

      {analyzing && (
        <p className="text-textMuted text-sm flex-shrink-0">Sending transcript to OpenAI…</p>
      )}

      {hasAnalysis && analysis && (
        <>
          {(analysis.contentBounds || (analysis.assetPlacements?.length ?? 0) > 0) && (
            <AnalysisMetaPanel analysis={analysis} />
          )}
          <OverlaySuggestionsTable
            analysis={analysis}
            generatedSuggestionIds={generatedSuggestionIds}
            displayUrls={displayUrls}
            selectedSuggestionId={selectedSuggestionId}
            approvedSuggestionIds={approvedSuggestionIds}
            onSelectSuggestion={onSelectSuggestion}
            onToggleApproval={onToggleApproval}
            onOpenLightbox={onOpenLightbox}
          />
        </>
      )}

      {!hasAnalysis && !analyzing && (
        <TabEmptyState
          title="No overlay suggestions yet."
          hint='Click "Generate overlay suggestions" above to generate overlay suggestions from the transcript.'
        />
      )}
    </div>
  );
}

function AnalysisMetaPanel({ analysis }: { analysis: TranscriptAnalysis }) {
  const bounds = analysis.contentBounds;
  const assets = analysis.assetPlacements ?? [];

  return (
    <section className="rounded-xl border border-border bg-surface/80 p-4 space-y-3 flex-shrink-0">
      {bounds ? (
        <div>
          <h4 className="text-sm font-semibold text-white">Episode content window</h4>
          <p className="text-sm text-textMuted mt-1">
            Actual content: {formatTimeRangeMs(bounds.contentStartMs, bounds.contentEndMs)}
            {bounds.videoDurationMs
              ? ` · file duration ${formatTimeRangeMs(0, bounds.videoDurationMs)}`
              : null}
          </p>
          <p className="text-xs text-textMuted mt-1">{bounds.rationale}</p>
        </div>
      ) : null}
      {assets.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold text-white">Asset placements ({assets.length})</h4>
          <ul className="mt-2 space-y-2">
            {assets.map((asset) => (
              <li
                key={asset.id}
                className="text-sm text-textMuted border border-border rounded-lg px-3 py-2 bg-background/60"
              >
                <strong className="text-white">{asset.assetFileName}</strong>
                {" · "}
                {formatTimeRangeMs(asset.startMs, asset.startMs + asset.durationMs)}
                {asset.triggerWord ? ` · trigger “${asset.triggerWord}”` : ""}
                {asset.verified ? " · verified" : " · rejected"}
                <span className="block text-xs mt-1">{asset.rationale}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function OverlaySuggestionsTable({
  analysis,
  generatedSuggestionIds,
  displayUrls,
  selectedSuggestionId,
  approvedSuggestionIds,
  onSelectSuggestion,
  onToggleApproval,
  onOpenLightbox,
}: {
  analysis: TranscriptAnalysis;
  generatedSuggestionIds: Set<string>;
  displayUrls: Record<string, string>;
  selectedSuggestionId: string | null;
  approvedSuggestionIds: Set<string>;
  onSelectSuggestion: (id: string) => void;
  onToggleApproval: (id: string) => void;
  onOpenLightbox: (suggestion: OverlaySuggestion, imageUrl?: string) => void;
}) {
  const stats = useMemo(() => {
    let approved = 0;
    let generated = 0;
    let pending = 0;
    for (const s of analysis.suggestions) {
      const hasImage = generatedSuggestionIds.has(s.id);
      const status = overlayRowStatus(s.id, hasImage, approvedSuggestionIds);
      if (status === "approved") approved += 1;
      else if (status === "generated") generated += 1;
      else pending += 1;
    }
    return { approved, generated, pending };
  }, [analysis.suggestions, generatedSuggestionIds, approvedSuggestionIds]);

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#151821] text-textMuted border-b border-border sticky top-0 z-10">
            <tr>
              <th className="p-3 w-10" aria-label="Select" />
              <th className="p-3 font-medium w-32">Time</th>
              <th className="p-3 font-medium min-w-[12rem]">Excerpt</th>
              <th className="p-3 font-medium w-32">Image</th>
              <th className="p-3 font-medium w-28">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {analysis.suggestions.map((s) => (
              <SuggestionRow
                key={s.id}
                suggestion={s}
                highlight={selectedSuggestionId === s.id}
                hasImage={generatedSuggestionIds.has(s.id)}
                displayUrl={displayUrls[s.id]}
                status={overlayRowStatus(s.id, generatedSuggestionIds.has(s.id), approvedSuggestionIds)}
                checked={approvedSuggestionIds.has(s.id)}
                onToggleChecked={() => onToggleApproval(s.id)}
                onSelect={() => onSelectSuggestion(s.id)}
                onToggleApproval={() => onToggleApproval(s.id)}
                onOpenLightbox={(url) => onOpenLightbox(s, url)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <OverlaySuggestionsFooter total={analysis.suggestions.length} stats={stats} />
    </div>
  );
}

function OverlaySuggestionsFooter({
  total,
  stats,
}: {
  total: number;
  stats: { approved: number; generated: number; pending: number };
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-border bg-[#151821] flex-shrink-0">
      <p className="text-xs text-textMuted">
        {total} suggestions · {stats.approved} approved for images · {stats.generated} with image
        (excluded) · {stats.pending} excluded
      </p>
    </div>
  );
}

function OverlayStatusBadge({
  status,
  onToggle,
}: {
  status: OverlayRowStatus;
  onToggle?: () => void;
}) {
  const styles: Record<OverlayRowStatus, string> = {
    pending: "bg-white bg-opacity-5 text-textMuted border-border",
    generated: "bg-[#3B82F6] bg-opacity-10 text-[#3B82F6] border-[#3B82F6] border-opacity-30",
    approved: "bg-success bg-opacity-20 text-success border-success border-opacity-30",
  };
  const labels: Record<OverlayRowStatus, string> = {
    pending: "Excluded",
    generated: "Excluded",
    approved: "Approved",
  };
  const titles: Record<OverlayRowStatus, string | undefined> = {
    pending: "Click to approve for image generation",
    generated: "Click to approve for final video",
    approved: "Click to exclude",
  };
  const className = `text-xs px-2 py-1 rounded border capitalize ${styles[status]}${
    onToggle ? " cursor-pointer hover:opacity-80" : ""
  }`;

  if (!onToggle) {
    return <span className={className}>{labels[status]}</span>;
  }

  return (
    <button
      type="button"
      title={titles[status]}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={className}
    >
      {labels[status]}
    </button>
  );
}

function SuggestionRow({
  suggestion,
  highlight,
  hasImage,
  displayUrl,
  status,
  checked,
  onToggleChecked,
  onSelect,
  onToggleApproval,
  onOpenLightbox,
}: {
  suggestion: OverlaySuggestion;
  highlight: boolean;
  hasImage: boolean;
  displayUrl?: string;
  status: OverlayRowStatus;
  checked: boolean;
  onToggleChecked: () => void;
  onSelect: () => void;
  onToggleApproval: () => void;
  onOpenLightbox: (imageUrl?: string) => void;
}) {
  return (
    <tr
      className={`cursor-pointer hover:bg-white hover:bg-opacity-5 ${
        highlight ? "bg-primary bg-opacity-10" : ""
      }`}
      onClick={onSelect}
    >
      <td className="p-3 w-10" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggleChecked}
          className="rounded border-border"
          aria-label={
            checked
              ? `Exclude overlay at ${formatTimeRangeMs(suggestion.startMs, suggestion.endMs)}`
              : `Approve overlay at ${formatTimeRangeMs(suggestion.startMs, suggestion.endMs)}`
          }
        />
      </td>
      <td className="p-3 text-white whitespace-nowrap align-top">
        {formatTimeRangeMs(suggestion.startMs, suggestion.endMs)}
        <br />
        <span className="text-xs text-textMuted">
          {formatIdealDisplayMs(suggestion.idealDisplayMs)}
        </span>
      </td>
      <td className="p-3 text-textMuted align-top max-w-md">
        <p className="text-sm leading-snug line-clamp-4" title={suggestion.transcriptExcerpt}>
          {excerptSnippet(suggestion.transcriptExcerpt, 280)}
        </p>
      </td>
      <td className="p-3 align-top" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          disabled={!displayUrl}
          title={displayUrl ? "View image" : undefined}
          onClick={() => onOpenLightbox(displayUrl)}
          className="w-28 aspect-video bg-background rounded-lg overflow-hidden flex items-center justify-center border border-border disabled:cursor-default hover:ring-1 hover:ring-primary/50 transition-shadow"
        >
          {displayUrl ? (
            <img
              src={displayUrl}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : hasImage ? (
            <span className="text-[10px] text-textMuted">Loading…</span>
          ) : (
            <ImageIcon className="text-border" size={20} />
          )}
        </button>
      </td>
      <td className="p-3" onClick={(e) => e.stopPropagation()}>
        <OverlayStatusBadge status={status} onToggle={onToggleApproval} />
      </td>
    </tr>
  );
}

function ImagesTabContent({
  hasTranscript,
  transcribing,
  transcriptionBusy,
  transcriptionProgress,
  hasAnalysis,
  generating,
  imageProgress,
  manifest,
  displayUrls,
  approvedSuggestionIds,
  selectedSuggestionId,
  approvedNeedingImagesCount,
  approvedWithImagesCount,
  onTranscribe,
  onGenerate,
  onToggleImage,
  onSelectImage,
  onOpenLightbox,
}: {
  hasTranscript: boolean;
  transcribing: boolean;
  transcriptionBusy: boolean;
  transcriptionProgress: PipelineProgress | null;
  hasAnalysis: boolean;
  generating: boolean;
  imageProgress: ImageGenerationProgress | null;
  manifest: OverlayImagesManifest | null;
  displayUrls: Record<string, string>;
  approvedSuggestionIds: Set<string>;
  selectedSuggestionId: string | null;
  approvedNeedingImagesCount: number;
  approvedWithImagesCount: number;
  onTranscribe: () => void;
  onGenerate: () => void;
  onToggleImage: (id: string) => void;
  onSelectImage: (id: string) => void;
  onOpenLightbox: (
    img: { suggestionId: string; title: string; transcriptExcerpt: string },
    imageUrl?: string,
  ) => void;
}) {
  if (!hasTranscript) {
    return (
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <EpisodeTranscribeBar
          transcribing={transcribing}
          transcriptionBusy={transcriptionBusy}
          progress={transcriptionProgress}
          onTranscribe={onTranscribe}
        />
        <TabEmptyState
          title="Transcribe this episode to get started."
          hint='After transcription, analyze overlays on the Overlays tab, then return here to generate images.'
        />
      </div>
    );
  }

  if (!hasAnalysis) {
    return (
      <TabEmptyState
        title="Analyze the transcript before generating images."
        hint='Open the Overlays tab and click "Generate overlay suggestions" to create overlay suggestions.'
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <ImagesTabBody
        generating={generating}
        imageProgress={imageProgress}
        manifest={manifest}
        displayUrls={displayUrls}
        approvedSuggestionIds={approvedSuggestionIds}
        selectedSuggestionId={selectedSuggestionId}
        approvedNeedingImagesCount={approvedNeedingImagesCount}
        approvedWithImagesCount={approvedWithImagesCount}
        onGenerate={onGenerate}
        onToggleImage={onToggleImage}
        onSelectImage={onSelectImage}
        onOpenLightbox={onOpenLightbox}
      />
    </div>
  );
}

function ImagesTabBody(props: {
  generating: boolean;
  imageProgress: ImageGenerationProgress | null;
  manifest: OverlayImagesManifest | null;
  displayUrls: Record<string, string>;
  approvedSuggestionIds: Set<string>;
  selectedSuggestionId: string | null;
  approvedNeedingImagesCount: number;
  approvedWithImagesCount: number;
  onGenerate: () => void;
  onToggleImage: (id: string) => void;
  onSelectImage: (id: string) => void;
  onOpenLightbox: (
    img: { suggestionId: string; title: string; transcriptExcerpt: string },
    imageUrl?: string,
  ) => void;
}) {
  const {
    generating,
    imageProgress,
    manifest,
    displayUrls,
    approvedSuggestionIds,
    selectedSuggestionId,
    approvedNeedingImagesCount,
    approvedWithImagesCount,
    onGenerate,
    onToggleImage,
    onSelectImage,
    onOpenLightbox,
  } = props;

  const regenerateMode =
    (manifest?.images.length ?? 0) > 0 && approvedNeedingImagesCount === 0;
  const actionableCount = regenerateMode
    ? approvedWithImagesCount
    : approvedNeedingImagesCount;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <button
        type="button"
        disabled={generating || actionableCount === 0}
        onClick={onGenerate}
        className="self-start flex-shrink-0 bg-primary hover:bg-primaryHover text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {generating
          ? regenerateMode
            ? "Regenerating images…"
            : "Generating images…"
          : regenerateMode
            ? `Regenerate all (${actionableCount} selected)`
            : `Generate images (${actionableCount} approved)`}
      </button>
      {approvedSuggestionIds.size > 0 &&
        actionableCount === 0 &&
        !generating &&
        !regenerateMode && (
        <p className="text-xs text-textMuted flex-shrink-0">
          All approved overlays already have images. Exclude overlays on the Overlays tab to skip
          them, or approve more suggestions.
        </p>
      )}

      {generating && imageProgress && (
        <div className="text-sm text-textMuted flex-shrink-0">
          <strong className="text-white">{imageProgress.stage}</strong>
          {imageProgress.message ? ` — ${imageProgress.message}` : ""} ({imageProgress.index}/
          {imageProgress.total})
        </div>
      )}

      {manifest && manifest.images.length > 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-2">
          {manifest.images.map((img) => (
            <ImageSelectCard
              key={img.suggestionId}
              img={img}
              displayUrl={displayUrls[img.suggestionId]}
              approved={approvedSuggestionIds.has(img.suggestionId)}
              isFocused={selectedSuggestionId === img.suggestionId}
              onToggle={() => onToggleImage(img.suggestionId)}
              onSelect={() => onSelectImage(img.suggestionId)}
              onOpenLightbox={() =>
                onOpenLightbox(img, displayUrls[img.suggestionId])
              }
            />
          ))}
          </div>
        </div>
      ) : !generating ? (
        <TabEmptyState
          title="No images generated yet."
          hint='Approve overlays on the Overlays tab, then click "Generate images" above. All overlays are approved by default after analysis.'
        />
      ) : null}
    </div>
  );
}

function ImageSelectCard({
  img,
  displayUrl,
  approved,
  isFocused,
  onToggle,
  onSelect,
  onOpenLightbox,
}: {
  img: { suggestionId: string; title: string; transcriptExcerpt: string };
  displayUrl?: string;
  approved: boolean;
  isFocused: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onOpenLightbox: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`rounded-xl border p-3 text-left transition-colors cursor-pointer ${
        isFocused ? "border-primary bg-primary bg-opacity-5" : "border-border bg-surface"
      }`}
    >
      <div className="flex items-start gap-2 mb-2" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={approved}
          onChange={onToggle}
          className="mt-0.5 rounded border-border"
          aria-label={`Include ${img.title} in final video`}
        />
        <p className="text-sm font-medium text-white flex-1 min-w-0">{img.title}</p>
      </div>
      <button
        type="button"
        disabled={!displayUrl}
        title={displayUrl ? "View image" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onOpenLightbox();
        }}
        className="w-full aspect-video bg-background rounded-lg overflow-hidden flex items-center justify-center border border-border disabled:cursor-default hover:ring-1 hover:ring-primary/50 transition-shadow"
      >
        {displayUrl ? (
          <img src={displayUrl} alt={img.title} className="w-full h-full object-cover" />
        ) : (
          <ImageIcon className="text-border" size={32} />
        )}
      </button>
      <p
        className="text-xs text-textMuted mt-2 leading-relaxed line-clamp-4"
        title={img.transcriptExcerpt}
      >
        {img.transcriptExcerpt}
      </p>
    </div>
  );
}

function TranscriptTabContent({
  transcript,
  hasTranscript,
  transcribing,
  transcriptionBusy,
  transcriptionProgress,
  onTranscribe,
}: {
  transcript: Transcript | null;
  hasTranscript: boolean;
  transcribing: boolean;
  transcriptionBusy: boolean;
  transcriptionProgress: PipelineProgress | null;
  onTranscribe: () => void;
}) {
  if (!hasTranscript) {
    return (
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <EpisodeTranscribeBar
          transcribing={transcribing}
          transcriptionBusy={transcriptionBusy}
          progress={transcriptionProgress}
          onTranscribe={onTranscribe}
        />
        <TabEmptyState
          title="Transcribe this episode to get started."
          hint='Click "Transcribe" above. The full transcript will appear here when finished.'
        />
      </div>
    );
  }
  if (!transcript) {
    return (
      <TabEmptyState
        title="Transcript not found for this episode."
        hint="Try refreshing the project from Overview, or re-run transcription if the file was removed."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <p className="text-xs text-textMuted flex-shrink-0">
        {transcript.segments.length} segments
        {transcript.appliedTranscriptTimingOffsetMs != null &&
          ` · timing offset ${transcript.appliedTranscriptTimingOffsetMs}ms`}
      </p>
      <TranscriptSegmentList transcript={transcript} />
    </div>
  );
}

function TranscriptSegmentList({ transcript }: { transcript: Transcript }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
      {transcript.segments.map((seg, i) => (
        <div key={i} className="p-3 rounded-lg bg-surface border border-border text-sm">
          <span className="text-primary text-xs font-mono mr-2">
            {formatTimeRangeMs(seg.startMs, seg.endMs)}
          </span>
          <span className="text-white">{seg.text}</span>
        </div>
      ))}
    </div>
  );
}

function PromptPanel({
  suggestion,
  promptText,
  isPromptEdited,
  onPromptChange,
  onRevertPrompt,
  versionTiles,
  displayUrls,
  videoId,
  onRegenerateImage,
  regenerating,
  hasAnalysis,
  onOpenLightbox,
}: {
  suggestion: OverlaySuggestion | null;
  promptText: string;
  isPromptEdited: boolean;
  onPromptChange: (text: string) => void;
  onRevertPrompt: () => void;
  versionTiles: OverlayImageVersionTile[];
  displayUrls: Record<string, string>;
  videoId: string;
  onRegenerateImage: () => void;
  regenerating: boolean;
  hasAnalysis: boolean;
  onOpenLightbox: (
    img: { suggestionId: string; title: string; transcriptExcerpt: string },
    imageUrl?: string,
  ) => void;
}) {
  const hasImages = versionTiles.length > 0;
  return (
    <div className="w-[260px] lg:w-[280px] xl:w-[300px] min-w-[240px] flex flex-col gap-4 flex-shrink-0 overflow-y-auto">
      <div className="bg-surface border border-border rounded-xl flex flex-col overflow-hidden">
        <PromptPanelHeader />
        <div className="p-5 flex-1 overflow-y-auto">
          {suggestion ? (
            <>
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-textMuted text-xs font-semibold uppercase tracking-wider">
                  Prompt
                </h3>
                <button
                  type="button"
                  onClick={onRevertPrompt}
                  disabled={!isPromptEdited}
                  title="Revert to original AI prompt"
                  className="p-1.5 rounded-lg text-textMuted hover:text-white hover:bg-white hover:bg-opacity-5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Revert prompt to original"
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              <textarea
                value={promptText}
                onChange={(e) => onPromptChange(e.target.value)}
                rows={8}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-white leading-relaxed mb-1 resize-y min-h-[8rem] focus:outline-none focus:border-primary"
                aria-label="Image generation prompt"
              />
              {isPromptEdited ? (
                <p className="text-[10px] text-primary mb-4">Using edited prompt for regenerate</p>
              ) : (
                <p className="text-[10px] text-textMuted mb-4">Original AI prompt</p>
              )}
              {suggestion.overlayText && (
                <>
                  <h3 className="text-textMuted text-xs font-semibold uppercase tracking-wider mb-2">
                    On-screen text
                  </h3>
                  <p className="text-sm text-textMuted mb-4">{suggestion.overlayText}</p>
                </>
              )}
              <h3 className="text-white text-sm font-medium mb-3">Images for this overlay</h3>
              {versionTiles.length === 0 ? (
                <p className="text-xs text-textMuted mb-4">Not generated yet.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {versionTiles.map((tile) => {
                    const url = displayUrls[tile.relativePath];
                    return (
                      <button
                        key={tile.relativePath}
                        type="button"
                        disabled={!url}
                        title={url ? `${tile.versionLabel} — view image` : undefined}
                        onClick={() =>
                          onOpenLightbox(
                            {
                              suggestionId: tile.suggestionId,
                              title: tile.title,
                              transcriptExcerpt: tile.transcriptExcerpt,
                            },
                            url,
                          )
                        }
                        className={`aspect-video bg-background border rounded-lg overflow-hidden relative disabled:cursor-default hover:ring-1 hover:ring-primary/50 transition-shadow ${
                          tile.isLatest ? "border-primary/60" : "border-border"
                        }`}
                      >
                        {url ? (
                          <img src={url} alt={tile.title} className="w-full h-full object-cover" />
                        ) : (
                          <ImageIcon className="absolute inset-0 m-auto text-border" size={24} />
                        )}
                        <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-[10px] text-white px-1 py-0.5 text-center truncate">
                          {tile.versionLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <p className="text-textMuted text-sm">Select an overlay row to view its prompt.</p>
          )}
          {hasAnalysis && suggestion && (
            <button
              type="button"
              disabled={regenerating || !hasImages}
              onClick={onRegenerateImage}
              className="w-full py-2.5 bg-primary hover:bg-primaryHover text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Wand2 size={14} /> Regenerate image
            </button>
          )}
          {hasAnalysis && suggestion && !hasImages && (
            <p className="text-xs text-textMuted mt-2 text-center">
              Generate this overlay on the Images tab first, then regenerate here.
            </p>
          )}
        </div>
      </div>

      <QuickActionsCard videoId={videoId} />
    </div>
  );
}

function PromptPanelHeader() {
  return (
    <div className="px-5 py-3 border-b border-border bg-[#151821]">
      <span className="text-sm font-medium text-white">Image Prompt</span>
    </div>
  );
}

function QuickActionsCard({ videoId }: { videoId: string }) {
  const navigate = useNavigate();
  return (
    <QuickActionsBody navigate={navigate} videoId={videoId} />
  );
}

function QuickActionsBody({
  navigate,
  videoId,
}: {
  navigate: ReturnType<typeof useNavigate>;
  videoId: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 flex-shrink-0">
      <h3 className="text-white text-sm font-medium mb-4">Quick Actions</h3>
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => navigate("/videos", { state: { videoId: videoId || undefined } })}
          className="w-full flex items-center gap-3 text-sm text-textMuted hover:text-white"
        >
          <Zap size={16} /> Open Videos
        </button>
        <button
          type="button"
          onClick={() => navigate("/settings")}
          className="w-full flex items-center gap-3 text-sm text-textMuted hover:text-white"
        >
          <Edit2 size={16} /> Pipeline settings
        </button>
      </div>
    </div>
  );
}

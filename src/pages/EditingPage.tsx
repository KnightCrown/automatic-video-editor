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
} from "lucide-react";
import { useProject } from "../context/ProjectContext";
import {
  analyzeTranscriptWithOpenai,
  generateOverlayImages,
  getOverlayImageDisplayUrl,
  getOverlayImagesManifest,
  getTranscript,
  getTranscriptAnalysis,
  isApiKeySet,
  isXaiApiKeySet,
  openProject,
  prepareFinalVideoTimelineWithSelection,
} from "../services/pipelineService";
import type {
  ImageGenerationProgress,
  OverlayImagesManifest,
  OverlaySuggestion,
  Transcript,
  TranscriptAnalysis,
} from "../types/pipeline";
import {
  displayPipelineStatus,
  formatIdealDisplayMs,
  formatTimeRangeMs,
  videoHasTranscriptArtifact,
} from "../utils/format";

type TabId = "overlays" | "images" | "transcript";

export function EditingPage() {
  const { project, setProject, refreshProject } = useProject();
  const location = useLocation();
  const navigate = useNavigate();
  const initialVideoId = (location.state as { videoId?: string } | null)?.videoId;

  const [activeVideoId, setActiveVideoId] = useState<string | null>(initialVideoId ?? null);
  const [activeTab, setActiveTab] = useState<TabId>("overlays");
  const [analysis, setAnalysis] = useState<TranscriptAnalysis | null>(null);
  const [manifest, setManifest] = useState<OverlayImagesManifest | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState<string | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());
  const [displayUrls, setDisplayUrls] = useState<Record<string, string>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [imageProgress, setImageProgress] = useState<ImageGenerationProgress | null>(null);
  const [creatingVideo, setCreatingVideo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKeySet, setApiKeySet] = useState<boolean | null>(null);
  const [xaiKeySet, setXaiKeySet] = useState<boolean | null>(null);

  const activeVideo = useMemo(() => {
    if (!project) return null;
    return project.videos.find((v) => v.id === activeVideoId) || project.videos[0] || null;
  }, [project, activeVideoId]);

  useEffect(() => {
    isApiKeySet().then(setApiKeySet);
    isXaiApiKeySet().then(setXaiKeySet);
  }, []);

  useEffect(() => {
    if (!activeVideoId && project?.videos?.length) {
      setActiveVideoId(initialVideoId ?? project.videos[0].id);
    }
  }, [project, activeVideoId, initialVideoId]);

  const reloadEpisodeData = useCallback(async () => {
    if (!project || !activeVideo) return;
    const [a, m, t] = await Promise.all([
      getTranscriptAnalysis(project.rootPath, activeVideo.id).catch(() => null),
      getOverlayImagesManifest(project.rootPath, activeVideo.id).catch(() => null),
      getTranscript(project.rootPath, activeVideo.id).catch(() => null),
    ]);
    setAnalysis(a);
    setManifest(m);
    setTranscript(t);
    if (a?.suggestions.length && !selectedSuggestionId) {
      setSelectedSuggestionId(a.suggestions[0].id);
    }
    if (m?.images.length) {
      setSelectedImageIds((prev) => {
        if (prev.size > 0) return prev;
        return new Set(m.images.map((img) => img.suggestionId));
      });
    }
  }, [project, activeVideo, selectedSuggestionId]);

  useEffect(() => {
    void reloadEpisodeData();
  }, [reloadEpisodeData]);

  useEffect(() => {
    if (!project?.rootPath || !manifest?.images.length) {
      setDisplayUrls({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const urls: Record<string, string> = {};
      await Promise.all(
        manifest.images.map(async (img) => {
          try {
            urls[img.suggestionId] = await getOverlayImageDisplayUrl(
              project.rootPath,
              img.relativePath,
            );
          } catch {
            /* skip */
          }
        }),
      );
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

  const imagesForSuggestion = useMemo(() => {
    if (!manifest || !selectedSuggestionId) return [];
    return manifest.images.filter((img) => img.suggestionId === selectedSuggestionId);
  }, [manifest, selectedSuggestionId]);

  const generatedSuggestionIds = useMemo(
    () => new Set(manifest?.images.map((i) => i.suggestionId) ?? []),
    [manifest],
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
    setAnalyzing(true);
    setError(null);
    const keyReady = await isApiKeySet();
    setApiKeySet(keyReady);
    if (!keyReady) {
      setError("OpenAI API key is not set. Save your key in Settings first.");
      setAnalyzing(false);
      return;
    }
    try {
      const result = await analyzeTranscriptWithOpenai(project.rootPath, activeVideo.id);
      setAnalysis(result);
      if (result.suggestions.length) setSelectedSuggestionId(result.suggestions[0].id);
      await refreshProject();
    } catch (err) {
      setError(String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleGenerateImages() {
    if (!project || !activeVideo) return;
    setGenerating(true);
    setError(null);
    setImageProgress(null);
    const keyOk = await isXaiApiKeySet();
    setXaiKeySet(keyOk);
    if (!keyOk) {
      setError("xAI API key is not set. Save your key in Settings first.");
      setGenerating(false);
      return;
    }
    try {
      const m = await generateOverlayImages(project.rootPath, activeVideo.id, (p) =>
        setImageProgress(p),
      );
      setManifest(m);
      setSelectedImageIds(new Set(m.images.map((img) => img.suggestionId)));
      await refreshProject();
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
      setImageProgress(null);
    }
  }

  async function handleCreateVideo() {
    if (!project || !activeVideo || selectedImageIds.size === 0) return;
    setCreatingVideo(true);
    setError(null);
    try {
      await prepareFinalVideoTimelineWithSelection(project.rootPath, activeVideo.id, [
        ...selectedImageIds,
      ]);
      navigate("/final-video", { state: { createdVideoIds: [activeVideo.id] } });
    } catch (err) {
      setError(String(err));
    } finally {
      setCreatingVideo(false);
    }
  }

  function toggleImage(suggestionId: string) {
    setSelectedImageIds((prev) => {
      const next = new Set(prev);
      if (next.has(suggestionId)) next.delete(suggestionId);
      else next.add(suggestionId);
      return next;
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
            disabled={creatingVideo || selectedImageIds.size === 0 || !activeVideo}
            onClick={() => void handleCreateVideo()}
            className="bg-[#8B5CF6] hover:bg-[#7C3AED] text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
          >
            <Film size={16} />
            {creatingVideo ? "Creating…" : `Create video (${selectedImageIds.size})`}
          </button>
          <button
            type="button"
            onClick={() => navigate("/final-video")}
            className="bg-surface border border-border px-3 py-2 rounded-lg text-sm text-textMuted hover:text-white"
          >
            Final video
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-danger bg-opacity-20 text-danger text-sm border border-danger border-opacity-30">
          {error}
        </div>
      )}

      {apiKeySet === false && (
        <p className="text-sm text-danger mb-4">OpenAI API key missing — set it in Settings.</p>
      )}
      {xaiKeySet === false && activeTab === "images" && (
        <p className="text-sm text-danger mb-4">xAI API key missing — set it in Settings.</p>
      )}

      <div className="flex-1 flex gap-6 overflow-hidden min-h-0">
        <EpisodeListPanel
          videos={project.videos}
          activeVideoId={activeVideo?.id ?? null}
          onSelect={setActiveVideoId}
          onAddEpisodes={() => void handleAddEpisodes()}
        />

        <div className="flex-[2] flex flex-col bg-surface border border-border rounded-xl overflow-hidden min-w-0">
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
                    analyzing={analyzing}
                    hasAnalysis={hasAnalysis}
                    analysis={analysis}
                    generatedSuggestionIds={generatedSuggestionIds}
                    selectedSuggestionId={selectedSuggestionId}
                    onAnalyze={() => void handleAnalyze()}
                    onSelectSuggestion={setSelectedSuggestionId}
                  />
                )}
                {activeTab === "images" && (
                  <ImagesTabContent
                    hasTranscript={hasTranscript}
                    hasAnalysis={hasAnalysis}
                    generating={generating}
                    imageProgress={imageProgress}
                    manifest={manifest}
                    displayUrls={displayUrls}
                    selectedImageIds={selectedImageIds}
                    onGenerate={() => void handleGenerateImages()}
                    onToggleImage={toggleImage}
                  />
                )}
                {activeTab === "transcript" && (
                  <TranscriptTabContent transcript={transcript} hasTranscript={hasTranscript} />
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
          imagesForSuggestion={imagesForSuggestion}
          displayUrls={displayUrls}
          videoId={activeVideo?.id ?? ""}
          onGenerateImages={() => void handleGenerateImages()}
          generating={generating}
          hasAnalysis={hasAnalysis}
        />
      </div>
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
  activeVideoId,
  onSelect,
  onAddEpisodes,
}: {
  videos: { id: string; fileName: string; status: string }[];
  activeVideoId: string | null;
  onSelect: (id: string) => void;
  onAddEpisodes: () => void;
}) {
  return (
    <div className="w-64 flex flex-col bg-surface border border-border rounded-xl overflow-hidden flex-shrink-0">
      <div className="p-4 border-b border-border flex justify-between items-center bg-[#151821]">
        <h3 className="text-sm font-semibold text-white">Episodes ({videos.length})</h3>
        <button
          type="button"
          onClick={onAddEpisodes}
          className="flex items-center gap-1.5 text-xs text-textMuted hover:text-white font-medium px-2 py-1 bg-white bg-opacity-5 rounded border border-white border-opacity-10"
        >
          <Plus size={14} /> Add episodes
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {videos.map((video) => (
          <button
            key={video.id}
            type="button"
            onClick={() => onSelect(video.id)}
            className={`w-full text-left p-3 rounded-xl border transition-colors flex items-center justify-between ${
              activeVideoId === video.id
                ? "bg-[#3B82F6] bg-opacity-10 border-[#3B82F6] border-opacity-50"
                : "bg-background border-border hover:border-gray-600"
            }`}
          >
            <p
              className={`text-sm font-medium truncate ${
                activeVideoId === video.id ? "text-white" : "text-textMain"
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

function OverlaysTabContent({
  hasTranscript,
  analyzing,
  hasAnalysis,
  analysis,
  generatedSuggestionIds,
  selectedSuggestionId,
  onAnalyze,
  onSelectSuggestion,
}: {
  hasTranscript: boolean;
  analyzing: boolean;
  hasAnalysis: boolean;
  analysis: TranscriptAnalysis | null;
  generatedSuggestionIds: Set<string>;
  selectedSuggestionId: string | null;
  onAnalyze: () => void;
  onSelectSuggestion: (id: string) => void;
}) {
  if (!hasTranscript) {
    return (
      <TabEmptyState
        title="Transcribe this episode to get started."
        hint="Go to Overview and run transcription for this video. Overlay suggestions appear after analysis."
      />
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
        {analyzing ? "Analyzing transcript…" : "Analyze transcript with OpenAI"}
      </button>

      {analyzing && (
        <p className="text-textMuted text-sm flex-shrink-0">Sending transcript to OpenAI…</p>
      )}

      {hasAnalysis && analysis && (
        <div className="rounded-xl border border-border bg-surface overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#151821] text-textMuted border-b border-border sticky top-0 z-10">
              <tr>
                <th className="p-3 font-medium w-28">Time</th>
                <th className="p-3 font-medium">Title</th>
                <th className="p-3 font-medium">Excerpt</th>
                <th className="p-3 font-medium w-24">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {analysis.suggestions.map((s) => (
                <SuggestionRow
                  key={s.id}
                  suggestion={s}
                  selected={selectedSuggestionId === s.id}
                  hasImage={generatedSuggestionIds.has(s.id)}
                  onSelect={() => onSelectSuggestion(s.id)}
                />
              ))}
            </tbody>
            </table>
          </div>
        </div>
      )}

      {!hasAnalysis && !analyzing && (
        <TabEmptyState
          title="No overlay suggestions yet."
          hint='Click "Analyze transcript with OpenAI" above to generate overlay suggestions from the transcript.'
        />
      )}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  selected,
  hasImage,
  onSelect,
}: {
  suggestion: OverlaySuggestion;
  selected: boolean;
  hasImage: boolean;
  onSelect: () => void;
}) {
  return (
    <tr
      className={`cursor-pointer hover:bg-white hover:bg-opacity-5 ${
        selected ? "bg-primary bg-opacity-10" : ""
      }`}
      onClick={onSelect}
    >
      <td className="p-3 text-white whitespace-nowrap">
        {formatTimeRangeMs(suggestion.startMs, suggestion.endMs)}
        <br />
        <span className="text-xs text-textMuted">{formatIdealDisplayMs(suggestion.idealDisplayMs)}</span>
      </td>
      <td className="p-3 text-white font-medium">{suggestion.title}</td>
      <td className="p-3 text-textMuted max-w-md">{suggestion.transcriptExcerpt}</td>
      <td className="p-3">
        <span
          className={`text-xs px-2 py-1 rounded ${
            hasImage
              ? "bg-success bg-opacity-20 text-success"
              : "bg-white bg-opacity-5 text-textMuted"
          }`}
        >
          {hasImage ? "Generated" : "Pending"}
        </span>
      </td>
    </tr>
  );
}

function ImagesTabContent({
  hasTranscript,
  hasAnalysis,
  generating,
  imageProgress,
  manifest,
  displayUrls,
  selectedImageIds,
  onGenerate,
  onToggleImage,
}: {
  hasTranscript: boolean;
  hasAnalysis: boolean;
  generating: boolean;
  imageProgress: ImageGenerationProgress | null;
  manifest: OverlayImagesManifest | null;
  displayUrls: Record<string, string>;
  selectedImageIds: Set<string>;
  onGenerate: () => void;
  onToggleImage: (id: string) => void;
}) {
  if (!hasTranscript) {
    return (
      <TabEmptyState
        title="Transcribe this episode to get started."
        hint="Image generation is available after transcription and overlay analysis on the Overlays tab."
      />
    );
  }

  if (!hasAnalysis) {
    return (
      <TabEmptyState
        title="Analyze the transcript before generating images."
        hint='Open the Overlays tab and click "Analyze transcript with OpenAI" to create overlay suggestions.'
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
        selectedImageIds={selectedImageIds}
        onGenerate={onGenerate}
        onToggleImage={onToggleImage}
      />
    </div>
  );
}

function ImagesTabBody(props: {
  generating: boolean;
  imageProgress: ImageGenerationProgress | null;
  manifest: OverlayImagesManifest | null;
  displayUrls: Record<string, string>;
  selectedImageIds: Set<string>;
  onGenerate: () => void;
  onToggleImage: (id: string) => void;
}) {
  const {
    generating,
    imageProgress,
    manifest,
    displayUrls,
    selectedImageIds,
    onGenerate,
    onToggleImage,
  } = props;

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <button
        type="button"
        disabled={generating}
        onClick={onGenerate}
        className="self-start flex-shrink-0 bg-primary hover:bg-primaryHover text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {generating ? "Generating images…" : "Generate images (Grok Imagine)"}
      </button>

      {generating && imageProgress && (
        <div className="text-sm text-textMuted flex-shrink-0">
          <strong className="text-white">{imageProgress.stage}</strong>
          {imageProgress.message ? ` — ${imageProgress.message}` : ""} ({imageProgress.index}/
          {imageProgress.total})
        </div>
      )}

      {manifest && manifest.images.length > 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pb-2">
          {manifest.images.map((img) => (
            <ImageSelectCard
              key={img.suggestionId}
              img={img}
              displayUrl={displayUrls[img.suggestionId]}
              selected={selectedImageIds.has(img.suggestionId)}
              onToggle={() => onToggleImage(img.suggestionId)}
            />
          ))}
          </div>
        </div>
      ) : !generating ? (
        <TabEmptyState
          title="No images generated yet."
          hint='Click "Generate images (Grok Imagine)" above to render images from your overlay suggestions.'
        />
      ) : null}
    </div>
  );
}

function ImageSelectCard({
  img,
  displayUrl,
  selected,
  onToggle,
}: {
  img: { suggestionId: string; title: string; imagePrompt: string };
  displayUrl?: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        selected ? "border-primary bg-primary bg-opacity-5" : "border-border bg-surface"
      }`}
    >
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white mb-2">{img.title}</p>
          <div className="aspect-video bg-background rounded-lg overflow-hidden mb-2 flex items-center justify-center">
            {displayUrl ? (
              <img src={displayUrl} alt={img.title} className="w-full h-full object-cover" />
            ) : (
              <ImageIcon className="text-border" size={32} />
            )}
          </div>
          <p className="text-xs text-textMuted line-clamp-3">{img.imagePrompt}</p>
        </div>
      </label>
    </div>
  );
}

function TranscriptTabContent({
  transcript,
  hasTranscript,
}: {
  transcript: Transcript | null;
  hasTranscript: boolean;
}) {
  if (!hasTranscript) {
    return (
      <TabEmptyState
        title="Transcribe this episode to get started."
        hint="The full transcript will appear here after you run transcription from Overview."
      />
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
  imagesForSuggestion,
  displayUrls,
  videoId,
  onGenerateImages,
  generating,
  hasAnalysis,
}: {
  suggestion: OverlaySuggestion | null;
  imagesForSuggestion: { suggestionId: string; title: string; relativePath: string }[];
  displayUrls: Record<string, string>;
  videoId: string;
  onGenerateImages: () => void;
  generating: boolean;
  hasAnalysis: boolean;
}) {
  return (
    <div className="w-[340px] flex flex-col gap-4 flex-shrink-0 overflow-y-auto">
      <div className="bg-surface border border-border rounded-xl flex flex-col overflow-hidden">
        <PromptPanelHeader />
        <div className="p-5 flex-1 overflow-y-auto">
          {suggestion ? (
            <>
              <h3 className="text-textMuted text-xs font-semibold uppercase tracking-wider mb-2">
                Prompt
              </h3>
              <p className="text-sm text-white leading-relaxed mb-4">{suggestion.imagePrompt}</p>
              {suggestion.overlayText && (
                <>
                  <h3 className="text-textMuted text-xs font-semibold uppercase tracking-wider mb-2">
                    On-screen text
                  </h3>
                  <p className="text-sm text-textMuted mb-4">{suggestion.overlayText}</p>
                </>
              )}
              <h3 className="text-white text-sm font-medium mb-3">Images for this overlay</h3>
              {imagesForSuggestion.length === 0 ? (
                <p className="text-xs text-textMuted mb-4">Not generated yet.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {imagesForSuggestion.map((img) => {
                    const url = displayUrls[img.suggestionId];
                    return (
                      <div
                        key={img.suggestionId}
                        className="aspect-video bg-background border border-border rounded-lg overflow-hidden relative"
                      >
                        {url ? (
                          <img src={url} alt={img.title} className="w-full h-full object-cover" />
                        ) : (
                          <ImageIcon className="absolute inset-0 m-auto text-border" size={24} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <p className="text-textMuted text-sm">Select an overlay row to view its prompt.</p>
          )}
          {hasAnalysis && (
            <button
              type="button"
              disabled={generating}
              onClick={onGenerateImages}
              className="w-full py-2.5 bg-primary hover:bg-primaryHover text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Wand2 size={14} /> Generate images
            </button>
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
          onClick={() => navigate("/final-video", { state: { createdVideoIds: videoId ? [videoId] : [] } })}
          className="w-full flex items-center gap-3 text-sm text-textMuted hover:text-white"
        >
          <Zap size={16} /> Open final video editor
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

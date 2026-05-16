import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useProject } from "../context/ProjectContext";
import { EpisodeAccordion, type EpisodePanelSpec } from "../components/EpisodeAccordion";
import {
  generateOverlayImages,
  getOverlayImageDisplayUrl,
  getOverlayImagesManifest,
  getTranscriptAnalysis,
  isXaiApiKeySet,
} from "../services/pipelineService";
import type {
  GeneratedOverlayImage,
  ImageGenerationProgress,
  OverlayImagesManifest,
  VideoJob,
} from "../types/pipeline";
import { downloadFromUrl, sanitizeDownloadFilename } from "../utils/download";

export function ImagesPage() {
  const { project, refreshProject } = useProject();
  const location = useLocation();
  const [xaiKeySet, setXaiKeySet] = useState<boolean | null>(null);
  const [manifestByVideo, setManifestByVideo] = useState<
    Record<string, OverlayImagesManifest | null>
  >({});
  const [analysisOkByVideo, setAnalysisOkByVideo] = useState<Record<string, boolean>>({});
  const [generatingVideoId, setGeneratingVideoId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImageGenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transcribedVideos =
    project?.videos.filter((v) => v.status === "transcribed") ?? [];
  const rootPath = project?.rootPath ?? "";

  useEffect(() => {
    isXaiApiKeySet().then(setXaiKeySet);
  }, []);

  const refreshManifestsAndAnalysis = useCallback(async () => {
    if (!project || transcribedVideos.length === 0) {
      setManifestByVideo({});
      setAnalysisOkByVideo({});
      return;
    }
    const manEntries = await Promise.all(
      transcribedVideos.map(async (v) => {
        const m = await getOverlayImagesManifest(project.rootPath, v.id);
        return [v.id, m] as const;
      }),
    );
    const anaEntries = await Promise.all(
      transcribedVideos.map(async (v) => {
        const a = await getTranscriptAnalysis(project.rootPath, v.id);
        return [v.id, !!(a && a.suggestions.length > 0)] as const;
      }),
    );
    setManifestByVideo(Object.fromEntries(manEntries));
    setAnalysisOkByVideo(Object.fromEntries(anaEntries));
  }, [project, transcribedVideos, location.pathname]);

  useEffect(() => {
    void refreshManifestsAndAnalysis();
  }, [refreshManifestsAndAnalysis]);

  const handleGenerate = useCallback(
    async (videoId: string) => {
      if (!project) return;
      setError(null);
      setGeneratingVideoId(videoId);
      setProgress(null);
      const keyOk = await isXaiApiKeySet();
      setXaiKeySet(keyOk);
      if (!keyOk) {
        setError(
          "xAI API key is not set. Open Settings and save your Grok Imagine (xAI) key.",
        );
        setGeneratingVideoId(null);
        return;
      }
      try {
        const m = await generateOverlayImages(
          project.rootPath,
          videoId,
          (p) => setProgress(p),
        );
        setManifestByVideo((prev) => ({ ...prev, [videoId]: m }));
        await refreshProject();
      } catch (err) {
        setError(String(err));
      } finally {
        setGeneratingVideoId(null);
        setProgress(null);
      }
    },
    [project, refreshProject],
  );

  const panels: EpisodePanelSpec[] = useMemo(
    () =>
      transcribedVideos.map((v) => ({
        id: v.id,
        title: v.fileName,
        subtitle: v.status,
        renderContent: () => (
          <ImagesEpisodeBody
            video={v}
            rootPath={rootPath}
            manifest={manifestByVideo[v.id] ?? null}
            analysisOk={analysisOkByVideo[v.id] ?? false}
            generating={
              generatingVideoId === v.id ? { progress } : null
            }
            onGenerate={() => handleGenerate(v.id)}
          />
        ),
      })),
    [
      transcribedVideos,
      rootPath,
      manifestByVideo,
      analysisOkByVideo,
      generatingVideoId,
      progress,
      handleGenerate,
    ],
  );

  if (!project) {
    return (
      <section className="page">
        <p className="muted">Open a project first from the Projects page.</p>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Images</h1>
        <p>
          Generate overlay art with xAI Grok Imagine per episode. Expand an episode to run
          generation and review prompts with previews. Use <strong>Gallery</strong> to download
          batches.
        </p>
      </header>

      {transcribedVideos.length === 0 ? (
        <p className="muted">
          Transcribe a video first, then run overlay analysis on the Overlays page.
        </p>
      ) : (
        <>
          {xaiKeySet === false && (
            <p className="error">
              xAI API key is not set. Open <strong>Settings</strong> → Grok Imagine (xAI), save
              your key, then return here.
            </p>
          )}

          {error && <p className="error">{error}</p>}

          <EpisodeAccordion panels={panels} />
        </>
      )}
    </section>
  );
}

function ImagesEpisodeBody({
  video,
  rootPath,
  manifest,
  analysisOk,
  generating,
  onGenerate,
}: {
  video: VideoJob;
  rootPath: string;
  manifest: OverlayImagesManifest | null;
  analysisOk: boolean;
  generating: { progress: ImageGenerationProgress | null } | null;
  onGenerate: () => void;
}) {
  const [displayUrls, setDisplayUrls] = useState<Record<string, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!manifest || manifest.images.length === 0 || !rootPath) {
      setDisplayUrls({});
      setPreviewErrors({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        manifest.images.map(async (img) => {
          try {
            const url = await getOverlayImageDisplayUrl(rootPath, img.relativePath);
            return { id: img.suggestionId, ok: true as const, url };
          } catch (e) {
            return { id: img.suggestionId, ok: false as const, message: String(e) };
          }
        }),
      );
      if (cancelled) return;
      const urls: Record<string, string> = {};
      const errs: Record<string, string> = {};
      for (const r of results) {
        if (r.ok) urls[r.id] = r.url;
        else errs[r.id] = r.message;
      }
      setDisplayUrls(urls);
      setPreviewErrors(errs);
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest, rootPath]);

  const busy = !!generating;

  return (
    <>
      {!analysisOk && (
        <p className="muted">
          No overlay suggestions for this episode. Open <strong>Overlays</strong> and run{" "}
          <em>Analyze transcript with OpenAI</em>.
        </p>
      )}

      <div className="actions-row" style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !analysisOk}
          onClick={onGenerate}
        >
          {busy ? "Generating images…" : "Generate images (Grok Imagine)"}
        </button>
      </div>

      {busy && generating?.progress && (
        <div className="card progress-card">
          <p>
            <strong>{generating.progress.stage}</strong>
            {generating.progress.message && ` — ${generating.progress.message}`}
          </p>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${
                  generating.progress.total > 0
                    ? (generating.progress.index / generating.progress.total) * 100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {busy && !generating?.progress && (
        <div className="card progress-card">
          <p className="muted">Starting image generation…</p>
        </div>
      )}

      {manifest && manifest.images.length > 0 && !busy && (
        <div className="card meta-card">
          <p className="muted">
            Generated {new Date(manifest.generatedAt).toLocaleString()} · Model: {manifest.model} ·{" "}
            {manifest.images.length} image{manifest.images.length === 1 ? "" : "s"}
          </p>
        </div>
      )}

      {manifest && manifest.images.length > 0 && (
        <div className="image-results">
          {manifest.images.map((img) => (
            <ImageResultCard
              key={img.suggestionId}
              videoId={video.id}
              img={img}
              displayUrl={displayUrls[img.suggestionId]}
              previewError={previewErrors[img.suggestionId]}
            />
          ))}
        </div>
      )}

      {!manifest && analysisOk && !busy && (
        <p className="muted">
          Click <strong>Generate images (Grok Imagine)</strong> to render each overlay prompt.
        </p>
      )}

      {manifest && manifest.images.length === 0 && !busy && (
        <p className="muted">No images in the last run. Try generating again after analysis.</p>
      )}
    </>
  );
}

function ImageResultCard({
  img,
  displayUrl,
  previewError,
  videoId,
}: {
  img: GeneratedOverlayImage;
  displayUrl?: string;
  previewError?: string;
  videoId: string;
}) {
  const file = `${sanitizeDownloadFilename(img.title)}-${img.suggestionId.slice(0, 8)}.png`;

  return (
    <div className="card image-result-card">
      <h3>{img.title}</h3>
      <div className="image-result-grid">
        <div className="image-result-preview">
          {displayUrl ? (
            <img src={displayUrl} alt={img.title} />
          ) : previewError ? (
            <p className="error" style={{ margin: 0, fontSize: "0.85rem" }}>
              Could not load preview: {previewError}
            </p>
          ) : (
            <p className="muted">Loading preview…</p>
          )}
        </div>
        <div className="image-result-text">
          {displayUrl && (
            <div className="image-result-actions">
              <button
                type="button"
                className="btn small primary"
                onClick={() => {
                  void downloadFromUrl(displayUrl, `${videoId}-${file}`);
                }}
              >
                Download PNG
              </button>
            </div>
          )}
          <p>
            <strong>Image prompt</strong>
          </p>
          <p className="prompt-cell">{img.imagePrompt}</p>
          <p>
            <strong>Transcript excerpt</strong>
          </p>
          <p className="excerpt-cell">{img.transcriptExcerpt}</p>
        </div>
      </div>
    </div>
  );
}

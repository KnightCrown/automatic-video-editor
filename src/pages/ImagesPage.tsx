import { useEffect, useState } from "react";
import { useProject } from "../context/ProjectContext";
import {
  generateOverlayImages,
  getOverlayImagesManifest,
  getTranscriptAnalysis,
  isXaiApiKeySet,
  readOverlayImageDataUrl,
} from "../services/pipelineService";
import type {
  GeneratedOverlayImage,
  ImageGenerationProgress,
  OverlayImagesManifest,
} from "../types/pipeline";

export function ImagesPage() {
  const { project, refreshProject } = useProject();
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [manifest, setManifest] = useState<OverlayImagesManifest | null>(null);
  const [analysisOk, setAnalysisOk] = useState(false);
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ImageGenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [xaiKeySet, setXaiKeySet] = useState<boolean | null>(null);

  const transcribedVideos =
    project?.videos.filter((v) => v.status === "transcribed") ?? [];

  useEffect(() => {
    isXaiApiKeySet().then(setXaiKeySet);
  }, []);

  useEffect(() => {
    if (!selectedVideoId && transcribedVideos.length > 0) {
      setSelectedVideoId(transcribedVideos[0].id);
    }
  }, [transcribedVideos, selectedVideoId]);

  const rootPath = project?.rootPath ?? "";

  useEffect(() => {
    if (!project || !selectedVideoId) {
      setManifest(null);
      setAnalysisOk(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const analysis = await getTranscriptAnalysis(rootPath, selectedVideoId);
      if (cancelled) return;
      setAnalysisOk(!!analysis && analysis.suggestions.length > 0);
      const m = await getOverlayImagesManifest(rootPath, selectedVideoId);
      if (cancelled) return;
      setManifest(m);
    })();
    return () => {
      cancelled = true;
    };
  }, [project, selectedVideoId, rootPath]);

  useEffect(() => {
    if (!manifest || !project) {
      setDataUrls({});
      return;
    }
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const img of manifest.images) {
        try {
          next[img.suggestionId] = await readOverlayImageDataUrl(
            project.rootPath,
            img.relativePath,
          );
        } catch {
          next[img.suggestionId] = "";
        }
        if (cancelled) return;
      }
      if (!cancelled) setDataUrls(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest, project]);

  async function handleGenerate() {
    if (!project || !selectedVideoId) return;
    setError(null);
    setGenerating(true);
    setProgress(null);
    const keyOk = await isXaiApiKeySet();
    setXaiKeySet(keyOk);
    if (!keyOk) {
      setError(
        "xAI API key is not set. Open Settings and save your Grok Imagine (xAI) key.",
      );
      setGenerating(false);
      return;
    }
    try {
      const m = await generateOverlayImages(
        project.rootPath,
        selectedVideoId,
        (p) => setProgress(p),
      );
      setManifest(m);
      await refreshProject();
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }

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
          Generate overlay art with xAI Grok Imagine from your analyzed prompts, then review images
          beside the prompt and transcript excerpt.
        </p>
      </header>

      {transcribedVideos.length === 0 ? (
        <p className="muted">Transcribe a video first, then run overlay analysis on the Overlays page.</p>
      ) : (
        <>
          {xaiKeySet === false && (
            <p className="error">
              xAI API key is not set. Open <strong>Settings</strong> → Grok Imagine (xAI), save
              your key, then return here.
            </p>
          )}

          {!analysisOk && (
            <p className="muted">
              No overlay suggestions for this video yet. Open <strong>Overlays</strong> and run{" "}
              <em>Analyze transcript with OpenAI</em> first.
            </p>
          )}

          <div className="card actions-row">
            <label className="field-inline">
              Video
              <select
                value={selectedVideoId}
                onChange={(e) => setSelectedVideoId(e.target.value)}
                disabled={generating}
              >
                {transcribedVideos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.fileName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn primary"
              disabled={generating || !selectedVideoId || !analysisOk}
              onClick={handleGenerate}
            >
              {generating ? "Generating images…" : "Generate images (Grok Imagine)"}
            </button>
          </div>

          {generating && progress && (
            <div className="card progress-card">
              <p>
                <strong>{progress.stage}</strong>
                {progress.message && ` — ${progress.message}`}
              </p>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${progress.total > 0 ? (progress.index / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && <p className="error">{error}</p>}

          {manifest && manifest.images.length > 0 && !generating && (
            <div className="card meta-card">
              <p className="muted">
                Generated {new Date(manifest.generatedAt).toLocaleString()} · Model:{" "}
                {manifest.model} · {manifest.images.length} image
                {manifest.images.length === 1 ? "" : "s"}
              </p>
            </div>
          )}

          {manifest && manifest.images.length > 0 && (
            <div className="image-results">
              {manifest.images.map((img) => (
                <ImageResultCard
                  key={img.suggestionId}
                  img={img}
                  dataUrl={dataUrls[img.suggestionId]}
                />
              ))}
            </div>
          )}

          {!manifest && analysisOk && !generating && (
            <p className="muted">
              Click <strong>Generate images (Grok Imagine)</strong> to render each overlay prompt.
            </p>
          )}

          {manifest && manifest.images.length === 0 && !generating && (
            <p className="muted">No images in the last run. Try generating again after analysis.</p>
          )}
        </>
      )}
    </section>
  );
}

function ImageResultCard({
  img,
  dataUrl,
}: {
  img: GeneratedOverlayImage;
  dataUrl?: string;
}) {
  return (
    <div className="card image-result-card">
      <h3>{img.title}</h3>
      <div className="image-result-grid">
        <div className="image-result-preview">
          {dataUrl ? (
            <img src={dataUrl} alt={img.title} />
          ) : (
            <p className="muted">Loading preview…</p>
          )}
        </div>
        <div className="image-result-text">
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

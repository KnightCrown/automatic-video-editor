import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useProject } from "../context/ProjectContext";
import { EpisodeAccordion, type EpisodePanelSpec } from "../components/EpisodeAccordion";
import {
  analyzeTranscriptWithOpenai,
  getTranscriptAnalysis,
  isApiKeySet,
} from "../services/pipelineService";
import type { TranscriptAnalysis } from "../types/pipeline";

export function OverlaysPage() {
  const { project } = useProject();
  const location = useLocation();
  const [analyzingVideoId, setAnalyzingVideoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKeySet, setApiKeySet] = useState<boolean | null>(null);
  const [analysisByVideo, setAnalysisByVideo] = useState<
    Record<string, TranscriptAnalysis | null>
  >({});

  const transcribedVideos =
    project?.videos.filter((v) => v.status === "transcribed") ?? [];

  useEffect(() => {
    isApiKeySet().then(setApiKeySet);
  }, []);

  const loadAnalyses = useCallback(async () => {
    if (!project || transcribedVideos.length === 0) {
      setAnalysisByVideo({});
      return;
    }
    const entries = await Promise.all(
      transcribedVideos.map(async (v) => {
        const a = await getTranscriptAnalysis(project.rootPath, v.id);
        return [v.id, a] as const;
      }),
    );
    setAnalysisByVideo(Object.fromEntries(entries));
  }, [project, transcribedVideos, location.pathname]);

  useEffect(() => {
    void loadAnalyses();
  }, [loadAnalyses]);

  const handleAnalyze = useCallback(
    async (videoId: string) => {
      if (!project) return;
      setAnalyzingVideoId(videoId);
      setError(null);
      const keyReady = await isApiKeySet();
      setApiKeySet(keyReady);
      if (!keyReady) {
        setError(
          "OpenAI API key is not set. Open Settings, enter your key, and click Save API key.",
        );
        setAnalyzingVideoId(null);
        return;
      }
      try {
        const result = await analyzeTranscriptWithOpenai(
          project.rootPath,
          videoId,
        );
        setAnalysisByVideo((prev) => ({ ...prev, [videoId]: result }));
      } catch (err) {
        setError(String(err));
      } finally {
        setAnalyzingVideoId(null);
      }
    },
    [project],
  );

  const panels: EpisodePanelSpec[] = useMemo(
    () =>
      transcribedVideos.map((v) => ({
        id: v.id,
        title: v.fileName,
        subtitle: v.status,
        renderContent: () => (
          <OverlaysEpisodeBody
            analysis={analysisByVideo[v.id] ?? null}
            analyzing={analyzingVideoId === v.id}
            onAnalyze={() => handleAnalyze(v.id)}
          />
        ),
      })),
    [transcribedVideos, analysisByVideo, analyzingVideoId, handleAnalyze],
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
        <h1>Overlays</h1>
        <p>
          Review OpenAI overlay suggestions per episode. Expand an episode to analyze or read
          results. Generate images on the <strong>Images</strong> tab after analysis.
        </p>
      </header>

      {transcribedVideos.length === 0 ? (
        <p className="muted">Transcribe videos first, then analyze the script here.</p>
      ) : (
        <>
          {apiKeySet === false && (
            <p className="error">
              OpenAI API key is not set. Open <strong>Settings</strong>, save your API key, then
              return here.
            </p>
          )}

          {error && <p className="error">{error}</p>}

          <EpisodeAccordion panels={panels} />
        </>
      )}
    </section>
  );
}

function OverlaysEpisodeBody({
  analysis,
  analyzing,
  onAnalyze,
}: {
  analysis: TranscriptAnalysis | null;
  analyzing: boolean;
  onAnalyze: () => void;
}) {
  function formatTime(ms?: number) {
    if (ms === undefined) return "—";
    const sec = Math.floor(ms / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function formatTimeRange(startMs?: number, endMs?: number) {
    if (startMs === undefined && endMs === undefined) return "—";
    return `${formatTime(startMs)}–${formatTime(endMs)}`;
  }

  function formatIdealDisplay(ms?: number) {
    if (ms === undefined) return "—";
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <>
      <div className="actions-row" style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          className="btn primary"
          disabled={analyzing}
          onClick={onAnalyze}
        >
          {analyzing ? "Analyzing transcript…" : "Analyze transcript with OpenAI"}
        </button>
      </div>

      {analyzing && (
        <div className="card loading-card">
          <div className="spinner" aria-hidden />
          <p>Sending full transcript to OpenAI. This may take a minute…</p>
        </div>
      )}

      {analysis && !analyzing && (
        <>
          <div className="card meta-card">
            <p className="muted">
              Last analyzed: {new Date(analysis.analyzedAt).toLocaleString()} · Model:{" "}
              {analysis.model}
            </p>
          </div>

          {analysis.bibleStories.length > 0 && (
            <div className="card">
              <h2>Bible stories discussed</h2>
              <ul className="story-list">
                {analysis.bibleStories.map((story) => (
                  <li key={story}>{story}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <h2>Overlay suggestions ({analysis.suggestions.length})</h2>
            {analysis.suggestions.length === 0 ? (
              <p className="muted">No overlay moments suggested for this video.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table suggestions-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Suggested on-screen</th>
                      <th>Title</th>
                      <th>Image prompt</th>
                      <th>On-screen text</th>
                      <th>Story</th>
                      <th>Excerpt</th>
                      <th>Rationale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.suggestions.map((s) => (
                      <tr key={s.id}>
                        <td>{formatTimeRange(s.startMs, s.endMs)}</td>
                        <td>{formatIdealDisplay(s.idealDisplayMs)}</td>
                        <td className="title-cell">{s.title}</td>
                        <td className="prompt-cell">{s.imagePrompt}</td>
                        <td>{s.overlayText ?? "—"}</td>
                        <td>{s.bibleStory ?? "—"}</td>
                        <td className="excerpt-cell">{s.transcriptExcerpt}</td>
                        <td className="rationale-cell">{s.rationale}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {!analysis && !analyzing && (
        <p className="muted">
          No analysis yet. Click <em>Analyze transcript with OpenAI</em> to review suggestions.
        </p>
      )}
    </>
  );
}

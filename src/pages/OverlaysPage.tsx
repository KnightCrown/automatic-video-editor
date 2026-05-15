import { useEffect, useState } from "react";
import { useProject } from "../context/ProjectContext";
import {
  analyzeTranscriptWithOpenai,
  getTranscriptAnalysis,
  isApiKeySet,
} from "../services/pipelineService";
import type { TranscriptAnalysis } from "../types/pipeline";

export function OverlaysPage() {
  const { project } = useProject();
  const [selectedVideoId, setSelectedVideoId] = useState<string>("");
  const [analysis, setAnalysis] = useState<TranscriptAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKeySet, setApiKeySet] = useState<boolean | null>(null);

  const transcribedVideos =
    project?.videos.filter((v) => v.status === "transcribed") ?? [];

  useEffect(() => {
    isApiKeySet().then(setApiKeySet);
  }, []);

  useEffect(() => {
    if (!selectedVideoId && transcribedVideos.length > 0) {
      setSelectedVideoId(transcribedVideos[0].id);
    }
  }, [transcribedVideos, selectedVideoId]);

  useEffect(() => {
    if (!project || !selectedVideoId) {
      setAnalysis(null);
      return;
    }
    getTranscriptAnalysis(project.rootPath, selectedVideoId)
      .then(setAnalysis)
      .catch((err) => setError(String(err)));
  }, [project, selectedVideoId]);

  if (!project) {
    return (
      <section className="page">
        <p className="muted">Open a project first from the Projects page.</p>
      </section>
    );
  }

  const rootPath = project.rootPath;

  async function handleAnalyze() {
    if (!selectedVideoId) return;
    setAnalyzing(true);
    setError(null);
    const keyReady = await isApiKeySet();
    setApiKeySet(keyReady);
    if (!keyReady) {
      setError(
        "OpenAI API key is not set. Open Settings, enter your key, and click Save API key.",
      );
      setAnalyzing(false);
      return;
    }
    try {
      const result = await analyzeTranscriptWithOpenai(
        rootPath,
        selectedVideoId,
      );
      setAnalysis(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setAnalyzing(false);
    }
  }

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

  return (
    <section className="page">
      <header className="page-header">
        <h1>Overlays</h1>
        <p>
          Review OpenAI overlay suggestions from the full transcript (text only). Generate images
          on the Images tab after analysis.
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

          <div className="card actions-row">
            <label className="field-inline">
              Video
              <select
                value={selectedVideoId}
                onChange={(e) => setSelectedVideoId(e.target.value)}
                disabled={analyzing}
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
              disabled={analyzing || !selectedVideoId}
              onClick={handleAnalyze}
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

          {error && <p className="error">{error}</p>}

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
                  <table className="data-table suggestions-table">
                    <thead>
                      <tr>
                        <th>Time</th>
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
                )}
              </div>
            </>
          )}

          {!analysis && !analyzing && !error && (
            <p className="muted">
              No analysis yet. Click &quot;Analyze transcript with OpenAI&quot; to review
              suggestions.
            </p>
          )}
        </>
      )}
    </section>
  );
}

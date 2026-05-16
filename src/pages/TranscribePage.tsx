import { useCallback, useEffect, useState } from "react";
import { useProject } from "../context/ProjectContext";
import {
  getTranscriptionPreflight,
  runTranscription,
  retryVideoTranscription,
} from "../services/pipelineService";
import { isParakeetModelReady } from "../services/parakeetModelService";
import type { PipelineProgress, TranscriptionPreflight } from "../types/pipeline";
import {
  errorStageLabel,
  formatTranscriptionError,
} from "../utils/transcriptionErrors";

export function TranscribePage() {
  const { project, setProject, refreshProject } = useProject();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<TranscriptionPreflight | null>(null);
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);

  const loadPreflight = useCallback(async () => {
    try {
      const result = await getTranscriptionPreflight();
      setPreflight(result);
    } catch {
      setPreflight(null);
    }
  }, []);

  useEffect(() => {
    loadPreflight();
  }, [loadPreflight, project?.updatedAt]);

  if (!project) {
    return (
      <section className="page">
        <p className="muted">Open a project first from the Projects page.</p>
      </section>
    );
  }

  const rootPath = project.rootPath;
  const canTranscribe =
    preflight?.ffmpegAvailable === true && preflight?.parakeetModelReady === true;

  async function handleRunAll() {
    setError(null);
    setRunning(true);
    try {
      await loadPreflight();
      const ready = await isParakeetModelReady();
      const manifest = await runTranscription(
        rootPath,
        !ready,
        (p) => setProgress(p),
      );
      setProject(manifest);
      const failed = manifest.videos.find((v) => v.status === "failed" && v.error);
      if (failed?.error) {
        setExpandedErrorId(failed.id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
      setProgress(null);
      await loadPreflight();
    }
  }

  async function handleRetry(videoId: string) {
    setError(null);
    setRunning(true);
    setProgress(null);
    setExpandedErrorId(videoId);
    try {
      const manifest = await retryVideoTranscription(rootPath, videoId, (p) =>
        setProgress(p),
      );
      setProject(manifest);
      const video = manifest.videos.find((v) => v.id === videoId);
      if (video?.status === "failed" && video.error) {
        setError(formatTranscriptionError(video.error));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
      setProgress(null);
      await loadPreflight();
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Transcribe</h1>
        <p>Extract audio and transcribe with Parakeet. Analyze overlays on the Overlays page.</p>
      </header>

      {preflight && (
        <div
          className={`card preflight-card ${canTranscribe ? "preflight-ok" : "preflight-warn"}`}
        >
          <h2>Before you transcribe</h2>
          <ul className="preflight-list">
            <li>
              <strong>FFmpeg:</strong>{" "}
              {preflight.ffmpegAvailable ? (
                <>Found at {preflight.ffmpegPath}</>
              ) : (
                <span className="error">
                  {preflight.ffmpegError ??
                    "Not found — install FFmpeg and restart the app."}
                </span>
              )}
            </li>
            <li>
              <strong>Parakeet model:</strong>{" "}
              {preflight.parakeetModelReady ? (
                "Downloaded and ready"
              ) : preflight.parakeetMissingFiles.length > 0 ? (
                <span className="error">
                  Incomplete — missing: {preflight.parakeetMissingFiles.join(", ")}. Download
                  in Settings.
                </span>
              ) : (
                <span className="error">Not downloaded — open Settings to download.</span>
              )}
            </li>
          </ul>
        </div>
      )}

      <div className="card actions-row">
        <button
          type="button"
          className="btn primary"
          onClick={handleRunAll}
          disabled={running || preflight?.ffmpegAvailable === false}
          title={
            preflight?.ffmpegAvailable === false
              ? "Install FFmpeg first (see checklist above)"
              : undefined
          }
        >
          {running ? "Processing…" : "Run transcription pipeline"}
        </button>
        <button type="button" className="btn" onClick={refreshProject} disabled={running}>
          Refresh
        </button>
        <button type="button" className="btn" onClick={loadPreflight} disabled={running}>
          Re-check setup
        </button>
      </div>

      {progress && (
        <div className="card progress-card">
          <p>
            <strong>{progress.stage}</strong>
            {progress.message && ` — ${progress.message}`}
          </p>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.min(100, progress.percent)}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="card error-card">
          <strong>Pipeline error</strong>
          <p className="error">{formatTranscriptionError(error)}</p>
        </div>
      )}

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Video</th>
              <th>Status</th>
              <th className="actions-cell">Actions</th>
            </tr>
          </thead>
          <tbody>
            {project.videos.map((video) => (
              <tr
                key={video.id}
                className={video.status === "failed" ? "row-failed" : undefined}
              >
                <td>{video.fileName}</td>
                <td className="status-cell">
                  <div className="status-cell-stack">
                    <span className={`status-pill status-${video.status}`}>
                      {video.status}
                    </span>
                    {video.error ? (
                      <div className="error-detail">
                        {errorStageLabel(video.error) && (
                          <span className="error-stage">
                            {errorStageLabel(video.error)}
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() =>
                            setExpandedErrorId(
                              expandedErrorId === video.id ? null : video.id,
                            )
                          }
                        >
                          {expandedErrorId === video.id ? "Hide details" : "Show details"}
                        </button>
                        {expandedErrorId === video.id && (
                          <pre className="error-pre">
                            {formatTranscriptionError(video.error)}
                          </pre>
                        )}
                        {expandedErrorId !== video.id && (
                          <p className="error-summary">
                            {formatTranscriptionError(video.error)}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className="actions-cell">
                  {video.status === "transcribed" && (
                    <span className="muted">Saved transcript</span>
                  )}
                  {(video.status === "failed" || video.status === "pending") && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={running}
                      onClick={() => handleRetry(video.id)}
                    >
                      {video.status === "pending" ? "Transcribe" : "Retry"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import { useEffect, useState } from "react";
import { useProject } from "../context/ProjectContext";
import {
  clearApiKey,
  clearXaiApiKey,
  getApiKeyStorageHint,
  getXaiApiKeyStorageHint,
  isApiKeySet,
  isXaiApiKeySet,
  saveApiKey,
  saveXaiApiKey,
  updateProjectSettings,
} from "../services/pipelineService";
import {
  deleteParakeetModel,
  downloadParakeetModel,
  getParakeetModelInfo,
  isParakeetModelReady,
} from "../services/parakeetModelService";
import type { ParakeetDownloadProgress, ParakeetModelFile } from "../types/pipeline";

export function SettingsPage() {
  const { project, setProject } = useProject();
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyStorageHint, setApiKeyStorageHint] = useState<string | null>(null);
  const [xaiKey, setXaiKey] = useState("");
  const [xaiKeySet, setXaiKeySet] = useState(false);
  const [xaiKeyStorageHint, setXaiKeyStorageHint] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [modelFiles, setModelFiles] = useState<ParakeetModelFile[]>([]);
  const [downloadProgress, setDownloadProgress] =
    useState<ParakeetDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [showContext, setShowContext] = useState(
    project?.settings.showContext ??
      "Christian kids YouTube show. Friendly, colorful, simple overlays.",
  );
  const [textModel, setTextModel] = useState(
    project?.settings.openaiTextModel ?? "gpt-4.1-mini",
  );
  const [grokImagineModel, setGrokImagineModel] = useState(
    project?.settings.grokImagineModel ?? "grok-imagine-image",
  );
  const [transcriptTimingOffsetMs, setTranscriptTimingOffsetMs] = useState(
    project?.settings.transcriptTimingOffsetMs ?? 0,
  );

  useEffect(() => {
    isApiKeySet().then(setApiKeySet);
    getApiKeyStorageHint().then(setApiKeyStorageHint);
    isXaiApiKeySet().then(setXaiKeySet);
    getXaiApiKeyStorageHint().then(setXaiKeyStorageHint);
    isParakeetModelReady().then(setModelReady);
    getParakeetModelInfo().then(setModelFiles);
  }, []);

  useEffect(() => {
    if (!project) return;
    setShowContext(project.settings.showContext);
    setTextModel(project.settings.openaiTextModel);
    setGrokImagineModel(
      project.settings.grokImagineModel ?? "grok-imagine-image",
    );
    setTranscriptTimingOffsetMs(project.settings.transcriptTimingOffsetMs ?? 0);
  }, [project]);

  async function handleSaveApiKey() {
    setError(null);
    setMessage(null);
    if (!apiKey.trim()) {
      setError("Enter an API key before saving.");
      return;
    }
    try {
      await saveApiKey(apiKey);
      setApiKeySet(true);
      setApiKey("");
      const hint = await getApiKeyStorageHint();
      setApiKeyStorageHint(hint);
      setMessage(
        hint
          ? `API key saved (${hint}).`
          : "API key saved.",
      );
    } catch (err) {
      const raw = String(err);
      if (raw.includes("api_key_empty")) {
        setError("API key cannot be empty.");
      } else if (raw.includes("write_secrets_failed")) {
        setError(
          "Could not write the API key to disk. Check that your user profile folder is writable.",
        );
      } else {
        setError(raw);
      }
    }
  }

  async function handleClearApiKey() {
    await clearApiKey();
    setApiKeySet(false);
    setApiKeyStorageHint(null);
    setMessage("API key removed.");
  }

  async function handleSaveXaiKey() {
    setError(null);
    setMessage(null);
    if (!xaiKey.trim()) {
      setError("Enter your xAI API key before saving.");
      return;
    }
    try {
      await saveXaiApiKey(xaiKey);
      setXaiKeySet(true);
      setXaiKey("");
      const hint = await getXaiApiKeyStorageHint();
      setXaiKeyStorageHint(hint);
      setMessage(hint ? `xAI key saved (${hint}).` : "xAI key saved.");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleClearXaiKey() {
    await clearXaiApiKey();
    setXaiKeySet(false);
    setXaiKeyStorageHint(null);
    setMessage("xAI API key removed.");
  }

  async function handleDownloadModel() {
    setBusy(true);
    setError(null);
    setDownloadProgress(null);
    try {
      await downloadParakeetModel(setDownloadProgress);
      setModelReady(true);
      setMessage("Parakeet model downloaded.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setDownloadProgress(null);
    }
  }

  async function handleDeleteModel() {
    setBusy(true);
    setError(null);
    try {
      await deleteParakeetModel();
      setModelReady(false);
      setMessage("Parakeet model deleted.");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProjectSettings() {
    if (!project) return;
    setError(null);
    try {
      const manifest = await updateProjectSettings(project.rootPath, {
        ...project.settings,
        showContext,
        openaiTextModel: textModel,
        grokImagineModel,
        transcriptTimingOffsetMs: (() => {
          const n = Number(transcriptTimingOffsetMs);
          return Number.isFinite(n) ? Math.round(n) : 0;
        })(),
      });
      setProject(manifest);
      setMessage("Project settings saved.");
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h1>Settings</h1>
        <p>Configure local speech model, API keys, Grok Imagine, and show context.</p>
      </header>

      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}

      <div className="card">
        <h2>Parakeet speech model (local)</h2>
        <p className="muted">
          English TDT v3 INT8 (~670 MB). Transcription runs entirely on your device.
        </p>
        <p>
          Status:{" "}
          <span className={modelReady ? "success" : "muted"}>
            {modelReady ? "Ready" : "Not downloaded"}
          </span>
        </p>
        <ul className="file-list">
          {modelFiles.map((f) => (
            <li key={f.fileName}>
              {f.fileName} — {f.sizeLabel}
            </li>
          ))}
        </ul>
        {downloadProgress && (
          <div className="progress-card">
            <p>
              Downloading {downloadProgress.fileName} ({downloadProgress.fileIndex}/
              {downloadProgress.fileCount})
            </p>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${downloadProgress.progress ?? 0}%` }}
              />
            </div>
          </div>
        )}
        <div className="actions-row">
          <button
            type="button"
            className="btn primary"
            disabled={busy || modelReady}
            onClick={handleDownloadModel}
          >
            Download model
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !modelReady}
            onClick={handleDeleteModel}
          >
            Delete model
          </button>
        </div>
      </div>

      <div className="card">
        <h2>OpenAI API</h2>
        <p className="muted">
          Stored in your OS keychain when available; otherwise saved locally in app
          data for this user account. Used only for OpenAI analysis.
        </p>
        <p>
          Status: {apiKeySet ? "Key saved" : "No key saved"}
          {apiKeySet && apiKeyStorageHint && (
            <span className="muted"> ({apiKeyStorageHint})</span>
          )}
        </p>
        <label className="field">
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
          />
        </label>
        <div className="actions-row">
          <button type="button" className="btn primary" onClick={handleSaveApiKey}>
            Save API key
          </button>
          <button type="button" className="btn" onClick={handleClearApiKey}>
            Clear
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Grok Imagine (xAI)</h2>
        <p className="muted">
          Used for text-to-image overlay art. Create an API key at{" "}
          <a href="https://console.x.ai/" target="_blank" rel="noreferrer">
            console.x.ai
          </a>
          . Stored like the OpenAI key (keychain + local fallback).
        </p>
        <p>
          Status: {xaiKeySet ? "Key saved" : "No key saved"}
          {xaiKeySet && xaiKeyStorageHint && (
            <span className="muted"> ({xaiKeyStorageHint})</span>
          )}
        </p>
        <label className="field">
          xAI API key
          <input
            type="password"
            value={xaiKey}
            onChange={(e) => setXaiKey(e.target.value)}
            placeholder="xai-…"
          />
        </label>
        <div className="actions-row">
          <button type="button" className="btn primary" onClick={handleSaveXaiKey}>
            Save xAI key
          </button>
          <button type="button" className="btn" onClick={handleClearXaiKey}>
            Clear
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Show & pipeline</h2>
        {!project && (
          <p className="muted">Open a project to save per-project settings.</p>
        )}
        <label className="field">
          Show context (system prompt)
          <textarea
            rows={4}
            value={showContext}
            onChange={(e) => setShowContext(e.target.value)}
          />
        </label>
        <label className="field">
          OpenAI text model
          <input value={textModel} onChange={(e) => setTextModel(e.target.value)} />
        </label>
        <label className="field">
          Grok Imagine model (images)
          <input
            value={grokImagineModel}
            onChange={(e) => setGrokImagineModel(e.target.value)}
            placeholder="grok-imagine-image"
          />
        </label>
        <label className="field">
          Transcript timing offset (ms)
          <input
            type="number"
            step={50}
            value={transcriptTimingOffsetMs}
            onChange={(e) =>
              setTranscriptTimingOffsetMs(Number(e.target.value))
            }
          />
        </label>
        <p className="muted settings-note">
          If overlay times line up slightly <em>before</em> the speech in your editor,
          FFmpeg is still extracting full audio from the start of the file (no silence trim), and Parakeet
          timestamps span the whole clip—try a positive offset here (e.g. 200–800). Save, then transcribe again.
          Exported transcripts also store ffprobe <code>start_time</code> per stream under{" "}
          <code>probedVideoStreamStartSec</code> / <code>probedAudioStreamStartSec</code> for debugging.
        </p>
        <p className="muted settings-note">
          Overlay script analysis uses the OpenAI text model. The Grok Imagine model is used on the
          Images page for each overlay prompt.
        </p>
        <button
          type="button"
          className="btn primary"
          disabled={!project}
          onClick={handleSaveProjectSettings}
        >
          Save project settings
        </button>
      </div>
    </section>
  );
}

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  RefreshCw,
  Trash2,
  Key,
  Sparkles,
  Mic,
  Sliders,
  Film,
} from "lucide-react";
import { useProject } from "../context/ProjectContext";
import {
  deleteParakeetModel,
  downloadParakeetModel,
  getParakeetModelInfo,
  isParakeetModelReady,
} from "../services/parakeetModelService";
import {
  clearApiKey,
  clearXaiApiKey,
  getApiKeyStorageHint,
  getVideoExportPreflight,
  getXaiApiKeyStorageHint,
  isApiKeySet,
  isXaiApiKeySet,
  saveApiKey,
  saveXaiApiKey,
  updateProjectSettings,
} from "../services/pipelineService";
import type {
  ParakeetDownloadProgress,
  ParakeetModelFile,
  VideoExportEncoderKind,
  VideoExportMode,
  VideoExportPreflight,
  VideoExportQuality,
} from "../types/pipeline";

function encoderKindLabel(kind: VideoExportEncoderKind): string {
  switch (kind) {
    case "nvenc":
      return "NVIDIA NVENC";
    case "qsv":
      return "Intel Quick Sync";
    case "amf":
      return "AMD AMF";
    case "videoToolbox":
      return "Apple VideoToolbox";
    default:
      return "Software (libx264)";
  }
}

export function SettingsPage() {
  const { project, setProject } = useProject();
  const [modelReady, setModelReady] = useState(false);
  const [modelFiles, setModelFiles] = useState<ParakeetModelFile[]>([]);
  const [downloadProgress, setDownloadProgress] =
    useState<ParakeetDownloadProgress | null>(null);
  const [modelBusy, setModelBusy] = useState(false);

  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyStorageHint, setApiKeyStorageHint] = useState<string | null>(null);
  const [xaiKey, setXaiKey] = useState("");
  const [xaiKeySet, setXaiKeySet] = useState(false);
  const [xaiKeyStorageHint, setXaiKeyStorageHint] = useState<string | null>(null);

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
  const [videoExportMode, setVideoExportMode] = useState<VideoExportMode>(
    project?.settings.videoExportMode ?? "auto",
  );
  const [videoExportQuality, setVideoExportQuality] = useState<VideoExportQuality>(
    project?.settings.videoExportQuality ?? "balanced",
  );
  const [exportPreflight, setExportPreflight] = useState<VideoExportPreflight | null>(
    null,
  );

  useEffect(() => {
    void refreshModelStatus();
    void refreshKeys();
    getVideoExportPreflight().then(setExportPreflight).catch(() => setExportPreflight(null));
  }, []);

  useEffect(() => {
    if (!project) return;
    setShowContext(project.settings.showContext);
    setTextModel(project.settings.openaiTextModel);
    setGrokImagineModel(project.settings.grokImagineModel ?? "grok-imagine-image");
    setTranscriptTimingOffsetMs(project.settings.transcriptTimingOffsetMs ?? 0);
    setVideoExportMode(project.settings.videoExportMode ?? "auto");
    setVideoExportQuality(project.settings.videoExportQuality ?? "balanced");
  }, [project]);

  async function refreshModelStatus() {
    const ready = await isParakeetModelReady();
    setModelReady(ready);
    if (ready) setModelFiles(await getParakeetModelInfo());
    else setModelFiles([]);
  }

  async function refreshKeys() {
    setApiKeySet(await isApiKeySet());
    setApiKeyStorageHint(await getApiKeyStorageHint());
    setXaiKeySet(await isXaiApiKeySet());
    setXaiKeyStorageHint(await getXaiApiKeyStorageHint());
  }

  async function handleDownloadModel() {
    setModelBusy(true);
    setError(null);
    setDownloadProgress(null);
    try {
      await downloadParakeetModel(setDownloadProgress);
      setModelReady(true);
      setModelFiles(await getParakeetModelInfo());
      setMessage("Parakeet model downloaded.");
    } catch (err) {
      setError(String(err));
    } finally {
      setModelBusy(false);
      setDownloadProgress(null);
    }
  }

  async function handleDeleteModel() {
    setModelBusy(true);
    setError(null);
    try {
      await deleteParakeetModel();
      setModelReady(false);
      setModelFiles([]);
      setMessage("Parakeet model deleted.");
    } catch (err) {
      setError(String(err));
    } finally {
      setModelBusy(false);
    }
  }

  async function handleSaveApiKey() {
    setError(null);
    setMessage(null);
    if (!apiKey.trim()) {
      setError("Enter an API key before saving.");
      return;
    }
    try {
      await saveApiKey(apiKey);
      setApiKey("");
      await refreshKeys();
      setMessage(apiKeyStorageHint ? `API key saved.` : "API key saved.");
    } catch (err) {
      setError(String(err));
    }
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
      setXaiKey("");
      await refreshKeys();
      setMessage("xAI key saved.");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveProjectSettings() {
    if (!project) return;
    setError(null);
    setMessage(null);
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
        videoExportMode,
        videoExportQuality,
      });
      setProject(manifest);
      setMessage("Project settings saved.");
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex-1 flex flex-col p-6 h-full overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1 text-white">Settings</h1>
        <p className="text-textMuted text-sm">
          Configure AI models, API keys, and application preferences.
        </p>
      </div>

      {error && (
        <p className="text-danger text-sm mb-4 p-3 rounded-lg bg-danger bg-opacity-10 border border-danger border-opacity-30">
          {error}
        </p>
      )}
      {message && (
        <p className="text-success text-sm mb-4 p-3 rounded-lg bg-success bg-opacity-10 border border-success border-opacity-30">
          {message}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="col-span-1 lg:col-span-2 xl:col-span-1 bg-surface border border-border rounded-xl p-6">
          <div className="flex justify-between items-start mb-2">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Mic className="text-[#8B5CF6]" size={20} /> Parakeet speech model (local)
            </h2>
            <span
              className={`text-xs px-2.5 py-1 rounded-md font-medium border ${
                modelReady
                  ? "bg-success bg-opacity-20 text-success border-success border-opacity-30"
                  : "bg-textMuted bg-opacity-20 text-textMuted border-border"
              }`}
            >
              {modelReady ? "Ready" : "Missing"}
            </span>
          </div>
          <p className="text-sm text-textMuted mb-6">
            English TDT v3 INT8 (~670 MB). Transcription runs entirely on your device.
          </p>

          <div className="bg-[#151821] rounded-lg p-4 border border-border mb-6">
            <p className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3">
              Model files
            </p>
            {modelReady && modelFiles.length > 0 ? (
              <ul className="space-y-2.5 text-sm text-textMuted">
                {modelFiles.map((f) => (
                  <li key={f.fileName} className="flex justify-between items-center">
                    <span className="flex items-center gap-2 text-white">
                      <CheckCircle2 className="text-success" size={14} /> {f.fileName}
                    </span>
                    <span className="text-xs">{f.sizeLabel}</span>
                  </li>
                ))}
              </ul>
            ) : downloadProgress ? (
              <div>
                <p className="text-sm text-white mb-2">
                  Downloading {downloadProgress.fileName} ({downloadProgress.fileIndex}/
                  {downloadProgress.fileCount})
                </p>
                <DownloadProgressBar progress={downloadProgress.progress ?? 0} />
              </div>
            ) : (
              <p className="text-sm text-textMuted">Files not downloaded.</p>
            )}
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              disabled={modelBusy || modelReady}
              onClick={() => void handleDownloadModel()}
              className="bg-primary hover:bg-primaryHover text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
            >
              <RefreshCw size={16} /> {modelBusy ? "Downloading…" : "Download model"}
            </button>
            <button
              type="button"
              disabled={modelBusy || !modelReady}
              onClick={() => void handleDeleteModel()}
              className="bg-transparent border border-border text-textMuted hover:text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
            >
              <Trash2 size={16} /> Delete model
            </button>
          </div>
        </div>

        <div className="col-span-1 lg:col-span-2 xl:col-span-1 space-y-6 flex flex-col">
          <ApiKeyCard
            title="OpenAI API"
            icon={<Sparkles className="text-[#3B82F6]" size={20} />}
            description="Used for transcript analysis and overlay suggestions."
            keyValue={apiKey}
            onKeyChange={setApiKey}
            keySet={apiKeySet}
            storageHint={apiKeyStorageHint}
            placeholder="sk-…"
            onSave={() => void handleSaveApiKey()}
            onClear={async () => {
              await clearApiKey();
              await refreshKeys();
              setMessage("API key removed.");
            }}
          />
          <ApiKeyCard
            title="Grok Imagine (xAI)"
            icon={<span className="font-bold text-white">xl</span>}
            description="Used for generating overlay images."
            keyValue={xaiKey}
            onKeyChange={setXaiKey}
            keySet={xaiKeySet}
            storageHint={xaiKeyStorageHint}
            placeholder="xai-…"
            onSave={() => void handleSaveXaiKey()}
            onClear={async () => {
              await clearXaiApiKey();
              await refreshKeys();
              setMessage("xAI API key removed.");
            }}
            footerLink={
              <a
                href="https://console.x.ai/"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline"
              >
                Create an API key at console.x.ai
              </a>
            }
          />
        </div>

        <div className="col-span-1 border border-border rounded-xl flex flex-col overflow-hidden bg-surface">
          <h2 className="text-sm font-semibold text-white p-5 border-b border-border flex items-center gap-2">
            <Sliders className="text-[#3B82F6]" size={16} /> Default model settings
          </h2>
          <div className="p-5 space-y-4">
            <label className="block">
              <span className="text-sm text-white block mb-1.5">Show context (system prompt)</span>
              <textarea
                rows={3}
                value={showContext}
                onChange={(e) => setShowContext(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
              />
            </label>
            <SettingSelect
              label="OpenAI model"
              value={textModel}
              onChange={setTextModel}
              options={["gpt-4.1-mini", "gpt-4o-mini", "gpt-4o", "gpt-4.1"]}
            />
            <SettingSelect
              label="Image model"
              value={grokImagineModel}
              onChange={setGrokImagineModel}
              options={["grok-imagine-image"]}
            />
            <label className="flex justify-between items-center gap-4">
              <span className="text-sm text-white">Transcript timing offset (ms)</span>
              <input
                type="number"
                step={50}
                value={transcriptTimingOffsetMs}
                onChange={(e) => setTranscriptTimingOffsetMs(Number(e.target.value))}
                className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-white w-32 focus:outline-none focus:border-primary"
              />
            </label>
            <p className="text-xs text-textMuted">
              Positive values shift overlay cues later if speech appears early in the editor.
            </p>
          </div>
        </div>

        <div className="col-span-1 border border-border rounded-xl flex flex-col overflow-hidden bg-surface">
          <h2 className="text-sm font-semibold text-white p-5 border-b border-border flex items-center gap-2">
            <Film className="text-[#10B981]" size={16} /> Output defaults
          </h2>
          <div className="p-5 space-y-4">
            <SettingSelect
              label="Export mode"
              value={videoExportMode}
              onChange={(v) => setVideoExportMode(v as VideoExportMode)}
              options={["auto", "hardware", "software"]}
            />
            <SettingSelect
              label="Export quality"
              value={videoExportQuality}
              onChange={(v) => setVideoExportQuality(v as VideoExportQuality)}
              options={["balanced", "fast"]}
            />
            {exportPreflight && (
              <div className="text-xs text-textMuted space-y-1 pt-2 border-t border-border">
                {exportPreflight.ffmpegPath && (
                  <p>
                    FFmpeg: <code className="text-white">{exportPreflight.ffmpegPath}</code>
                  </p>
                )}
                {exportPreflight.recommendedEncoder && (
                  <p>
                    Recommended encoder:{" "}
                    <span className="text-white">
                      {encoderKindLabel(exportPreflight.recommendedEncoder)}
                    </span>
                    {exportPreflight.cudaOverlayAvailable ? " · CUDA overlays" : ""}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <button
          type="button"
          disabled={!project}
          onClick={() => void handleSaveProjectSettings()}
          className="bg-primary hover:bg-primaryHover text-white px-5 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          Save project settings
        </button>
        {!project && (
          <p className="text-textMuted text-sm mt-2">Open a project in Overview to save pipeline settings.</p>
        )}
      </div>
    </div>
  );
}

function DownloadProgressBar({ progress }: { progress: number }) {
  return (
    <div className="h-2 bg-background rounded-full overflow-hidden">
      <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
    </div>
  );
}

function SettingSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-sm text-white">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none w-48"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function ApiKeyCard({
  title,
  icon,
  description,
  keyValue,
  onKeyChange,
  keySet,
  storageHint,
  placeholder,
  onSave,
  onClear,
  footerLink,
}: {
  title: string;
  icon: React.ReactNode;
  description: string;
  keyValue: string;
  onKeyChange: (v: string) => void;
  keySet: boolean;
  storageHint: string | null;
  placeholder: string;
  onSave: () => void;
  onClear: () => void;
  footerLink?: React.ReactNode;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-6">
      <div className="flex justify-between items-start mb-2">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          {icon} {title}
        </h2>
        <span
          className={`text-xs px-2.5 py-1 rounded-md font-medium border ${
            keySet
              ? "bg-success bg-opacity-20 text-success border-success border-opacity-30"
              : "bg-danger bg-opacity-20 text-danger border-danger border-opacity-30"
          }`}
        >
          {keySet ? "Key saved" : "Missing"}
        </span>
      </div>
      <p className="text-sm text-textMuted mb-4">{description}</p>
      {keySet && storageHint && (
        <p className="text-xs text-textMuted mb-2">Stored: {storageHint}</p>
      )}
      <input
        type="password"
        value={keyValue}
        onChange={(e) => onKeyChange(e.target.value)}
        placeholder={keySet ? "Enter new key to replace…" : placeholder}
        className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-primary mb-4"
      />
      <ApiKeyActions onSave={onSave} onClear={onClear} footerLink={footerLink} />
    </div>
  );
}

function ApiKeyActions({
  onSave,
  onClear,
  footerLink,
}: {
  onSave: () => void;
  onClear: () => void;
  footerLink?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSave}
          className="bg-primary hover:bg-primaryHover text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
        >
          <Key size={16} /> Save API key
        </button>
        <button
          type="button"
          onClick={onClear}
          className="bg-transparent border border-border text-textMuted hover:text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
        >
          <Trash2 size={16} /> Clear key
        </button>
      </div>
      {footerLink}
    </div>
  );
}

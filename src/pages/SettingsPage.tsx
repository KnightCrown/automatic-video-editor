import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  RefreshCw,
  Trash2,
  Key,
  Sparkles,
  Mic,
  Film,
  FolderOpen,
  Info,
  X,
} from "lucide-react";
import { OverlaySettingsModal } from "../components/OverlaySettingsModal";
import { useProject } from "../context/ProjectContext";
import {
  deleteParakeetModel,
  downloadParakeetModel,
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
  OverlayClipLayout,
  ParakeetDownloadProgress,
  VideoExportEncoderKind,
  VideoExportMode,
  VideoExportPreflight,
  VideoExportQuality,
} from "../types/pipeline";
import { overlayLayoutFromSettings } from "../utils/overlayLayout";

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

const TEXT_MODEL_OPTIONS = [
  { value: "gpt-4.1-mini", label: "GPT 4.1 Mini" },
  { value: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
] as const;

function normalizeTextModel(model: string): string {
  if (model === "gpt-5.4-mini" || model === "gpt-5.4") return "gpt-5.4-mini";
  return "gpt-4.1-mini";
}

export function SettingsPage() {
  const { project, setProject } = useProject();
  const [modelReady, setModelReady] = useState(false);
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
  const [assetFolderPath, setAssetFolderPath] = useState(
    project?.settings.assetFolderPath ?? "",
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
  const [overlayLayout, setOverlayLayout] = useState<OverlayClipLayout>(() =>
    overlayLayoutFromSettings(project?.settings),
  );
  const [overlaySettingsOpen, setOverlaySettingsOpen] = useState(false);
  const [promptHelpOpen, setPromptHelpOpen] = useState(false);

  useEffect(() => {
    void refreshModelStatus();
    void refreshKeys();
    getVideoExportPreflight().then(setExportPreflight).catch(() => setExportPreflight(null));
  }, []);

  useEffect(() => {
    if (!project) return;
    setShowContext(project.settings.showContext);
    setAssetFolderPath(project.settings.assetFolderPath ?? "");
    setTextModel(normalizeTextModel(project.settings.openaiTextModel));
    setGrokImagineModel(project.settings.grokImagineModel ?? "grok-imagine-image");
    setTranscriptTimingOffsetMs(project.settings.transcriptTimingOffsetMs ?? 0);
    setVideoExportMode(project.settings.videoExportMode ?? "auto");
    setVideoExportQuality(project.settings.videoExportQuality ?? "balanced");
    setOverlayLayout(overlayLayoutFromSettings(project.settings));
  }, [project]);

  async function refreshModelStatus() {
    setModelReady(await isParakeetModelReady());
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
      setMessage("OpenAI API key saved.");
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
      setMessage("xAI API key saved.");
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
        assetFolderPath: assetFolderPath.trim() || undefined,
        openaiTextModel: textModel,
        grokImagineModel,
        transcriptTimingOffsetMs: (() => {
          const n = Number(transcriptTimingOffsetMs);
          return Number.isFinite(n) ? Math.round(n) : 0;
        })(),
        videoExportMode,
        videoExportQuality,
        defaultOverlayLayout: overlayLayout,
      });
      setProject(manifest);
      setMessage("Project settings saved.");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveOverlayLayout(layout: OverlayClipLayout) {
    setOverlayLayout(layout);
    setOverlaySettingsOpen(false);
    if (!project) {
      setMessage("Overlay position saved. Open a project to persist with other settings.");
      return;
    }
    setError(null);
    try {
      const manifest = await updateProjectSettings(project.rootPath, {
        ...project.settings,
        defaultOverlayLayout: layout,
      });
      setProject(manifest);
      setMessage("Overlay position saved.");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSelectAssetFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select asset folder",
    });
    if (selected && typeof selected === "string") {
      setAssetFolderPath(selected);
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
        <div className="bg-surface border border-border rounded-xl p-6 space-y-8">
          <ParakeetSection
            modelReady={modelReady}
            modelBusy={modelBusy}
            downloadProgress={downloadProgress}
            onDownload={() => void handleDownloadModel()}
            onDelete={() => void handleDeleteModel()}
          />

          <div className="border-t border-border" />

          <ApiKeySection
            title="OpenAI API"
            icon={<Sparkles className="text-[#3B82F6]" size={18} />}
            description="Transcript analysis and overlay suggestions."
            keyValue={apiKey}
            onKeyChange={setApiKey}
            keySet={apiKeySet}
            storageHint={apiKeyStorageHint}
            placeholder="sk-…"
            onSave={() => void handleSaveApiKey()}
            onClear={async () => {
              await clearApiKey();
              await refreshKeys();
              setMessage("OpenAI API key removed.");
            }}
          />

          <div className="border-t border-border" />

          <ApiKeySection
            title="Grok Imagine (xAI)"
            icon={<span className="font-bold text-white text-sm">xl</span>}
            description="Overlay image generation."
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

          <div className="border-t border-border pt-8 space-y-4">
            <SettingSelect
              label="OpenAI model"
              value={textModel}
              onChange={setTextModel}
              options={TEXT_MODEL_OPTIONS}
            />
            <SettingSelect
              label="Image model"
              value={grokImagineModel}
              onChange={setGrokImagineModel}
              options={["grok-imagine-image"]}
            />
          </div>
        </div>

        <div className="border border-border rounded-xl flex flex-col overflow-hidden bg-surface">
          <h2 className="text-sm font-semibold text-white p-5 border-b border-border flex items-center gap-2">
            <Film className="text-[#10B981]" size={16} /> Output defaults
          </h2>
          <div className="p-5 space-y-4 flex-1">
            <label className="block">
              <span className="text-sm text-white mb-1.5 flex items-center gap-2">
                Show context (system prompt)
                <button
                  type="button"
                  onClick={() => setPromptHelpOpen(true)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-textMuted hover:text-white hover:border-primary"
                  aria-label="Show system prompt examples"
                  title="Prompt examples"
                >
                  <Info size={14} />
                </button>
              </span>
              <textarea
                rows={5}
                value={showContext}
                onChange={(e) => setShowContext(e.target.value)}
                placeholder="Describe the video style, reusable assets, intro/outro rules, and when specific assets should appear."
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
              />
              <p className="text-xs text-textMuted mt-2">
                Saved with this project and reused when the app restarts. Use it for visual style,
                production rules, and asset instructions.
              </p>
            </label>
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
            <button
              type="button"
              onClick={() => setOverlaySettingsOpen(true)}
              className="w-full mt-2 py-2.5 rounded-lg text-sm font-medium border border-border text-white hover:bg-background transition-colors"
            >
              Overlay settings
            </button>
            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex items-start gap-3">
                <FolderOpen className="text-[#8B5CF6] mt-0.5" size={17} />
                <div>
                  <h3 className="text-sm font-semibold text-white">Asset folder</h3>
                  <p className="text-xs text-textMuted mt-1">
                    Select a folder where your assets are stored. You can reference assets in this
                    folder in your master prompt, for example: add the intro at the start of the
                    video and play the surprise clip each time I say surprise.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  value={assetFolderPath}
                  readOnly
                  placeholder="No asset folder selected"
                  className="flex-1 min-w-0 bg-background border border-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-textMuted focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleSelectAssetFolder()}
                  className="px-3 py-2 rounded-lg text-sm border border-border text-white hover:bg-background"
                >
                  Select
                </button>
                {assetFolderPath ? (
                  <button
                    type="button"
                    onClick={() => setAssetFolderPath("")}
                    className="px-3 py-2 rounded-lg text-sm border border-border text-textMuted hover:text-white hover:bg-background"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <PromptHelpModal open={promptHelpOpen} onClose={() => setPromptHelpOpen(false)} />

      <OverlaySettingsModal
        open={overlaySettingsOpen}
        initialLayout={overlayLayout}
        onClose={() => setOverlaySettingsOpen(false)}
        onSave={(layout) => void handleSaveOverlayLayout(layout)}
      />

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

function StatusBadge({ ready, readyLabel, missingLabel }: { ready: boolean; readyLabel: string; missingLabel: string }) {
  return (
    <span
      className={`text-xs px-2.5 py-1 rounded-md font-medium border shrink-0 ${
        ready
          ? "bg-success bg-opacity-20 text-success border-success border-opacity-30"
          : "bg-textMuted bg-opacity-20 text-textMuted border-border"
      }`}
    >
      {ready ? readyLabel : missingLabel}
    </span>
  );
}

function PromptHelpModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  const examples = [
    {
      title: "Describe the visual style",
      text: "Make the episode feel like bright 2D storybook Bible art with clear expressions, warm lighting, and no scary imagery.",
    },
    {
      title: "Add intro and outro assets",
      text: "I have intro.mp4 and outro.mp4 in my asset folder. Start every video with intro.mp4, then play the episode, then add outro.mp4 at the end.",
    },
    {
      title: "Trigger an overlay from speech",
      text: "Each time the host says yay, play yay.mp4 as an overlay in the default overlay position for two seconds.",
    },
    {
      title: "Use a full-screen asset",
      text: "When the host says surprise, play surprise.mp4 as a full-screen overlay, then continue the episode.",
    },
    {
      title: "Give editing rules",
      text: "Keep overlays playful but readable. Avoid covering faces. Use asset clips only when they support the spoken moment.",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-help-title"
        className="w-full max-w-2xl rounded-xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h2 id="prompt-help-title" className="text-lg font-semibold text-white">
              System prompt examples
            </h2>
            <p className="mt-1 text-sm text-textMuted">
              Use this field as a master prompt for style, asset placement, and smart editing
              rules. The prompt is saved with the project.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-textMuted hover:text-white hover:bg-background"
            aria-label="Close prompt examples"
          >
            <X size={17} />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-5 space-y-4">
          {examples.map((example) => (
            <div key={example.title} className="rounded-lg border border-border bg-background/70 p-4">
              <h3 className="text-sm font-semibold text-white">{example.title}</h3>
              <p className="mt-2 text-sm text-textMuted">{example.text}</p>
            </div>
          ))}
          <p className="text-xs text-textMuted">
            Asset names should match files in the selected asset folder, such as intro.mp4,
            outro.mp4, yay.mp4, or surprise.mp4.
          </p>
        </div>
      </section>
    </div>
  );
}

function ParakeetSection({
  modelReady,
  modelBusy,
  downloadProgress,
  onDownload,
  onDelete,
}: {
  modelReady: boolean;
  modelBusy: boolean;
  downloadProgress: ParakeetDownloadProgress | null;
  onDownload: () => void;
  onDelete: () => void;
}) {
  return (
    <section>
      <div className="flex justify-between items-start gap-3 mb-3">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <Mic className="text-[#8B5CF6]" size={18} /> Parakeet speech model
        </h2>
        <StatusBadge ready={modelReady} readyLabel="Ready" missingLabel="Not installed" />
      </div>
      <p className="text-sm text-textMuted mb-4">
        Local transcription model. Download once to transcribe episodes on your device.
      </p>

      {downloadProgress && (
        <div className="mb-4">
          <p className="text-sm text-white mb-2">
            Downloading… ({downloadProgress.fileIndex}/{downloadProgress.fileCount})
          </p>
          <DownloadProgressBar progress={downloadProgress.progress ?? 0} />
        </div>
      )}

      <div className="flex gap-3 flex-wrap">
        <button
          type="button"
          disabled={modelBusy || modelReady}
          onClick={onDownload}
          className="bg-primary hover:bg-primaryHover text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw size={16} className={modelBusy ? "animate-spin" : ""} />
          {modelBusy ? "Downloading…" : "Download model"}
        </button>
        <button
          type="button"
          disabled={modelBusy || !modelReady}
          onClick={onDelete}
          className="bg-transparent border border-border text-textMuted hover:text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
        >
          <Trash2 size={16} /> Delete model
        </button>
      </div>
    </section>
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
  options: readonly string[] | readonly { value: string; label: string }[];
}) {
  const entries = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-sm text-white">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none w-48"
      >
        {entries.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ApiKeySection({
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
  icon: ReactNode;
  description: string;
  keyValue: string;
  onKeyChange: (v: string) => void;
  keySet: boolean;
  storageHint: string | null;
  placeholder: string;
  onSave: () => void;
  onClear: () => void;
  footerLink?: ReactNode;
}) {
  return (
    <section>
      <div className="flex justify-between items-start gap-3 mb-2">
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          {icon} {title}
        </h3>
        <StatusBadge ready={keySet} readyLabel="Key saved" missingLabel="Missing" />
      </div>
      <p className="text-sm text-textMuted mb-3">{description}</p>
      {keySet && storageHint && (
        <p className="text-xs text-textMuted mb-2">Stored: {storageHint}</p>
      )}
      <input
        type="password"
        value={keyValue}
        onChange={(e) => onKeyChange(e.target.value)}
        placeholder={keySet ? "Enter new key to replace…" : placeholder}
        className="w-full bg-background border border-border rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-primary mb-3"
      />
      <ApiKeyActions onSave={onSave} onClear={onClear} footerLink={footerLink} />
    </section>
  );
}

function ApiKeyActions({
  onSave,
  onClear,
  footerLink,
}: {
  onSave: () => void;
  onClear: () => void;
  footerLink?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div className="flex gap-3 flex-wrap">
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

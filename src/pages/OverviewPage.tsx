import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  FolderUp,
  Play,
  RefreshCw,
  CheckCircle2,
  ChevronRight,
  AlertCircle,
  Clock,
} from "lucide-react";
import { useProject, getStoredProjectRoot } from "../context/ProjectContext";
import {
  getTranscriptionPreflight,
  openProject,
  getProject,
  runTranscription,
  retryVideoTranscription,
} from "../services/pipelineService";
import { isParakeetModelReady } from "../services/parakeetModelService";
import type { PipelineProgress, VideoJob } from "../types/pipeline";
import {
  errorStageLabel,
  formatTranscriptionError,
} from "../utils/transcriptionErrors";
import { displayPipelineStatus, projectDisplayName } from "../utils/format";

type StatusFilter = "All" | "Ready" | "Processing" | "Completed" | "Failed";

function matchesFilter(video: VideoJob, filter: StatusFilter): boolean {
  switch (filter) {
    case "Ready":
      return video.status === "pending";
    case "Processing":
      return ["processing", "transcribing", "analyzing", "generating_images"].includes(
        video.status,
      );
    case "Completed":
      return (
        video.status === "images_generated" ||
        video.status === "done" ||
        video.status === "analyzed"
      );
    case "Failed":
      return video.status === "failed";
    default:
      return true;
  }
}

function PipelineProgressBar({ status }: { status: string }) {
  const steps = [
    {
      name: "Transcribe",
      completed: [
        "transcribed",
        "analyzing",
        "analyzed",
        "generating_images",
        "images_generated",
        "done",
      ].includes(status),
      active: status === "transcribing",
      failed: status === "failed",
    },
    {
      name: "Analyze",
      completed: ["analyzed", "generating_images", "images_generated", "done"].includes(status),
      active: status === "analyzing",
      failed: false,
    },
    {
      name: "Images",
      completed: ["images_generated", "done"].includes(status),
      active: status === "generating_images",
      failed: false,
    },
  ];

  return <PipelineSteps steps={steps} />;
}

function PipelineSteps({
  steps,
}: {
  steps: { name: string; completed: boolean; active: boolean; failed: boolean }[];
}) {
  return (
    <div className="flex items-center w-full max-w-[200px] justify-between relative px-2">
      <div className="absolute top-1/2 left-4 right-4 h-0.5 bg-border -translate-y-1/2 z-0" />
      {steps.map((step, i) => (
        <div key={step.name} className="flex flex-col items-center gap-1.5 z-10 relative bg-surface">
          {step.completed ? (
            <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
              <CheckCircle2 size={12} className="text-white" />
            </div>
          ) : step.active ? (
            <div className="w-5 h-5 rounded-full border-2 border-primary bg-background" />
          ) : step.failed && i === 0 ? (
            <FailedStepDot />
          ) : (
            <div className="w-5 h-5 rounded-full border-2 border-border bg-background" />
          )}
          <span className="text-[10px] text-textMuted">{step.name}</span>
        </div>
      ))}
    </div>
  );
}

function FailedStepDot() {
  return (
    <div className="w-5 h-5 rounded-full bg-danger flex items-center justify-center">
      <AlertCircle size={12} className="text-white" />
    </div>
  );
}

function SummaryRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: number;
  valueClass: string;
}) {
  return (
    <div className="flex justify-between text-textMuted">
      <span>{label}</span>
      <span className={`font-medium ${valueClass}`}>{value}</span>
    </div>
  );
}

export function OverviewPage() {
  const { project, setProject, refreshProject } = useProject();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);
  const [canTranscribe, setCanTranscribe] = useState(true);

  const loadPreflight = useCallback(async () => {
    try {
      const preflight = await getTranscriptionPreflight();
      setCanTranscribe(
        preflight.ffmpegAvailable === true && preflight.parakeetModelReady === true,
      );
    } catch {
      setCanTranscribe(false);
    }
  }, []);

  useEffect(() => {
    const stored = getStoredProjectRoot();
    if (!stored || project) return;
    getProject(stored)
      .then(setProject)
      .catch(() => localStorage.removeItem("devotiontime.projectRoot"));
  }, [project, setProject]);

  useEffect(() => {
    void loadPreflight();
  }, [loadPreflight, project?.updatedAt]);

  async function pickFolder() {
    setError(null);
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select video project folder",
    });
    if (!selected || typeof selected !== "string") return;

    setLoading(true);
    try {
      const manifest = await openProject(selected);
      setProject(manifest);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  const counts = useMemo(
    () => ({
      all: project?.videos.length || 0,
      ready: project?.videos.filter((v) => v.status === "pending").length || 0,
      processing:
        project?.videos.filter((v) =>
          ["processing", "transcribing", "analyzing", "generating_images"].includes(v.status),
        ).length || 0,
      completed:
        project?.videos.filter((v) =>
          ["images_generated", "done", "analyzed"].includes(v.status),
        ).length || 0,
      failed: project?.videos.filter((v) => v.status === "failed").length || 0,
    }),
    [project?.videos],
  );

  const filteredVideos = useMemo(() => {
    if (!project) return [];
    const q = search.trim().toLowerCase();
    return project.videos.filter((video) => {
      if (!matchesFilter(video, filter)) return false;
      if (!q) return true;
      return video.fileName.toLowerCase().includes(q);
    });
  }, [project, filter, search]);

  const readyCount = useMemo(
    () => project?.videos.filter((v) => v.status === "pending").length ?? 0,
    [project?.videos],
  );

  async function handleRunAllReady() {
    if (!project) return;
    setError(null);
    setRunning(true);
    try {
      await loadPreflight();
      const ready = await isParakeetModelReady();
      const manifest = await runTranscription(
        project.rootPath,
        !ready,
        (p) => setProgress(p),
      );
      setProject(manifest);
      const failed = manifest.videos.find((v) => v.status === "failed" && v.error);
      if (failed?.error) setExpandedErrorId(failed.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
      setProgress(null);
      await loadPreflight();
    }
  }

  async function handleRetryVideo(videoId: string) {
    if (!project) return;
    setError(null);
    setRunning(true);
    setProgress(null);
    setExpandedErrorId(videoId);
    try {
      const manifest = await retryVideoTranscription(project.rootPath, videoId, (p) =>
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

  function openInEditing(videoId: string) {
    navigate("/editing", { state: { videoId } });
  }

  return (
    <div className="flex-1 flex flex-col p-6 h-full overflow-y-auto">
      <div className="flex justify-between items-start mb-6">
        <OverviewPageHeader />
        <button
          type="button"
          onClick={pickFolder}
          disabled={loading || running}
          className="bg-primary hover:bg-primaryHover text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
        >
          <FolderUp size={16} />
          {loading ? "Importing..." : "Import folder"}
        </button>
      </div>

      {!canTranscribe && project && (
        <p className="text-sm text-[#EAB308] mb-4">
          Transcription setup incomplete — check FFmpeg and Parakeet model in Settings.
        </p>
      )}

      {error && (
        <div className="bg-danger bg-opacity-20 text-danger p-4 rounded-xl mb-6 border border-danger border-opacity-50">
          {error}
        </div>
      )}

      {progress && (
        <div className="bg-surface border border-border rounded-xl p-4 mb-6">
          <p className="text-sm text-white mb-2">
            <strong>{progress.stage}</strong>
            {progress.message ? ` — ${progress.message}` : ""}
          </p>
          <div className="h-2 bg-background rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.min(100, progress.percent)}%` }}
            />
          </div>
        </div>
      )}

      {project ? (
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6 min-h-0">
          <div className="xl:col-span-3 flex flex-col gap-4">
            <div className="bg-surface rounded-xl p-5 flex justify-between items-center border border-border">
              <div className="flex gap-4 items-center min-w-0">
                <div className="w-14 h-14 bg-primary bg-opacity-20 text-primary rounded-xl flex items-center justify-center flex-shrink-0">
                  <FolderOpen size={28} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-white">
                    {projectDisplayName(project.rootPath)}
                  </h2>
                  <p className="text-textMuted text-sm break-all">{project.rootPath}</p>
                  <p className="text-textMuted text-xs mt-1 flex items-center gap-1">
                    <Clock size={12} /> {project.videos.length} video
                    {project.videos.length === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={pickFolder}
                disabled={loading || running}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-white hover:bg-opacity-5 flex items-center gap-2 flex-shrink-0"
              >
                <FolderOpen size={16} /> Open folder
              </button>
            </div>

            <div className="flex-1 flex flex-col bg-surface rounded-xl border border-border overflow-hidden">
              <div className="p-4 border-b border-border flex flex-wrap justify-between items-center gap-3">
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["All", counts.all],
                      ["Ready", counts.ready],
                      ["Processing", counts.processing],
                      ["Completed", counts.completed],
                      ["Failed", counts.failed],
                    ] as const
                  ).map(([label, count]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setFilter(label)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                        filter === label
                          ? "bg-primary bg-opacity-20 text-primary"
                          : "text-textMuted hover:bg-white hover:bg-opacity-5"
                      }`}
                    >
                      {label === "All" ? "All Videos" : label}{" "}
                      <span className="ml-1 opacity-70">{count}</span>
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search videos..."
                  className="bg-background border border-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-primary w-64 text-textMain"
                />
              </div>

              <div className="overflow-auto flex-1">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-[#151821] text-textMuted text-xs font-medium sticky top-0 z-20">
                    <tr>
                      <th className="p-4 font-medium">Video</th>
                      <th className="p-4 font-medium">Status</th>
                      <th className="p-4 font-medium w-48">Pipeline Progress</th>
                      <th className="p-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredVideos.map((video) => {
                      const isProcessing = [
                        "processing",
                        "transcribing",
                        "analyzing",
                        "generating_images",
                      ].includes(video.status);
                      return (
                        <tr
                          key={video.id}
                          className="hover:bg-white hover:bg-opacity-5 group transition-colors cursor-pointer"
                          onClick={() => openInEditing(video.id)}
                        >
                          <td className="p-4">
                            <p
                              className="font-medium text-sm text-white truncate max-w-[280px]"
                              title={video.fileName}
                            >
                              {video.fileName}
                            </p>
                            {video.error && (
                              <div className="mt-1" onClick={(e) => e.stopPropagation()}>
                                {errorStageLabel(video.error) && (
                                  <span className="text-[10px] uppercase text-textMuted mr-2">
                                    {errorStageLabel(video.error)}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  className="text-xs text-danger hover:underline"
                                  onClick={() =>
                                    setExpandedErrorId(
                                      expandedErrorId === video.id ? null : video.id,
                                    )
                                  }
                                >
                                  {expandedErrorId === video.id ? "Hide error" : "Show error"}
                                </button>
                                {expandedErrorId === video.id && (
                                  <pre className="mt-1 text-xs text-danger whitespace-pre-wrap max-w-md">
                                    {formatTranscriptionError(video.error)}
                                  </pre>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="p-4">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium uppercase tracking-wider
                              ${
                                video.status === "done" ||
                                video.status === "images_generated" ||
                                video.status === "analyzed" ||
                                video.status === "transcribed"
                                  ? "bg-[#8B5CF6] bg-opacity-10 text-[#8B5CF6] border border-[#8B5CF6] border-opacity-30"
                                  : video.status === "pending"
                                    ? "bg-success bg-opacity-10 text-success border border-success border-opacity-30"
                                    : video.status === "failed"
                                      ? "bg-danger bg-opacity-10 text-danger border border-danger border-opacity-30"
                                      : "bg-[#3B82F6] bg-opacity-10 text-[#3B82F6] border border-[#3B82F6] border-opacity-30"
                              }`}
                            >
                              {displayPipelineStatus(
                                isProcessing ? "transcribing" : video.status,
                              )}
                            </span>
                          </td>
                          <td className="p-4">
                            <PipelineProgressBar status={video.status} />
                          </td>
                          <td className="p-4 text-right" onClick={(e) => e.stopPropagation()}>
                            <VideoRowActions
                              video={video}
                              running={running}
                              isProcessing={isProcessing}
                              onRetry={() => void handleRetryVideo(video.id)}
                              onOpen={() => openInEditing(video.id)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                    {filteredVideos.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-8 text-center text-textMuted text-sm">
                          No videos match this filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="p-4 border-t border-border flex justify-between items-center bg-[#151821]">
                <span className="text-xs text-textMuted">{filteredVideos.length} shown</span>
                <div className="flex gap-3">
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => void refreshProject()}
                    className="text-sm font-medium text-textMuted hover:text-white flex items-center gap-2 disabled:opacity-50"
                  >
                    <RefreshCw size={14} /> Refresh
                  </button>
                  <button
                    type="button"
                    disabled={running || readyCount === 0 || !canTranscribe}
                    title={
                      !canTranscribe
                        ? "Complete setup in Settings first"
                        : readyCount === 0
                          ? "No pending videos"
                          : "Run transcription pipeline"
                    }
                    onClick={() => void handleRunAllReady()}
                    className="bg-primary hover:bg-primaryHover text-white px-4 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50"
                  >
                    <Play size={14} /> Start all ready ({readyCount})
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="xl:col-span-1 flex flex-col gap-4">
            <div className="bg-surface rounded-xl p-5 border border-border">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <div className="w-1 h-4 bg-primary rounded-full" /> Project Summary
              </h3>
              <div className="space-y-3 text-sm">
                <SummaryRow label="Total videos" value={counts.all} valueClass="text-white" />
                <SummaryRow label="Completed" value={counts.completed} valueClass="text-[#8B5CF6]" />
                <SummaryRow label="Processing" value={counts.processing} valueClass="text-[#3B82F6]" />
                <SummaryRow label="Ready" value={counts.ready} valueClass="text-success" />
                <SummaryRow label="Failed" value={counts.failed} valueClass="text-danger" />
              </div>
            </div>

            <OverviewTipsCard navigate={navigate} />
          </div>
        </div>
      ) : (
        <OverviewEmptyState pickFolder={pickFolder} loading={loading} />
      )}
    </div>
  );
}

function OverviewPageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1 text-white">Overview</h1>
      <p className="text-textMuted text-sm">
        Import a folder to get started. We&apos;ll find all videos and prepare them for your AI
        pipeline.
      </p>
    </div>
  );
}

function VideoRowActions({
  video,
  running,
  isProcessing,
  onRetry,
  onOpen,
}: {
  video: VideoJob;
  running: boolean;
  isProcessing: boolean;
  onRetry: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
      {video.status === "failed" || video.status === "pending" ? (
        <button
          type="button"
          disabled={running}
          title={video.status === "pending" ? "Transcribe" : "Retry"}
          onClick={onRetry}
          className="p-1.5 text-textMuted hover:text-white rounded disabled:opacity-40"
        >
          <RefreshCw size={16} />
        </button>
      ) : !isProcessing ? (
        <button
          type="button"
          title="Open in Editing"
          onClick={onOpen}
          className="p-1.5 text-textMuted hover:text-white rounded"
        >
          <Play size={16} />
        </button>
      ) : null}
    </div>
  );
}

function OverviewTipsCard({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  return (
    <div className="bg-surface rounded-xl p-5 border border-border">
      <h3 className="text-sm font-semibold text-[#EAB308] mb-2 flex items-center gap-2">
        <div className="w-1 h-4 bg-[#EAB308] rounded-full" /> Tips
      </h3>
      <p className="text-xs text-textMuted mb-2">
        Run <strong>Start all ready</strong> to transcribe pending videos, then open{" "}
        <strong>Editing</strong> to analyze overlays and generate images.
      </p>
      <button
        type="button"
        onClick={() => navigate("/settings")}
        className="text-xs text-primary hover:underline flex items-center"
      >
        Open Settings <ChevronRight size={12} />
      </button>
    </div>
  );
}

function OverviewEmptyState({
  pickFolder,
  loading,
}: {
  pickFolder: () => void;
  loading: boolean;
}) {
  return (
    <div className="flex-1 flex items-center justify-center border-2 border-dashed border-border rounded-xl">
      <div className="text-center">
        <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center mx-auto mb-4 text-primary">
          <FolderUp size={32} />
        </div>
        <h3 className="text-lg font-medium text-white mb-2">No project open</h3>
        <p className="text-textMuted text-sm mb-4 max-w-sm">
          Import a folder containing your show videos to jump into the DevotionTime pipeline.
        </p>
        <button
          type="button"
          onClick={pickFolder}
          disabled={loading}
          className="bg-primary hover:bg-primaryHover text-white px-5 py-2.5 rounded-lg text-sm font-medium mx-auto inline-flex items-center gap-2"
        >
          <FolderUp size={18} />
          {loading ? "Importing..." : "Import folder now"}
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Film, FolderOpen, Play, Wand2, Check, Download } from "lucide-react";
import { VideoEditorModal } from "../components/video/VideoEditorModal";
import { VideoPreviewWithOverlays } from "../components/video/VideoPreviewWithOverlays";
import { useProject } from "../context/ProjectContext";
import {
  useVideoExport,
  useVideoExportSession,
} from "../context/VideoExportContext";
import {
  getFinalVideoExports,
  getFinalVideoTimeline,
  getTranscriptionPreflight,
  saveFinalVideoTimeline,
} from "../services/pipelineService";
import type {
  FinalVideoExport,
  FinalVideoTimeline,
  VideoJob,
  VideoOverlayClip,
} from "../types/pipeline";
import { displayPipelineStatus } from "../utils/format";

export function VideosPage() {
  const { project } = useProject();
  const location = useLocation();
  const navigate = useNavigate();
  const initialVideoId = (location.state as { videoId?: string } | null)?.videoId;

  const [activeVideoPath, setActiveVideoPath] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<FinalVideoTimeline | null>(null);
  const [exports, setExports] = useState<FinalVideoExport[]>([]);
  const [exportCounts, setExportCounts] = useState<Record<string, number>>({});
  const [timelineFlags, setTimelineFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [editingVideo, setEditingVideo] = useState<VideoJob | null>(null);
  const [playingExportId, setPlayingExportId] = useState<string | null>(null);
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(() => new Set());
  const [batchExport, setBatchExport] = useState<{
    index: number;
    total: number;
    videoId: string;
    fileName: string;
  } | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const batchRunningRef = useRef(false);

  const { startExport } = useVideoExport();

  const activeVideo = useMemo(() => {
    if (!project?.videos.length || !activeVideoPath) return null;
    return project.videos.find((v) => v.path === activeVideoPath) ?? null;
  }, [project?.videos, activeVideoPath]);

  const clips = useMemo(() => timeline?.clips ?? [], [timeline?.clips]);

  useEffect(() => {
    if (!project?.videos.length) {
      setActiveVideoPath(null);
      return;
    }
    setActiveVideoPath((current) => {
      if (current && project.videos.some((v) => v.path === current)) return current;
      if (initialVideoId) {
        const fromNav = project.videos.find((v) => v.id === initialVideoId);
        if (fromNav) return fromNav.path;
      }
      return project.videos[0].path;
    });
  }, [project?.videos, initialVideoId]);

  useEffect(() => {
    if (!initialVideoId) return;
    navigate(location.pathname, { replace: true, state: null });
  }, [initialVideoId, location.pathname, navigate]);

  const loadEpisodeSummaries = useCallback(async () => {
    if (!project) return;
    const counts: Record<string, number> = {};
    const flags: Record<string, boolean> = {};
    await Promise.all(
      project.videos.map(async (video) => {
        try {
          const manifest = await getFinalVideoExports(project.rootPath, video.id);
          counts[video.id] = manifest.exports.length;
        } catch {
          counts[video.id] = 0;
        }
        try {
          const t = await getFinalVideoTimeline(project.rootPath, video.id);
          flags[video.id] = t.clips.length > 0;
        } catch {
          flags[video.id] = false;
        }
      }),
    );
    setExportCounts(counts);
    setTimelineFlags(flags);
  }, [project]);

  const loadActiveEpisode = useCallback(async () => {
    if (!project || !activeVideo) {
      setTimeline(null);
      setExports([]);
      return;
    }
    setLoading(true);
    try {
      const [t, manifest] = await Promise.all([
        getFinalVideoTimeline(project.rootPath, activeVideo.id).catch(() => null),
        getFinalVideoExports(project.rootPath, activeVideo.id),
      ]);
      setTimeline(t);
      setExports(manifest.exports);
      setExportCounts((prev) => ({ ...prev, [activeVideo.id]: manifest.exports.length }));
      setTimelineFlags((prev) => ({ ...prev, [activeVideo.id]: (t?.clips.length ?? 0) > 0 }));
    } finally {
      setLoading(false);
    }
  }, [project, activeVideo]);

  useEffect(() => {
    void loadEpisodeSummaries();
  }, [loadEpisodeSummaries, project?.updatedAt]);

  useEffect(() => {
    void loadActiveEpisode();
  }, [loadActiveEpisode]);

  useEffect(() => {
    getTranscriptionPreflight().then((p) => setFfmpegOk(p.ffmpegAvailable));
  }, []);

  const exportSession = useVideoExportSession(activeVideo?.id ?? "");
  useEffect(() => {
    if (exportSession.status === "success") {
      void loadActiveEpisode();
      void loadEpisodeSummaries();
    }
  }, [exportSession.status, loadActiveEpisode, loadEpisodeSummaries]);

  const selectedExportableCount = useMemo(() => {
    if (!project) return 0;
    return project.videos.filter(
      (v) => selectedVideoIds.has(v.id) && (timelineFlags[v.id] ?? false),
    ).length;
  }, [project, selectedVideoIds, timelineFlags]);

  function toggleVideoSelected(videoId: string) {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  const handleBatchExport = useCallback(async () => {
    if (!project || batchRunningRef.current) return;
    const targets = project.videos.filter(
      (v) => selectedVideoIds.has(v.id) && (timelineFlags[v.id] ?? false),
    );
    if (targets.length === 0) {
      setBatchError("Select at least one episode that is ready to export.");
      return;
    }
    if (ffmpegOk === false) {
      setBatchError("FFmpeg is not available — install FFmpeg to export videos.");
      return;
    }

    setBatchError(null);
    batchRunningRef.current = true;

    try {
      for (let i = 0; i < targets.length; i++) {
        const video = targets[i];
        setBatchExport({
          index: i + 1,
          total: targets.length,
          videoId: video.id,
          fileName: video.fileName,
        });
        setActiveVideoPath(video.path);

        const t = await getFinalVideoTimeline(project.rootPath, video.id);
        if (t.clips.length === 0) continue;

        const ran = await startExport({
          videoId: video.id,
          fileName: video.fileName,
          rootPath: project.rootPath,
          clips: t.clips,
        });
        if (!ran) break;
      }
    } finally {
      batchRunningRef.current = false;
      setBatchExport(null);
      await loadEpisodeSummaries();
      await loadActiveEpisode();
    }
  }, [
    project,
    selectedVideoIds,
    timelineFlags,
    ffmpegOk,
    startExport,
    loadEpisodeSummaries,
    loadActiveEpisode,
  ]);

  if (!project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <p className="text-textMuted text-sm">Open a project from Overview first.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 h-full overflow-hidden">
      <div className="flex justify-between items-center mb-6 flex-shrink-0 gap-4">
        <div>
          <h1 className="text-2xl font-semibold mb-1 text-white">Videos</h1>
          <p className="text-textMuted text-sm">
            Browse exported final videos by episode. Create a timeline in Editing, then export here.
          </p>
        </div>
        <button
          type="button"
          disabled={
            batchExport !== null ||
            selectedExportableCount === 0 ||
            ffmpegOk === false
          }
          onClick={() => void handleBatchExport()}
          className="bg-primary hover:bg-primaryHover disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 flex-shrink-0"
        >
          <Download size={16} />
          {batchExport
            ? `Exporting ${batchExport.index}/${batchExport.total}…`
            : selectedExportableCount > 0
              ? `Export (${selectedExportableCount})`
              : "Export"}
        </button>
      </div>

      {batchError && (
        <div className="mb-4 p-3 rounded-lg bg-danger bg-opacity-20 text-danger text-sm border border-danger border-opacity-30">
          {batchError}
        </div>
      )}

      {batchExport && (
        <div className="mb-4 p-4 rounded-xl bg-surface border border-border flex-shrink-0">
          <p className="text-sm text-white font-medium">
            Exporting episode {batchExport.index} of {batchExport.total}
          </p>
          <p className="text-sm text-textMuted mt-1">{batchExport.fileName}</p>
        </div>
      )}

      <div className="flex-1 flex gap-6 overflow-hidden min-h-0 min-w-0">
        <EpisodeSidebar
          videos={project.videos}
          activeVideoPath={activeVideoPath}
          exportCounts={exportCounts}
          timelineFlags={timelineFlags}
          selectedVideoIds={selectedVideoIds}
          batchExport={batchExport}
          onSelect={(id) => {
            const video = project.videos.find((v) => v.id === id);
            if (video) setActiveVideoPath(video.path);
          }}
          onToggleSelected={toggleVideoSelected}
        />

        <div className="flex-1 min-w-0 flex flex-col bg-surface border border-border rounded-xl overflow-hidden">
          {!activeVideo ? (
            <div className="flex-1 flex items-center justify-center text-textMuted text-sm">
              Select an episode
            </div>
          ) : loading ? (
            <div className="flex-1 flex items-center justify-center text-textMuted text-sm">
              Loading…
            </div>
          ) : (
            <EpisodeVideosPanel
              video={activeVideo}
              rootPath={project.rootPath}
              clips={clips}
              exports={exports}
              ffmpegOk={ffmpegOk}
              playingExportId={playingExportId}
              onPlayExport={setPlayingExportId}
              onEditTimeline={() => setEditingVideo(activeVideo)}
              exportSession={exportSession}
              batchExportActive={batchExport !== null}
            />
          )}
        </div>
      </div>

      {editingVideo && project && timeline ? (
        <VideoEditorModal
          video={editingVideo}
          rootPath={project.rootPath}
          initialClips={clips}
          onSave={async (nextClips) => {
            const nextTimeline: FinalVideoTimeline = {
              videoId: editingVideo.id,
              clips: nextClips,
              updatedAt: new Date().toISOString(),
            };
            await saveFinalVideoTimeline(project.rootPath, nextTimeline);
            setTimeline(nextTimeline);
          }}
          isQueued={selectedVideoIds.has(editingVideo.id)}
          onAddToRenderQueue={() => {
            setSelectedVideoIds((prev) => {
              if (prev.has(editingVideo.id)) return prev;
              const next = new Set(prev);
              next.add(editingVideo.id);
              return next;
            });
          }}
          onClose={() => setEditingVideo(null)}
        />
      ) : null}
    </div>
  );
}

function EpisodeSidebar({
  videos,
  activeVideoPath,
  exportCounts,
  timelineFlags,
  selectedVideoIds,
  batchExport,
  onSelect,
  onToggleSelected,
}: {
  videos: VideoJob[];
  activeVideoPath: string | null;
  exportCounts: Record<string, number>;
  timelineFlags: Record<string, boolean>;
  selectedVideoIds: Set<string>;
  batchExport: { index: number; total: number; videoId: string; fileName: string } | null;
  onSelect: (id: string) => void;
  onToggleSelected: (id: string) => void;
}) {
  return (
    <div className="w-64 min-h-0 self-stretch flex flex-col bg-surface border border-border rounded-xl overflow-hidden flex-shrink-0">
      <div className="p-4 border-b border-border bg-[#151821] flex-shrink-0">
        <h3 className="text-sm font-semibold text-white">Episodes ({videos.length})</h3>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {videos.map((video) => {
          const exportCount = exportCounts[video.id] ?? 0;
          const hasTimeline = timelineFlags[video.id] ?? false;
          const isSelected = selectedVideoIds.has(video.id);
          const isBatchCurrent = batchExport?.videoId === video.id;
          return (
            <div
              key={video.id}
              className={`flex items-center gap-2 p-3 rounded-xl border transition-colors ${
                activeVideoPath === video.path
                  ? "bg-[#8B5CF6] bg-opacity-10 border-[#8B5CF6] border-opacity-50"
                  : "bg-background border-border hover:border-gray-600"
              } ${isBatchCurrent ? "ring-1 ring-primary" : ""}`}
            >
              <button
                type="button"
                onClick={() => onSelect(video.id)}
                className="flex-1 min-w-0 text-left"
              >
                <p className="text-sm font-medium text-white truncate">{video.fileName}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className="text-[10px] text-textMuted uppercase">
                    {displayPipelineStatus(video.status)}
                  </span>
                  {exportCount > 0 ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary bg-opacity-20 text-primary">
                      {exportCount} video{exportCount === 1 ? "" : "s"}
                    </span>
                  ) : hasTimeline ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white bg-opacity-5 text-textMuted">
                      Ready to export
                    </span>
                  ) : null}
                </div>
              </button>
              <button
                type="button"
                disabled={!hasTimeline || batchExport !== null}
                onClick={() => onToggleSelected(video.id)}
                className={`w-[22px] h-[22px] rounded flex items-center justify-center flex-shrink-0 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                  isSelected
                    ? "bg-primary text-white"
                    : "bg-black/50 border border-white/40 hover:border-white/70"
                }`}
                aria-label={`Select ${video.fileName} for export`}
                aria-pressed={isSelected}
              >
                <Check size={14} className={isSelected ? "opacity-100" : "opacity-0"} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EpisodeVideosPanel({
  video,
  rootPath,
  clips,
  exports,
  ffmpegOk,
  playingExportId,
  onPlayExport,
  onEditTimeline,
  exportSession,
  batchExportActive,
}: {
  video: VideoJob;
  rootPath: string;
  clips: VideoOverlayClip[];
  exports: FinalVideoExport[];
  ffmpegOk: boolean | null;
  playingExportId: string | null;
  onPlayExport: (id: string | null) => void;
  onEditTimeline: () => void;
  exportSession: ReturnType<typeof useVideoExportSession>;
  batchExportActive: boolean;
}) {
  const { startExport, cancelExport } = useVideoExport();
  const exporting = exportSession.status === "exporting";
  const hasTimeline = clips.length > 0;

  const handleExport = useCallback(() => {
    void startExport({
      videoId: video.id,
      fileName: video.fileName,
      rootPath,
      clips,
    });
  }, [clips, rootPath, startExport, video.fileName, video.id]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{video.fileName}</h2>
        <p className="text-sm text-textMuted mt-1">
          {exports.length > 0
            ? `${exports.length} exported video${exports.length === 1 ? "" : "s"}`
            : hasTimeline
              ? "Timeline ready — export your first video below."
              : "No final video yet."}
        </p>
      </div>

      {!hasTimeline && exports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-textMuted text-sm mb-4">
            Use <strong className="text-white">Create video</strong> in Editing to build a timeline
            from your approved overlay images, then return here to export.
          </p>
          <Link
            to="/editing"
            state={{ videoId: video.id }}
            className="inline-flex items-center gap-2 bg-primary hover:bg-primaryHover text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            <Film size={16} /> Go to Editing
          </Link>
        </div>
      ) : null}

      {exports.length > 0 ? (
        <section>
          <h3 className="text-sm font-semibold text-white mb-3">Exported videos</h3>
          <div className="space-y-4">
            {exports.map((exp) => (
              <ExportedVideoCard
                key={exp.id}
                exportRecord={exp}
                isPlaying={playingExportId === exp.id}
                onTogglePlay={() =>
                  onPlayExport(playingExportId === exp.id ? null : exp.id)
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {hasTimeline ? (
        <section className="rounded-xl border border-border bg-[#151821] p-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Preview & export</h3>
              <p className="text-xs text-textMuted mt-1">
                {clips.length} overlay{clips.length === 1 ? "" : "s"} on timeline
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={onEditTimeline}
                disabled={exporting || batchExportActive}
                className="px-3 py-1.5 rounded-lg text-sm border border-border text-textMuted hover:text-white hover:bg-white hover:bg-opacity-5 disabled:opacity-50"
              >
                Edit timeline
              </button>
              <button
                type="button"
                disabled={exporting || batchExportActive || ffmpegOk === false}
                onClick={handleExport}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-primary hover:bg-primaryHover text-white disabled:opacity-50 flex items-center gap-2"
              >
                <Wand2 size={14} />
                {exporting ? "Exporting…" : "Export this video"}
              </button>
              {exporting ? (
                <button
                  type="button"
                  disabled={exportSession.cancelling}
                  onClick={() => void cancelExport(video.id)}
                  className="px-3 py-1.5 rounded-lg text-sm border border-border text-textMuted hover:text-white disabled:opacity-50"
                >
                  {exportSession.cancelling ? "Cancelling…" : "Cancel"}
                </button>
              ) : null}
            </div>
          </div>

          <VideoPreviewWithOverlays
            key={`${video.id}-${clips.length}`}
            videoPath={video.path}
            rootPath={rootPath}
            clips={clips}
          />

          {exporting && exportSession.progress ? (
            <div>
              <p className="text-sm text-textMuted mb-2">
                {exportSession.progress.message ?? exportSession.progress.stage}{" "}
                — {Math.round(exportSession.progress.percent)}%
              </p>
              <div className="h-2 bg-background rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${exportSession.progress.percent}%` }}
                />
              </div>
            </div>
          ) : null}

          {exportSession.status === "success" && exportSession.resultPath ? (
            <p className="text-sm text-success">
              Saved to {exportSession.resultPath}
            </p>
          ) : null}

          {exportSession.status === "error" && exportSession.error ? (
            <p className="text-sm text-danger">{exportSession.error}</p>
          ) : null}

          {ffmpegOk === false ? (
            <p className="text-sm text-[#EAB308]">
              FFmpeg is not available — install FFmpeg to export videos.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ExportedVideoCard({
  exportRecord,
  isPlaying,
  onTogglePlay,
}: {
  exportRecord: FinalVideoExport;
  isPlaying: boolean;
  onTogglePlay: () => void;
}) {
  const videoSrc = convertFileSrc(exportRecord.outputPath);

  return (
    <div className="rounded-xl border border-border bg-background overflow-hidden">
      <div className="flex flex-col sm:flex-row">
        <div className="sm:w-64 flex-shrink-0 bg-black aspect-video sm:aspect-auto sm:h-36 relative">
          {isPlaying ? (
            <video
              src={videoSrc}
              controls
              autoPlay
              className="w-full h-full object-contain"
            />
          ) : (
            <button
              type="button"
              onClick={onTogglePlay}
              className="w-full h-full flex items-center justify-center text-white hover:bg-white hover:bg-opacity-5 transition-colors min-h-[9rem]"
            >
              <Play size={32} className="opacity-80" />
            </button>
          )}
        </div>
        <div className="flex-1 p-4 flex flex-col justify-between gap-3 min-w-0">
          <div>
            <p className="text-sm font-medium text-white truncate">{exportRecord.fileName}</p>
            <p className="text-xs text-textMuted mt-1">
              Exported {new Date(exportRecord.exportedAt).toLocaleString()}
            </p>
            <p className="text-xs text-textMuted mt-1 truncate" title={exportRecord.outputPath}>
              {exportRecord.outputPath}
            </p>
            <p className="text-[10px] text-textMuted mt-1 uppercase">
              {exportRecord.clipCount} overlay{exportRecord.clipCount === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={onTogglePlay}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-textMuted hover:text-white"
            >
              {isPlaying ? "Hide player" : "Play"}
            </button>
            <button
              type="button"
              onClick={() => void revealItemInDir(exportRecord.outputPath)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-textMuted hover:text-white flex items-center gap-1.5"
            >
              <FolderOpen size={12} /> Show in folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

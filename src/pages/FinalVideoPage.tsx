import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { VideoEditorModal } from "../components/video/VideoEditorModal";
import { VideoPreviewWithOverlays } from "../components/video/VideoPreviewWithOverlays";
import { EpisodeAccordion, type EpisodePanelSpec } from "../components/EpisodeAccordion";
import { useProject } from "../context/ProjectContext";
import {
  useVideoExport,
  useVideoExportSession,
} from "../context/VideoExportContext";
import {
  getFinalVideoTimeline,
  getOverlayImagesManifest,
  getTranscriptAnalysis,
  getTranscriptionPreflight,
  rebuildFinalVideoTimeline,
  saveFinalVideoTimeline,
} from "../services/pipelineService";
import type {
  FinalVideoTimeline,
  OverlayImagesManifest,
  TimelineVideoClip,
  TranscriptAnalysis,
  VideoJob,
  VideoOverlayClip,
} from "../types/pipeline";
import { videoHasTranscriptArtifact } from "../utils/format";

function exportStageLabel(stage: string): string {
  switch (stage) {
    case "prepare":
      return "Preparing";
    case "encode_cuda":
      return "GPU overlays + NVENC";
    case "encode_hw":
      return "Hardware encode";
    case "encode_sw":
      return "Software encode";
    case "fallback":
      return "Fallback";
    case "cancelled":
      return "Cancelled";
    case "complete":
      return "Complete";
    default:
      return stage;
  }
}

function formatExportElapsed(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function FinalVideoPage() {
  const { project } = useProject();
  const { getSession } = useVideoExport();
  const location = useLocation();
  const createdVideoIds =
    (location.state as { createdVideoIds?: string[] } | null)?.createdVideoIds ?? null;
  const [manifestByVideo, setManifestByVideo] = useState<
    Record<string, OverlayImagesManifest | null>
  >({});
  const [analysisByVideo, setAnalysisByVideo] = useState<
    Record<string, TranscriptAnalysis | null>
  >({});
  const [timelineByVideo, setTimelineByVideo] = useState<
    Record<string, FinalVideoTimeline | null>
  >({});
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [editingVideo, setEditingVideo] = useState<VideoJob | null>(null);
  const [loading, setLoading] = useState(false);

  const pipelineVideos = useMemo(
    () => project?.videos.filter((v) => videoHasTranscriptArtifact(v.status)) ?? [],
    [project?.videos],
  );

  const readyVideos = useMemo(
    () =>
      pipelineVideos.filter((v) => {
        const m = manifestByVideo[v.id];
        const a = analysisByVideo[v.id];
        return m && m.images.length > 0 && a && a.suggestions.length > 0;
      }),
    [pipelineVideos, manifestByVideo, analysisByVideo],
  );

  const refresh = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const man = await Promise.all(
        pipelineVideos.map(async (v) => {
          const m = await getOverlayImagesManifest(project.rootPath, v.id);
          return [v.id, m] as const;
        }),
      );
      const ana = await Promise.all(
        pipelineVideos.map(async (v) => {
          const a = await getTranscriptAnalysis(project.rootPath, v.id);
          return [v.id, a] as const;
        }),
      );
      setManifestByVideo(Object.fromEntries(man));
      setAnalysisByVideo(Object.fromEntries(ana));

      const timelines = await Promise.all(
        pipelineVideos.map(async (v) => {
          try {
            const t = await getFinalVideoTimeline(project.rootPath, v.id);
            return [v.id, t] as const;
          } catch {
            return [v.id, null] as const;
          }
        }),
      );
      setTimelineByVideo(Object.fromEntries(timelines));
    } finally {
      setLoading(false);
    }
  }, [project, pipelineVideos]);

  useEffect(() => {
    void refresh();
  }, [refresh, location.pathname]);

  useEffect(() => {
    if (!project || !createdVideoIds?.length) return;
    void (async () => {
      const entries = await Promise.all(
        createdVideoIds.map(async (id) => {
          const t = await getFinalVideoTimeline(project.rootPath, id);
          return [id, t] as const;
        }),
      );
      setTimelineByVideo((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    })();
  }, [project, createdVideoIds]);

  useEffect(() => {
    getTranscriptionPreflight().then((p) => setFfmpegOk(p.ffmpegAvailable));
  }, []);

  const handleRebuildTimeline = useCallback(
    async (videoId: string) => {
      if (!project) return null;
      const t = await rebuildFinalVideoTimeline(project.rootPath, videoId);
      setTimelineByVideo((prev) => ({ ...prev, [videoId]: t }));
      return t;
    },
    [project],
  );

  const panels: EpisodePanelSpec[] = useMemo(
    () =>
      readyVideos.map((v) => {
        const clips = timelineByVideo[v.id]?.clips ?? [];
        const videoClips = timelineByVideo[v.id]?.videoClips ?? [];
        const timeline = timelineByVideo[v.id];
        const imageCount = manifestByVideo[v.id]?.images.length ?? 0;
        const exportStatus = getSession(v.id).status;
        const exportSubtitle =
          exportStatus === "exporting"
            ? `Exporting… · ${clips.length} overlay${clips.length === 1 ? "" : "s"}`
            : exportStatus === "success"
              ? `Export done · ${clips.length} overlay${clips.length === 1 ? "" : "s"}`
              : `${clips.length} overlay${clips.length === 1 ? "" : "s"}`;
        return {
          id: v.id,
          title: v.fileName,
          subtitle: exportSubtitle,
          renderContent: () => (
            <FinalVideoEpisodeBody
              video={v}
              rootPath={project!.rootPath}
              clips={clips}
              videoClips={videoClips}
              contentStartMs={timeline?.contentStartMs}
              contentEndMs={timeline?.contentEndMs}
              enablePreviewKeyboard={!editingVideo}
              imageCount={imageCount}
              ffmpegOk={ffmpegOk}
              onRebuildTimeline={() => handleRebuildTimeline(v.id)}
              onEdit={() => setEditingVideo(v)}
            />
          ),
        };
      }),
    [
      readyVideos,
      project,
      timelineByVideo,
      manifestByVideo,
      ffmpegOk,
      handleRebuildTimeline,
      getSession,
      editingVideo,
    ],
  );

  const editingClips =
    editingVideo && timelineByVideo[editingVideo.id]
      ? timelineByVideo[editingVideo.id]!.clips
      : [];

  return (
    <section className="page">
      <header className="page-header">
        <h1>Final Video</h1>
        <p>
          Preview your source video with overlay images at the times suggested by OpenAI.
          Export a finished MP4 or edit overlay timing on the timeline.
        </p>
      </header>

      {ffmpegOk === false ? (
        <p className="error">
          FFmpeg is not available. Install FFmpeg to export videos (see Settings / Transcribe
          preflight).
        </p>
      ) : null}

      {!project ? (
        <p className="muted">Open a project first from Overview.</p>
      ) : readyVideos.length === 0 ? (
        <p className="muted">
          Complete the pipeline first: transcribe a video in Overview, then open{" "}
          <Link to="/editing">Editing</Link> to analyze overlays, generate images, and use{" "}
          <strong>Create video</strong> to build a timeline.
        </p>
      ) : (
        <>
          {loading ? <p className="muted">Loading timelines…</p> : null}
          {createdVideoIds && createdVideoIds.length > 0 ? (
            <p className="success" style={{ marginBottom: "1rem" }}>
              Final video timeline created for {createdVideoIds.length} episode
              {createdVideoIds.length === 1 ? "" : "s"}. Preview and export below.
            </p>
          ) : null}
          <EpisodeAccordion panels={panels} />
        </>
      )}

      {editingVideo && project ? (
        <VideoEditorModal
          video={editingVideo}
          rootPath={project.rootPath}
          initialClips={editingClips}
          onSave={async ({ clips, videoClips }) => {
            const existing = timelineByVideo[editingVideo.id];
            const timeline: FinalVideoTimeline = {
              videoId: editingVideo.id,
              clips,
              videoClips,
              contentStartMs: existing?.contentStartMs,
              contentEndMs: existing?.contentEndMs,
              updatedAt: new Date().toISOString(),
            };
            await saveFinalVideoTimeline(project.rootPath, timeline);
            setTimelineByVideo((prev) => ({
              ...prev,
              [editingVideo.id]: timeline,
            }));
          }}
          initialVideoClips={
            editingVideo && timelineByVideo[editingVideo.id]
              ? timelineByVideo[editingVideo.id]!.videoClips ?? []
              : []
          }
          contentStartMs={timelineByVideo[editingVideo.id]?.contentStartMs}
          contentEndMs={timelineByVideo[editingVideo.id]?.contentEndMs}
          onClose={() => setEditingVideo(null)}
        />
      ) : null}
    </section>
  );
}

function FinalVideoEpisodeBody({
  video,
  rootPath,
  clips,
  videoClips,
  contentStartMs,
  contentEndMs,
  enablePreviewKeyboard = true,
  imageCount,
  ffmpegOk,
  onRebuildTimeline,
  onEdit,
}: {
  video: VideoJob;
  rootPath: string;
  clips: VideoOverlayClip[];
  videoClips: TimelineVideoClip[];
  contentStartMs?: number;
  contentEndMs?: number;
  enablePreviewKeyboard?: boolean;
  imageCount: number;
  ffmpegOk: boolean | null;
  onRebuildTimeline: () => Promise<FinalVideoTimeline | null>;
  onEdit: () => void;
}) {
  const { startExport, cancelExport } = useVideoExport();
  const session = useVideoExportSession(video.id);
  const exporting = session.status === "exporting";
  const [rebuilding, setRebuilding] = useState(false);

  const handleExport = useCallback(() => {
    void startExport({
      videoId: video.id,
      fileName: video.fileName,
      rootPath,
      clips,
      videoClips,
    });
  }, [clips, rootPath, startExport, video.fileName, video.id, videoClips]);

  const handleCancelExport = useCallback(() => {
    void cancelExport(video.id);
  }, [cancelExport, video.id]);

  const handleRebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await onRebuildTimeline();
    } finally {
      setRebuilding(false);
    }
  }, [onRebuildTimeline]);

  const exportProgress = session.progress;
  const exportResult = session.status === "success" ? session.resultPath : null;
  const exportFinishedElapsedSec = session.finishedElapsedSec;
  const exportElapsedSec = session.elapsedSec;
  const error =
    session.status === "error"
      ? session.error
      : session.status === "cancelled"
        ? null
        : session.error;

  return (
    <div className="final-video-episode">
      <div className="final-video-actions">
        <button type="button" className="btn" onClick={onEdit} disabled={exporting}>
          Edit
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={exporting || ffmpegOk === false || clips.length === 0}
          onClick={handleExport}
        >
          {exporting ? "Exporting…" : "Export video"}
        </button>
        {exporting ? (
          <button
            type="button"
            className="btn"
            disabled={session.cancelling}
            onClick={handleCancelExport}
          >
            {session.cancelling ? "Cancelling…" : "Cancel export"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn small"
          disabled={rebuilding || exporting}
          onClick={() => void handleRebuild()}
        >
          {rebuilding ? "Rebuilding…" : "Rebuild timeline"}
        </button>
      </div>

      {clips.length === 0 && imageCount > 0 ? (
        <p className="error">
          No overlay clips on the timeline ({imageCount} image
          {imageCount === 1 ? "" : "s"} in gallery). This can happen if overlay analysis was
          re-run after images were generated. Click <strong>Rebuild timeline</strong> to match
          images with current analysis.
        </p>
      ) : null}

      <VideoPreviewWithOverlays
        key={`${video.id}-${clips.length}-${clips.map((c) => c.suggestionId).join(",")}`}
        videoPath={video.path}
        rootPath={rootPath}
        clips={clips}
        videoClips={videoClips}
        contentStartMs={contentStartMs}
        contentEndMs={contentEndMs}
        enableKeyboardShortcuts={enablePreviewKeyboard}
      />

      {clips.length > 0 ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          {clips.length} overlay{clips.length === 1 ? "" : "s"} — play the video to preview them
          at the scheduled times.
        </p>
      ) : null}

      {exporting ? (
        <div className="card progress-card">
          <p>
            <strong>
              {exportProgress
                ? exportStageLabel(exportProgress.stage)
                : "Preparing"}
            </strong>
            {" — "}
            {Math.round(exportProgress?.percent ?? 0)}%
            <span className="muted"> · elapsed {formatExportElapsed(exportElapsedSec)}</span>
          </p>
          <div
            className="progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(exportProgress?.percent ?? 0)}
            aria-label="Export progress"
          >
            <div
              className="progress-fill"
              style={{
                width: `${Math.min(100, Math.max(0, exportProgress?.percent ?? 0))}%`,
              }}
            />
          </div>
          {exportProgress?.message ? (
            <p className="muted" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
              {exportProgress.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {session.status === "cancelled" ? (
        <p className="muted">Export cancelled.</p>
      ) : null}

      {exportResult ? (
        <p className="success">
          Saved to: {exportResult}
          {exportFinishedElapsedSec != null ? (
            <span className="muted">
              {" "}
              (completed in {formatExportElapsed(exportFinishedElapsedSec)})
            </span>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <p className="error">
          {error}
          {error.includes("Software mode") ||
          error.includes("encode_hw") ||
          error.includes("encode_cuda") ? (
            <>
              {" "}
              Try <strong>Force software</strong> under Settings → Video export.
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

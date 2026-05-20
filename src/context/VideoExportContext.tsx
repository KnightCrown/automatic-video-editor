import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelVideoExport,
  exportFinalVideo,
  recordFinalVideoExport,
} from "../services/pipelineService";
import type { VideoExportProgress, TimelineVideoClip, VideoOverlayClip } from "../types/pipeline";
import { pickVideoSavePath, sanitizeDownloadFilename } from "../utils/download";

export type VideoExportStatus = "idle" | "exporting" | "success" | "error" | "cancelled";

export type VideoExportSession = {
  videoId: string;
  status: VideoExportStatus;
  progress: VideoExportProgress | null;
  startedAt: number | null;
  elapsedSec: number;
  finishedElapsedSec: number | null;
  resultPath: string | null;
  error: string | null;
  cancelling: boolean;
};

type VideoExportContextValue = {
  getSession: (videoId: string) => VideoExportSession;
  startExport: (args: {
    videoId: string;
    fileName: string;
    rootPath: string;
    clips: VideoOverlayClip[];
    videoClips?: TimelineVideoClip[];
  }) => Promise<boolean>;
  cancelExport: (videoId: string) => Promise<void>;
  clearSession: (videoId: string) => void;
};

const idleSession = (videoId: string): VideoExportSession => ({
  videoId,
  status: "idle",
  progress: null,
  startedAt: null,
  elapsedSec: 0,
  finishedElapsedSec: null,
  resultPath: null,
  error: null,
  cancelling: false,
});

const VideoExportContext = createContext<VideoExportContextValue | null>(null);

function isExportCancelledError(err: unknown): boolean {
  return String(err).includes("export_cancelled");
}

export function VideoExportProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Record<string, VideoExportSession>>({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const patchSession = useCallback(
    (videoId: string, patch: Partial<VideoExportSession>) => {
      setSessions((prev) => {
        const base = prev[videoId] ?? idleSession(videoId);
        return { ...prev, [videoId]: { ...base, ...patch, videoId } };
      });
    },
    [],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<VideoExportProgress>("video_export_progress", (event) => {
      const p = event.payload;
      const cur = sessionsRef.current[p.videoId];
      if (!cur || cur.status !== "exporting") return;
      setSessions((prev) => {
        const base = prev[p.videoId];
        if (!base || base.status !== "exporting") return prev;
        return {
          ...prev,
          [p.videoId]: { ...base, progress: p },
        };
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) void unlisten();
    };
  }, []);

  useEffect(() => {
    const exporting = Object.values(sessions).some((s) => s.status === "exporting");
    if (!exporting) return;

    const tick = () => {
      setSessions((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, session] of Object.entries(prev)) {
          if (session.status !== "exporting" || session.startedAt == null) continue;
          const elapsedSec = Math.floor((Date.now() - session.startedAt) / 1000);
          if (session.elapsedSec !== elapsedSec) {
            next[id] = { ...session, elapsedSec };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [sessions]);

  const getSession = useCallback(
    (videoId: string) => sessions[videoId] ?? idleSession(videoId),
    [sessions],
  );

  const clearSession = useCallback((videoId: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[videoId];
      return next;
    });
  }, []);

  const cancelExport = useCallback(
    async (videoId: string) => {
      const cur = sessionsRef.current[videoId];
      if (!cur || cur.status !== "exporting" || cur.cancelling) return;
      patchSession(videoId, { cancelling: true, error: null });
      try {
        await cancelVideoExport(videoId);
      } catch (err) {
        patchSession(videoId, { cancelling: false, error: String(err) });
      }
    },
    [patchSession],
  );

  const startExport = useCallback(
    async ({
      videoId,
      fileName,
      rootPath,
      clips,
      videoClips = [],
    }: {
      videoId: string;
      fileName: string;
      rootPath: string;
      clips: VideoOverlayClip[];
      videoClips?: TimelineVideoClip[];
    }) => {
      const cur = sessionsRef.current[videoId];
      if (cur?.status === "exporting") return false;

      const defaultName = sanitizeDownloadFilename(
        `${fileName.replace(/\.[^.]+$/, "")}-final.mp4`,
      );
      const outPath = await pickVideoSavePath(defaultName);
      if (!outPath) return false;

      const startedAt = Date.now();
      patchSession(videoId, {
        status: "exporting",
        startedAt,
        elapsedSec: 0,
        finishedElapsedSec: null,
        resultPath: null,
        error: null,
        cancelling: false,
        progress: {
          videoId,
          stage: "prepare",
          percent: 0,
          message: "Preparing export…",
        },
      });

      try {
        const path = await exportFinalVideo(rootPath, videoId, outPath, clips, videoClips);
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        try {
          await recordFinalVideoExport(
            rootPath,
            videoId,
            path,
            defaultName,
            clips.length,
          );
        } catch {
          /* export succeeded; registry is best-effort */
        }
        patchSession(videoId, {
          status: "success",
          startedAt: null,
          elapsedSec: elapsed,
          finishedElapsedSec: elapsed,
          resultPath: path,
          progress: {
            videoId,
            stage: "complete",
            percent: 100,
            message: "Export complete",
          },
          cancelling: false,
        });
        return true;
      } catch (err) {
        if (isExportCancelledError(err)) {
          patchSession(videoId, {
            status: "cancelled",
            startedAt: null,
            progress: {
              videoId,
              stage: "cancelled",
              percent: 0,
              message: "Export cancelled",
            },
            cancelling: false,
            finishedElapsedSec: null,
          });
        } else {
          patchSession(videoId, {
            status: "error",
            startedAt: null,
            error: String(err),
            cancelling: false,
          });
        }
        return true;
      }
    },
    [patchSession],
  );

  const value = useMemo(
    () => ({
      getSession,
      startExport,
      cancelExport,
      clearSession,
    }),
    [getSession, startExport, cancelExport, clearSession],
  );

  return (
    <VideoExportContext.Provider value={value}>{children}</VideoExportContext.Provider>
  );
}

export function useVideoExport() {
  const ctx = useContext(VideoExportContext);
  if (!ctx) {
    throw new Error("useVideoExport must be used within VideoExportProvider");
  }
  return ctx;
}

export function useVideoExportSession(videoId: string): VideoExportSession {
  const { getSession } = useVideoExport();
  return getSession(videoId);
}

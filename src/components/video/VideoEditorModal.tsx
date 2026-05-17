import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoJob, VideoOverlayClip } from "../../types/pipeline";
import {
  VideoPreviewWithOverlays,
  type VideoPreviewHandle,
} from "./VideoPreviewWithOverlays";
import { VideoTimelineEditor } from "./VideoTimelineEditor";

type Props = {
  video: VideoJob;
  rootPath: string;
  initialClips: VideoOverlayClip[];
  onSave: (clips: VideoOverlayClip[]) => Promise<void>;
  onClose: () => void;
};

export function VideoEditorModal({
  video,
  rootPath,
  initialClips,
  onSave,
  onClose,
}: Props) {
  const previewRef = useRef<VideoPreviewHandle>(null);
  const [clips, setClips] = useState<VideoOverlayClip[]>(initialClips);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pxPerMs, setPxPerMs] = useState(0.05);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setClips(initialClips);
    setSelectedId(null);
    setCurrentMs(0);
  }, [video.id, initialClips]);

  const handleSeek = useCallback((ms: number) => {
    previewRef.current?.seekToMs(ms);
    setCurrentMs(ms);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(clips);
      onClose();
    } finally {
      setSaving(false);
    }
  }, [clips, onClose, onSave]);

  return (
    <div className="video-editor-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="video-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-editor-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="video-editor-modal-header">
          <h2 id="video-editor-title">Edit — {video.fileName}</h2>
          <button type="button" className="btn small" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="video-editor-modal-body">
          <VideoPreviewWithOverlays
            ref={previewRef}
            videoPath={video.path}
            rootPath={rootPath}
            clips={clips}
            large
            onTimeUpdate={setCurrentMs}
            onDurationChange={setDurationMs}
            showSeekMarkers
          />

          <VideoTimelineEditor
            clips={clips}
            durationMs={durationMs || 60_000}
            currentMs={currentMs}
            selectedId={selectedId}
            pxPerMs={pxPerMs}
            fitToWidth
            onClipsChange={setClips}
            onSelect={setSelectedId}
            onSeek={handleSeek}
            onPxPerMsChange={setPxPerMs}
          />
        </div>

        <footer className="video-editor-modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save timeline"}
          </button>
        </footer>
      </div>
    </div>
  );
}

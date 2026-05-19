import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { downloadFromUrl } from "../utils/download";

export type ImageLightboxPayload = {
  imageUrl: string;
  title?: string;
  excerpt?: string;
  timeLabel?: string;
  downloadFilename?: string;
};

type Props = {
  payload: ImageLightboxPayload | null;
  onClose: () => void;
};

export function ImageLightbox({ payload, onClose }: Props) {
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!payload) setDownloading(false);
  }, [payload]);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payload, onClose]);

  if (!payload) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="relative max-w-5xl w-full max-h-[90vh] flex flex-col bg-surface border border-border rounded-xl overflow-hidden shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={payload.title ?? "Image preview"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-[#151821] flex-shrink-0">
          <div className="min-w-0 flex-1" title={payload.title}>
            {payload.title ? (
              <h2 className="text-sm font-medium text-white truncate">{payload.title}</h2>
            ) : null}
            {payload.timeLabel ? (
              <p className="text-xs text-primary font-mono mt-0.5">{payload.timeLabel}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {payload.downloadFilename ? (
              <button
                type="button"
                disabled={downloading}
                onClick={() => {
                  setDownloading(true);
                  void downloadFromUrl(payload.imageUrl, payload.downloadFilename!)
                    .catch(() => undefined)
                    .finally(() => setDownloading(false));
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#8B5CF6] hover:bg-[#7C3AED] text-white disabled:opacity-50"
              >
                <Download size={14} />
                {downloading ? "Saving…" : "Download"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-textMuted hover:text-white hover:bg-white/10"
              aria-label="Close preview"
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto bg-background flex items-center justify-center p-4">
          <img
            src={payload.imageUrl}
            alt={payload.title ?? ""}
            className="max-w-full max-h-[min(60vh,720px)] object-contain rounded-lg"
          />
        </div>
        {payload.excerpt ? (
          <div className="px-4 py-3 border-t border-border flex-shrink-0 max-h-[30vh] overflow-y-auto">
            <p className="text-xs text-textMuted font-semibold uppercase tracking-wider mb-1">
              Transcript excerpt
            </p>
            <p className="text-sm text-white leading-relaxed">{payload.excerpt}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

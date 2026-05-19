import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { OverlayClipLayout } from "../types/pipeline";
import {
  clampOverlayEditorRect,
  editorRectToLayout,
  layoutToEditorRect,
  type OverlayEditorRect,
} from "../utils/overlayLayout";

type Props = {
  open: boolean;
  initialLayout: OverlayClipLayout;
  onClose: () => void;
  onSave: (layout: OverlayClipLayout) => void;
};

type DragMode = "move" | "resize" | null;

export function OverlaySettingsModal({ open, initialLayout, onClose, onSave }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<OverlayEditorRect>(() => layoutToEditorRect(initialLayout));
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    startRect: OverlayEditorRect;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setRect(layoutToEditorRect(initialLayout));
    }
  }, [open, initialLayout]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const pointerPercent = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      xPct: ((clientX - box.left) / box.width) * 100,
      yPct: ((clientY - box.top) / box.height) * 100,
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const pt = pointerPercent(e.clientX, e.clientY);
      if (!pt) return;

      if (drag.mode === "move") {
        const dx = pt.xPct - drag.startX;
        const dy = pt.yPct - drag.startY;
        setRect(
          clampOverlayEditorRect({
            xPct: drag.startRect.xPct + dx,
            yPct: drag.startRect.yPct + dy,
            widthPct: drag.startRect.widthPct,
          }),
        );
        return;
      }

      if (drag.mode === "resize") {
        const widthPct = pt.xPct - drag.startRect.xPct;
        setRect(
          clampOverlayEditorRect({
            xPct: drag.startRect.xPct,
            yPct: drag.startRect.yPct,
            widthPct,
          }),
        );
      }
    };

    const onPointerUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [open, pointerPercent]);

  const startDrag = (mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pt = pointerPercent(e.clientX, e.clientY);
    if (!pt || !mode) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode,
      startX: pt.xPct,
      startY: pt.yPct,
      startRect: rect,
    };
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl flex flex-col bg-surface border border-border rounded-xl overflow-hidden shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Overlay settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border bg-[#151821]">
          <div>
            <h2 className="text-base font-semibold text-white">Overlay settings</h2>
            <p className="text-xs text-textMuted mt-1">
              Drag to move. Drag the corner to resize. Overlay stays 16:9.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-textMuted hover:text-white hover:bg-background"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 sm:p-6">
          <div
            ref={canvasRef}
            className="relative w-full aspect-video rounded-lg bg-[#4a4a4a] border border-border overflow-hidden select-none touch-none"
          >
            <div
              className="absolute aspect-video rounded-md border-2 border-red-500 bg-red-500/35 shadow-lg cursor-move"
              style={{
                left: `${rect.xPct}%`,
                top: `${rect.yPct}%`,
                width: `${rect.widthPct}%`,
              }}
              onPointerDown={(e) => startDrag("move", e)}
            >
              <span className="absolute inset-0 flex items-center justify-center text-[10px] sm:text-xs font-medium text-white/90 pointer-events-none">
                Overlay
              </span>
              <button
                type="button"
                aria-label="Resize overlay"
                className="absolute right-0 bottom-0 w-4 h-4 sm:w-5 sm:h-5 translate-x-1/2 translate-y-1/2 rounded-sm bg-red-500 border-2 border-white cursor-se-resize shadow"
                onPointerDown={(e) => startDrag("resize", e)}
              />
            </div>
          </div>
          <p className="text-xs text-textMuted mt-3 text-center">
            Gray area is the video frame. Red box is where overlay images appear on export.
          </p>
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t border-border bg-[#151821]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-textMuted border border-border hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(editorRectToLayout(rect))}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary hover:bg-primaryHover text-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

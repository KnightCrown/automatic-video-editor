import type { OverlayClipLayout, VideoOverlayClip } from "../types/pipeline";
import { DEFAULT_OVERLAY_LAYOUT } from "../types/pipeline";

/** Top-left position and width (% of screen) for the 16:9 overlay editor. */
export type OverlayEditorRect = {
  xPct: number;
  yPct: number;
  widthPct: number;
};

export const OVERLAY_EDITOR_MIN_WIDTH_PCT = 12;
export const OVERLAY_EDITOR_MAX_WIDTH_PCT = 85;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** On a 16:9 screen, a 16:9 overlay's height as % of screen height equals its width %. */
export function overlayHeightPct(widthPct: number): number {
  return widthPct;
}

export function layoutToEditorRect(layout: OverlayClipLayout): OverlayEditorRect {
  const widthPct = layout.widthPct;
  const xPct =
    layout.anchor === "top-right"
      ? 100 - layout.marginXPct - widthPct
      : layout.marginXPct;
  return clampOverlayEditorRect({
    xPct,
    yPct: layout.marginYPct,
    widthPct,
  });
}

export function editorRectToLayout(rect: OverlayEditorRect): OverlayClipLayout {
  const normalized = clampOverlayEditorRect(rect);
  return {
    anchor: "top-right",
    marginXPct: 100 - normalized.xPct - normalized.widthPct,
    marginYPct: normalized.yPct,
    widthPct: normalized.widthPct,
  };
}

export function clampOverlayEditorRect(rect: OverlayEditorRect): OverlayEditorRect {
  const widthPct = clamp(
    rect.widthPct,
    OVERLAY_EDITOR_MIN_WIDTH_PCT,
    OVERLAY_EDITOR_MAX_WIDTH_PCT,
  );
  const heightPct = overlayHeightPct(widthPct);
  const maxX = 100 - widthPct;
  const maxY = 100 - heightPct;
  return {
    widthPct,
    xPct: clamp(rect.xPct, 0, maxX),
    yPct: clamp(rect.yPct, 0, maxY),
  };
}

export function overlayLayoutFromSettings(
  settings?: { defaultOverlayLayout?: OverlayClipLayout },
): OverlayClipLayout {
  return settings?.defaultOverlayLayout ?? DEFAULT_OVERLAY_LAYOUT;
}

export function applyOverlayLayoutToClips(
  clips: VideoOverlayClip[],
  layout: OverlayClipLayout,
): VideoOverlayClip[] {
  const copy = { ...layout };
  return clips.map((clip) => ({ ...clip, layout: { ...copy } }));
}

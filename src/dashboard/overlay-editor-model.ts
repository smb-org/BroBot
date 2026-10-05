import type { OverlayStyleAlignment } from "./overlay-style-model";

export interface OverlayEditorPosition {
  x: number;
  y: number;
}

export interface OverlayEditorSize {
  width: number;
  height: number;
}

export interface OverlayEditorPositionLimits extends OverlayEditorPosition {
  minX: number;
}

export const overlayEditorMeasuredSize = (
  measured: OverlayEditorSize,
  fallback: OverlayEditorSize,
): OverlayEditorSize => measured.width === 0 && measured.height === 0 ? fallback : measured;

/** Fallback bounds for pointer-drag clamping before an element has rendered measurable dimensions. */
export const UNMEASURED_ELEMENT_FALLBACK_SIZE: OverlayEditorSize = { width: 40, height: 40 };

export const overlayEditorPositionLimits = (
  canvas: OverlayEditorSize,
  renderedElement: OverlayEditorSize,
  anchor: OverlayStyleAlignment = "left",
): OverlayEditorPositionLimits => {
  const width = Math.max(0, renderedElement.width);
  const minimumX = anchor === "right" ? Math.ceil(width) : anchor === "center" ? Math.ceil(width / 2) : 0;
  const maximumX = anchor === "right" ? Math.floor(canvas.width)
    : anchor === "center" ? Math.floor(canvas.width - width / 2)
      : Math.floor(canvas.width - width);
  if (minimumX <= maximumX) {
    return {
      minX: minimumX,
      x: maximumX,
      y: Math.max(0, Math.floor(canvas.height - Math.max(0, renderedElement.height))),
    };
  }
  const fallbackX = anchor === "right" ? Math.floor(canvas.width) : anchor === "center" ? Math.round(canvas.width / 2) : 0;
  return {
    minX: fallbackX,
    x: fallbackX,
    y: Math.max(0, Math.floor(canvas.height - Math.max(0, renderedElement.height))),
  };
};

export const clampOverlayEditorPosition = (
  position: OverlayEditorPosition,
  canvas: OverlayEditorSize,
  renderedElement: OverlayEditorSize,
  anchor: OverlayStyleAlignment = "left",
): OverlayEditorPosition => {
  const limits = overlayEditorPositionLimits(canvas, renderedElement, anchor);
  return {
    x: Number.isFinite(position.x) ? Math.round(Math.max(limits.minX, Math.min(limits.x, position.x))) : limits.minX,
    y: Number.isFinite(position.y) ? Math.round(Math.max(0, Math.min(limits.y, position.y))) : 0,
  };
};

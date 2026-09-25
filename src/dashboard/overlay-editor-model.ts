export interface OverlayEditorPosition {
  x: number;
  y: number;
}

export interface OverlayEditorSize {
  width: number;
  height: number;
}

/**
 * Used to clamp position when an element's real rendered size is not known yet
 * (e.g. it is hidden with `inComposition: false` and about to be shown), so a
 * position picked while the element was invisible cannot leave it off-canvas.
 */
export const UNMEASURED_ELEMENT_FALLBACK_SIZE: OverlayEditorSize = { width: 40, height: 40 };

export const overlayEditorPositionLimits = (
  canvas: OverlayEditorSize,
  renderedElement: OverlayEditorSize,
): OverlayEditorPosition => ({
  x: Math.max(0, Math.floor(canvas.width - Math.max(0, renderedElement.width))),
  y: Math.max(0, Math.floor(canvas.height - Math.max(0, renderedElement.height))),
});

export const clampOverlayEditorPosition = (
  position: OverlayEditorPosition,
  canvas: OverlayEditorSize,
  renderedElement: OverlayEditorSize,
): OverlayEditorPosition => {
  const limits = overlayEditorPositionLimits(canvas, renderedElement);
  return {
    x: Number.isFinite(position.x) ? Math.round(Math.max(0, Math.min(limits.x, position.x))) : 0,
    y: Number.isFinite(position.y) ? Math.round(Math.max(0, Math.min(limits.y, position.y))) : 0,
  };
};

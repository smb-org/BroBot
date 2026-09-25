export interface OverlayEditorPosition {
  x: number;
  y: number;
}

export interface OverlayEditorSize {
  width: number;
  height: number;
}

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

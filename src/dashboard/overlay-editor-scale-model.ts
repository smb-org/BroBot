import { clampOverlayEditorPosition, type OverlayEditorSize, type OverlayEditorPosition } from "./overlay-editor-model";
import type { OverlayStyleAlignment } from "./overlay-style-model";
import { OVERLAY_ELEMENT_MAXIMUM_WIDTH_PX, OVERLAY_ELEMENT_MINIMUM_WIDTH_PX } from "../contracts/values";

export { OVERLAY_ELEMENT_MAXIMUM_WIDTH_PX, OVERLAY_ELEMENT_MINIMUM_WIDTH_PX } from "../contracts/values";

export type OverlayEditorScaleCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type OverlayEditorWidthEdge = "left" | "right";

export interface OverlayEditorElementBounds extends OverlayEditorSize {
  left: number;
  top: number;
}

interface ScaleHandleDragInput {
  scalePercent: number;
  bounds: OverlayEditorElementBounds;
  corner: OverlayEditorScaleCorner;
  pointer: OverlayEditorPosition;
  canvas: OverlayEditorSize;
  anchor: OverlayStyleAlignment;
  shiftKey: boolean;
}

export interface OverlayEditorScaledPosition extends OverlayEditorPosition {
  scalePercent: number;
}

export interface OverlayEditorWidthPosition extends OverlayEditorPosition {
  widthPx: number | null;
}

interface WidthHandleDragInput {
  scalePercent: number;
  bounds: OverlayEditorElementBounds;
  edge: OverlayEditorWidthEdge;
  pointer: OverlayEditorPosition;
  canvas: OverlayEditorSize;
  anchor: OverlayStyleAlignment;
}

interface WidthFieldInput {
  widthPx: number | null;
  bounds: OverlayEditorElementBounds;
  scalePercent: number;
  canvas: OverlayEditorSize;
  anchor: OverlayStyleAlignment;
}

const clampScalePercent = (scalePercent: number): number => Math.max(25, Math.min(400, scalePercent));

const clampWidthPx = (widthPx: number, maximumWidthPx = OVERLAY_ELEMENT_MAXIMUM_WIDTH_PX): number =>
  Math.max(OVERLAY_ELEMENT_MINIMUM_WIDTH_PX, Math.min(OVERLAY_ELEMENT_MAXIMUM_WIDTH_PX, maximumWidthPx, Math.round(widthPx)));

const anchorXForBounds = (bounds: OverlayEditorElementBounds, anchor: OverlayStyleAlignment): number =>
  anchor === "right" ? bounds.left + bounds.width : anchor === "center" ? bounds.left + bounds.width / 2 : bounds.left;

const elementXForLeftAndWidth = (left: number, width: number, anchor: OverlayStyleAlignment): number =>
  anchor === "right" ? left + width : anchor === "center" ? left + width / 2 : left;

/** Resizes a side handle in canvas pixels while holding the opposite edge in place. */
export const resizeOverlayElementWidthFromHandleDrag = ({
  scalePercent,
  bounds,
  edge,
  pointer,
  canvas,
  anchor,
}: WidthHandleDragInput): OverlayEditorWidthPosition => {
  const scale = clampScalePercent(scalePercent) / 100;
  const movingDirection = edge === "left" ? -1 : 1;
  const fixedX = edge === "left" ? bounds.left + bounds.width : bounds.left;
  const availableVisibleWidth = edge === "left" ? fixedX : canvas.width - fixedX;
  const maximumWidthPx = Math.max(OVERLAY_ELEMENT_MINIMUM_WIDTH_PX, Math.floor(Math.max(0, availableVisibleWidth) / scale));
  const requestedWidthPx = (pointer.x - fixedX) * movingDirection / scale;
  const nextWidthPx = clampWidthPx(requestedWidthPx, maximumWidthPx);
  const renderedWidth = nextWidthPx * scale;
  const left = edge === "left" ? fixedX - renderedWidth : fixedX;
  const x = elementXForLeftAndWidth(left, renderedWidth, anchor);
  const position = clampOverlayEditorPosition(
    { x, y: bounds.top },
    canvas,
    { width: renderedWidth, height: bounds.height },
    anchor,
  );
  return { widthPx: nextWidthPx, ...position };
};

/** Applies a numeric width while keeping the element's horizontal anchor in place. */
export const setOverlayElementWidthFromField = ({
  widthPx,
  bounds,
  scalePercent,
  canvas,
  anchor,
}: WidthFieldInput): OverlayEditorWidthPosition => {
  const scale = clampScalePercent(scalePercent) / 100;
  const anchorX = anchorXForBounds(bounds, anchor);
  const maximumVisibleWidth = anchor === "right"
    ? anchorX
    : anchor === "center"
      ? Math.min(anchorX, canvas.width - anchorX) * 2
      : canvas.width - anchorX;
  const maximumWidthPx = Math.max(OVERLAY_ELEMENT_MINIMUM_WIDTH_PX, Math.floor(maximumVisibleWidth / scale));
  const nextWidthPx = widthPx === null ? null : clampWidthPx(widthPx, maximumWidthPx);
  const renderedWidth = nextWidthPx === null ? bounds.width : nextWidthPx * scale;
  const left = anchor === "right" ? anchorX - renderedWidth : anchor === "center" ? anchorX - renderedWidth / 2 : anchorX;
  const position = clampOverlayEditorPosition(
    { x: elementXForLeftAndWidth(left, renderedWidth, anchor), y: bounds.top },
    canvas,
    { width: renderedWidth, height: bounds.height },
    anchor,
  );
  return { widthPx: nextWidthPx, ...position };
};

export const scaleOverlayElementFromHandleDrag = ({
  scalePercent,
  bounds,
  corner,
  pointer,
  canvas,
  anchor,
  shiftKey,
}: ScaleHandleDragInput): OverlayEditorScaledPosition => {
  const currentScale = clampScalePercent(scalePercent);
  const handleX = corner.endsWith("left") ? -1 : 1;
  const handleY = corner.startsWith("top") ? -1 : 1;
  const fixedX = handleX < 0 ? bounds.left + bounds.width : bounds.left;
  const fixedY = handleY < 0 ? bounds.top + bounds.height : bounds.top;
  const horizontalFactor = bounds.width <= 0 ? 1 : (pointer.x - fixedX) * handleX / bounds.width;
  const verticalFactor = bounds.height <= 0 ? 1 : (pointer.y - fixedY) * handleY / bounds.height;
  const factor = Math.abs(horizontalFactor - 1) >= Math.abs(verticalFactor - 1) ? horizontalFactor : verticalFactor;
  const step = shiftKey ? 5 : 1;
  const requestedScale = currentScale * factor;
  const snappedScale = Math.round(requestedScale / step) * step;
  const maximumWidth = handleX < 0 ? fixedX : canvas.width - fixedX;
  const maximumHeight = handleY < 0 ? fixedY : canvas.height - fixedY;
  const maximumScale = Math.min(
    bounds.width <= 0 ? 400 : currentScale * Math.max(0, maximumWidth) / bounds.width,
    bounds.height <= 0 ? 400 : currentScale * Math.max(0, maximumHeight) / bounds.height,
    400,
  );
  const nextScale = clampScalePercent(Math.min(snappedScale, Math.floor(maximumScale / step) * step));
  const sizeFactor = nextScale / currentScale;
  const width = bounds.width * sizeFactor;
  const height = bounds.height * sizeFactor;
  const left = handleX < 0 ? fixedX - width : fixedX;
  const top = handleY < 0 ? fixedY - height : fixedY;
  const x = anchor === "right" ? left + width : anchor === "center" ? left + width / 2 : left;
  const position = clampOverlayEditorPosition({ x, y: top }, canvas, { width, height }, anchor);

  return { scalePercent: nextScale, ...position };
};

export const stepOverlayScaleFromKeyboard = (scalePercent: number, key: string): number | null => {
  const direction = key === "+" || key === "=" ? 1 : key === "-" || key === "−" ? -1 : 0;
  return direction === 0 ? null : clampScalePercent(scalePercent + direction * 5);
};

import { describe, expect, it } from "vitest";

import {
  resizeOverlayElementWidthFromHandleDrag,
  scaleOverlayElementFromHandleDrag,
  setOverlayElementWidthFromField,
  stepOverlayScaleFromKeyboard,
} from "../../src/dashboard/overlay-editor-scale-model";

describe("overlay editor scale handles", () => {
  it("scales both dimensions proportionally while keeping the opposite corner fixed", () => {
    expect(scaleOverlayElementFromHandleDrag({
      scalePercent: 100,
      bounds: { left: 100, top: 100, width: 200, height: 100 },
      corner: "bottom-right",
      pointer: { x: 360, y: 230 },
      canvas: { width: 1920, height: 1080 },
      anchor: "left",
      shiftKey: false,
    })).toEqual({ scalePercent: 130, x: 100, y: 100 });
  });

  it("keeps the bottom edge fixed when scaling from a top corner", () => {
    expect(scaleOverlayElementFromHandleDrag({
      scalePercent: 100,
      bounds: { left: 100, top: 300, width: 200, height: 100 },
      corner: "top-right",
      pointer: { x: 360, y: 270 },
      canvas: { width: 1920, height: 1080 },
      anchor: "left",
      shiftKey: false,
    })).toEqual({ scalePercent: 130, x: 100, y: 270 });
  });

  it("respects the horizontal anchor when holding the opposite corner", () => {
    expect(scaleOverlayElementFromHandleDrag({
      scalePercent: 100,
      bounds: { left: 1400, top: 100, width: 200, height: 100 },
      corner: "bottom-left",
      pointer: { x: 1340, y: 230 },
      canvas: { width: 1920, height: 1080 },
      anchor: "right",
      shiftKey: false,
    })).toEqual({ scalePercent: 130, x: 1600, y: 100 });
  });

  it("keeps the fixed corner in place when the canvas edge limits a drag", () => {
    const result = scaleOverlayElementFromHandleDrag({
      scalePercent: 100,
      bounds: { left: 1700, top: 100, width: 200, height: 100 },
      corner: "bottom-right",
      pointer: { x: 2500, y: 500 },
      canvas: { width: 1920, height: 1080 },
      anchor: "left",
      shiftKey: false,
    });

    expect(result).toEqual({ scalePercent: 110, x: 1700, y: 100 });
    expect(result.x + 200 * result.scalePercent / 100).toBeLessThanOrEqual(1920);
  });

  it("snaps to whole percentages normally and five percent steps with Shift", () => {
    const input = {
      scalePercent: 100,
      bounds: { left: 100, top: 100, width: 200, height: 100 },
      corner: "bottom-right" as const,
      pointer: { x: 371, y: 235 },
      canvas: { width: 1920, height: 1080 },
      anchor: "left" as const,
    };

    expect(scaleOverlayElementFromHandleDrag({ ...input, shiftKey: false }).scalePercent).toBe(136);
    expect(scaleOverlayElementFromHandleDrag({ ...input, shiftKey: true }).scalePercent).toBe(135);
  });

  it("clamps handle scales to 25–400 percent", () => {
    const input = {
      scalePercent: 100,
      bounds: { left: 100, top: 100, width: 200, height: 100 },
      corner: "bottom-right" as const,
      canvas: { width: 1920, height: 1080 },
      anchor: "left" as const,
      shiftKey: false,
    };

    expect(scaleOverlayElementFromHandleDrag({ ...input, pointer: { x: -100, y: -100 } }).scalePercent).toBe(25);
    expect(scaleOverlayElementFromHandleDrag({ ...input, pointer: { x: 2000, y: 1000 } }).scalePercent).toBe(400);
  });

  it("steps the focused element by five percent and respects scale limits", () => {
    expect(stepOverlayScaleFromKeyboard(100, "+")).toBe(105);
    expect(stepOverlayScaleFromKeyboard(100, "-")).toBe(95);
    expect(stepOverlayScaleFromKeyboard(400, "+")).toBe(400);
    expect(stepOverlayScaleFromKeyboard(25, "-")).toBe(25);
    expect(stepOverlayScaleFromKeyboard(100, "x")).toBeNull();
  });
});

describe("overlay editor width handles", () => {
  it("changes width from the right edge while keeping the left edge fixed", () => {
    expect(resizeOverlayElementWidthFromHandleDrag({
      scalePercent: 100,
      bounds: { left: 100, top: 40, width: 200, height: 60 },
      edge: "right",
      pointer: { x: 351, y: 70 },
      canvas: { width: 1920, height: 1080 },
      anchor: "left",
    })).toEqual({ widthPx: 251, x: 100, y: 40 });
  });

  it("changes width from the left edge while keeping the right anchor fixed", () => {
    expect(resizeOverlayElementWidthFromHandleDrag({
      scalePercent: 100,
      bounds: { left: 300, top: 40, width: 200, height: 60 },
      edge: "left",
      pointer: { x: 400, y: 70 },
      canvas: { width: 1920, height: 1080 },
      anchor: "right",
    })).toEqual({ widthPx: 100, x: 500, y: 40 });
  });

  it("converts the pointer distance through scale and clamps at the canvas edges and minimum width", () => {
    const canvas = { width: 1920, height: 1080 };
    const rightClamped = resizeOverlayElementWidthFromHandleDrag({
      scalePercent: 100,
      bounds: { left: 1700, top: 0, width: 200, height: 50 },
      edge: "right",
      pointer: { x: 2500, y: 25 },
      canvas,
      anchor: "left",
    });
    expect(rightClamped).toEqual({ widthPx: 220, x: 1700, y: 0 });

    const minimum = resizeOverlayElementWidthFromHandleDrag({
      scalePercent: 200,
      bounds: { left: 0, top: 0, width: 200, height: 50 },
      edge: "left",
      pointer: { x: 199, y: 25 },
      canvas,
      anchor: "left",
    });
    expect(minimum).toEqual({ widthPx: 80, x: 40, y: 0 });
  });

  it("syncs field changes with the horizontal anchor, canvas clamp, and automatic reset", () => {
    const base = {
      bounds: { left: 100, top: 30, width: 200, height: 60 },
      scalePercent: 100,
      canvas: { width: 500, height: 300 },
    };
    expect(setOverlayElementWidthFromField({ ...base, widthPx: 300, anchor: "right" }))
      .toEqual({ widthPx: 300, x: 300, y: 30 });
    expect(setOverlayElementWidthFromField({ ...base, widthPx: 600, anchor: "left" }))
      .toEqual({ widthPx: 400, x: 100, y: 30 });
    expect(setOverlayElementWidthFromField({ ...base, widthPx: null, anchor: "center" }))
      .toEqual({ widthPx: null, x: 200, y: 30 });
  });
});

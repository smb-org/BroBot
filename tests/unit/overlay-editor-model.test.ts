import { describe, expect, it } from "vitest";

import { clampOverlayEditorPosition, overlayEditorPositionLimits } from "../../src/dashboard/overlay-editor-model";

describe("overlay editor element bounds", () => {
  it("keeps the full rendered element inside the reference canvas", () => {
    expect(clampOverlayEditorPosition(
      { x: -8, y: 999 },
      { width: 1280, height: 720 },
      { width: 300, height: 95 },
    )).toEqual({ x: 0, y: 625 });
  });

  it("uses rendered dimensions after element scaling", () => {
    const renderedElement = { width: 450, height: 160 };
    expect(overlayEditorPositionLimits({ width: 1280, height: 720 }, renderedElement)).toEqual({ x: 830, y: 560 });
    expect(clampOverlayEditorPosition(
      { x: 1280, y: 720 },
      { width: 1280, height: 720 },
      renderedElement,
    )).toEqual({ x: 830, y: 560 });
  });

  it("anchors an element at the origin when it is larger than the canvas", () => {
    expect(clampOverlayEditorPosition(
      { x: 48, y: 24 },
      { width: 320, height: 180 },
      { width: 500, height: 240 },
    )).toEqual({ x: 0, y: 0 });
  });
});

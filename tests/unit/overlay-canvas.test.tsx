import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { generateOverlayStyleBlock } from "../../src/dashboard/overlay-style-model";
import { OverlayCanvas } from "../../src/overlay/canvas";

const overlay = {
  id: "overlay-a",
  revision: 1,
  width: 1280,
  height: 720,
  css: generateOverlayStyleBlock({ overlay: {}, elements: { "element-a": { textAlign: "right" } } }),
  elements: [{
    id: "element-a", kind: "variable", label: "Score", variableName: "score", text: "Score: {value}",
    x: 900, y: 100, scalePercent: 150, z: 0, inComposition: true,
  }],
};

describe("OverlayCanvas anchors", () => {
  afterEach(cleanup);

  it("applies the managed horizontal anchor before the composition scale", () => {
    const { container } = render(<OverlayCanvas
      overlay={overlay}
      language="en"
      variables={{ score: 1234 }}
      elementId={null}
      debug={false}
    />);

    const element = container.querySelector<HTMLElement>('[data-element="element-a"]');
    expect(element).not.toBeNull();
    expect(element?.className).toBe("brobot-overlay-composition-element");
    expect(element?.style.transform).toBe("scale(1.5) translateX(var(--brobot-overlay-anchor-x, 0%))");
    expect(overlay.css).toContain("--brobot-overlay-anchor-x: -100%;");
  });

  it("keeps the standalone element transform unchanged", () => {
    const { container } = render(<OverlayCanvas
      overlay={overlay}
      language="en"
      variables={{ score: 1234 }}
      elementId="element-a"
      debug={false}
    />);

    const element = container.querySelector<HTMLElement>("[data-element]");
    expect(element).not.toBeNull();
    expect(element?.className).toBe("");
    expect(element?.style.transform).toBe("scale(1.5)");
  });
});

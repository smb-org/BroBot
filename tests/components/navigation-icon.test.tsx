import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NavigationIcon } from "../../src/dashboard/ui/NavigationIcon";

describe("navigation icons", () => {
  it("renders named SVG icons for navigation pages and modules", () => {
    const kinds = ["faq", "votekick", "events", "overlays", "system", "variable", "audit"];
    const { container } = render(<>{kinds.map((kind) => <NavigationIcon key={kind} kind={kind} />)}</>);
    const icons = [...container.querySelectorAll("svg")];

    expect(icons).toHaveLength(kinds.length);
    for (const icon of icons) {
      expect(icon.querySelectorAll("path, circle, rect, line, polyline").length).toBeGreaterThan(0);
      expect(icon).toHaveAttribute("fill", "none");
    }
  });
});

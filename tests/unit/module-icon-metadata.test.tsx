import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { ModuleIcon } from "../../src/dashboard/module-panels";

afterEach(cleanup);

describe("module panel icon metadata", () => {
  it("declares raid and clips glyph paths on their own module metadata", () => {
    for (const id of ["raid", "clips"]) {
      const module = MODULES.find((entry) => entry.id === id);
      expect(module?.panelIcon?.paths.length, id).toBeGreaterThan(0);
    }
  });

  it("renders each icon descriptor through the same generic SVG renderer", () => {
    const { container } = render(<>{MODULES.map((module) => <ModuleIcon key={module.id} moduleId={module.id} />)}</>);
    MODULES.forEach((module, index) => {
      const glyph = container.querySelector(`svg:nth-of-type(${String(index + 1)})`);
      expect(Array.from(glyph?.querySelectorAll("path") ?? []).map((path) => path.getAttribute("d"))).toEqual(module.panelIcon?.paths);
      expect(glyph).toHaveAttribute("focusable", "false");
    });
  });
});

import { describe, expect, it } from "vitest";

import { cn } from "../../src/dashboard/ui/primitives/utils";

describe("dashboard class names", () => {
  it("joins array and object class values and resolves conflicting Tailwind utilities", () => {
    expect(cn("p-2", ["text-sm", "font-medium"], { flex: true }, "p-4 text-lg"))
      .toBe("font-medium flex p-4 text-lg");
  });

  it("keeps modifiers separate while merging conflicts within the same modifier", () => {
    expect(cn("hover:bg-blue-500", "md:p-2", "hover:bg-red-500", "md:p-4"))
      .toBe("hover:bg-red-500 md:p-4");
  });
});

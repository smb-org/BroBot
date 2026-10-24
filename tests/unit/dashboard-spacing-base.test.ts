import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dashboard spacing base", () => {
  it("sets the Tailwind spacing base to 4px inside the theme block", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/dashboard/ui/tokens.css"), "utf8");
    const theme = /@theme\s*\{([\s\S]*?)\n\}/u.exec(tokens)?.[1];
    expect(theme).toMatch(/^\s*--spacing:\s*4px;/mu);
  });
});

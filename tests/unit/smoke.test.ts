import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";

describe("Browser-Vitest-Grundgerüst", () => {
  it("startet mit dem registrierten Textbefehle-Modul", () => {
    expect(MODULES.map((module) => module.id)).toEqual(["textbefehle", "kanalereignisse", "werbung", "raid"]);
  });
});

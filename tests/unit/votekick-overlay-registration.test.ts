import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../src/modules/votekick/contracts");
  vi.resetModules();
});

it("registers the overlay element without loading the votekick settings schema", async () => {
  vi.doMock("../../src/modules/votekick/contracts", () => {
    throw new Error("Overlay registration must not import the settings schema.");
  });

  const { votekickOverlayElement } = await import("../../src/modules/votekick/overlay/element");

  expect(votekickOverlayElement.kind).toBe("votekick.tally");
  expect(votekickOverlayElement.defaultConfig).toEqual({ showCountdown: true, hideAfterCloseSeconds: 15 });
});

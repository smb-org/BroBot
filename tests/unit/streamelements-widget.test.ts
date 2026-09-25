import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const widgetSource = readFileSync(resolve(testDirectory, "../../docs/embedding/streamelements/widget.js"), "utf8");
const validateOverlayUrl = (): ((overlayUrl: string, brobotAddress: string) => string | null) => {
  const context: {
    URL: typeof URL;
    URLSearchParams: typeof URLSearchParams;
    window: { addEventListener: () => undefined };
    validate?: (overlayUrl: string, address: string) => string | null;
  } = {
    URL,
    URLSearchParams,
    window: { addEventListener: () => undefined },
  };
  runInNewContext(`${widgetSource}\nglobalThis.validate = buildValidatedOverlaySrc;`, context);
  if (context.validate === undefined) throw new Error("Widget URL validator was not loaded.");
  return context.validate;
};

describe("StreamElements widget URL validation", () => {
  it("builds a clean iframe URL only for the expected HTTPS overlay origin", () => {
    const validate = validateOverlayUrl();
    const token = "A".repeat(43);

    expect(validate(`https://brobot.example.invalid/overlay#token=${token}`, "https://brobot.example.invalid"))
      .toBe(`https://brobot.example.invalid/overlay#token=${token}`);
    expect(validate(`https://brobot.example.invalid/overlay.html?redirect=https://other.invalid#token=${token}`, "https://brobot.example.invalid"))
      .toBeNull();
    expect(validate(`https://other.invalid/overlay#token=${token}`, "https://brobot.example.invalid"))
      .toBeNull();
    expect(validate(`https://brobot.example.invalid/account#token=${token}`, "https://brobot.example.invalid"))
      .toBeNull();
    expect(validate("https://brobot.example.invalid/overlay#token=short", "https://brobot.example.invalid"))
      .toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPalette, writePalette } from "../../src/dashboard/ui/palette";

const storageKey = "brobot.palette";

describe("dashboard palette storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-palette");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the default palette when storage is empty", () => {
    expect(readPalette()).toBe("nachtschicht");
  });

  it("reads a stored supported palette", () => {
    window.localStorage.setItem(storageKey, "indigo-nacht");

    expect(readPalette()).toBe("indigo-nacht");
  });

  it("uses the default palette when storage access throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("Storage is unavailable.");
    });

    expect(readPalette()).toBe("nachtschicht");
  });

  it("applies and persists a palette", () => {
    writePalette("indigo-nacht");

    expect(document.documentElement.dataset.palette).toBe("indigo-nacht");
    expect(window.localStorage.getItem(storageKey)).toBe("indigo-nacht");
  });

  it("applies a palette when storage writes throw", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage is unavailable.");
    });

    expect(() => { writePalette("indigo-nacht"); }).not.toThrow();
    expect(document.documentElement.dataset.palette).toBe("indigo-nacht");
  });
});

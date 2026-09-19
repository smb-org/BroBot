import { afterEach, describe, expect, it } from "vitest";

import { dashboardLanguage } from "../../src/dashboard/locale";
import { roleLabel } from "../../src/dashboard/labels";

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

describe("Dashboard-Locale", () => {
  afterEach(() => {
    setBrowserLanguage("de-DE");
  });

  it("bestimmt die Panel-Sprache aus der Browsersprache", () => {
    setBrowserLanguage("en-US");

    expect(dashboardLanguage()).toBe("en");
    expect(roleLabel("verwalter")).toBe("Manager");
  });

  it("verwendet Deutsch für deutsche Browser", () => {
    setBrowserLanguage("de-AT");

    expect(dashboardLanguage()).toBe("de");
    expect(roleLabel("bediener")).toBe("Bediener");
  });
});

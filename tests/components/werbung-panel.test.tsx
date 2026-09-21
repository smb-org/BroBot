import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WerbungPanel } from "../../src/modules/werbung/panel";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Werbung-Panel-Ansicht", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("bindet die Feldgestaltung gemeinsam an die Panel-Hülle", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");

    expect(styles).toMatch(/\.inspector-form label,\s*\.content-section label,\s*\.module-stack label/);
    expect(styles).toMatch(/\.module-stack label\s*\{ display: grid/);
    expect(styles).toMatch(/:is\(\.inspector-form, \.content-section, \.module-stack\) input/);
    expect(styles).toMatch(/:is\(\.inspector-form, \.content-section, \.module-stack\) textarea/);
    expect(styles).toMatch(/:is\(\.inspector-form, \.content-section, \.module-stack\) select/);
    expect(styles).toMatch(/--config-field-schmal:\s*9rem/);
    expect(styles).toMatch(/--config-field-mittel:\s*20rem/);
    expect(styles).toMatch(/--config-field-breit:\s*40rem/);
  });

  it.each([
    ["de-DE", "Automatische Ansage", "Automatische Werbepause", "Manuelle Ansage", "Manuell gestartete Werbepause", "Aktionen", "Ansagen speichern"],
    ["en-US", "Automatic announcement", "Automatic ad break", "Manual announcement", "Manually started ad break", "Actions", "Save announcements"],
  ])("rendert Felder und Abschnitte auf %s", async (browserLanguage, automaticHeading, automaticLabel, manualHeading, manualLabel, actionsHeading, saveLabel) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ settings: {
      automatisch: "Automatisch {duration}",
      manuell: "Manuell {duration}",
    } })));
    Object.defineProperty(window.navigator, "language", { value: browserLanguage, configurable: true });

    render(<WerbungPanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: automaticHeading, level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: manualHeading, level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: actionsHeading, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: saveLabel })).toBeInTheDocument();

    const textareas = await screen.findAllByRole("textbox");
    expect(textareas).toHaveLength(2);
    expect(textareas.map((textarea) => textarea.closest("label")?.className)).toEqual([
      "config-field config-field--breit",
      "config-field config-field--breit",
    ]);
    expect(textareas[0]?.closest("label")).toHaveTextContent(automaticLabel);
    expect(textareas[1]?.closest("label")).toHaveTextContent(manualLabel);
    for (const textarea of textareas) {
      const field = textarea.closest("label");
      const hint = field?.querySelector(".config-field__hint");
      expect(hint).not.toBeNull();
      expect(textarea.compareDocumentPosition(hint as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

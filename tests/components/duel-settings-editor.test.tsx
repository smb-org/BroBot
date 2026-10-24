import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";
import settingsEditor from "../../src/modules/duel/panel/settings-editor";
import { duelSettingsEditorCatalog } from "../../src/modules/duel/panel/settings-editor-locale";

afterEach(() => { cleanup(); });

describe("duel command settings", () => {
  it("keeps the displayed command tokens intact when editing either command", () => {
    function Harness() {
      const [settings, setSettings] = useState(duelSettingsForLanguage("en"));
      const copy = duelSettingsEditorCatalog.en;
      return <UiProvider>
        <SettingsEditor
          spec={settingsEditor.spec}
          sectionId="commands"
          settings={settings}
          onChange={(key, next) => { setSettings((current) => ({ ...current, [key]: next })); }}
          texts={copy}
          templateMessages={copy.templateMessages}
        />
        <output data-testid="command-values">{`${settings.challengeCommand}|${settings.acceptCommand}`}</output>
      </UiProvider>;
    }

    render(<Harness />);
    const challenge = screen.getByRole("textbox", { name: "Challenge command" });
    const accept = screen.getByRole("textbox", { name: "Accept command" });
    expect(challenge).toHaveValue("!duel");
    expect(accept).toHaveValue("!yes");
    expect(document.querySelectorAll(".ui-field__prefix")).toHaveLength(0);

    fireEvent.change(challenge, { target: { value: "!sword" } });
    fireEvent.change(accept, { target: { value: "!confirm" } });

    expect(screen.getByTestId("command-values")).toHaveTextContent("!sword|!confirm");
    expect(challenge).toHaveValue("!sword");
    expect(accept).toHaveValue("!confirm");
  });
});

describe("duel message settings", () => {
  it("switches a message off without clearing its text and shows its state in read-only mode", () => {
    const saved = duelSettingsForLanguage("en");
    function Harness() {
      const [settings, setSettings] = useState(saved);
      return <UiProvider>
        <SettingsEditor
          spec={settingsEditor.spec}
          sectionId="texts"
          settings={settings}
          onChange={(key, next) => { setSettings((current) => ({ ...current, [key]: next })); }}
          texts={duelSettingsEditorCatalog.en}
          templateMessages={duelSettingsEditorCatalog.en.templateMessages}
          customContext={{ language: "en" }}
        />
        <output data-testid="duel-challenge-text">{settings.texts.challengeOpen}</output>
        <output data-testid="duel-challenge-state">{String(settings.texts.challengeOpenEnabled)}</output>
      </UiProvider>;
    }

    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: "Open duel announcement: Send message" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.getByTestId("duel-challenge-state").textContent).toBe("false");
    expect(screen.getByTestId("duel-challenge-text").textContent).toBe(saved.texts.challengeOpen);

    cleanup();
    render(<UiProvider><SettingsEditor
      spec={settingsEditor.spec}
      sectionId="texts"
      settings={{ ...saved, texts: { ...saved.texts, challengeOpenEnabled: false } }}
      onChange={() => undefined}
      texts={duelSettingsEditorCatalog.en}
      templateMessages={duelSettingsEditorCatalog.en.templateMessages}
      customContext={{ language: "en" }}
      readOnly
      enabledLabel={duelSettingsEditorCatalog.en.enabledLabel}
      disabledLabel={duelSettingsEditorCatalog.en.disabledLabel}
    /></UiProvider>);

    const stateRow = screen.getByText("Open duel announcement").closest(".duel-settings-editor__text-field");
    expect(stateRow?.textContent).toContain("Off");
    expect(stateRow?.textContent).toContain(saved.texts.challengeOpen);
  });

  it("marks a cleared enabled message with its error and clears the error once text returns", () => {
    const saved = duelSettingsForLanguage("en");
    function Harness() {
      const [settings, setSettings] = useState({ ...saved, texts: { ...saved.texts, challengeOpen: "" } });
      const fieldErrors = settings.texts.challengeOpen.trim().length === 0 ? { "texts.challengeOpen": "Text missing" } : {};
      return <UiProvider>
        <SettingsEditor
          spec={settingsEditor.spec}
          sectionId="texts"
          settings={settings}
          onChange={(key, next) => { setSettings((current) => ({ ...current, [key]: next })); }}
          texts={duelSettingsEditorCatalog.en}
          templateMessages={duelSettingsEditorCatalog.en.templateMessages}
          customContext={{ language: "en" }}
          fieldErrors={fieldErrors}
        />
      </UiProvider>;
    }

    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "Open duel announcement" });
    expect(textbox).toHaveAttribute("aria-invalid", "true");
    const describedBy = textbox.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)).toHaveTextContent("Text missing");
    fireEvent.change(textbox, { target: { value: "A duel is open." } });
    expect(textbox).not.toHaveAttribute("aria-invalid");
    expect(textbox).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("Text missing")).toBeNull();
  });
});

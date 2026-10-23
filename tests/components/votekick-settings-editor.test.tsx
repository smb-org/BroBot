import { useState } from "react";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";
import { votekickSettingsEditorCatalog } from "../../src/modules/votekick/panel/locale";
import settingsEditor from "../../src/modules/votekick/panel/settings-editor";
import { VotekickThresholdExample } from "../../src/modules/votekick/panel/threshold-example";

afterEach(() => { cleanup(); });

describe("votekick starter role setting", () => {
  it.each([
    ["en", "Minimum role", "Viewer and higher", "viewer"],
    ["de", "Mindestrolle", "Zuschauer und höher", "viewer"],
  ] as const)("shows and saves the localized role select in %s", async (language, label, option, value) => {
    const copy = votekickSettingsEditorCatalog(language);
    function Harness() {
      const [settings, setSettings] = useState(DEFAULT_VOTEKICK_SETTINGS);
      return <UiProvider>
        <SettingsEditor
          spec={settingsEditor.spec}
          sectionId="settings"
          settings={settings}
          onChange={(key, next) => { setSettings((current) => ({ ...current, [key]: next })); }}
          texts={copy}
          templateMessages={copy.templateMessages}
        />
        <output data-testid="starter-role-value">{settings.starterMinRole}</output>
      </UiProvider>;
    }

    render(<Harness />);
    const select = screen.getByRole("combobox", { name: label });
    expect(select).toHaveTextContent(language === "de" ? "VIP und höher" : "VIP and higher");
    fireEvent.click(select);
    const optionElement = await screen.findByRole("option", { name: option });
    fireEvent.pointerDown(optionElement, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.click(optionElement);
    expect(screen.getByTestId("starter-role-value")).toHaveTextContent(value);
    expect(select).toHaveTextContent(option);
  });

  it("defines a two-column settings page with the threshold rule attached to its values", () => {
    expect(settingsEditor.layout).toBe("columns");
    expect(settingsEditor.spec.sections.map(({ id }) => id)).toEqual(["settings", "messages"]);
    expect(settingsEditor.spec.sections.find(({ id }) => id === "settings")?.note).toBe("thresholdRule");
    expect(settingsEditor.locales.de.notes?.thresholdRule).toContain("größere Wert");
    expect(settingsEditor.locales.en.notes?.thresholdRule).toContain("larger of");
  });

  it.each([
    ["de", "Mindestens", "Höchstens"],
    ["en", "Minimum", "Maximum"],
  ] as const)("visibly labels the minimum and maximum timeout duration fields in %s", (language, minimumLabel, maximumLabel) => {
    const copy = votekickSettingsEditorCatalog(language);
    render(<UiProvider>
      <SettingsEditor
        spec={settingsEditor.spec}
        sectionId="settings"
        settings={DEFAULT_VOTEKICK_SETTINGS}
        onChange={() => undefined}
        texts={copy}
        templateMessages={copy.templateMessages}
      />
    </UiProvider>);

    const range = document.querySelector(".timeout-duration-range-fields--visible-labels");
    expect(range).not.toBeNull();
    expect(within(range as HTMLElement).getByText(minimumLabel)).toBeVisible();
    expect(within(range as HTMLElement).getByText(maximumLabel)).toBeVisible();
  });

  it("uses a singular preview character count in English", () => {
    expect(settingsEditor.locales.en.templateMessages.previewCountLabel(1)).toBe("1 character");
  });

  it("updates the worked threshold example beside its rule note from unsaved settings values", () => {
    function Harness() {
      const [settings, setSettings] = useState(DEFAULT_VOTEKICK_SETTINGS);
      return <UiProvider>
        <SettingsEditor
          spec={settingsEditor.spec}
          sectionId="settings"
          settings={settings}
          onChange={(key, next) => { setSettings((current) => ({ ...current, [key]: next })); }}
          texts={votekickSettingsEditorCatalog("en")}
          templateMessages={votekickSettingsEditorCatalog("en").templateMessages}
          afterNote={<VotekickThresholdExample minNetVotes={settings.minNetVotes} percent={settings.percent} language="en" />}
        />
      </UiProvider>;
    }

    render(<Harness />);
    expect(screen.getByText("7 net yes votes needed")).toBeInTheDocument();
    const note = document.querySelector(".ui-rule-note");
    expect(note?.nextElementSibling).toHaveClass("votekick-threshold-example");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Minimum net yes votes" }), { target: { value: "8" } });
    expect(screen.getByText("8 net yes votes needed")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Active chatters percent" }), { target: { value: "30" } });
    expect(screen.getByText("11 net yes votes needed")).toBeInTheDocument();
  });

  it.each([
    ["de", false], ["de", true], ["en", false], ["en", true],
  ] as const)("shows the saved threshold example and read-only values for operators (%s, section-only: %s)", (language, readOnlySectionOnly) => {
    const copy = votekickSettingsEditorCatalog(language);
    const savedSettings = { ...DEFAULT_VOTEKICK_SETTINGS, minNetVotes: 8, percent: 30 };
    render(<UiProvider>
      <SettingsEditor
        spec={settingsEditor.spec}
        sectionId="settings"
        settings={savedSettings}
        onChange={() => undefined}
        texts={copy}
        templateMessages={copy.templateMessages}
        readOnly
        readOnlySectionOnly={readOnlySectionOnly}
        enabledLabel={copy.enabledLabel}
        disabledLabel={copy.disabledLabel}
        afterNote={<VotekickThresholdExample minNetVotes={savedSettings.minNetVotes} percent={savedSettings.percent} language={language} />}
      />
    </UiProvider>);

    expect(screen.getByText(copy.notes?.thresholdRule ?? "")).not.toBeNull();
    expect(screen.getByText(language === "de" ? "11 Netto-Ja-Stimmen nötig" : "11 net yes votes needed")).not.toBeNull();
    expect(document.querySelector(".ui-rule-note")?.nextElementSibling?.classList.contains("votekick-threshold-example")).toBe(true);
    expect(screen.getByText(language === "de" ? "Mindest-Netto-Ja-Stimmen" : "Minimum net yes votes")).not.toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("keeps each message's enabled state and text together in operator properties", () => {
    const copy = votekickSettingsEditorCatalog("en");
    render(<UiProvider>
      <SettingsEditor
        spec={settingsEditor.spec}
        sectionId="messages"
        settings={DEFAULT_VOTEKICK_SETTINGS}
        onChange={() => undefined}
        texts={copy}
        templateMessages={copy.templateMessages}
        readOnly
        enabledLabel={copy.enabledLabel}
        disabledLabel={copy.disabledLabel}
      />
    </UiProvider>);

    const properties = document.querySelector(".ui-settings-editor__readonly-sections");
    expect(properties).not.toBeNull();
    const startMessage = within(properties as HTMLElement).getByText("Start message").closest("div");
    expect(startMessage).not.toBeNull();
    expect(startMessage).toHaveTextContent("On");
    expect(startMessage).toHaveTextContent(DEFAULT_VOTEKICK_SETTINGS.startText);
    expect(startMessage).toHaveTextContent("Message text");
  });
});

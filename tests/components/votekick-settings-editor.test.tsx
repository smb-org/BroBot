import { useState } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";
import { votekickSettingsEditorCatalog } from "../../src/modules/votekick/panel/locale";
import settingsEditor from "../../src/modules/votekick/panel/settings-editor";

afterEach(() => { cleanup(); });

describe("votekick starter role setting", () => {
  it.each([
    ["en", "Minimum role to start", "Viewer and higher", "viewer"],
    ["de", "Mindestrolle zum Starten", "Zuschauer und höher", "viewer"],
  ] as const)("shows and saves the localized role select in %s", async (language, label, option, value) => {
    const copy = votekickSettingsEditorCatalog(language);
    function Harness() {
      const [settings, setSettings] = useState(DEFAULT_VOTEKICK_SETTINGS);
      return <UiProvider>
        <SettingsEditor
          spec={settingsEditor.spec}
          sectionId="thresholds"
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
    expect(select).toHaveValue(language === "de" ? "VIP und höher" : "VIP and higher");
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: option }));
    expect(screen.getByTestId("starter-role-value")).toHaveTextContent(value);
    expect(select).toHaveValue(option);
  });
});

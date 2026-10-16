import { useState } from "react";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { BELABOX_DEFAULT_SETTINGS } from "../../src/modules/belabox/contracts";
import settingsEditor from "../../src/modules/belabox/panel/settings-editor";
import { belaboxSettingsEditorCatalog } from "../../src/modules/belabox/panel/settings-locale";

describe("BELABOX settings editor", () => {
  afterEach(() => { cleanup(); });

  it("edits the polling mode and keeps interval choices numeric", () => {
    const copy = belaboxSettingsEditorCatalog("en");
    let latest = BELABOX_DEFAULT_SETTINGS;
    const Harness = () => {
      const [settings, setSettings] = useState(BELABOX_DEFAULT_SETTINGS);
      latest = settings;
      return <UiProvider><SettingsEditor
        spec={settingsEditor.spec}
        sectionId="polling"
        settings={settings}
        onChange={(key, value) => { setSettings((current) => ({ ...current, [key]: value })); }}
        texts={copy}
        templateMessages={copy.templateMessages}
      /></UiProvider>;
    };
    render(<Harness />);

    fireEvent.click(within(screen.getByRole("group", { name: "Mode" })).getByRole("button", { name: "On demand" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Interval" })).getByRole("button", { name: "30 s" }));

    expect(latest).toMatchObject({ mode: "on_demand", intervalSeconds: 30 });
  });

  it("shows nested chat alert settings in operator properties", () => {
    const copy = belaboxSettingsEditorCatalog("en");
    render(<UiProvider><SettingsEditor
      spec={settingsEditor.spec}
      sectionId="alerts"
      settings={BELABOX_DEFAULT_SETTINGS}
      onChange={() => undefined}
      texts={copy}
      templateMessages={copy.templateMessages}
      readOnly
      enabledLabel={copy.enabledLabel}
      disabledLabel={copy.disabledLabel}
    /></UiProvider>);

    const properties = document.querySelector(".ui-settings-editor__readonly-sections");
    expect(properties).not.toBeNull();
    const nestedRows = [
      ["Chat cooldown", "300 s"],
      ["Low bitrate text", BELABOX_DEFAULT_SETTINGS.lowText],
      ["Low bitrate target", "source_only"],
      ["Disconnect text", BELABOX_DEFAULT_SETTINGS.disconnectText],
      ["Disconnect target", "source_only"],
      ["Recovery text", BELABOX_DEFAULT_SETTINGS.recoveryText],
      ["Recovery target", "source_only"],
    ] as const;
    for (const [label, value] of nestedRows) {
      const row = within(properties as HTMLElement).getByText(label).closest("div");
      expect(row).not.toBeNull();
      expect(row).toHaveTextContent(value);
    }
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });
});

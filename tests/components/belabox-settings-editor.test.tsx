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

  it("shows empty alert templates as off using the shared message pattern", () => {
    const copy = belaboxSettingsEditorCatalog("en");
    render(<UiProvider><SettingsEditor
      spec={settingsEditor.spec}
      sectionId="alerts"
      settings={{
        ...BELABOX_DEFAULT_SETTINGS,
        chatEnabled: true,
        lowText: "",
        disconnectText: "",
        recoveryText: "",
      }}
      onChange={() => undefined}
      texts={copy}
      templateMessages={copy.templateMessages}
      enabledLabel={copy.enabledLabel}
      disabledLabel={copy.disabledLabel}
    /></UiProvider>);

    expect(document.querySelectorAll(".ui-settings-editor__message")).toHaveLength(3);
    expect(Array.from(document.querySelectorAll(".ui-settings-editor__message-heading span"), (element) => element.textContent))
      .toEqual(["Off", "Off", "Off"]);
    expect(screen.getByText("Low bitrate target")).toBeInTheDocument();
    expect(screen.getByText("Disconnect target")).toBeInTheDocument();
    expect(screen.getByText("Recovery target")).toBeInTheDocument();
  });
});

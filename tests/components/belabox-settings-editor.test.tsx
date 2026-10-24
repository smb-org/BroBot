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

  it("shows empty alert templates as switched off while keeping their fields available", () => {
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
      {...(copy.messageEnabledLabel === undefined ? {} : { messageEnabledLabel: copy.messageEnabledLabel })}
    /></UiProvider>);

    expect(document.querySelectorAll(".ui-settings-editor__message")).toHaveLength(3);
    for (const messageSwitch of screen.getAllByRole("switch", { name: /Send message/u })) {
      expect(messageSwitch.getAttribute("aria-checked")).toBe("false");
    }
    expect(screen.queryByText("Low bitrate target")).not.toBeNull();
    expect(screen.queryByText("Disconnect target")).not.toBeNull();
    expect(screen.queryByText("Recovery target")).not.toBeNull();
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
      ["Low bitrate target", "Our chat only"],
      ["Disconnect text", BELABOX_DEFAULT_SETTINGS.disconnectText],
      ["Disconnect target", "Our chat only"],
      ["Recovery text", BELABOX_DEFAULT_SETTINGS.recoveryText],
      ["Recovery target", "Our chat only"],
    ] as const;
    for (const [label, value] of nestedRows) {
      const labelNode = within(properties as HTMLElement).getByText((_, element) => element !== null && (
        element.tagName === "DT"
          ? element.textContent === label
          : element.tagName === "SPAN" && element.textContent.startsWith(`${label}:`)));
      const row = labelNode.closest("div");
      expect(row).not.toBeNull();
      expect(row).toHaveTextContent(value);
    }
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });
});

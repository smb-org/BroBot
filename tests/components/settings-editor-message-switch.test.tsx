import { useState } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { adsModule } from "../../src/modules/ads";
import adsSettingsEditor from "../../src/modules/ads/panel/settings-editor";
import { adsSettingsEditorCatalog } from "../../src/modules/ads/panel/locale";

describe("shared message settings editor", () => {
  afterEach(() => { cleanup(); });

  it("switches a message off without changing its saved text", () => {
    let latest = adsModule.defaultSettings;
    const copy = adsSettingsEditorCatalog("en");
    const Harness = () => {
      const [settings, setSettings] = useState(adsModule.defaultSettings);
      latest = settings;
      return <UiProvider><SettingsEditor
        spec={adsSettingsEditor.spec}
        sectionId="announcements"
        settings={settings}
        onChange={(key, value) => { setSettings((current) => ({ ...current, [key]: value })); }}
        texts={copy}
        templateMessages={copy.templateMessages}
        messageEnabledLabel="Send message"
      /></UiProvider>;
    };
    render(<Harness />);

    const messageText = screen.getByRole("textbox", { name: "Automatic ad break" });
    const messageSwitch = screen.getByRole("switch", { name: "Automatic ad break: Send message" });
    expect(messageSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(messageSwitch);

    expect(latest.automatic).toBe(adsModule.defaultSettings.automatic);
    expect(latest.automaticEnabled).toBe(false);
    expect((messageText as HTMLTextAreaElement).value).toBe(adsModule.defaultSettings.automatic);
    expect(screen.getByRole("switch", { name: "Automatic ad break: Send message" }).getAttribute("aria-checked")).toBe("false");
  });

  it("shows the explicit message state in read-only view", () => {
    const copy = adsSettingsEditorCatalog("en");
    render(<UiProvider><SettingsEditor
      spec={adsSettingsEditor.spec}
      sectionId="announcements"
      settings={{ ...adsModule.defaultSettings, automaticEnabled: false }}
      onChange={() => undefined}
      texts={copy}
      templateMessages={copy.templateMessages}
      readOnly
      enabledLabel={copy.enabledLabel}
      disabledLabel={copy.disabledLabel}
    /></UiProvider>);

    const row = screen.getByText("Automatic ad break").closest("div");
    expect(row?.textContent).toContain("Off");
    expect(row?.textContent).toContain(adsModule.defaultSettings.automatic);
  });
});

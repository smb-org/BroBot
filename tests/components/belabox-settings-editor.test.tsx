import { useState } from "react";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { BELABOX_DEFAULT_SETTINGS, belaboxSettingsSchema } from "../../src/modules/belabox/contracts";
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

    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Mode" })).getByRole("radio", { name: "On demand" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Interval" })).getByRole("radio", { name: "30 s" }));

    expect(latest).toEqual({ mode: "on_demand", intervalSeconds: 30 });
    expect(belaboxSettingsSchema.safeParse(latest).success).toBe(true);
  });
});

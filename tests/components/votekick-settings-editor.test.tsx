import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { votekickDefaultSettingsForLanguage } from "../../src/modules/votekick/contracts";
import settingsEditor from "../../src/modules/votekick/panel/settings-editor";

afterEach(cleanup);

describe("Votekick message settings", () => {
  it("keeps disabled message text editable", () => {
    const definition = settingsEditor;
    const settings = { ...votekickDefaultSettingsForLanguage("en"), startTextEnabled: false };
    render(<UiProvider><SettingsEditor
      spec={definition.spec}
      sectionId="messages"
      settings={settings}
      onChange={() => {}}
      texts={definition.locales.en}
      templateMessages={definition.locales.en.templateMessages}
    /></UiProvider>);

    expect(screen.getByRole("textbox", { name: "Start message" })).toBeTruthy();
  });
});

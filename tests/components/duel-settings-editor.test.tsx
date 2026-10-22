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

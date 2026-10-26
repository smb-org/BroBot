import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { heistSettingsForLanguage } from "../../src/modules/heist/contracts";
import settingsEditor from "../../src/modules/heist/panel/settings-editor";

afterEach(() => { cleanup(); });

describe("heist settings editor", () => {
  it("switches a message off without clearing its saved template", () => {
    const saved = heistSettingsForLanguage("en");
    function Harness() {
      const [settings, setSettings] = useState(saved);
      const copy = settingsEditor.locales.en;
      return <UiProvider>
        <SettingsEditor
          spec={settingsEditor.spec}
          sectionId="messages"
          settings={settings}
          onChange={(key, next) => { setSettings((current) => ({ ...current, [key]: next })); }}
          texts={copy}
          templateMessages={copy.templateMessages}
          messageEnabledLabel={copy.messageEnabledLabel ?? "Send message"}
          enabledLabel={copy.enabledLabel}
          disabledLabel={copy.disabledLabel}
        />
        <output data-testid="heist-start-text">{settings.startText}</output>
        <output data-testid="heist-start-state">{String(settings.startTextEnabled)}</output>
      </UiProvider>;
    }

    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: "Start message: Send message" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    expect(screen.getByTestId("heist-start-state").textContent).toBe("false");
    expect(screen.getByTestId("heist-start-text").textContent).toBe(saved.startText);
  });

  it("keeps the configured stakes and round timing visible in their labeled sections", () => {
    const settings = heistSettingsForLanguage("en");

    render(<UiProvider><SettingsEditor
      spec={settingsEditor.spec}
      sectionId="stakes"
      settings={settings}
      onChange={() => undefined}
      texts={settingsEditor.locales.en}
      templateMessages={settingsEditor.locales.en.templateMessages}
    /></UiProvider>);

    const minimumStake = screen.getByLabelText("Minimum stake");
    const maximumStake = screen.getByLabelText("Maximum stake");
    if (!(minimumStake instanceof HTMLInputElement) || !(maximumStake instanceof HTMLInputElement)) {
      throw new Error("Stake settings must render number inputs.");
    }
    expect(minimumStake.value).toBe("10");
    expect(maximumStake.value).toBe("1000");
  });
});

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import settingsEditor from "../../src/modules/chat_voting/panel/settings-editor";
import { chatVotingSettingsEditorCatalog } from "../../src/modules/chat_voting/panel/locale";

describe("chat voting settings editor", () => {
  afterEach(() => { cleanup(); });

  it("keeps the runtime announcement settings editable in the Messages section", () => {
    const copy = chatVotingSettingsEditorCatalog("en");
    render(<UiProvider><SettingsEditor
      spec={settingsEditor.spec}
      sectionId="messages"
      settings={DEFAULT_CHAT_VOTING_SETTINGS}
      onChange={() => undefined}
      texts={copy}
      templateMessages={copy.templateMessages}
      {...(copy.messageEnabledLabel === undefined ? {} : { messageEnabledLabel: copy.messageEnabledLabel })}
    /></UiProvider>);

    const startText = screen.getByRole("textbox", { name: "Start text" });
    if (!(startText instanceof HTMLTextAreaElement)) throw new Error("The start text field is not a textarea.");
    expect(startText.value).toBe(DEFAULT_CHAT_VOTING_SETTINGS.startText);
    expect(screen.getByRole("switch", { name: "Start text: Send message" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: /Send the result in chat/u }).getAttribute("aria-checked")).toBe("true");
    const resultText = screen.getByRole("textbox", { name: "Result text" });
    if (!(resultText instanceof HTMLTextAreaElement)) throw new Error("The result text field is not a textarea.");
    expect(resultText.value).toBe("{vote.result}");
    expect(document.querySelector(".ui-chat-target-field__trigger")).not.toBeNull();
  });

  it("shows every tab's settings to operators and groups each message with its on/off state", () => {
    const copy = chatVotingSettingsEditorCatalog("en");
    const values = { ...DEFAULT_CHAT_VOTING_SETTINGS, startText: "Started {vote.title}", resultText: "Finished {vote.result}" };
    render(<UiProvider><SettingsEditor
      spec={settingsEditor.spec}
      sectionId="general"
      settings={values}
      onChange={() => undefined}
      texts={copy}
      templateMessages={copy.templateMessages}
      readOnly
      enabledLabel={copy.enabledLabel}
      disabledLabel={copy.disabledLabel}
      {...(copy.messageEnabledLabel === undefined ? {} : { messageEnabledLabel: copy.messageEnabledLabel })}
    /></UiProvider>);

    const properties = document.querySelector(".ui-settings-editor__readonly-sections");
    expect(properties).not.toBeNull();
    expect(within(properties as HTMLElement).queryByText("Default duration")).not.toBeNull();
    expect(within(properties as HTMLElement).queryByText("Start text")).not.toBeNull();
    const startRow = within(properties as HTMLElement).getByText("Start text").closest("div");
    expect(startRow).not.toBeNull();
    expect(startRow?.textContent).toContain("On");
    const resultRow = within(properties as HTMLElement).getByText("Send the result in chat").closest("div");
    expect(resultRow).not.toBeNull();
    expect(resultRow?.textContent).toContain("On");
    expect(resultRow?.textContent).toContain("Finished {vote.result}");
    expect(within(properties as HTMLElement).queryByText("Result target")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

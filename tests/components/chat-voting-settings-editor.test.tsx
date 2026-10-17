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
    /></UiProvider>);

    expect(screen.getByRole("textbox", { name: "Start text" })).toHaveValue(DEFAULT_CHAT_VOTING_SETTINGS.startText);
    expect(screen.getByRole("switch", { name: /Send the result in chat/u })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Result text" })).toHaveValue("{vote.result}");
    expect(document.querySelector(".ui-chat-target-field__trigger")).toBeInTheDocument();
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
    /></UiProvider>);

    const properties = document.querySelector(".ui-settings-editor__readonly-sections");
    expect(properties).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Default duration")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Start text")).toBeInTheDocument();
    const resultRow = within(properties as HTMLElement).getByText("Send the result in chat").closest("div");
    expect(resultRow).not.toBeNull();
    expect(resultRow).toHaveTextContent("On");
    expect(resultRow).toHaveTextContent("Finished {vote.result}");
    expect(within(properties as HTMLElement).getByText("Result target")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

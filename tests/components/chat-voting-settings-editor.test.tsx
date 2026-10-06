import { useState } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import settingsEditor from "../../src/modules/chat_voting/panel/settings-editor";
import { chatVotingSettingsEditorCatalog } from "../../src/modules/chat_voting/panel/locale";
import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";

describe("chat voting settings editor", () => {
  afterEach(() => { cleanup(); });

  it("shows defaults as placeholders, keeps empty labels optional, and names a disabled timer", () => {
    const copy = chatVotingSettingsEditorCatalog("en");
    const Harness = () => {
      const [values, setValues] = useState(DEFAULT_CHAT_VOTING_SETTINGS);
      return <UiProvider><SettingsEditor
        spec={settingsEditor.spec}
        sectionId="labels"
        settings={values}
        onChange={(key, next) => { setValues((current) => ({ ...current, [key]: next })); }}
        texts={copy}
        templateMessages={copy.templateMessages}
      /></UiProvider>;
    };
    render(<Harness />);

    expect(screen.getByRole("textbox", { name: "Yes/no labels" })).toHaveAttribute("placeholder", "Yes|No");
    const zeroOne = screen.getByRole("textbox", { name: "0/1 labels" });
    const oneTwo = screen.getByRole("textbox", { name: "1/2 labels" });
    expect(zeroOne).toHaveAttribute("placeholder", "No|Yes");
    expect(oneTwo).toHaveAttribute("placeholder", "1|2");
    expect(zeroOne).not.toBeRequired();
    expect(oneTwo).not.toBeRequired();
    fireEvent.change(zeroOne, { target: { value: "Nein|Doch" } });
    fireEvent.change(oneTwo, { target: { value: "Eins|Zwei" } });
    expect(zeroOne).toHaveValue("Nein|Doch");
    expect(oneTwo).toHaveValue("Eins|Zwei");
    expect(screen.getByRole("textbox", { name: "Scale labels" })).toHaveAttribute("placeholder", "1|2|3|4|5");
    expect(screen.getByRole("textbox", { name: "Labels for 2–9 options" })).toHaveAttribute("placeholder", "1|2|3|…|9");
    expect(screen.getByRole("textbox", { name: "Yes/no labels" })).not.toBeRequired();
    const timer = screen.getByRole("spinbutton", { name: "Default duration" });
    expect(timer).toHaveValue("0");
    expect(timer.parentElement).toHaveTextContent("Off");
    expect(timer.parentElement).not.toHaveTextContent("s");
    fireEvent.click(screen.getByRole("button", { name: "Increase close time" }));
    expect(timer).toHaveValue("30");
  });

  it("shows the localized zero label in the read-only operator properties", () => {
    const copy = chatVotingSettingsEditorCatalog("de");
    render(<UiProvider><SettingsEditor
      spec={settingsEditor.spec}
      sectionId="labels"
      settings={DEFAULT_CHAT_VOTING_SETTINGS}
      onChange={() => undefined}
      texts={copy}
      templateMessages={copy.templateMessages}
      readOnly
    /></UiProvider>);

    expect(screen.getByText("Standarddauer")).toBeInTheDocument();
    expect(screen.getByText("Aus")).toBeInTheDocument();
    expect(screen.queryByText("0 s")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Standarddauer" })).not.toBeInTheDocument();
  });
});

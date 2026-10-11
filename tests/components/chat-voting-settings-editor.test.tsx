import { useState } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CHAT_VOTING_SETTINGS, chatVotingSettingsSchema } from "../../src/modules/chat_voting/contracts";
import settingsEditor from "../../src/modules/chat_voting/panel/settings-editor";
import { chatVotingSettingsEditorCatalog } from "../../src/modules/chat_voting/panel/locale";
import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";

describe("chat voting settings editor", () => {
  afterEach(() => { cleanup(); });

  it("removes saved answer labels from settings and keeps the default duration editor", () => {
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

    expect(screen.queryByRole("textbox", { name: /labels|beschriftungen/iu })).not.toBeInTheDocument();
    const timer = screen.getByRole("spinbutton", { name: "Default duration" });
    expect(timer).toHaveValue("0");
    expect(timer.parentElement).toHaveTextContent("Off");
    expect(timer.parentElement).not.toHaveTextContent("s");
    fireEvent.click(screen.getByRole("button", { name: "Increase close time" }));
    expect(timer).toHaveValue("30");
  });

  it.each([["en", "Start text"], ["de", "Starttext"]] as const)(
    "shows the optional start template, preview, and localized variables in %s",
    (language, fieldLabel) => {
      const copy = chatVotingSettingsEditorCatalog(language);
      const startTextCopy = copy.fields.startText;
      const pickerMessages = copy.templateMessages.variablePicker;
      if (startTextCopy?.variables === undefined || startTextCopy.previewLabel === undefined || pickerMessages === undefined) {
        throw new Error("The localized start template editor catalog is incomplete.");
      }
      render(<UiProvider><SettingsEditor
        spec={settingsEditor.spec}
        sectionId="start"
        settings={DEFAULT_CHAT_VOTING_SETTINGS}
        onChange={() => undefined}
        texts={copy}
        variables={{ startText: startTextCopy.variables }}
        templateMessages={copy.templateMessages}
      /></UiProvider>);

      const field = screen.getByRole("textbox", { name: fieldLabel });
      expect(field).not.toBeRequired();
      expect(screen.getByText(copy.templateMessages.countLabel(DEFAULT_CHAT_VOTING_SETTINGS.startText.length, 500))).toBeInTheDocument();
      expect(screen.getByText(startTextCopy.previewLabel)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: pickerMessages.triggerLabel })).toBeInTheDocument();
      expect(startTextCopy.variables.map(({ name }) => name)).toEqual(["vote.title", "vote.options", "vote.duration"]);
      expect(startTextCopy.variables[0]?.description).toContain(language === "de" ? "Frage" : "question");
      expect(startTextCopy.variables[2]?.description).toContain(language === "de" ? "zeitbegrenzte" : "time-limited");
      const section = settingsEditor.spec.sections.find(({ id }) => id === "start");
      const startField = section?.fields.find((field) => field.kind === "template" && field.key === "startText");
      if (startField?.kind !== "template") throw new Error("The start text template field is missing.");
      const samples = Object.fromEntries(startTextCopy.variables.map(({ name, sample }) => [name, sample]));
      const preview = startField.preview(DEFAULT_CHAT_VOTING_SETTINGS.startText, samples);
      expect(preview).toContain(
        language === "de" ? "1 = Pizza, 2 = Burger, 3 = Döner" : "1 = Pizza, 2 = Burger, 3 = Kebab",
      );
      expect(preview).toContain(language === "de" ? "2 Minuten" : "2 minutes");

      const resultTextCopy = copy.fields.resultText;
      expect(resultTextCopy?.variables?.map(({ name }) => name)).toContain("vote.duration");
    },
  );

  it("defaults the start template and accepts an empty value up to 500 characters", () => {
    expect(chatVotingSettingsSchema.parse({}).startText).toBe(DEFAULT_CHAT_VOTING_SETTINGS.startText);
    expect(chatVotingSettingsSchema.safeParse({ ...DEFAULT_CHAT_VOTING_SETTINGS, startText: "" }).success).toBe(true);
    expect(chatVotingSettingsSchema.safeParse({ ...DEFAULT_CHAT_VOTING_SETTINGS, startText: "x".repeat(500) }).success).toBe(true);
    expect(chatVotingSettingsSchema.safeParse({ ...DEFAULT_CHAT_VOTING_SETTINGS, startText: "x".repeat(501) }).success).toBe(false);
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

  it("strips retired label settings from the active settings schema", () => {
    const parsed = chatVotingSettingsSchema.parse({ yesNoLabels: "Approve|Reject", scaleLabels: "Low|High" });
    expect(parsed).toEqual(DEFAULT_CHAT_VOTING_SETTINGS);
    expect(parsed).not.toHaveProperty("yesNoLabels");
    expect(parsed).not.toHaveProperty("scaleLabels");
  });
});

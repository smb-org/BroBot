import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button, ConfirmDialog, EditorShell, Field, FieldPair, NumberField, SettingsEditor, TagInput, TemplateText, TextArea, UiProvider, type SettingsEditorSpec, type TextAreaMessages, type TemplateVariableOption } from "../../src/dashboard/ui";
import { ChoiceCards } from "../../src/dashboard/ui/ChoiceCards";
import { SegmentedControl } from "../../src/dashboard/ui/SegmentedControl";
import { Switch } from "../../src/dashboard/ui/Switch";

const renderUi = (node: ReactNode): ReturnType<typeof render> => render(<UiProvider>{node}</UiProvider>);

const expectHelperAfterField = (field: HTMLElement, expectedText: string): void => {
  const describedBy = field.getAttribute("aria-describedby")?.split(" ") ?? [];
  const helperId = describedBy.find((id) => (document.getElementById(id)?.textContent ?? "").includes(expectedText));
  if (helperId === undefined) throw new Error(`Missing helper description: ${expectedText}`);
  const helper = document.getElementById(helperId);
  if (helper === null) throw new Error(`Missing helper element: ${helperId}`);
  expect(field.compareDocumentPosition(helper) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
};

const templateOptions: readonly TemplateVariableOption[] = [
  { name: "user", description: "The triggering viewer", sample: "streamerin" },
  { name: "viewers", description: "Raid viewer count", sample: "42" },
];

const textAreaMessages: TextAreaMessages = {
  countLabel: (count, max) => `${String(count)} von ${String(max)} Zeichen`,
  previewCountLabel: (count) => `${String(count)} Zeichen`,
  unknownVariable: (name, suggestion, available) => suggestion === null
    ? `Unbekannte Variable {${name}}. Verfügbar: ${available.map((item) => `{${item}}`).join(", ")}`
    : `Unbekannte Variable {${name}} — Meintest du {${suggestion}}?`,
  insertSuggestionLabel: (name) => `{${name}} einsetzen`,
  worstCaseLength: (length) => `Mit den längsten Werten bis zu ${String(length)} Zeichen.`,
};

const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

beforeEach(() => {
  if (originalRangeBounds === undefined) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 0, 0),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalRangeBounds === undefined) delete (Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
  else Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBounds);
});

describe("editor field seam", () => {
  it("keeps a visual prefix out of the value, normalizes input, and gives icon fields only their label", () => {
    const onChange = vi.fn();
    renderUi(
      <div>
        <Field label="Command name" prefix="!" value="hello" normalize={(value) => value.toLowerCase()} onChange={onChange} />
        <Field label="Shoutout name" prefix="@" value="viewer" normalize={(value) => value.toLowerCase()} onChange={onChange} />
        <Field label="Search members" icon="search" value="" onChange={onChange} />
      </div>,
    );

    const name = screen.getByRole("textbox", { name: "Command name" });
    expect(name.closest(".ui-field--prefixed")).toBeInTheDocument();
    expect(document.querySelector(".ui-field__prefix")).toHaveTextContent("!");
    fireEvent.change(name, { target: { value: "!HELLO" } });
    expect(onChange).toHaveBeenCalledWith("hello");
    fireEvent.change(screen.getByRole("textbox", { name: "Shoutout name" }), { target: { value: "@VIEWER" } });
    expect(onChange).toHaveBeenLastCalledWith("viewer");
    expect(name).not.toHaveAttribute("maxlength");
    expect(screen.getByRole("textbox", { name: "Search members" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search members" }).parentElement?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("counts Field values, warns at 90 percent, and exposes an error above the limit without truncating", () => {
    renderUi(<Field label="Name" hint="A short name" value="123456789" maxLength={10} countLabel={(count, max) => `${String(count)} / ${String(max)}`} onChange={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).not.toHaveAttribute("maxlength");
    expect(screen.getByText("9 / 10")).toHaveClass("ui-field__count--warning");

    cleanup();
    const { container } = renderUi(<Field label="Name" hint="A short name" value="12345678901" maxLength={10} countLabel={(count, max) => `${String(count)} / ${String(max)}`} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true");
    expect(container.querySelector(".mantine-TextInput-error")).toHaveTextContent("× 11 / 10");
  });

  it("renders FieldPair as the container-query grid seam", () => {
    const { container } = renderUi(<FieldPair><Field label="Channel" hint="For the channel." value="5" onChange={() => {}} /><Field label="Viewer" hint="For each viewer." value="30" onChange={() => {}} /></FieldPair>);
    expect(container.querySelectorAll(".ui-field-pair > .mantine-TextInput-root")).toHaveLength(2);
  });

  it("places the shared helper description below each control", () => {
    renderUi(<div>
      <Field label="Name" hint="The command name." value="hello" onChange={() => {}} />
      <NumberField label="Cooldown" hint="Seconds between uses." value={5} onChange={() => {}} />
      <TagInput label="Aliases" hint="Other names." value={[]} onChange={() => {}} removeLabel={(entry) => `Remove ${entry}`} listLabel="Alias list" messages={{ countLabel: (count, max) => `${String(count)} of ${String(max)}`, atLimitHint: "At the limit.", duplicateWarning: (entry) => `${entry} is already listed.` }} />
      <SegmentedControl label="Mode" hint="The active mode." value="one" onChange={() => {}} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />
      <ChoiceCards label="Tier" hint="Who can run it." value="everyone" onChange={() => {}} options={[{ value: "everyone", label: "Everyone", description: "Anyone." }]} />
      <Switch layout="inline" label="Enabled" hint="Takes effect now." checked onChange={() => {}} />
      <TextArea label="Reply" hint="What the bot says." value="Hello" onChange={() => {}} messages={textAreaMessages} />
    </div>);
    expectHelperAfterField(screen.getByRole("textbox", { name: "Name" }), "The command name.");
    expectHelperAfterField(screen.getByRole("spinbutton", { name: "Cooldown" }), "Seconds between uses.");
    expectHelperAfterField(screen.getByRole("combobox", { name: "Aliases" }), "Other names.");
    expectHelperAfterField(screen.getByRole("radiogroup", { name: "Mode" }), "The active mode.");
    expectHelperAfterField(screen.getByRole("radiogroup", { name: "Tier" }), "Who can run it.");
    expectHelperAfterField(screen.getByRole("switch", { name: "Enabled" }), "Takes effect now.");
    expectHelperAfterField(screen.getByRole("textbox", { name: "Reply" }), "What the bot says.");
  });

  it("steps by the requested amount, clamps at the maximum, preserves the unit outside the value, and hides Mantine controls", () => {
    function Harness() {
      const [value, setValue] = useState<number | "">(5);
      return <NumberField label="Cooldown" hint="From zero to ten" value={value} onChange={setValue} min={0} max={10} step={5} unit="s" increaseLabel="Increase cooldown" decreaseLabel="Decrease cooldown" />;
    }
    renderUi(<Harness />);
    const field = screen.getByRole("spinbutton", { name: "Cooldown" });
    const stepper = field.closest(".ui-number-field__stepper");
    expect(stepper?.children).toHaveLength(3);
    expect(stepper?.children[0]).toHaveClass("mantine-Button-root");
    expect(stepper?.children[1]).toContainElement(field);
    expect(stepper?.children[2]).toHaveClass("mantine-Button-root");
    const helperId = field.getAttribute("aria-describedby")?.split(" ").find((part) => (document.getElementById(part)?.textContent ?? "").includes("From zero to ten"));
    expect(helperId).toBeDefined();
    expect(document.getElementById(helperId ?? "")?.closest(".ui-number-field__stepper")).toBe(stepper);
    fireEvent.click(screen.getByRole("button", { name: "Increase cooldown" }));
    expect(field).toHaveValue("10");
    expect(screen.getByRole("button", { name: "Increase cooldown" })).toBeDisabled();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field).toHaveValue("5");
    expect(field).not.toHaveValue("5 s");
    expect(document.querySelector(".mantine-NumberInput-controls")).not.toBeInTheDocument();
  });

  it("renders labelled segments with value-dependent help, arrow navigation, and disabled options", () => {
    function Harness({ disabled = false }: { disabled?: boolean }) {
      const [value, setValue] = useState("reply");
      return <SegmentedControl label="Response type" hint={value === "say" ? "Write a normal message." : "Reply to the triggering message."} value={value} onChange={setValue} disabled={disabled} options={[{ value: "say", label: "Message" }, { value: "reply", label: "Reply" }]} />;
    }
    renderUi(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Response type" });
    expect(group).toHaveAccessibleDescription("Reply to the triggering message.");
    const reply = within(group).getByRole("radio", { name: "Reply" });
    fireEvent.keyDown(reply, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(within(group).getByRole("radio", { name: "Message" })).toBeChecked();

    cleanup();
    renderUi(<Harness disabled />);
    expect(screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled)).toBe(true);
  });

  it("renders vertically stacked choice cards with accessible descriptions, hidden icons, arrow keys, and disabled options", () => {
    function Harness({ disabled = false }: { disabled?: boolean }) {
      const [value, setValue] = useState("everyone");
      return <ChoiceCards label="Who can run it" hint="Moderators and broadcasters always can." value={value} onChange={setValue} disabled={disabled} options={[
        { value: "everyone", label: "Everyone", description: "Anyone in chat.", icon: "tierEveryone" },
        { value: "vip", label: "VIPs", description: "VIPs, moderators, and broadcasters.", icon: "tierVip" },
      ]} />;
    }
    renderUi(<Harness />);
    const everyone = screen.getByRole("radio", { name: "Everyone. Anyone in chat." });
    expect(everyone.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    fireEvent.keyDown(everyone, { key: "ArrowRight", code: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "VIPs. VIPs, moderators, and broadcasters." })).toBeChecked();

    cleanup();
    renderUi(<Harness disabled />);
    expect(screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled)).toBe(true);
  });

  it("lets the whole switch-card surface toggle and describes disabled dependent fields", () => {
    const onChange = vi.fn();
    const { container } = renderUi(
      <Switch layout="card" label="Shoutout" description="Send a shoutout on a large raid." hint="Controls the threshold below." checked={false} onChange={onChange} lockedReason="Shoutout is off.">
        <Field label="Viewer threshold" hint="Minimum viewer count." value="50" onChange={() => {}} />
      </Switch>,
    );
    const card = container.querySelector(".ui-switch-card");
    expect(card).not.toBeNull();
    fireEvent.click(card as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(true);
    const control = screen.getByRole("switch", { name: /^Shoutout/u });
    const switchDescriptions = control.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(switchDescriptions.some((id) => (document.getElementById(id)?.textContent ?? "").includes("Controls the threshold below."))).toBe(true);
    expect(switchDescriptions.some((id) => (document.getElementById(id)?.textContent ?? "").includes("Shoutout is off."))).toBe(true);
    const dependent = screen.getByRole("textbox", { name: "Viewer threshold" });
    expect(dependent).toBeDisabled();
    const dependentDescriptions = dependent.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(dependentDescriptions.some((id) => (document.getElementById(id)?.textContent ?? "").includes("Shoutout is off."))).toBe(true);
    expect(screen.getByText("Controls the threshold below.")).toBeInTheDocument();
  });

  it("parses and normalizes tags, retains invalid input, suppresses duplicates, counts tags, and allows removal at the limit", async () => {
    function Harness() {
      const [value, setValue] = useState<string[]>([]);
      return <TagInput
        label="Aliases"
        hint="Extra names for this command."
        value={value}
        onChange={setValue}
        prefix="!"
        normalize={(entry) => entry.toLowerCase()}
        validate={(entry) => /^[a-z0-9_-]+$/u.test(entry) ? null : `!${entry} — letters, numbers, hyphens, and underscores only`}
        maxTags={2}
        removeLabel={(entry) => `Remove alias ${entry}`}
        listLabel="Alias list"
        messages={{ countLabel: (count, max) => `${String(count)} von ${String(max)}`, atLimitHint: "At most two aliases.", duplicateWarning: (entry) => `${entry} is already listed.` }}
      />;
    }
    renderUi(<Harness />);
    const input = screen.getByRole("combobox", { name: "Aliases" });
    fireEvent.paste(input, { clipboardData: { getData: () => "!Hi, hey" } });
    expect(await screen.findByText("!hi")).toBeInTheDocument();
    expect(screen.getByText("!hey")).toBeInTheDocument();
    expect(document.querySelectorAll(".ui-tag-input__pill-label")).toHaveLength(2);
    expect(screen.getByText("2 von 2")).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove alias !hi" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove alias !hi" }));
    expect(input).toBeEnabled();
    fireEvent.paste(input, { clipboardData: { getData: () => "!HEY" } });
    expect(await screen.findByText("!hey is already listed.")).toBeInTheDocument();
    fireEvent.paste(input, { clipboardData: { getData: () => "!hé" } });
    expect(await screen.findByText(/letters, numbers/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-describedby");
    expect(input.getAttribute("aria-describedby")).toMatch(/error/u);
  });
});

describe("template field", () => {
  it("counts template characters, warns at 90 percent, blocks only over-limit text, and submits with Ctrl+Enter", () => {
    const onSubmit = vi.fn((event: SyntheticEvent<HTMLFormElement>) => { event.preventDefault(); });
    const { rerender } = renderUi(
      <form onSubmit={onSubmit}>
        <TextArea label="Reply" hint="What the bot writes." value="123456789" maxLength={10} onChange={() => {}} messages={textAreaMessages} />
      </form>,
    );
    const input = screen.getByRole("textbox", { name: "Reply" });
    expect(screen.getByText("9 von 10 Zeichen")).toHaveClass("ui-textarea__count--warning");
    expect(input).not.toHaveAttribute("maxlength");
    rerender(<UiProvider><form onSubmit={onSubmit}><TextArea label="Reply" hint="What the bot writes." value="12345678901" maxLength={10} onChange={() => {}} messages={textAreaMessages} /></form></UiProvider>);
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("× 11 von 10 Zeichen")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("renders known variable tint and unknown variable warning decorations around the same text", () => {
    const { container } = renderUi(<TextArea label="Reply" hint="What the bot writes." value="Hi {user} {viewer}" variables={templateOptions} onChange={() => {}} messages={textAreaMessages} />);
    const known = container.querySelectorAll(".template-field__decoration--known");
    const unknown = container.querySelectorAll(".template-field__decoration--unknown");
    expect(Array.from(known, (part) => part.textContent)).toEqual(["{user}"]);
    expect(Array.from(unknown, (part) => part.textContent)).toEqual(["{viewer}"]);
    expect(known[0]).toHaveAttribute("data-kind", "known");
    expect(unknown[0]).toHaveAttribute("data-kind", "unknown");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Hi {user} {viewer}");
  });

  it("shows composing text, delays issue checks until composition ends, inserts chips at the saved selection, and handles suggestions", async () => {
    const onIssuesChange = vi.fn();
    const parentKeyDown = vi.fn();
    function Harness() {
      const [value, setValue] = useState("Hello world");
      return (
        <div onKeyDown={parentKeyDown}>
          <TextArea label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={setValue} onIssuesChange={onIssuesChange} messages={textAreaMessages} />
          <output aria-label="Current value">{value}</output>
        </div>
      );
    }
    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    onIssuesChange.mockClear();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "Hello {viewer}" } });
    expect(input.closest(".template-field")).toHaveAttribute("data-composing", "true");
    expect(onIssuesChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: "" });
    await waitFor(() => expect(onIssuesChange).toHaveBeenCalledWith({ unknown: ["viewer"], worstCaseExceeded: false }));

    fireEvent.change(input, { target: { value: "Hello world" } });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    input.setSelectionRange(6, 6);
    fireEvent.select(input);
    fireEvent.click(screen.getByRole("button", { name: "{user}" }));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Hello {user}world");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply" })).toHaveFocus());

    fireEvent.change(input, { target: { value: "{vi" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { hidden: true })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("{viewers}");
  });

  it("does not accept a variable suggestion with Enter during IME composition", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    function Harness() {
      const [value, setValue] = useState("");
      return <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><TextArea label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={(next) => { onChange(next); setValue(next); }} messages={textAreaMessages} /></form>;
    }
    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "{vi", selectionStart: 3 } });
    expect(input).toHaveValue("{vi");
    onChange.mockClear();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveValue("{vi");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps Escape inside an open variable suggestion list", async () => {
    const parentKeyDown = vi.fn();
    function Harness() {
      const [value, setValue] = useState("");
      return <div onKeyDown={parentKeyDown}><TextArea label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={setValue} messages={textAreaMessages} /></div>;
    }
    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "{vi", selectionStart: 3 } });
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(parentKeyDown).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
  });

  it("keeps read-only text selectable and disables editing chips", () => {
    renderUi(<TextArea label="Reply" hint="What the bot writes." value="Hi {user}" variables={templateOptions} readOnly onChange={() => {}} messages={textAreaMessages} />);
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "{user}" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "{viewers}" })).toBeDisabled();
  });

  it("suggests replacement for an unknown token, shows worst-case warnings without blocking, and previews sample rendering", () => {
    const onIssuesChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState("Hi {viewer}");
      return (
        <TextArea
          label="Reply"
          hint="What the bot writes."
          value={value}
          variables={templateOptions}
          worstCaseLength={512}
          maxLength={500}
          onChange={setValue}
          onIssuesChange={onIssuesChange}
          preview={(template, values) => template.replace("{user}", values.user ?? "").replace("{viewer}", values.viewers ?? "")}
          previewLabel="Preview"
          previewSpeaker="BroBot"
          messages={textAreaMessages}
        />
      );
    }
    renderUi(
      <Harness />,
    );
    expect(screen.getByText(/Meintest du \{viewers\}/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "{viewers} einsetzen" })).toBeInTheDocument();
    expect(screen.getByText(/bis zu 512 Zeichen/)).toBeInTheDocument();
    expect(screen.getByText("Hi {viewer}")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
    expect(onIssuesChange).toHaveBeenCalledWith({ unknown: ["viewer"], worstCaseExceeded: true });
    expect(screen.getByRole("textbox", { name: "Reply" })).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "{viewers} einsetzen" }));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Hi {viewers}");
  });

  it("renders reading templates with the same known and unknown token treatment", () => {
    renderUi(<TemplateText value="{user} {viewer}" variables={templateOptions} />);
    expect(document.querySelector(".ui-template-text [data-kind='known']")).toHaveTextContent("{user}");
    expect(document.querySelector(".ui-template-text [data-kind='unknown']")).toHaveTextContent("{viewer}");
    expect(document.querySelector(".ui-template-text")).toHaveTextContent("{user} {viewer}");
  });

});

describe("EditorShell and declaration renderer", () => {
  const baseProps = {
    ariaLabel: "Command editor",
    title: "!hello",
    sections: [
      { id: "settings", label: "Settings", icon: "tabSettings" as const, content: <Field label="Name" hint="Command name." value="hello" onChange={() => {}} /> },
      { id: "advanced", label: "Advanced", icon: "tabAdvanced" as const, issue: "warning" as const, content: <Field label="Cooldown" hint="Delay between uses." value="5" onChange={() => {}} /> },
    ],
    dirty: false,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    saveLabel: "Save",
    discardLabel: "Discard",
    savedLabel: "Saved.",
    pendingLabel: "Saving…",
    issueLabels: { error: "error", warning: "hint" },
  };

  it("shows tab icons only with two or more sections, navigates tabs by arrow keys, and moves from save to the first invalid field", async () => {
    function Harness() {
      const [section, setSection] = useState("settings");
      return <EditorShell {...baseProps} section={section} onSectionChange={setSection} dirty invalid sections={[
        { id: "settings", label: "Settings", icon: "tabSettings", issue: "error", content: <Field label="Name" hint="Command name." value="" error="Required" onChange={() => {}} /> },
        { id: "advanced", label: "Advanced", icon: "tabAdvanced", issue: "warning", content: <Field label="Cooldown" hint="Delay between uses." value="5" onChange={() => {}} /> },
      ]} />;
    }
    renderUi(<Harness />);
    const settingsTab = screen.getByRole("tab", { name: /^Settings/u });
    expect(settingsTab.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("tab", { name: "Advanced, hint" })).toBeInTheDocument();
    fireEvent.keyDown(settingsTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Advanced, hint" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("tab", { name: "Settings, error" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus());
  });

  it("keeps the persistent save bar visible across clean, dirty, warning, saved, error, pending, and conflict states", () => {
    const { rerender } = renderUi(<EditorShell {...baseProps} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("");

    rerender(<UiProvider><EditorShell {...baseProps} dirty warnings={["Unknown variable {viewer}."]} /></UiProvider>);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("data-variant", "filled");
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("mantine-Button-root");
    expect(screen.getByRole("status")).toHaveTextContent("Unknown variable {viewer}.");
    expect(screen.getByRole("status").querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    rerender(<UiProvider><EditorShell {...baseProps} saved warningStatusLabel={(warnings) => `Saved — ${String(warnings.length)} warning: ${warnings[0] ?? ""}`} warnings={["Unknown variable {viewer}."]} /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Saved — 1 warning: Unknown variable {viewer}.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    rerender(<UiProvider><EditorShell {...baseProps} saved /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    rerender(<UiProvider><EditorShell {...baseProps} dirty /></UiProvider>);
    expect(screen.getByRole("status")).not.toHaveTextContent("Saved.");

    rerender(<UiProvider><EditorShell {...baseProps} dirty error="Network failed." /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("× Network failed.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    rerender(<UiProvider><EditorShell {...baseProps} dirty pending /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const onReload = vi.fn();
    rerender(<UiProvider><EditorShell {...baseProps} dirty conflict={{ message: "Changed elsewhere.", reloadLabel: "Load server version", onReload }} /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("× Changed elsewhere.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Load server version" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load server version" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("renders read-only content as properties without a form, editable field, or save bar", () => {
    renderUi(<EditorShell {...baseProps} readOnly={{ reason: "Only managers can edit this command.", content: <dl className="properties"><div><dt>Name</dt><dd>hello</dd></div></dl> }} />);
    expect(screen.getAllByText("Only managers can edit this command.")).toHaveLength(1);
    expect(screen.getByRole("definition")).toHaveTextContent("hello");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.querySelector("form")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-save-bar")).not.toBeInTheDocument();
  });

  it("adds the third confirmation action between cancel and confirm", () => {
    renderUi(<ConfirmDialog opened title="Discard changes?" description="Unsaved data will be lost." cancelLabel="Keep editing" onCancel={() => {}} alternative={{ label: "Save and switch", onClick: () => {} }} confirmLabel="Discard and switch" onConfirm={() => {}} danger />);
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button").map((button) => button.textContent).filter((text) => text.length > 0);
    expect(buttons).toEqual(["Keep editing", "Save and switch", "Discard and switch"]);
  });

  it("keeps the persistent save bar after the form body as the editor's final child", () => {
    renderUi(<EditorShell {...baseProps} />);
    const editor = document.querySelector(".ui-editor-shell");
    expect(editor?.lastElementChild).toHaveClass("ui-save-bar");
    expect(editor?.querySelector(".ui-editor-shell__form")?.lastElementChild).toHaveClass("ui-editor-shell__body");
  });

  it("renders every confirmation action in full and gives subtle danger buttons an outline", () => {
    renderUi(<div>
      <ConfirmDialog opened title="Unsaved changes" description="Choose what to do." cancelLabel="Weiter bearbeiten" onCancel={() => {}} alternative={{ label: "Speichern und wechseln", onClick: () => {} }} confirmLabel="Verwerfen und wechseln" onConfirm={() => {}} />
      <Button icon="remove" danger="subtle">Delete command</Button>
    </div>);
    expect(screen.getByRole("button", { name: "Weiter bearbeiten" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern und wechseln" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verwerfen und wechseln" })).toBeInTheDocument();
    const deleteButton = screen.getByRole("button", { name: "Delete command" });
    expect(deleteButton).toHaveAttribute("data-variant", "default");
    expect(deleteButton.style.getPropertyValue("--button-bd")).toBe("1px solid #403c38");
  });

  it("renders settings from a typed declaration and catalogue with helper descriptions on every field", () => {
    interface Settings {
      threshold: number;
      shoutoutName: string;
      message: string;
      mode: "one" | "two";
      enabled: boolean;
      dependentThreshold: number;
    }
    const spec: SettingsEditorSpec<Settings> = {
      sections: [{ id: "general", icon: "tabSettings", fields: [
        { kind: "number", key: "threshold", unit: "viewers", min: 0, max: 100, step: 1 },
        { kind: "text", key: "shoutoutName", prefix: "@" },
        { kind: "template", key: "message", preview: (template, samples) => template.replace("{user}", samples.user ?? "") },
        { kind: "segment", key: "mode", options: [{ value: "one" }, { value: "two" }] },
        { kind: "switchCard", key: "enabled", children: [{ kind: "number", key: "dependentThreshold", unit: "viewers", min: 0, max: 100, step: 1 }] },
      ] }],
    };
    const texts = {
      sections: { general: "General" },
      fields: {
        threshold: { label: "Threshold", hint: "Minimum viewer count.", increaseLabel: "Increase threshold", decreaseLabel: "Decrease threshold" },
        shoutoutName: { label: "Shoutout name", hint: "The account sent a shoutout.", countLabel: (count: number, max: number) => `${String(count)} / ${String(max)}` },
        message: { label: "Message", hint: "What the bot writes.", previewLabel: "Preview", previewSpeaker: "BroBot" },
        mode: { label: "Mode", hint: "Select a mode.", options: { one: { label: "One", description: "First choice." }, two: { label: "Two", description: "Second choice." } } },
        enabled: { label: "Shoutout", hint: "Controls the dependent threshold.", description: "Send a shoutout after a large raid.", disabledReason: "Shoutout is off." },
        dependentThreshold: { label: "Dependent threshold", hint: "Minimum viewer count.", increaseLabel: "Increase dependent threshold", decreaseLabel: "Decrease dependent threshold" },
      },
    };
    renderUi(<SettingsEditor
      spec={spec}
      sectionId="general"
      settings={{ threshold: 12, shoutoutName: "channel", message: "Hello {user}", mode: "one", enabled: false, dependentThreshold: 50 }}
      onChange={() => {}}
      texts={texts}
      variables={{ message: templateOptions }}
      templateMessages={textAreaMessages}
    />);
    const fields = [
      screen.getByRole("spinbutton", { name: "Threshold" }),
      screen.getByRole("textbox", { name: "Shoutout name" }),
      screen.getByRole("textbox", { name: "Message" }),
      screen.getByRole("radiogroup", { name: "Mode" }),
      screen.getByRole("switch", { name: /^Shoutout/u }),
      screen.getByRole("spinbutton", { name: "Dependent threshold" }),
    ];
    for (const field of fields) {
      const describedBy = field.getAttribute("aria-describedby");
      expect(describedBy, "field description ids").toBeTruthy();
      for (const id of describedBy?.split(" ") ?? []) expect((document.getElementById(id)?.textContent ?? "").trim()).not.toBe("");
    }
    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeInTheDocument();
  });
});

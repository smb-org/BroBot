import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button, ChipsInput, ConfirmDialog, EditorShell, Field, FieldPair, GameMultiSelect, SegmentChoice, SettingsEditor, SwitchRow, SwitchSection, TemplateText, TemplateTextField, UiProvider, UnitInput, type GameMultiSelectGame, type GameMultiSelectMessages, type SettingsEditorSpec, type TemplateTextFieldMessages, type TemplateTextFieldVariable } from "../../src/dashboard/ui";
import { ChoiceCards } from "../../src/dashboard/ui/ChoiceCards";

const renderUi = (node: ReactNode): ReturnType<typeof render> => render(<UiProvider>{node}</UiProvider>);

const expectHelperAfterField = (field: HTMLElement, expectedText: string): void => {
  const describedBy = field.getAttribute("aria-describedby")?.split(" ") ?? [];
  const helperId = describedBy.find((id) => (document.getElementById(id)?.textContent ?? "").includes(expectedText));
  if (helperId === undefined) throw new Error(`Missing helper description: ${expectedText}`);
  const helper = document.getElementById(helperId);
  if (helper === null) throw new Error(`Missing helper element: ${helperId}`);
  expect(field.compareDocumentPosition(helper) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
};

const templateOptions: readonly TemplateTextFieldVariable[] = [
  { name: "user", description: "The triggering viewer", sample: "streamerin" },
  { name: "viewers", description: "Raid viewer count", sample: "42" },
];

const templateTextFieldMessages: TemplateTextFieldMessages = {
  countLabel: (count, max) => `${String(count)} von ${String(max)} Zeichen`,
  previewCountLabel: (count) => `${String(count)} Zeichen`,
  openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
  unknownVariable: (name, suggestion) => suggestion === null
    ? `Unbekannte Variable {${name}}.`
    : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
  insertSuggestionLabel: (name) => `{${name}} einsetzen`,
  insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
  worstCaseLength: (length) => `Mit den längsten Werten bis zu ${String(length)} Zeichen.`,
  picker: {
    title: "Choose a variable", noResults: "No variables found.",
    externalHelp: "Looks up live data from Twitch when the template runs",
    groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
    keyHints: { navigate: "select", insert: "insert", close: "close" },
  },
};

const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

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
  vi.useRealTimers();
  if (originalRangeBounds === undefined) delete (Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
  else Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBounds);
  if (originalScrollIntoView === undefined) delete (HTMLElement.prototype as unknown as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }).scrollIntoView;
  else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
});

describe("editor field seam", () => {
  it("shows lazy Twitch box art beside a selected game", async () => {
    const game: GameMultiSelectGame = {
      id: "123",
      name: "Example Game",
      boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/123-{width}x{height}.jpg",
    };
    const messages: GameMultiSelectMessages = {
      label: "Games",
      hint: "Filter this text by game.",
      search: "Search Twitch games",
      searchHint: "Search for a game.",
      loading: "Searching…",
      empty: "No games found.",
      error: "Search failed.",
      suggestions: "Suggestions",
      allGames: "All games",
      limitReached: "You can select up to 10 games.",
      selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`,
      remove: (name) => `Remove ${name}`,
    };
    const searchGames = vi.fn().mockResolvedValue([game]);
    function Harness() {
      const [value, setValue] = useState<GameMultiSelectGame[]>([]);
      return <GameMultiSelect searchGames={searchGames} value={value} onChange={setValue} messages={messages} />;
    }

    renderUi(<Harness />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Games" }), { target: { value: "Example" } });
    const option = await screen.findByRole("option", { name: /Example Game/u, hidden: true });
    const optionImage = option.querySelector("img");
    expect(optionImage).toHaveAttribute("loading", "lazy");
    expect(optionImage).toHaveAttribute("alt", "");
    expect(optionImage).toHaveAttribute("width", "28");
    expect(optionImage).toHaveAttribute("height", "38");

    fireEvent.click(option);
    const selectedImage = document.querySelector(".ui-game-multi-select__chip img");
    expect(selectedImage).toHaveAttribute("src", "https://static-cdn.jtvnw.net/ttv-boxart/123-20x27.jpg");
    expect(selectedImage).toHaveAttribute("width", "20");
    expect(selectedImage).toHaveAttribute("height", "27");
  });

  it("loads empty-query suggestions and hydrates older selected games with box art", async () => {
    const storedGame: GameMultiSelectGame = { id: "42", name: "Zelda: Ocarina of Time" };
    const gameWithArt: GameMultiSelectGame = {
      ...storedGame,
      boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg",
    };
    const messages: GameMultiSelectMessages = {
      label: "Games", hint: "Filter by game.", search: "Search games", searchHint: "Search for a game.",
      loading: "Searching…", empty: "No games found.", error: "Search failed.", suggestions: "Suggestions", allGames: "All games", limitReached: "You can select up to 10 games.",
      selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`, remove: (name) => `Remove ${name}`,
    };
    const searchGames = vi.fn().mockResolvedValue([gameWithArt]);
    const lookupGames = vi.fn().mockResolvedValue([gameWithArt]);
    const onChange = vi.fn();

    renderUi(<GameMultiSelect searchGames={searchGames} lookupGames={lookupGames} value={[storedGame]} onChange={onChange} messages={messages} />);
    await waitFor(() => expect(lookupGames).toHaveBeenCalledWith(["42"]));
    await waitFor(() => expect(document.querySelector(".ui-game-multi-select__chip img")).toHaveAttribute(
      "src",
      "https://static-cdn.jtvnw.net/ttv-boxart/42-20x27.jpg",
    ));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.focus(screen.getByRole("searchbox", { name: "Games" }));
    expect(await screen.findByRole("option", { name: /Zelda: Ocarina of Time/u, hidden: true })).toBeInTheDocument();
    expect(searchGames).toHaveBeenCalledWith("");
  });

  it("retries failed artwork lookups without changing the selected game draft", async () => {
    vi.useFakeTimers();
    const storedGame: GameMultiSelectGame = { id: "42", name: "Zelda: Ocarina of Time" };
    const gameWithArt: GameMultiSelectGame = {
      ...storedGame,
      boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/42-{width}x{height}.jpg",
    };
    const messages: GameMultiSelectMessages = {
      label: "Games", hint: "Filter by game.", search: "Search games", searchHint: "Search for a game.",
      loading: "Searching…", empty: "No games found.", error: "Search failed.", suggestions: "Suggestions", allGames: "All games", limitReached: "You can select up to 10 games.",
      selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`, remove: (name) => `Remove ${name}`,
    };
    const searchGames = vi.fn().mockResolvedValue([]);
    const lookupGames = vi.fn().mockRejectedValueOnce(new Error("Twitch unavailable")).mockResolvedValueOnce([gameWithArt]);
    const onChange = vi.fn();

    renderUi(<GameMultiSelect searchGames={searchGames} lookupGames={lookupGames} value={[storedGame]} onChange={onChange} messages={messages} />);
    await act(async () => { await Promise.resolve(); });
    expect(lookupGames).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(lookupGames).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".ui-game-multi-select__chip img")).toHaveAttribute(
      "src",
      "https://static-cdn.jtvnw.net/ttv-boxart/42-20x27.jpg",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("omits missing box art for suggestions and selected games", async () => {
    const messages: GameMultiSelectMessages = {
      label: "Games", hint: "Filter by game.", search: "Search games", searchHint: "Search for a game.",
      loading: "Searching…", empty: "No games found.", error: "Search failed.", suggestions: "Suggestions", allGames: "All games", limitReached: "You can select up to 10 games.",
      selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`, remove: (name) => `Remove ${name}`,
    };
    const game: GameMultiSelectGame = { id: "99", name: "Unlisted Game" };
    const searchGames = vi.fn().mockResolvedValue([game]);
    renderUi(<GameMultiSelect searchGames={searchGames} value={[game]} onChange={() => {}} messages={messages} />);

    fireEvent.focus(screen.getByRole("searchbox", { name: "Games" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Games" }), { target: { value: "Unlisted" } });
    const option = await screen.findByRole("option", { name: /Unlisted Game/u, hidden: true });
    expect(document.querySelector(".ui-game-multi-select__chip .ui-game-multi-select__cover-placeholder")).not.toBeInTheDocument();
    expect(option.querySelector(".ui-game-multi-select__cover-placeholder")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-game-multi-select__chip .ui-game-multi-select__cover")).not.toBeInTheDocument();
    expect(option.querySelector(".ui-game-multi-select__cover")).not.toBeInTheDocument();
  });

  it("closes game results on Escape from the input or an option and when focus leaves the picker", async () => {
    const messages: GameMultiSelectMessages = {
      label: "Games", hint: "h", search: "s", searchHint: "sh", loading: "l", empty: "e", error: "x",
      suggestions: "Suggestions", allGames: "All games", limitReached: "You can select up to 10 games.", selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`,
      remove: (name) => `Remove ${name}`,
    };
    const searchGames = vi.fn().mockResolvedValue([{ id: "1", name: "Example Game" }]);
    renderUi(
      <div>
        <GameMultiSelect searchGames={searchGames} value={[]} onChange={() => {}} messages={messages} />
        <button type="button">outside</button>
      </div>,
    );
    const input = screen.getByRole("searchbox", { name: "Games" });
    const open = async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Example" } });
      return screen.findByRole("option", { name: /Example Game/u, hidden: true });
    };

    fireEvent.keyDown(await open(), { key: "Escape" });
    expect(screen.queryByRole("option", { hidden: true })).not.toBeInTheDocument();

    await open();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("option", { hidden: true })).not.toBeInTheDocument();

    const option = await open();
    fireEvent.focusOut(option, { relatedTarget: input });
    expect(screen.getByRole("option", { hidden: true })).toBeInTheDocument();
    fireEvent.focusOut(option, { relatedTarget: screen.getByRole("button", { name: "outside" }) });
    expect(screen.queryByRole("option", { hidden: true })).not.toBeInTheDocument();
  });

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
    expect(container.querySelector(".ui-field__error")).toHaveTextContent("× 11 / 10");
  });

  it("renders FieldPair as the container-query grid seam", () => {
    const { container } = renderUi(<FieldPair><Field label="Channel" hint="For the channel." value="5" onChange={() => {}} /><Field label="Viewer" hint="For each viewer." value="30" onChange={() => {}} /></FieldPair>);
    expect(container.querySelectorAll(".ui-field-pair > .ui-field")).toHaveLength(2);
  });

  it("places the shared helper description below each control", () => {
    renderUi(<div>
      <Field label="Name" hint="The command name." value="hello" onChange={() => {}} />
      <UnitInput label="Cooldown" hint="Seconds between uses." value={5} onChange={() => {}} />
      <ChipsInput label="Aliases" hint="Other names." values={[]} onChange={() => {}} removeLabel={(entry) => `Remove ${entry}`} listLabel="Alias list" messages={{ countLabel: (count, max) => `${String(count)} of ${String(max)}`, atLimitHint: "At the limit.", duplicateWarning: (entry) => `${entry} is already listed.` }} />
      <SegmentChoice label="Mode" hint="The active mode." value="one" onChange={() => {}} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />
      <ChoiceCards label="Tier" hint="Who can run it." value="everyone" onChange={() => {}} options={[{ value: "everyone", label: "Everyone", description: "Anyone." }]} />
      <SwitchRow label="Enabled" hint="Takes effect now." checked onChange={() => {}} />
      <TemplateTextField label="Reply" hint="What the bot says." value="Hello" onChange={() => {}} messages={templateTextFieldMessages} />
    </div>);
    expectHelperAfterField(screen.getByRole("textbox", { name: "Name" }), "The command name.");
    expectHelperAfterField(screen.getByRole("spinbutton", { name: "Cooldown" }), "Seconds between uses.");
    expectHelperAfterField(screen.getByRole("textbox", { name: "Aliases" }), "Other names.");
    expectHelperAfterField(screen.getByRole("group", { name: "Mode" }), "The active mode.");
    expectHelperAfterField(screen.getByRole("group", { name: "Tier" }), "Who can run it.");
    expectHelperAfterField(screen.getByRole("switch", { name: "Enabled" }), "Takes effect now.");
    expectHelperAfterField(screen.getByRole("textbox", { name: "Reply" }), "What the bot says.");
  });

  it("clamps the value on blur and applies a suggested value with the unit outside the input", () => {
    function Harness() {
      const [value, setValue] = useState<number | "">(5);
      return <UnitInput label="Cooldown" hint="From zero to ten" value={value} onChange={setValue} min={0} max={10} step={5} unit="s" suggestions={[5, 10]} />;
    }
    renderUi(<Harness />);
    const field = screen.getByRole("spinbutton", { name: "Cooldown" });
    const helperId = field.getAttribute("aria-describedby")?.split(" ").find((part) => (document.getElementById(part)?.textContent ?? "").includes("From zero to ten"));
    expect(helperId).toBeDefined();
    expect(field.closest(".unit-input")).toContainElement(document.getElementById(helperId ?? ""));
    fireEvent.change(field, { target: { value: "15" } });
    expect(field).toHaveValue(15);
    fireEvent.blur(field);
    expect(field).toHaveValue(10);
    fireEvent.click(screen.getByRole("button", { name: "5 s" }));
    expect(field).toHaveValue(5);
    expect(field.closest(".unit-input__control")).toHaveTextContent("s");
  });

  it("renders labelled segments with value-dependent help, arrow navigation, and disabled options", () => {
    function Harness({ disabled = false }: { disabled?: boolean }) {
      const [value, setValue] = useState("reply");
      return <SegmentChoice label="Response type" hint={value === "say" ? "Write a normal message." : "Reply to the triggering message."} value={value} onChange={setValue} disabled={disabled} options={[{ value: "say", label: "Message" }, { value: "reply", label: "Reply" }]} />;
    }
    renderUi(<Harness />);
    const group = screen.getByRole("group", { name: "Response type" });
    expect(group).toHaveAccessibleDescription("Reply to the triggering message.");
    const reply = within(group).getByRole("button", { name: "Reply" });
    fireEvent.keyDown(reply, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(within(group).getByRole("button", { name: "Message" })).toHaveAttribute("aria-pressed", "true");

    cleanup();
    renderUi(<Harness disabled />);
    expect(screen.getAllByRole("button", { name: /Message|Reply/u }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("renders keyboard-operable choice cards with accessible names, hidden icons, and disabled options", () => {
    function Harness({ disabled = false }: { disabled?: boolean }) {
      const [value, setValue] = useState("everyone");
      return <ChoiceCards label="Who can run it" hint="Moderators and broadcasters always can." value={value} onChange={setValue} disabled={disabled} options={[
        { value: "everyone", label: "Everyone", description: "Anyone in chat.", icon: "tierEveryone" },
        { value: "vip", label: "VIPs", description: "VIPs, moderators, and broadcasters.", icon: "tierVip" },
      ]} />;
    }
    renderUi(<Harness />);
    const everyone = screen.getByRole("button", { name: "Everyone. Anyone in chat." });
    expect(everyone.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    everyone.focus();
    fireEvent.click(screen.getByRole("button", { name: "VIPs. VIPs, moderators, and broadcasters." }));
    expect(screen.getByRole("button", { name: "VIPs. VIPs, moderators, and broadcasters." })).toHaveAttribute("aria-pressed", "true");

    cleanup();
    renderUi(<Harness disabled />);
    expect(screen.getAllByRole("button", { name: /Everyone|VIPs/u }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("keeps SwitchSection children hidden while off and exposes its hint", () => {
    const onChange = vi.fn();
    const { container } = renderUi(
      <SwitchSection title="Shoutout" hint="Controls the threshold below." checked={false} onChange={onChange}>
        <Field label="Viewer threshold" hint="Minimum viewer count." value="50" onChange={() => {}} />
      </SwitchSection>,
    );
    const section = container.querySelector(".ui-switch-section");
    expect(section).not.toBeNull();
    expect(section).toHaveTextContent("Shoutout");
    expect(section).toHaveTextContent("Controls the threshold below.");
    expect(section?.querySelectorAll(".ui-switch-section__heading, .ui-switch-section__hint")).toHaveLength(2);
    expect(section).not.toHaveTextContent("Viewer threshold");
    fireEvent.click(screen.getByRole("switch", { name: "Shoutout" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("parses and normalizes tags, retains invalid input, suppresses duplicates, counts tags, and allows removal at the limit", async () => {
    function Harness() {
      const [value, setValue] = useState<string[]>([]);
      return <ChipsInput
        label="Aliases"
        hint="Extra names for this command."
        values={value}
        onChange={setValue}
        stripPrefix="!"
        normalize={(entry) => entry.toLowerCase()}
        validate={(entry) => /^[a-z0-9_-]+$/u.test(entry) ? null : `!${entry} — letters, numbers, hyphens, and underscores only`}
        max={2}
        removeLabel={(entry) => `Remove alias ${entry}`}
        listLabel="Alias list"
        messages={{ countLabel: (count, max) => `${String(count)} von ${String(max)}`, atLimitHint: "At most two aliases.", duplicateWarning: (entry) => `${entry} is already listed.` }}
      />;
    }
    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Aliases" });
    fireEvent.change(input, { target: { value: "!Hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "hey" } });
    fireEvent.keyDown(input, { key: "," });
    expect(await screen.findByText("hi")).toBeInTheDocument();
    expect(screen.getByText("hey")).toBeInTheDocument();
    expect(document.querySelectorAll(".chips-input__chip-label")).toHaveLength(2);
    expect(screen.getByText("2 von 2")).toBeInTheDocument();
    expect(input).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Remove alias !hi" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove alias !hi" }));
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "!HEY" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("!hey is already listed.")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "!hé" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/letters, numbers/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-describedby");
    expect(input.getAttribute("aria-describedby")).toMatch(/feedback/u);
  });
});

describe("template field", () => {
  it("counts template characters, warns at 90 percent, blocks only over-limit text, and submits with Ctrl+Enter", () => {
    const onSubmit = vi.fn((event: SyntheticEvent<HTMLFormElement>) => { event.preventDefault(); });
    const { rerender } = renderUi(
      <form onSubmit={onSubmit}>
        <TemplateTextField label="Reply" hint="What the bot writes." value="123456789" maxLength={10} onChange={() => {}} messages={templateTextFieldMessages} />
      </form>,
    );
    const input = screen.getByRole("textbox", { name: "Reply" });
    expect(screen.getByText("9 von 10 Zeichen")).toHaveClass("ui-template-text-field__count--warning");
    expect(input).not.toHaveAttribute("maxlength");
    rerender(<UiProvider><form onSubmit={onSubmit}><TemplateTextField label="Reply" hint="What the bot writes." value="12345678901" maxLength={10} onChange={() => {}} messages={templateTextFieldMessages} /></form></UiProvider>);
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector(".ui-template-text-field__helper-error")).toHaveTextContent("11 von 10 Zeichen");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("renders known variable tint and unknown variable warning decorations around the same text", () => {
    const { container } = renderUi(<TemplateTextField label="Reply" hint="What the bot writes." value="Hi {user} {viewer}" variables={templateOptions} onChange={() => {}} messages={templateTextFieldMessages} />);
    const known = container.querySelectorAll(".template-text-field__decoration--module");
    const unknown = container.querySelectorAll(".template-text-field__decoration--unknown");
    expect(Array.from(known, (part) => part.textContent)).toEqual(["{user}"]);
    expect(Array.from(unknown, (part) => part.textContent)).toEqual(["{viewer}"]);
    expect(known[0]).toHaveAttribute("data-kind", "module");
    expect(unknown[0]).toHaveAttribute("data-kind", "unknown");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Hi {user} {viewer}");
    expect(screen.getByText("Unbekannte Variable {viewer} – meintest du {viewers}?")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply" })).not.toHaveStyle({ paddingRight: "54px" });
  });

  it("shows composing text, delays issue checks until composition ends, inserts variables at the caret, and filters suggestions", async () => {
    const onIssuesChange = vi.fn();
    const parentKeyDown = vi.fn();
    function Harness() {
      const [value, setValue] = useState("Hello world");
      return (
        <div onKeyDown={parentKeyDown}>
          <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={setValue} onIssuesChange={onIssuesChange} messages={templateTextFieldMessages} />
          <output aria-label="Current value">{value}</output>
        </div>
      );
    }
    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    onIssuesChange.mockClear();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "Hello {viewer}" } });
    expect(input.closest(".template-text-field")).toHaveAttribute("data-composing", "true");
    expect(onIssuesChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: "" });
    await waitFor(() => expect(onIssuesChange).toHaveBeenCalledWith({ unknown: ["viewer"], worstCaseExceeded: false }));

    fireEvent.change(input, { target: { value: "Hello world" } });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    input.setSelectionRange(6, 6);
    fireEvent.select(input);
    fireEvent.change(input, { target: { value: "Hello {us}world", selectionStart: 9, selectionEnd: 9 } });
    input.setSelectionRange(9, 9);
    fireEvent.select(input);
    expect(await screen.findByRole("option", { name: /\{user\}/u, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /\{viewers\}/u, hidden: true })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Hello {user}world");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reply" })).toHaveFocus());

    fireEvent.change(input, { target: { value: "Hello {user} {viewers", selectionStart: 21, selectionEnd: 21 } });
    input.setSelectionRange(21, 21);
    fireEvent.select(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "Choose a variable", hidden: true })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("Hello {user} {viewers}");
  });

  it("chooses an exact variable name before an earlier group description match", async () => {
    const variables: readonly TemplateTextFieldVariable[] = [
      { name: "currency.convert", description: "Converts the target amount", sample: "11,50 €", kind: "module", parameter: { value: "USD EUR" } },
      { name: "target", description: "The selected target", sample: "streamerin", kind: "system" },
    ];
    function Harness() {
      const [value, setValue] = useState("Hello {target");
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={variables} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.select(input);
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("Hello {target}");
  });

  it("scrolls the active suggestion into view after each arrow navigation step", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    function Harness() {
      const [value, setValue] = useState("");
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "{", selectionStart: 1, selectionEnd: 1 } });
    await waitFor(() => expect(screen.getAllByRole("option", { hidden: true })).toHaveLength(2));
    scrollIntoView.mockClear();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("suggests dotted module variables after a namespace prefix and replaces the whole token", async () => {
    const variables: readonly TemplateTextFieldVariable[] = [
      { name: "sun.set", description: "Sunset", sample: "20:30" },
      { name: "sun.rise", description: "Sunrise", sample: "06:15" },
      { name: "weather.temp", description: "Temperature", sample: "18" },
    ];
    function Harness() {
      const [value, setValue] = useState("");
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={variables} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "{sun.", selectionStart: 5 } });

    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    const options = screen.getAllByRole("option", { hidden: true });
    expect(options.some((option) => option.textContent.includes("sun.set"))).toBe(true);
    expect(options.some((option) => option.textContent.includes("sun.rise"))).toBe(true);
    expect(options.some((option) => option.textContent.includes("weather.temp"))).toBe(false);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("{sun.set}");
  });

  it.each([
    ["currency.convert", "{currency.c", "{currency.convert USD EUR}"],
    ["api.sunset", "{api.sun", "{api.sunset}"],
    ["pick", "{pi", "{pick first|second}"],
  ])("completes %s inline", async (name, initialValue, expectedValue) => {
    const variables: readonly TemplateTextFieldVariable[] = [
      { name: "currency.convert", description: "Convert currency", sample: "11,50 €", parameters: "currency_pair", parameter: { value: "USD EUR" } },
      { name: "api.sunset", description: "API source sunset", sample: "18:42" },
      { name: "pick", description: "Choose an option", sample: "First", parameters: "choices", parameter: { value: "first|second" } },
    ];
    function Harness() {
      const [value, setValue] = useState(initialValue);
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={variables} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    input.setSelectionRange(initialValue.length, initialValue.length);
    fireEvent.select(input);
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue(expectedValue));
    expect(variables.some((variable) => variable.name === name)).toBe(true);
  });

  it.each([
    ["{sun.s}", 6, "{sun.set}"],
    ["{sun.s", 6, "{sun.set}"],
    ["{sun.set} rest", 6, "{sun.set} rest"],
  ])("completes a dotted variable around the caret in %s", async (initialValue, caret, expectedValue) => {
    const variables: readonly TemplateTextFieldVariable[] = [
      { name: "sun.set", description: "Sunset", sample: "20:30" },
    ];
    function Harness() {
      const [value, setValue] = useState(initialValue);
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={variables} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    input.setSelectionRange(caret, caret);
    fireEvent.select(input);
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue(expectedValue));
    await waitFor(() => expect(input.selectionStart).toBe("{sun.set}".length));
    expect(input.selectionEnd).toBe("{sun.set}".length);
  });

  it("does not accept a variable suggestion with Enter during IME composition", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    function Harness() {
      const [value, setValue] = useState("");
      return <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={(next) => { onChange(next); setValue(next); }} messages={templateTextFieldMessages} /></form>;
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
      return <div onKeyDown={parentKeyDown}><TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={setValue} messages={templateTextFieldMessages} /></div>;
    }
    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "{vi", selectionStart: 3 } });
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "true"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(parentKeyDown).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
  });

  it("computes the suggestion query from the live DOM value on a native selection event, not a stale value prop", () => {
    // Regression: a browser can fire the native `select` event for a
    // keystroke's caret move before React re-renders with that keystroke's
    // value. `onSelect` used to recompute the query against the closed-over
    // `value` prop (still the pre-keystroke text) paired with the event's
    // post-keystroke caret -- a mismatched pair that finds no unclosed "{"
    // and closes/never opens the dropdown a correctly-paired computation
    // would have opened.
    function Harness() {
      const [value] = useState("Hallo {user}");
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={() => {}} messages={templateTextFieldMessages} />;
    }
    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    expect(input).toHaveAttribute("aria-expanded", "false");

    // Mutate the DOM directly (as a real browser already has by the time it
    // fires `select`) without going through `fireEvent.change`, so the React
    // `value` prop stays one render behind the DOM's live text.
    input.value = "Hallo {user}{";
    input.setSelectionRange(13, 13);
    fireEvent.select(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps read-only text selectable and does not open the picker", () => {
    renderUi(<TemplateTextField label="Reply" hint="What the bot writes." value="Hi {user}" variables={templateOptions} readOnly onChange={() => {}} messages={templateTextFieldMessages} />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Insert variable" })).not.toBeInTheDocument();
  });

  it("detects an open brace while keeping its editor text and picker available", () => {
    function Harness() {
      const [value, setValue] = useState("");
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={templateOptions} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "{", selectionStart: 1, selectionEnd: 1 } });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
    expect(screen.getByText("Offene Variable: Schließe die geschweifte Klammer mit } ab.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the four variable groups with example values", () => {
    const variables: readonly TemplateTextFieldVariable[] = [
      { name: "module.value", description: "Module value", sample: "module-example", kind: "module" },
      { name: "game", description: "Current game", sample: "channel-example", kind: "system" },
      { name: "var.points", description: "Own points", sample: "own-example", kind: "channel" },
      { name: "text.welcome", description: "Welcome text", sample: "text-example", kind: "module", isTextBlock: true },
    ];
    function Harness() {
      const [value, setValue] = useState("");
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={variables} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    const input = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(input, { target: { value: "{", selectionStart: 1, selectionEnd: 1 } });
    if (!(input instanceof HTMLTextAreaElement)) throw new TypeError("Expected a template textarea.");
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
    for (const label of ["This module", "Channel", "Own variables", "Text blocks"]) {
      expect(document.body).toHaveTextContent(label);
    }
    for (const sample of ["module-example", "channel-example", "own-example", "text-example"]) {
      expect(document.body).toHaveTextContent(sample);
    }
  });

  it("suggests replacement for an unknown token, shows worst-case warnings without blocking, and previews sample rendering", () => {
    const onIssuesChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState("Hi {viewer}");
      return (
        <TemplateTextField
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
          messages={templateTextFieldMessages}
        />
      );
    }
    renderUi(
      <Harness />,
    );
    expect(screen.getByText(/meintest du \{viewers\}/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "{viewers} einsetzen" })).toBeInTheDocument();
    expect(screen.getByText(/bis zu 512 Zeichen/)).toBeInTheDocument();
    expect(screen.getByText("Hi {viewer}")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
    expect(onIssuesChange).toHaveBeenCalledWith({ unknown: ["viewer"], worstCaseExceeded: true });
    expect(screen.getByRole("textbox", { name: "Reply" })).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "{viewers} einsetzen" }));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Hi {viewers}");
  });

  it("places the complete chat preview and character count below the textarea and before the help text", () => {
    const longMessage = "A complete preview message that continues beyond the old two-line limit without being clipped or shortened.";
    const { container } = renderUi(
      <TemplateTextField
        label="Reply"
        hint="What the bot writes."
        value={longMessage}
        maxLength={500}
        onChange={() => {}}
        preview={(template) => template}
        previewLabel="Preview"
        previewSpeaker="BroBot"
        messages={templateTextFieldMessages}
      />,
    );

    const field = container.querySelector(".ui-template-text-field");
    const textarea = screen.getByRole("textbox", { name: "Reply" });
    const labelRow = container.querySelector(".ui-template-text-field__label-row");
    const previewHeader = container.querySelector(".ui-template-text-field__preview-header");
    const previewMessage = container.querySelector(".ui-template-text-field__preview-message");
    const previewText = container.querySelector(".ui-template-text-field__preview-text");
    const help = container.querySelector(".ui-template-text-field__helper-row");
    if (field === null || labelRow === null || previewHeader === null || previewMessage === null || previewText === null || help === null) {
      throw new Error("The template field is missing its label row, preview, or help text.");
    }
    expect(previewHeader).toHaveTextContent("Preview");
    expect(previewHeader).toHaveTextContent(`${String(longMessage.length)} von 500 Zeichen`);
    expect(previewMessage).toHaveTextContent(`BroBot: ${longMessage}`);
    expect(previewText.textContent).toBe(longMessage);
    expect(previewText).not.toHaveTextContent("…");
    expect(previewMessage).not.toHaveClass("ui-chat-preview__message");
    expect(labelRow.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(textarea.compareDocumentPosition(previewHeader) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(previewHeader.compareDocumentPosition(previewMessage) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(previewMessage.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("repairs an unknown variable name without dropping its arguments", () => {
    const variables: readonly TemplateTextFieldVariable[] = [
      { name: "currency.convert", description: "Converts an amount", sample: "11,50 €", parameters: "currency_pair", parameter: { value: "USD EUR" } },
    ];
    function Harness() {
      const [value, setValue] = useState("Hello {currency.conver GBP EUR}");
      return <TemplateTextField label="Reply" hint="What the bot writes." value={value} variables={variables} onChange={setValue} messages={templateTextFieldMessages} />;
    }

    renderUi(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "{currency.convert} einsetzen" }));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Hello {currency.convert GBP EUR}");
  });

  it("renders reading templates with the same known and unknown token treatment", () => {
    renderUi(<TemplateText value="{user} {viewer}" variables={templateOptions} />);
    expect(document.querySelector(".ui-template-text [data-kind='module']")).toHaveTextContent("{user}");
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
        { id: "settings", label: "Settings", icon: "tabSettings", content: <Field id="command-name" label="Name" hint="Command name." value="" error="Required" onChange={() => {}} /> },
        { id: "advanced", label: "Advanced", icon: "tabAdvanced", content: <Field id="command-cooldown" label="Cooldown" hint="Delay between uses." value="" error="Enter a duration" onChange={() => {}} /> },
      ]} invalidMessage="Correct the marked fields." invalidFields={[
        { id: "command-name", label: "Name", message: "Required", sectionId: "settings" },
        { id: "command-cooldown", label: "Cooldown", message: "Enter a duration", sectionId: "advanced" },
      ]} />;
    }
    renderUi(<Harness />);
    const settingsTab = screen.getByRole("tab", { name: /^Settings/u });
    expect(settingsTab.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("tab", { name: "Advanced, error" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/2 (invalid fields|Felder fehlerhaft)/u);
    fireEvent.click(screen.getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    const invalidPopover = await screen.findByRole("dialog", { name: "Fehlerhafte Felder" });
    expect(within(invalidPopover).getByRole("button", { name: "Name: Required" })).toBeInTheDocument();
    const cooldownLink = within(invalidPopover).getByRole("button", { name: "Cooldown: Enter a duration" });
    fireEvent.click(cooldownLink);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Cooldown" })).toHaveFocus());

    const advancedTab = screen.getByRole("tab", { name: "Advanced, error" });
    expect(advancedTab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("tab", { name: "Settings, error" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus());
  });

  it("reveals interaction-driven errors before focusing the first invalid field", async () => {
    const attemptOrder: string[] = [];
    function Harness() {
      const [attempted, setAttempted] = useState(false);
      return <EditorShell
        {...baseProps}
        dirty
        invalid={attempted}
        invalidMessage="Correct the marked fields."
        onInvalidSave={() => { attemptOrder.push("validate"); }}
        onSave={() => { attemptOrder.push("save"); setAttempted(true); }}
        sections={[
          { id: "settings", label: "Settings", content: <Field id="description" label="Description" value="Ready" onChange={() => {}} /> },
          { id: "advanced", label: "Advanced", content: <Field id="delayed-name" label="Name" value="" {...(attempted ? { error: "Required" } : {})} onChange={() => {}} /> },
        ]}
        invalidFields={attempted ? [{ id: "delayed-name", label: "Name", message: "Required", sectionId: "advanced" }] : []}
      />;
    }
    renderUi(<Harness />);

    expect(screen.getByRole("tab", { name: "Advanced" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: "Advanced, error" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    expect(within(await screen.findByRole("dialog", { name: "Fehlerhafte Felder" })).getByRole("button", { name: "Name: Required" })).toBeInTheDocument();
    expect(attemptOrder).toEqual(["validate", "save"]);
  });

  it("keeps the error summary links mounted across re-renders with equal invalid fields and drops them at once on activation", async () => {
    const makeFields = () => [{ id: "settings-name", label: "Name", message: "Required", sectionId: "settings" }];
    const shell = () => <UiProvider><EditorShell {...baseProps} dirty invalid invalidMessage="Correct the marked fields." invalidFields={makeFields()} /></UiProvider>;
    const { rerender } = render(shell());

    fireEvent.click(screen.getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    const link = within(await screen.findByRole("dialog", { name: "Fehlerhafte Felder" })).getByRole("button", { name: "Name: Required" });
    rerender(shell());

    expect(within(screen.getByRole("dialog", { name: "Fehlerhafte Felder" })).getByRole("button", { name: "Name: Required" })).toBe(link);
    expect(link.isConnected).toBe(true);

    fireEvent.click(link);
    expect(screen.queryByRole("dialog", { name: "Fehlerhafte Felder" })).toBeNull();
  });

  it("reveals every validator when saving with a known blocking field", async () => {
    function Harness() {
      const [attempted, setAttempted] = useState(false);
      return <EditorShell
        {...baseProps}
        dirty
        invalid
        invalidMessage="Correct the marked fields."
        onInvalidSave={() => { setAttempted(true); }}
        onSave={vi.fn()}
        sections={[
          { id: "settings", label: "Settings", content: <Field id="known-name" label="Name" value="" error="Required" onChange={() => {}} /> },
          { id: "advanced", label: "Advanced", content: <Field id="delayed-cooldown" label="Cooldown" value="" {...(attempted ? { error: "Enter a duration" } : {})} onChange={() => {}} /> },
        ]}
        invalidFields={[
          { id: "known-name", label: "Name", message: "Required", sectionId: "settings" },
          ...(attempted ? [{ id: "delayed-cooldown", label: "Cooldown", message: "Enter a duration", sectionId: "advanced" }] : []),
        ]}
      />;
    }
    renderUi(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const status = screen.getByRole("status");
    fireEvent.click(within(status).getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    const invalidPopover = await screen.findByRole("dialog", { name: "Fehlerhafte Felder" });
    await within(invalidPopover).findByRole("button", { name: "Cooldown: Enter a duration" });
    expect(within(invalidPopover).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Advanced, error" })).toBeInTheDocument();
    fireEvent.click(within(invalidPopover).getByRole("button", { name: "Cooldown: Enter a duration" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Cooldown" })).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Cooldown" })).toHaveAttribute("aria-invalid", "true");
  });

  it("refocuses the first error on every invalid save attempt", async () => {
    function Harness() {
      const [section, setSection] = useState("settings");
      const [attempted, setAttempted] = useState(false);
      return <EditorShell {...baseProps} dirty invalid invalidMessage="Correct the marked fields." section={section} onSectionChange={setSection}
        onInvalidSave={() => { setAttempted(true); }}
        sections={[
          { id: "settings", label: "Settings", content: <Field id="repeat-name" label="Name" value="" {...(attempted ? { error: "Required" } : {})} onChange={() => {}} /> },
          { id: "advanced", label: "Advanced", content: <Field id="repeat-cooldown" label="Cooldown" value="5" onChange={() => {}} /> },
        ]}
        invalidFields={[{ id: "repeat-name", label: "Name", message: "Required", sectionId: "settings" }]} />;
    }
    renderUi(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus());
    fireEvent.click(screen.getByRole("tab", { name: /^Advanced/u }));
    expect(screen.getByRole("textbox", { name: "Cooldown" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus());
    expect(screen.getByRole("tab", { name: /^Settings/u })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps collapsed sections marked until every hidden error is cleared", async () => {
    const detailsSection = [{ id: "settings", label: "Settings", content: <details>
      <summary>Advanced</summary>
      <Field id="usage-text" label="Usage" value="" error="Too long" onChange={() => {}} />
      <Field id="usage-limit" label="Limit" value="" error="Enter a smaller value" onChange={() => {}} />
    </details> }];
    const firstError = { id: "usage-text", label: "Usage", message: "Too long", sectionId: "settings" };
    const secondError = { id: "usage-limit", label: "Limit", message: "Enter a smaller value", sectionId: "settings" };
    const { rerender } = renderUi(<EditorShell {...baseProps} dirty invalid invalidMessage="Correct the marked fields."
      sections={detailsSection}
      invalidFields={[firstError, secondError]} />);
    const details = document.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    const invalidPopover = await screen.findByRole("dialog", { name: "Fehlerhafte Felder" });
    fireEvent.click(within(invalidPopover).getByRole("button", { name: "Usage: Too long" }));
    expect(details.open).toBe(false);
    expect(details).toHaveAttribute("data-editor-error", "true");
    expect(screen.getByText("Advanced")).toHaveFocus();
    fireEvent.click(within(invalidPopover).getByRole("button", { name: "Limit: Enter a smaller value" }));
    expect(details).toHaveAttribute("data-editor-error", "true");

    rerender(<UiProvider><EditorShell {...baseProps} dirty invalid invalidMessage="Correct the marked fields."
      sections={detailsSection}
      invalidFields={[firstError, secondError]} /></UiProvider>);
    expect(details).toHaveAttribute("data-editor-error", "true");

    rerender(<UiProvider><EditorShell {...baseProps} dirty invalid invalidMessage="Correct the marked fields."
      sections={detailsSection}
      invalidFields={[firstError]} /></UiProvider>);
    expect(details).toHaveAttribute("data-editor-error", "true");

    rerender(<UiProvider><EditorShell {...baseProps} dirty sections={detailsSection} invalidFields={[]} /></UiProvider>);
    expect(details).not.toHaveAttribute("data-editor-error");
  });

  it("keeps SaveStatus visible across clean, dirty, warning, saved, error, pending, and conflict states", () => {
    const { rerender } = renderUi(<EditorShell {...baseProps} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("");

    rerender(<UiProvider><EditorShell {...baseProps} dirty warnings={["Unknown variable {viewer}."]} /></UiProvider>);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("data-variant", "primary");
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("ui-button");
    expect(screen.getByRole("status")).toHaveTextContent("Unknown variable {viewer}.");
    expect(screen.getByRole("status").querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    rerender(<UiProvider><EditorShell {...baseProps} saved warningStatusLabel={(warnings) => `Saved — ${String(warnings.length)} warning: ${warnings[0] ?? ""}`} warnings={["Unknown variable {viewer}."]} /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Saved — 1 warning: Unknown variable {viewer}.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    rerender(<UiProvider><EditorShell {...baseProps} saved /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
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
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load server version" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load server version" }).closest(".ui-save-bar__actions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load server version" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("renders read-only content as properties and preserves the editor class without a form, editable field, or SaveStatus", () => {
    renderUi(<EditorShell {...baseProps} className="votekick-settings-editor" readOnly={{ reason: "Only managers can edit this command.", content: <dl className="properties"><div><dt>Name</dt><dd>hello</dd></div></dl> }} />);
    expect(screen.getAllByText("Only managers can edit this command.")).toHaveLength(1);
    expect(screen.getByRole("definition")).toHaveTextContent("hello");
    expect(document.querySelector(".ui-editor-shell")).toHaveClass("votekick-settings-editor");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.querySelector("form")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-save-bar")).not.toBeInTheDocument();
  });

  it("adds the third confirmation action between cancel and confirm", () => {
    renderUi(<ConfirmDialog opened title="Discard changes?" description="Unsaved data will be lost." cancelLabel="Keep editing" onCancel={() => {}} alternative={{ label: "Save and switch", onClick: () => {} }} confirmLabel="Discard and switch" onConfirm={() => {}} danger />);
    const buttons = within(screen.getByRole("dialog")).getAllByRole("button").map((button) => button.textContent).filter((text) => text.length > 0);
    expect(buttons).toEqual(["Keep editing", "Save and switch", "Discard and switch"]);
  });

  it("keeps persistent SaveStatus after the form body as the editor's final child", () => {
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
    cleanup();
    renderUi(<Button icon="remove" danger="subtle">Delete command</Button>);
    const deleteButton = screen.getByRole("button", { name: "Delete command" });
    expect(deleteButton).toHaveAttribute("data-variant", "danger-outline");
    expect(deleteButton).toHaveClass("border-[var(--color-error-text)]");
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
        threshold: { label: "Threshold", hint: "Minimum viewer count." },
        shoutoutName: { label: "Shoutout name", hint: "The account sent a shoutout.", countLabel: (count: number, max: number) => `${String(count)} / ${String(max)}` },
        message: { label: "Message", hint: "What the bot writes.", previewLabel: "Preview", previewSpeaker: "BroBot" },
        mode: { label: "Mode", hint: "Select a mode.", options: { one: { label: "One", description: "First choice." }, two: { label: "Two", description: "Second choice." } } },
        enabled: { label: "Shoutout", hint: "Controls the dependent threshold.", description: "Send a shoutout after a large raid.", disabledReason: "Shoutout is off." },
        dependentThreshold: { label: "Dependent threshold", hint: "Minimum viewer count." },
      },
    };
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      return <SettingsEditor<Settings>
        spec={spec}
        sectionId="general"
        settings={{ threshold: 12, shoutoutName: "channel", message: "Hello {user}", mode: "one", enabled, dependentThreshold: 50 }}
        onChange={(key, value) => { if (key === "enabled" && typeof value === "boolean") setEnabled(value); }}
        texts={texts}
        variables={{ message: templateOptions }}
        templateMessages={templateTextFieldMessages}
      />;
    }
    renderUi(<Harness />);
    const fieldHelp: readonly (readonly [string, string])[] = [
      ["Threshold", "Minimum viewer count."],
      ["Shoutout name", "The account sent a shoutout."],
      ["Message", "What the bot writes."],
      ["Mode", "First choice."],
    ];
    for (const [label, help] of fieldHelp) {
      if (label === "Threshold") {
        expect(screen.getByText(help, { selector: ".unit-input__description" })).toBeVisible();
      } else {
        expect(screen.getByRole("button", { name: `${label}: ${help}` })).toHaveAttribute("title", help);
      }
    }
    expect(screen.getByText("Send a shoutout after a large raid.")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Dependent threshold" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Shoutout" }));
    expect(screen.getByRole("spinbutton", { name: "Dependent threshold" })).toBeInTheDocument();
    expect(screen.getAllByText("Minimum viewer count.", { selector: ".unit-input__description" })).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Mode" })).toBeInTheDocument();
  });
});

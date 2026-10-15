import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatPreview, ChatTargetField, GameMultiSelect, TokenChip, UiProvider, type GameMultiSelectGame, type GameMultiSelectMessages } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";

const messages: GameMultiSelectMessages = {
  label: "Spiele",
  hint: "Ohne Auswahl gelten alle Spiele.",
  search: "Spiel hinzufügen",
  searchHint: "Mindestens zwei Zeichen eingeben.",
  loading: "Spiele werden geladen …",
  empty: "Keine Spiele gefunden.",
  error: "Spiele konnten nicht geladen werden.",
  suggestions: "Vorschläge",
  allGames: "Alle Spiele",
  limitReached: "Du kannst höchstens 10 Spiele auswählen.",
  selectedCount: (count, maximum) => `${String(count)} von ${String(maximum)}`,
  remove: (name) => `${name} entfernen`,
};

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const renderUi = (children: ReactNode): ReturnType<typeof render> => render(<UiProvider>{children}</UiProvider>);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
});

describe("Part B shared UI", () => {
  it("only shows chat targets included in allowed", async () => {
    const onChange = vi.fn();
    renderUi(<ChatTargetField label="Chat-Ziel" value="source_only" onChange={onChange} allowed={["all_chats", "source_only"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat-Ziel" }));

    expect(await screen.findByRole("radio", { name: /Alle Chats/u, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Nur unser Chat/u, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Automatisch/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Kanaleinstellung verwenden/u, hidden: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Alle Chats/u, hidden: true }));
    expect(onChange).toHaveBeenCalledWith("all_chats");
  });

  it("uses only the chevron to signal that the chat target can be changed", () => {
    renderUi(<ChatTargetField label="Chat-Ziel" value="source_only" onChange={() => undefined} />);

    const trigger = screen.getByRole("button", { name: "Chat-Ziel" });
    expect(trigger.querySelector(".ui-chat-target-field__change")).not.toBeInTheDocument();
    expect(trigger.querySelector(".ui-chat-target-field__chevron")).toBeInTheDocument();
  });

  it("shows channel default only when allowed and maps it to null", () => {
    const onChange = vi.fn();
    renderUi(<ChatTargetField label="Chat-Ziel" value="all_chats" onChange={onChange} allowed={["all_chats", "source_only", "channel_default", "where_asked"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat-Ziel" }));
    const channelDefault = screen.getByRole("radio", { name: /Kanaleinstellung verwenden/u, hidden: true });
    expect(channelDefault).toHaveAttribute("aria-checked", "false");
    fireEvent.click(channelDefault);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps one tab stop in a radio group that supports inheritance", async () => {
    const onChange = vi.fn();
    renderUi(<ChatTargetField label="Chat-Ziel" value={null} onChange={onChange} allowed={["all_chats", "source_only", "channel_default", "where_asked"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat-Ziel" }));
    const selected = await screen.findByRole("radio", { name: /Kanaleinstellung verwenden/u, hidden: true });
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: /Nur unser Chat/u, hidden: true })).toHaveAttribute("tabindex", "-1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("labels inheritance with the effective channel default when available", () => {
    renderUi(<ChatTargetField
      label="Chat-Ziel"
      value={null}
      onChange={() => undefined}
      allowed={["all_chats", "source_only", "channel_default"]}
      effectiveDefault="source_only"
    />);

    fireEvent.click(screen.getByRole("button", { name: "Chat-Ziel" }));
    expect(screen.getByRole("radio", { name: /Kanaleinstellung verwenden \(Nur unser Chat\)/u, hidden: true })).toHaveAttribute("aria-checked", "true");
  });

  it("does not offer inheritance unless the caller declares backend support", () => {
    renderUi(<ChatTargetField label="Chat-Ziel" value="source_only" onChange={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat-Ziel" }));
    expect(screen.queryByRole("radio", { name: /Kanaleinstellung verwenden/u, hidden: true })).not.toBeInTheDocument();
  });

  it("requests empty-query suggestions before typing and refuses an eleventh game", async () => {
    const selectedGames: GameMultiSelectGame[] = Array.from({ length: 9 }, (_, index) => ({ id: String(index + 1), name: `Game ${String(index + 1)}` }));
    const tenthGame: GameMultiSelectGame = { id: "10", name: "Game Ten" };
    const eleventhGame: GameMultiSelectGame = { id: "11", name: "Game Eleven" };
    const searchGames = vi.fn().mockResolvedValue([tenthGame, eleventhGame]);

    function Harness() {
      const [value, setValue] = useState(selectedGames);
      return <GameMultiSelect searchGames={searchGames} value={value} onChange={setValue} messages={messages} />;
    }

    renderUi(<Harness />);
    const search = screen.getByRole("searchbox", { name: "Spiele" });
    fireEvent.focus(search);

    const tenthOption = await screen.findByRole("option", { name: "Game Ten", hidden: true });
    expect(searchGames).toHaveBeenCalledWith("");
    fireEvent.click(tenthOption);

    expect(await screen.findByText("10 von 10")).toBeInTheDocument();
    expect(screen.getByText(messages.limitReached)).toBeInTheDocument();
    expect(document.querySelector(".ui-game-multi-select__cover-placeholder svg")).toBeInTheDocument();
    const eleventhOption = screen.getByRole("option", { name: "Game Eleven", hidden: true });
    expect(eleventhOption).toBeDisabled();
    fireEvent.click(eleventhOption);
    expect(screen.getByText("10 von 10")).toBeInTheDocument();
  });

  it("reopens game results when the focused input is clicked after Escape", async () => {
    const searchGames = vi.fn().mockResolvedValue([{ id: "1", name: "Game One" }]);
    renderUi(<GameMultiSelect searchGames={searchGames} value={[]} onChange={() => undefined} messages={messages} />);
    const search = screen.getByRole("searchbox", { name: "Spiele" });
    fireEvent.click(search);
    fireEvent.focus(search);
    expect(await screen.findByRole("option", { name: "Game One" })).toBeInTheDocument();

    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => { expect(screen.queryByRole("option", { name: "Game One" })).not.toBeInTheDocument(); });

    fireEvent.click(search);
    expect(await screen.findByRole("option", { name: "Game One" })).toBeInTheDocument();
  });

  it("copies a token to the clipboard and announces success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderUi(<><TokenChip token="{api.sunset}" /><ToastHost /></>);

    fireEvent.click(screen.getByRole("button", { name: "{api.sunset} kopieren" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("{api.sunset}"));
    expect(await screen.findByText("Token kopiert.")).toBeInTheDocument();
  });

  it("renders the preview label with a two-line message area", () => {
    renderUi(<ChatPreview label="Vorschau" speaker="BroBot" text="Die Antwort erscheint hier." countLabel="28 Zeichen" />);

    expect(screen.getByText("Vorschau")).toBeInTheDocument();
    expect(screen.getByText("BroBot")).toBeInTheDocument();
    expect(screen.getByText("Die Antwort erscheint hier.")).toBeInTheDocument();
    expect(document.querySelector(".ui-chat-preview__message")).toHaveAttribute("title", "BroBot: Die Antwort erscheint hier.");
  });
});

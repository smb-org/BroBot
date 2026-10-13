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

  it("shows channel default only when allowed and maps it to null", () => {
    const onChange = vi.fn();
    renderUi(<ChatTargetField label="Chat-Ziel" value={null} onChange={onChange} allowed={["all_chats", "channel_default"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Chat-Ziel" }));
    const channelDefault = screen.getByRole("radio", { name: /Kanaleinstellung verwenden/u, hidden: true });
    expect(channelDefault).toHaveAttribute("aria-checked", "true");
    fireEvent.click(channelDefault);
    expect(onChange).toHaveBeenCalledWith(null);
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
    const eleventhOption = screen.getByRole("option", { name: "Game Eleven", hidden: true });
    expect(eleventhOption).toBeDisabled();
    fireEvent.click(eleventhOption);
    expect(screen.getByText("10 von 10")).toBeInTheDocument();
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

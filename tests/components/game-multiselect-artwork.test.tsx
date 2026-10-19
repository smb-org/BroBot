import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GameMultiSelect, UiProvider, type GameMultiSelectGame, type GameMultiSelectMessages } from "../../src/dashboard/ui";

afterEach(cleanup);

describe("shared game picker artwork", () => {
  it("shows covers only after load and removes failed images without an icon", () => {
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

    const { container } = render(<UiProvider><GameMultiSelect
      searchGames={() => Promise.resolve([])}
      value={[game]}
      onChange={() => undefined}
      messages={messages}
      compact
      singleValue
    /></UiProvider>);

    const cover = container.querySelector<HTMLImageElement>(".ui-game-multi-select__cover");
    if (cover === null) throw new Error("The selected game cover was not rendered.");
    expect(cover).toHaveStyle({ visibility: "hidden" });
    fireEvent.load(cover);
    const loadedCover = container.querySelector<HTMLImageElement>(".ui-game-multi-select__cover");
    if (loadedCover === null) throw new Error("The loaded game cover was removed.");
    expect(loadedCover).toHaveStyle({ visibility: "visible" });

    fireEvent.error(loadedCover);
    expect(container.querySelector(".ui-game-multi-select__cover")).not.toBeInTheDocument();
    expect(container.querySelector(".ui-game-multi-select__cover-placeholder")).not.toBeInTheDocument();
  });
});

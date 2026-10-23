import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VotekickLockCard } from "../../src/modules/votekick/panel/lock-card";
import { UiProvider } from "../../src/dashboard/ui";

afterEach(() => { cleanup(); });

describe("VotekickLockCard", () => {
  it("shows the active vote and its remaining time", () => {
    render(<UiProvider><VotekickLockCard
      state={{ kind: "chat_vote", title: "What should we play?", until: "2030-01-01T00:01:20.000Z" }}
      status="ready" language="en" now={Date.parse("2030-01-01T00:00:00.000Z")}
    /></UiProvider>);

    expect(screen.getByRole("region", { name: "Mutual lock" })).toHaveTextContent("What should we play? · ends in 1:20");
    expect(screen.getByRole("region", { name: "Mutual lock" })).toHaveTextContent("A vote is running");
  });

  it("keeps the countdown separate from a long vote title", () => {
    const title = "Welches Spiel spielen wir am kommenden Wochenende zusammen im Community-Stream?";
    const { container } = render(<UiProvider><VotekickLockCard
      state={{ kind: "chat_vote", title, until: "2030-01-01T00:01:20.000Z" }}
      status="ready" language="de" now={Date.parse("2030-01-01T00:00:00.000Z")}
    /></UiProvider>);
    const titleElement = container.querySelector(".votekick-lock-card__main-title");
    const countdown = container.querySelector(".votekick-lock-card__main-countdown");

    expect(titleElement?.getAttribute("title")).toBe(title);
    expect(titleElement?.textContent).toBe(title);
    expect(countdown?.textContent).toBe(" · endet in 1:20");
  });

  it("keeps the ticking countdown out of live regions and announces lock transitions", () => {
    const { container, rerender } = render(<UiProvider><VotekickLockCard
      state={null} status="ready" language="en" now={Date.parse("2030-01-01T00:00:00.000Z")}
    /></UiProvider>);
    rerender(<UiProvider><VotekickLockCard
      state={{ kind: "chat_vote", title: "What should we play?", until: "2030-01-01T00:01:20.000Z" }}
      status="ready" language="en" now={Date.parse("2030-01-01T00:00:00.000Z")}
    /></UiProvider>);

    const countdown = container.querySelector(".votekick-lock-card__main-countdown");
    expect(countdown).toHaveAttribute("aria-live", "off");
    expect(countdown?.closest('[aria-live="polite"], [aria-live="assertive"]')).toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("A vote is running");

    rerender(<UiProvider><VotekickLockCard
      state={null} status="ready" language="en" now={Date.parse("2030-01-01T00:00:01.000Z")}
    /></UiProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("No vote is active");
  });

  it("shows a running votekick and its remaining time", () => {
    render(<UiProvider><VotekickLockCard
      state={{ kind: "votekick", target: "sampleviewer", until: "2030-01-01T00:00:45.000Z" }}
      status="ready" language="en" now={Date.parse("2030-01-01T00:00:00.000Z")}
    /></UiProvider>);

    expect(screen.getByRole("region", { name: "Mutual lock" })).toHaveTextContent("Votekick against sampleviewer · ends in 0:45");
  });

  it.each([
    [null, "ready", "No vote is running right now."],
    [null, "loading", "Loading voting status"],
    [null, "error", "Voting status could not be loaded."],
    [{ kind: "unknown" as const }, "ready", "A vote is active. Its details are still loading."],
  ] as const)("keeps a reserved card for empty, loading, error, and unresolved lock states", (state, status, copy) => {
    const { container } = render(<UiProvider><VotekickLockCard state={state} status={status} language="en" now={Date.now()} /></UiProvider>);
    const card = screen.getByRole("region", { name: "Mutual lock" });
    expect(card).toHaveTextContent(copy);
    expect(container.querySelector(".votekick-lock-card__reserved")).toBeInTheDocument();
  });

  it("keeps the short error status in the header and the full explanation in the reserved body", () => {
    render(<UiProvider><VotekickLockCard state={null} status="error" language="en" now={Date.now()} /></UiProvider>);
    const card = screen.getByRole("region", { name: "Mutual lock" });

    expect(card.querySelector(".votekick-lock-card__header")).toHaveTextContent("Unavailable");
    expect(card.querySelector(".votekick-lock-card__header")).not.toHaveTextContent("Voting status could not be loaded.");
    expect(card.querySelector(".votekick-lock-card__reserved")).toHaveTextContent("Voting status could not be loaded.");
  });
});

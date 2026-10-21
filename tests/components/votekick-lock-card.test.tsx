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
});

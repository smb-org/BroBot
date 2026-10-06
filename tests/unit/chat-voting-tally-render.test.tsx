import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Tally from "../../src/modules/chat_voting/overlay/tally";

describe("chat voting overlay tally", () => {
  afterEach(cleanup);

  it("renders the top five text terms and masks terms before filter readiness", () => {
    const terms = [
      { term: "alpha", count: 6, approved: true },
      { term: "bravo", count: 5, approved: false },
      { term: "charlie", count: 4, approved: true },
      { term: "delta", count: 3, approved: true },
      { term: "echo", count: 2, approved: true },
      { term: "foxtrot", count: 1, approved: true },
    ];
    render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "text-poll",
      openedAt: "2030-01-01T00:00:00.000Z",
      status: "open",
      preset: "free_text",
      optionCount: 0,
      textMode: "first_word",
      labels: [],
      counts: [],
      terms,
      more: 2,
      termFilterReady: true,
      revision: 1,
    }} now={Date.now()} language="en" />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("charlie")).toBeInTheDocument();
    expect(screen.getByText("delta")).toBeInTheDocument();
    expect(screen.getByText("echo")).toBeInTheDocument();
    expect(screen.queryByText("foxtrot")).not.toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
    expect(screen.getByText("more: 2")).toBeInTheDocument();

    cleanup();
    render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "text-poll",
      status: "open",
      preset: "free_text",
      counts: [],
      terms,
      termFilterReady: false,
      revision: 2,
    }} now={Date.now()} language="en" />);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText("?")).not.toBeInTheDocument();
    expect(screen.queryByText("bravo")).not.toBeInTheDocument();
  });

  it("renders labels and counts for digit presets", () => {
    render(<Tally config={{ layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 }} state={{
      pollId: "zero-one-poll",
      status: "open",
      preset: "digit_01",
      optionCount: 2,
      labels: ["Nein", "Ja"],
      counts: [1, 2],
      revision: 1,
    }} now={Date.now()} language="de" />);

    expect(screen.getByText("Nein")).toBeInTheDocument();
    expect(screen.getByText("Ja")).toBeInTheDocument();
    expect(screen.getByText("1 · 33%")).toBeInTheDocument();
    expect(screen.getByText("2 · 67%")).toBeInTheDocument();
  });
});

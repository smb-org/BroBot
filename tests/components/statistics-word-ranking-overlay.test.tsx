import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/modules/contract";
import StatisticsWordRankingEditor from "../../src/modules/statistics/overlay/ranking-editor";
import StatisticsWordRanking from "../../src/modules/statistics/overlay/ranking-view";

afterEach(cleanup);

describe("statistics word ranking overlay", () => {
  it("reserves five fixed row slots when only two words are available", () => {
    const { container } = render(<StatisticsWordRanking
      config={{ scope: "total", count: 5, title: "Top words", bars: true }}
      state={{
        serverNow: "2030-01-01T00:00:00.000Z",
        stream: null,
        total: { entries: [
          { word: "alpha", displayWord: "Alpha", count: 20 },
          { word: "beta", displayWord: "Beta", count: 10 },
        ] },
      }} now={0} language="en" />);

    expect(container.querySelectorAll(".statistics-word-ranking__row")).toHaveLength(5);
    expect(container.querySelectorAll(".statistics-word-ranking__row--empty")).toHaveLength(3);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("scales row bars against the top count", () => {
    const { container } = render(<StatisticsWordRanking
      config={{ scope: "stream", count: 3, title: "Top words", bars: true }}
      state={{
        serverNow: "2030-01-01T00:00:00.000Z",
        stream: { entries: [
          { word: "alpha", displayWord: "Alpha", count: 12 },
          { word: "beta", displayWord: "Beta", count: 6 },
        ], streamIsLive: true },
        total: null,
      }} now={0} language="en" />);

    const rows = container.querySelectorAll<HTMLElement>(".statistics-word-ranking__row");
    expect(rows[0]?.style.getPropertyValue("--word-ranking-bar-width")).toBe("100%");
    expect(rows[1]?.style.getPropertyValue("--word-ranking-bar-width")).toBe("50%");
  });

  it("exposes labeled editor fields and commits validated values", () => {
    const onChange = vi.fn<(config: JsonObject) => void>();
    const { container, rerender } = render(<StatisticsWordRankingEditor config={{ scope: "stream", count: 5, bars: true }} onChange={onChange} language="en" />);

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "total" } });
    expect(onChange).toHaveBeenLastCalledWith({ scope: "total", count: 5, bars: true });
    rerender(<StatisticsWordRankingEditor config={{ scope: "total", count: 5, bars: true }} onChange={onChange} language="en" />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Word count" }), { target: { value: "7" } });
    expect(onChange).toHaveBeenLastCalledWith({ scope: "total", count: 7, bars: true });
    rerender(<StatisticsWordRankingEditor config={{ scope: "total", count: 7, bars: true }} onChange={onChange} language="en" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "My words" } });
    expect(onChange).toHaveBeenLastCalledWith({ scope: "total", count: 7, title: "My words", bars: true });
    rerender(<StatisticsWordRankingEditor config={{ scope: "total", count: 7, title: "My words", bars: true }} onChange={onChange} language="en" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show bars" }));
    expect(onChange).toHaveBeenLastCalledWith({ scope: "total", count: 7, title: "My words", bars: false });
    expect(container.querySelectorAll(".statistics-word-ranking-editor__preview-row")).toHaveLength(7);
  });
});

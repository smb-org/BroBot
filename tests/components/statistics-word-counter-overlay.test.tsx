import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/modules/contract";
import StatisticsWordCounterEditor from "../../src/modules/statistics/overlay/editor";
import StatisticsWordCounter from "../../src/modules/statistics/overlay/view";
import { statisticsWordCounterOverlayElement } from "../../src/modules/statistics/overlay/element";
import {
  mergeStatisticsWordCounterRealtimeState,
  parseStatisticsWordCounterConfig,
} from "../../src/modules/statistics/overlay/state";

afterEach(cleanup);

describe("statistics word counter overlay", () => {
  it("renders both counts with localized captions and a reserved numeric width", () => {
    const { container } = render(<StatisticsWordCounter config={{ word: "fak", label: "Fak", show: "both" }} state={{
      words: { fak: { streamCount: 128, totalCount: 1_248, streamIsLive: true } },
      serverNow: "2030-01-01T00:00:00.000Z",
    }} now={0} language="en" />);

    expect(screen.getByRole("heading", { name: "Fak" })).toBeInTheDocument();
    expect(screen.getByText("Stream")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("1,248")).toBeInTheDocument();
    expect(container.querySelectorAll(".statistics-word-counter__value")).toHaveLength(2);
    expect(container.querySelector(".statistics-word-counter")?.getAttribute("data-stream-live")).toBe("true");
  });

  it("keeps the last stream count visible while offline", () => {
    render(<StatisticsWordCounter config={{ word: "fak", label: "Fak", show: "stream" }} state={{
      words: { fak: { streamCount: 4, totalCount: 0, streamIsLive: false } },
      serverNow: "2030-01-01T00:00:00.000Z",
    }} now={0} language="de" />);

    expect(screen.getByText("Stream")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("provides a bilingual editor preview and stores the folded word", () => {
    expect(parseStatisticsWordCounterConfig({ word: "FAAAK" })).toEqual({ word: "fak", label: "FAAAK", show: "both" });
    expect(parseStatisticsWordCounterConfig({ word: "fak and bak" })).toBeNull();
    expect(statisticsWordCounterOverlayElement.previewState?.({ word: "fak", label: "Fak", show: "both" }, "de", 0))
      .toMatchObject({ words: { fak: { streamCount: 128, totalCount: 1_248 } } });

    const onChange = vi.fn<(config: JsonObject) => void>();
    const { rerender } = render(<StatisticsWordCounterEditor config={{ word: "hello", label: "hello", show: "both" }} onChange={onChange} language="en" />);

    expect(screen.getByText(/Preview: hello · Stream 128 · Total 1,248/u)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "FAAAK" } });
    expect(onChange).toHaveBeenLastCalledWith({ word: "fak", label: "FAAAK", show: "both" });
    rerender(<StatisticsWordCounterEditor config={{ word: "fak", label: "FAAAK", show: "both" }} onChange={onChange} language="en" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "total" } });
    expect(onChange).toHaveBeenLastCalledWith({ word: "fak", label: "FAAAK", show: "total" });
  });

  it("applies bootstrap freshness independently for each word", () => {
    const initial = mergeStatisticsWordCounterRealtimeState(null, {
      words: {
        alpha: { streamCount: 8, totalCount: 100, streamIsLive: true },
      },
      serverNow: "2030-01-01T00:00:00.000Z",
    });
    const withLaterChunk = mergeStatisticsWordCounterRealtimeState(initial, {
      words: {
        beta: { streamCount: 2, totalCount: 12, streamIsLive: true },
      },
      serverNow: "2030-01-01T00:00:02.000Z",
    });
    const withBootstrap = mergeStatisticsWordCounterRealtimeState(withLaterChunk, {
      words: {
        alpha: { streamCount: 0, totalCount: 4, streamIsLive: true },
      },
      serverNow: "2030-01-01T00:00:01.000Z",
    });

    expect(withBootstrap).toMatchObject({
      words: {
        alpha: { streamCount: 0, totalCount: 4, streamIsLive: true },
        beta: { streamCount: 2, totalCount: 12, streamIsLive: true },
      },
      serverNow: "2030-01-01T00:00:02.000Z",
    });
  });
});

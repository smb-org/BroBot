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
      bootstrapWordSet: true,
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
      bootstrapWordSet: true,
      words: {
        alpha: { streamCount: 0, totalCount: 4, streamIsLive: true },
      },
      serverNow: "2030-01-01T00:00:01.000Z",
    });

    expect(withBootstrap).toMatchObject({
      words: {
        alpha: { streamCount: 0, totalCount: 4, streamIsLive: true },
      },
      serverNow: "2030-01-01T00:00:01.000Z",
    });
  });

  it("keeps configuration churn bounded to the current bootstrap word", () => {
    let state: Readonly<Record<string, unknown>> | null = null;
    for (let index = 0; index < 1_000; index += 1) {
      const word = `word-${String(index)}`;
      state = mergeStatisticsWordCounterRealtimeState(state, {
        bootstrapWordSet: true,
        words: { [word]: { streamCount: index, totalCount: index, streamIsLive: true } },
        serverNow: new Date(1_893_456_000_000 + index * 1_000).toISOString(),
      });
    }

    expect(state?.words).toEqual({ "word-999": { streamCount: 999, totalCount: 999, streamIsLive: true } });
    expect(state?.wordServerNow).toEqual({ "word-999": new Date(1_893_456_999_000).toISOString() });
  });

  it("ignores chunk words that are not in this counter's bootstrap", () => {
    const initial = mergeStatisticsWordCounterRealtimeState(null, {
      bootstrapWordSet: true,
      words: { alpha: { streamCount: 1, totalCount: 10, streamIsLive: true } },
      serverNow: "2030-01-01T00:00:00.000Z",
    });
    const afterChunk = mergeStatisticsWordCounterRealtimeState(initial, {
      words: {
        alpha: { streamCount: 2, totalCount: 11, streamIsLive: true },
        beta: { streamCount: 7, totalCount: 20, streamIsLive: true },
      },
      serverNow: "2030-01-01T00:00:01.000Z",
    });

    expect(afterChunk.words).toEqual({ alpha: { streamCount: 2, totalCount: 11, streamIsLive: true } });
  });

  it("keeps a newer chunk value over a stale bootstrap value", () => {
    const initial = mergeStatisticsWordCounterRealtimeState(null, {
      bootstrapWordSet: true,
      words: { alpha: { streamCount: 1, totalCount: 10, streamIsLive: true } },
      serverNow: "2030-01-01T00:00:00.000Z",
    });
    const afterChunk = mergeStatisticsWordCounterRealtimeState(initial, {
      words: { alpha: { streamCount: 2, totalCount: 11, streamIsLive: true } },
      serverNow: "2030-01-01T00:00:02.000Z",
    });
    const afterStaleBootstrap = mergeStatisticsWordCounterRealtimeState(afterChunk, {
      bootstrapWordSet: true,
      words: { alpha: { streamCount: 0, totalCount: 4, streamIsLive: true } },
      serverNow: "2030-01-01T00:00:01.000Z",
    });

    expect(afterStaleBootstrap.words).toEqual({ alpha: { streamCount: 2, totalCount: 11, streamIsLive: true } });
  });

  it("does not add chunk words before the first bootstrap", () => {
    const afterChunk = mergeStatisticsWordCounterRealtimeState(null, {
      words: { alpha: { streamCount: 2, totalCount: 11, streamIsLive: true } },
      serverNow: "2030-01-01T00:00:01.000Z",
    });

    expect(afterChunk.words).toEqual({});
  });
});

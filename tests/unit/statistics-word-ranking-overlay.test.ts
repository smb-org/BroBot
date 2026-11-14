import { describe, expect, it } from "vitest";

import { statisticsWordRankingOverlayElement } from "../../src/modules/statistics/overlay/ranking-element";
import {
  mergeStatisticsWordRankingRealtimeState,
  parseStatisticsWordRankingConfig,
  parseStatisticsWordRankingState,
} from "../../src/modules/statistics/overlay/state";
import { selectStatisticsWordRankingEntries } from "../../src/modules/statistics/word-ranking";

const earlier = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:02.000Z";

const rankingState = (
  serverNow: string,
  entries: readonly { word: string; displayWord: string; count: number }[],
): Record<string, unknown> => ({
  serverNow,
  stream: { entries, streamIsLive: true, computedAt: serverNow },
  total: { entries, computedAt: serverNow },
});

describe("statistics word ranking state", () => {
  it("builds an editor preview state that passes the state validation", () => {
    const state = statisticsWordRankingOverlayElement.previewState?.(
      { scope: "stream", count: 10, bars: true }, "de", Date.parse(earlier),
    );

    expect(parseStatisticsWordRankingState(state)?.stream?.entries).toHaveLength(10);
  });

  it("validates scope, row count, title, and bars defaults", () => {
    expect(parseStatisticsWordRankingConfig({})).toEqual({ scope: "stream", count: 5, bars: true });
    expect(parseStatisticsWordRankingConfig({ scope: "total", count: 10, title: "", bars: false }))
      .toEqual({ scope: "total", count: 10, title: "", bars: false });
    expect(parseStatisticsWordRankingConfig({ scope: "unknown" })).toBeNull();
    expect(parseStatisticsWordRankingConfig({ count: 2 })).toBeNull();
    expect(parseStatisticsWordRankingConfig({ title: "x".repeat(81) })).toBeNull();
    expect(parseStatisticsWordRankingConfig({ bars: "yes" })).toBeNull();
  });

  it("replaces a scope list when an equal-time live state arrives", () => {
    const current = mergeStatisticsWordRankingRealtimeState(null, rankingState(earlier, [
      { word: "alpha", displayWord: "Alpha", count: 4 },
    ]));
    const next = mergeStatisticsWordRankingRealtimeState(current, rankingState(earlier, [
      { word: "alpha", displayWord: "ALPHA", count: 5 },
    ]));

    expect(next.stream).toEqual({
      entries: [{ word: "alpha", displayWord: "ALPHA", count: 5 }], streamIsLive: true, computedAt: earlier,
    });
  });

  it("does not replace a scope with an older bootstrap or live state", () => {
    const current = mergeStatisticsWordRankingRealtimeState(null, {
      ...rankingState(later, [
        { word: "alpha", displayWord: "Alpha", count: 4 },
      ]),
      bootstrap: true,
    });
    const staleBootstrap = mergeStatisticsWordRankingRealtimeState(current, {
      ...rankingState(earlier, [
        { word: "alpha", displayWord: "Alpha", count: 1 },
      ]),
      bootstrap: true,
    });
    const next = mergeStatisticsWordRankingRealtimeState(staleBootstrap, rankingState(earlier, [
      { word: "alpha", displayWord: "Alpha", count: 4 },
    ]));

    expect(next.stream).toEqual({
      entries: [{ word: "alpha", displayWord: "Alpha", count: 4 }], streamIsLive: true, computedAt: later,
    });
  });

  it("lets a fresh bootstrap populate a null scope", () => {
    const current = mergeStatisticsWordRankingRealtimeState(null, {
      serverNow: earlier,
      stream: null,
      total: null,
      bootstrap: true,
    });
    const next = mergeStatisticsWordRankingRealtimeState(current, {
      serverNow: later,
      stream: { entries: [{ word: "beta", displayWord: "Beta", count: 9 }], streamIsLive: true, computedAt: later },
      total: { entries: [{ word: "beta", displayWord: "Beta", count: 9 }], computedAt: later },
      bootstrap: true,
    });

    expect(next.stream).toEqual({
      entries: [{ word: "beta", displayWord: "Beta", count: 9 }],
      streamIsLive: true,
      computedAt: later,
    });
    expect(next.total).toEqual({ entries: [{ word: "beta", displayWord: "Beta", count: 9 }], computedAt: later });
  });

  it("leaves a null scope unchanged in a live message", () => {
    const current = mergeStatisticsWordRankingRealtimeState(null, rankingState(earlier, [
      { word: "alpha", displayWord: "Alpha", count: 4 },
    ]));
    const next = mergeStatisticsWordRankingRealtimeState(current, {
      serverNow: later,
      stream: null,
      total: { entries: [{ word: "beta", displayWord: "Beta", count: 9 }], computedAt: later },
    });

    expect(next.stream).toEqual(current.stream);
    expect(next.total).toEqual({ entries: [{ word: "beta", displayWord: "Beta", count: 9 }], computedAt: later });
  });

  it("compares each scope against its own computedAt timestamp", () => {
    const current = mergeStatisticsWordRankingRealtimeState(null, {
      ...rankingState(earlier, [{ word: "alpha", displayWord: "Alpha", count: 4 }]),
      bootstrap: true,
    });
    const totalUpdate = mergeStatisticsWordRankingRealtimeState(current, {
      serverNow: later,
      stream: null,
      total: { entries: [{ word: "beta", displayWord: "Beta", count: 9 }], computedAt: later },
    });
    const streamUpdate = mergeStatisticsWordRankingRealtimeState(totalUpdate, {
      serverNow: "2030-01-01T00:00:03.000Z",
      stream: {
        entries: [{ word: "delta", displayWord: "Delta", count: 7 }],
        streamIsLive: true,
        computedAt: "2030-01-01T00:00:01.000Z",
      },
      total: { entries: [{ word: "delta", displayWord: "Delta", count: 7 }], computedAt: "2030-01-01T00:00:01.000Z" },
    });

    expect(streamUpdate.stream).toEqual({
      entries: [{ word: "delta", displayWord: "Delta", count: 7 }],
      streamIsLive: true,
      computedAt: "2030-01-01T00:00:01.000Z",
    });
    expect(streamUpdate.total).toEqual({ entries: [{ word: "beta", displayWord: "Beta", count: 9 }], computedAt: later });
    expect(streamUpdate.serverNow).toBe("2030-01-01T00:00:03.000Z");
  });

  it("keeps previous scope values and computedAt timestamps after a hydration failure", () => {
    const current = mergeStatisticsWordRankingRealtimeState(null, rankingState(later, [
      { word: "alpha", displayWord: "Alpha", count: 4 },
    ]));
    const failed = mergeStatisticsWordRankingRealtimeState(current, {
      serverNow: "2030-01-01T00:00:03.000Z",
      refreshAt: "2030-01-01T00:00:33.000Z",
    });

    expect(failed.stream).toEqual(current.stream);
    expect(failed.total).toEqual(current.total);
    expect((failed.stream as { computedAt?: string } | undefined)?.computedAt).toBe(later);
    expect((failed.total as { computedAt?: string } | undefined)?.computedAt).toBe(later);
    expect(failed.refreshAt).toBe("2030-01-01T00:00:33.000Z");
    expect(failed.serverNow).toBe("2030-01-01T00:00:03.000Z");
  });

  it("carries a retry deadline through a valid live message", () => {
    const failed = mergeStatisticsWordRankingRealtimeState(rankingState(earlier, [
      { word: "alpha", displayWord: "Alpha", count: 4 },
    ]), {
      serverNow: later,
      refreshAt: "2030-01-01T00:00:32.000Z",
    });
    const live = mergeStatisticsWordRankingRealtimeState(failed, {
      serverNow: later,
      stream: { entries: [{ word: "beta", displayWord: "Beta", count: 9 }], streamIsLive: true, computedAt: later },
      total: null,
    });

    expect(live.stream).toEqual({
      entries: [{ word: "beta", displayWord: "Beta", count: 9 }],
      streamIsLive: true,
      computedAt: later,
    });
    expect(live.refreshAt).toBe("2030-01-01T00:00:32.000Z");
  });

  it("ignores invalid input without a retry deadline", () => {
    const current = mergeStatisticsWordRankingRealtimeState(null, rankingState(earlier, [
      { word: "alpha", displayWord: "Alpha", count: 4 },
    ]));

    expect(mergeStatisticsWordRankingRealtimeState(current, { serverNow: later, stream: "invalid" })).toEqual(current);
  });

  it("keeps a failure as the state when there is no previous hydration", () => {
    const failure = {
      serverNow: earlier,
      refreshAt: later,
    };

    expect(mergeStatisticsWordRankingRealtimeState(null, failure)).toEqual(failure);
  });
});

describe("statistics word ranking selection", () => {
  it("filters ignored words, fillers, and rare total words while retaining display spelling", () => {
    const baselineCounts = new Map([
      ["largest", { displayWord: "Largest!", count: 90, lastSeenAt: "2030-01-01T00:00:00.000Z" }],
      ["ignored", { displayWord: "Ignored", count: 80, lastSeenAt: "2030-01-01T00:00:00.000Z" }],
      ["lol", { displayWord: "LOL", count: 70, lastSeenAt: "2030-01-01T00:00:00.000Z" }],
      ["rare", { displayWord: "Rare", count: 2, lastSeenAt: "2029-12-01T00:00:00.000Z" }],
      ["visible", { displayWord: "Visible", count: 12, lastSeenAt: "2030-01-01T00:00:00.000Z" }],
    ]);

    expect(selectStatisticsWordRankingEntries({
      baselineCounts,
      streamCounts: new Map(),
      scope: "total",
      hiddenBefore: "2029-12-25T00:00:00.000Z",
      ignoredWords: new Set(["ignored"]),
      limit: 10,
    })).toEqual([
      { word: "largest", displayWord: "Largest!", count: 90 },
      { word: "visible", displayWord: "Visible", count: 12 },
    ]);
  });

  it("keeps only the best requested rows and uses the folded word as its tie break", () => {
    const streamCounts = new Map([
      ["delta", { displayWord: "Delta", count: 5, lastSeenAt: earlier }],
      ["alpha", { displayWord: "Alpha", count: 5, lastSeenAt: earlier }],
      ["beta", { displayWord: "Beta", count: 4, lastSeenAt: earlier }],
    ]);

    expect(selectStatisticsWordRankingEntries({
      baselineCounts: new Map(),
      streamCounts,
      scope: "stream",
      hiddenBefore: earlier,
      ignoredWords: new Set(),
      limit: 2,
    })).toEqual([
      { word: "alpha", displayWord: "Alpha", count: 5 },
      { word: "delta", displayWord: "Delta", count: 5 },
    ]);
  });
});

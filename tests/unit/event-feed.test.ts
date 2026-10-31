import { describe, expect, it, vi } from "vitest";

import type { PanelEventEntry, PanelEventsResponse } from "../../src/panel-contract";
import {
  applyEventChanges,
  eventFeedContinuation,
  eventFeedEntries,
  initialHead,
  isEventChangesResponse,
  refreshEventHead,
  type EventHead,
  type EventHeadRefreshIo,
} from "../../src/dashboard/events/model";

const compareText = (left: string, right: string): number => left.localeCompare(right);

const entry = (eventId: string, createdAt: string): PanelEventEntry => ({
  eventId,
  createdAt,
  moduleId: "raid",
  triggerId: eventId,
  code: "test",
  detail: "{}",
  actorUserId: null,
  actorLogin: null,
  actorDisplayName: null,
});

const page = (entries: PanelEventEntry[], nextCursor: string | null, headCursor?: number): PanelEventsResponse => ({
  entries,
  nextCursor,
  ...(headCursor === undefined ? {} : { headCursor }),
});

const modernHead = (entries: PanelEventEntry[], cursor = "older", headCursor = 10): EventHead =>
  initialHead(page(entries, cursor, headCursor));

describe("event feed head and history union", () => {
  it("deduplicates overlap between the head and history and sorts newest first", () => {
    const head = modernHead([entry("new", "2026-01-03"), entry("shared", "2026-01-02")]);
    const rows = eventFeedEntries(head, [page([entry("shared", "2026-01-02"), entry("old", "2026-01-01")], null)]);

    expect(rows.map((row) => row.eventId)).toEqual(["new", "shared", "old"]);
  });

  it("keeps a late row inside the loaded range in chronological position", () => {
    const head = applyEventChanges(modernHead([entry("new", "2026-01-03"), entry("old", "2026-01-01")]), {
      entries: [entry("late", "2026-01-02")],
      headCursor: 11,
      hasMore: false,
    });

    expect(eventFeedEntries(head, []).map((row) => row.eventId)).toEqual(["new", "late", "old"]);
  });

  it("holds rows below the active frontier until their history page arrives", () => {
    const head = modernHead([entry("new", "2026-01-03"), entry("frontier", "2026-01-02")]);
    const before = eventFeedEntries(head, [page([entry("frontier", "2026-01-02")], "older-2")]);
    const after = eventFeedEntries(head, [
      page([entry("frontier", "2026-01-02")], "older-2"),
      page([entry("below", "2026-01-01")], null),
    ]);

    expect(before.map((row) => row.eventId)).toEqual(["new", "frontier"]);
    expect(after.map((row) => row.eventId)).toEqual(["new", "frontier", "below"]);
  });

  it("starts a new legacy epoch when the history boundary moves before a page commits", async () => {
    const current = initialHead(page([entry("100", "2026-01-03"), entry("51", "2026-01-02")], "cursor-51"));
    const io = {
      fetchHead: vi.fn(() => Promise.resolve(page([entry("101", "2026-01-04"), entry("52", "2026-01-03")], "cursor-52"))),
      fetchChanges: vi.fn(),
      historyHasPages: () => false,
      isFollowing: () => false,
    };
    const refreshed = await refreshEventHead(current, io);

    expect(refreshed.epoch).not.toBe(current.epoch);
    expect(refreshed.nextCursor).toBe("cursor-52");
    expect(io.fetchHead).toHaveBeenCalledOnce();
  });

  it("keeps a legacy epoch while its continuation is unchanged and no history page has committed", async () => {
    const current = initialHead(page([entry("100", "2026-01-03"), entry("51", "2026-01-02")], "cursor-51"));
    const refreshed = await refreshEventHead(current, {
      fetchHead: () => Promise.resolve(page([entry("101", "2026-01-04"), entry("51", "2026-01-02")], "cursor-51")),
      fetchChanges: () => Promise.resolve({ entries: [], headCursor: 0, hasMore: false }),
      historyHasPages: () => false,
      isFollowing: () => false,
    });

    expect(refreshed.epoch).toBe(current.epoch);
    expect(refreshed.entries.map((row) => row.eventId)).toEqual(["101", "51"]);
  });

  it("starts a new legacy epoch when history pages already exist", async () => {
    const current = initialHead(page([entry("100", "2026-01-03"), entry("51", "2026-01-02")], "cursor-51"));
    const refreshed = await refreshEventHead(current, {
      fetchHead: () => Promise.resolve(page([entry("101", "2026-01-04"), entry("51", "2026-01-02")], "cursor-51")),
      fetchChanges: () => Promise.resolve({ entries: [], headCursor: 0, hasMore: false }),
      historyHasPages: () => true,
      isFollowing: () => false,
    });

    expect(refreshed.epoch).not.toBe(current.epoch);
  });

  it("consumes a complete multi-page delta without duplicating rows", async () => {
    const current = modernHead([entry("old", "2026-01-01")], "cursor", 10);
    const io = {
      fetchHead: vi.fn(),
      fetchChanges: vi.fn()
        .mockResolvedValueOnce({ entries: [entry("a", "2026-01-03")], headCursor: 11, hasMore: true })
        .mockResolvedValueOnce({ entries: [entry("b", "2026-01-02")], headCursor: 12, hasMore: true })
        .mockResolvedValueOnce({ entries: [entry("a", "2026-01-03")], headCursor: 13, hasMore: false }),
      historyHasPages: () => false,
      isFollowing: () => false,
    };
    const refreshed = await refreshEventHead(current, io);

    expect(io.fetchChanges).toHaveBeenCalledTimes(3);
    expect(refreshed.headCursor).toBe(13);
    expect(refreshed.entries.map((row) => row.eventId).sort(compareText)).toEqual(["a", "b", "old"]);
  });

  it("resets after five full delta pages", async () => {
    const current = modernHead([entry("old", "2026-01-01")], "cursor", 10);
    const io = {
      fetchHead: vi.fn(() => Promise.resolve(page([entry("fresh", "2026-01-04")], "history", 999))),
      fetchChanges: vi.fn(() => Promise.resolve({ entries: [entry("delta", "2026-01-02")], headCursor: 11, hasMore: true })),
      historyHasPages: () => false,
      isFollowing: () => false,
    };
    const refreshed = await refreshEventHead(current, io);

    expect(io.fetchChanges).toHaveBeenCalledTimes(5);
    expect(io.fetchHead).toHaveBeenCalledOnce();
    expect(refreshed.entries.map((row) => row.eventId)).toEqual(["fresh"]);
    expect(refreshed.epoch).not.toBe(current.epoch);
  });

  it("does not commit earlier burst pages when a later changes request fails", async () => {
    const current = modernHead([entry("old", "2026-01-01")], "cursor", 10);
    const fetchChanges = vi.fn<EventHeadRefreshIo["fetchChanges"]>()
      .mockResolvedValueOnce({ entries: [entry("first-page", "2026-01-03")], headCursor: 11, hasMore: true })
      .mockRejectedValueOnce(new Error("page two failed"));
    const io = { fetchHead: vi.fn(), fetchChanges, historyHasPages: () => true, isFollowing: () => false };

    await expect(refreshEventHead(current, io)).rejects.toThrow("page two failed");
    expect(current.headCursor).toBe(10);
    fetchChanges.mockReset()
      .mockResolvedValueOnce({ entries: [entry("first-page", "2026-01-03")], headCursor: 11, hasMore: true })
      .mockResolvedValueOnce({ entries: [entry("second-page", "2026-01-02")], headCursor: 12, hasMore: false });
    const retried = await refreshEventHead(current, { ...io, fetchChanges });

    expect(fetchChanges.mock.calls.map(([after]) => after)).toEqual([10, 11]);
    expect(retried.entries.map((row) => row.eventId).sort(compareText)).toEqual(["first-page", "old", "second-page"]);
  });

  it("falls back to a new legacy epoch after an invalid modern response", async () => {
    const current = modernHead([entry("old", "2026-01-01")], "cursor", 10);
    const refreshed = await refreshEventHead(current, {
      fetchHead: () => Promise.resolve(page([entry("fresh", "2026-01-03")], null)),
      fetchChanges: () => Promise.resolve(page([entry("old-worker-head", "2026-01-04")], null)),
      historyHasPages: () => false,
      isFollowing: () => false,
    });

    expect(refreshed.headCursor).toBeNull();
    expect(refreshed.entries.map((row) => row.eventId)).toEqual(["fresh"]);
    expect(refreshed.epoch).not.toBe(current.epoch);
  });

  it("starts a fresh epoch after a following head crosses the 1000 row cap", async () => {
    const current = modernHead(Array.from({ length: 1000 }, (_, index) => entry(String(index), `2026-01-${String(index % 28 + 1).padStart(2, "0")}`)), "cursor", 10);
    const io = {
      fetchHead: vi.fn(() => Promise.resolve(page([entry("fresh", "2026-02-01")], "history", 20))),
      fetchChanges: vi.fn(() => Promise.resolve({ entries: [entry("overflow", "2026-02-02")], headCursor: 11, hasMore: false })),
      historyHasPages: () => false,
      isFollowing: () => true,
    };
    const refreshed = await refreshEventHead(current, io);

    expect(io.fetchHead).toHaveBeenCalledOnce();
    expect(refreshed.entries.map((row) => row.eventId)).toEqual(["fresh"]);
    expect(refreshed.epoch).not.toBe(current.epoch);
  });

  it("defers an oversized frozen head until a following refresh", async () => {
    const current = modernHead(Array.from({ length: 1001 }, (_, index) => entry(String(index), `2026-01-${String(index % 28 + 1).padStart(2, "0")}`)), "cursor", 10);
    const io = {
      fetchHead: vi.fn(() => Promise.resolve(page([entry("fresh", "2026-02-01")], "history", 20))),
      fetchChanges: vi.fn(() => Promise.resolve({ entries: [], headCursor: 10, hasMore: false })),
      historyHasPages: () => false,
      isFollowing: () => true,
    };
    const refreshed = await refreshEventHead(current, io);

    expect(io.fetchChanges).not.toHaveBeenCalled();
    expect(io.fetchHead).toHaveBeenCalledOnce();
    expect(refreshed.entries.map((row) => row.eventId)).toEqual(["fresh"]);
  });

  it("leaves an oversized frozen head intact until the reader follows again", async () => {
    const current = modernHead(Array.from({ length: 1001 }, (_, index) => entry(String(index), `2026-01-${String(index % 28 + 1).padStart(2, "0")}`)), "cursor", 10);
    const frozen = await refreshEventHead(current, {
      fetchHead: () => Promise.resolve(page([entry("fresh", "2026-02-01")], "history", 20)),
      fetchChanges: () => Promise.resolve({ entries: [entry("extra", "2026-02-02")], headCursor: 11, hasMore: false }),
      historyHasPages: () => false,
      isFollowing: () => false,
    });
    const resetHead = vi.fn(() => Promise.resolve(page([entry("fresh-head", "2026-02-03")], "history", 30)));
    const following = await refreshEventHead(frozen, {
      fetchHead: resetHead,
      fetchChanges: vi.fn(),
      historyHasPages: () => false,
      isFollowing: () => true,
    });

    expect(frozen.entries).toHaveLength(1002);
    expect(frozen.epoch).toBe(current.epoch);
    expect(resetHead).toHaveBeenCalledOnce();
    expect(following.entries.map((row) => row.eventId)).toEqual(["fresh-head"]);
  });

  it("validates old-worker and malformed change responses", () => {
    expect(isEventChangesResponse(page([], null), 10)).toBe(false);
    expect(isEventChangesResponse({ entries: [], headCursor: 9, hasMore: false }, 10)).toBe(false);
    expect(isEventChangesResponse({ entries: [], headCursor: 10 }, 10)).toBe(false);
    expect(isEventChangesResponse({ entries: [], headCursor: 10, hasMore: false }, 10)).toBe(true);
  });

  it("uses the newest history continuation and the head continuation before pagination starts", () => {
    const head = modernHead([entry("head", "2026-01-03")], "head-cursor");

    expect(eventFeedContinuation(head, [])).toBe("head-cursor");
    expect(eventFeedContinuation(head, [page([], "history-cursor")])).toBe("history-cursor");
  });
});

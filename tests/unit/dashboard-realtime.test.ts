import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseRealtimeMessage } from "../../src/dashboard/realtime";
import { dashboardDataKeys, queryKeys } from "../../src/dashboard/data/keys";
import {
  getDashboardRealtimeStatus,
  invalidateDashboardChannelQueries,
  reconcileDashboardRealtimeMessage,
  reconcileDashboardPanelResourceRevisions,
  setDashboardRealtimeStatus,
} from "../../src/dashboard/data/realtime";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import type { RealtimeMessage } from "../../src/realtime-contract";

const channelId = "channel-a";
const moduleHint = (type: string, payload: Readonly<Record<string, unknown>> = {}): RealtimeMessage => ({
  version: 1,
  id: `hint-${type}`,
  createdAt: "2026-10-09T08:00:00.000Z",
  channelId,
  type,
  payload,
} as unknown as RealtimeMessage);

const addQuery = (queryClient: QueryClient, key: readonly unknown[]): void => {
  queryClient.setQueryData(key, { ready: true });
};

afterEach(() => {
  setDashboardRealtimeStatus(channelId, "offline");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dashboard realtime messages", () => {
  it("ignores legacy module panel hints", () => {
    const result = parseRealtimeMessage(JSON.stringify({
      version: 1,
      id: "module-sample-1",
      createdAt: "2026-10-09T08:00:00.000Z",
      channelId: "channel-a",
      type: "modul.belabox.changed",
      payload: { part: "live" },
    }), "channel-a");

    expect(result.kind).toBe("ignored");

    const secretPayload = parseRealtimeMessage(JSON.stringify({
      version: 1,
      id: "module-sample-secret",
      createdAt: "2026-10-09T08:00:00.000Z",
      channelId: "channel-a",
      type: "modul.belabox.changed",
      payload: { part: "live", statsUrl: "https://secret.invalid", publisherKey: "secret" },
    }), "channel-a");
    expect(secretPayload.kind).not.toBe("message");
  });

  it("bounds sustained module hints and does not refresh module settings", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reads = { events: 0, panel: 0, settings: 0 };
    const queryKeysByPart = {
      events: dashboardDataKeys.events(channelId, { origin: null, module: null, tone: null, person: null }),
      panel: moduleQueryKey(channelId, "chat_voting", "panel"),
      settings: moduleQueryKey(channelId, "chat_voting", "settings"),
    } as const;
    const subscriptions = Object.entries(queryKeysByPart).map(([part, queryKey]) => {
      queryClient.setQueryData(queryKey, { ready: true });
      const observer = new QueryObserver(queryClient, {
        queryKey,
        queryFn: () => {
          reads[part as keyof typeof reads] += 1;
          return Promise.resolve({ ready: true });
        },
        staleTime: Infinity,
      });
      return observer.subscribe(() => undefined);
    });
    const revisions: Record<string, number> = { "channel.events": 0, "module:chat_voting:data": 0 };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));
    await reconcileDashboardPanelResourceRevisions(queryClient, channelId);

    const reconciliations: Promise<void>[] = [];
    for (let index = 0; index < 20; index += 1) {
      revisions["channel.events"] = (revisions["channel.events"] ?? 0) + 1;
      revisions["module:chat_voting:data"] = (revisions["module:chat_voting:data"] ?? 0) + 1;
      reconciliations.push(reconcileDashboardRealtimeMessage(queryClient, moduleHint("event_log.new", {
        entries: [{
          eventId: `event-${String(index)}`,
          createdAt: "2026-10-09T08:00:00.000Z",
          moduleId: "chat_voting",
          code: "chat_voting.vote_recorded",
          actorUserId: null,
        }],
      })));
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all(reconciliations);

    expect(reads.panel).toBeLessThanOrEqual(2);
    expect(reads.events).toBeLessThanOrEqual(2);
    expect(reads.settings).toBe(0);

    subscriptions.forEach((unsubscribe) => { unsubscribe(); });
    queryClient.clear();
  });

  it("refreshes an overlay detail only once when its overlay list also changes", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const overlays = dashboardDataKeys.overlays(channelId);
    const overlay = dashboardDataKeys.overlay(channelId, "overlay-a");
    let listReads = 0;
    let detailReads = 0;
    queryClient.setQueryData(overlays, { overlays: [] });
    queryClient.setQueryData(overlay, { overlay: { revision: 1 } });
    const listObserver = new QueryObserver(queryClient, {
      queryKey: overlays,
      queryFn: () => { listReads += 1; return Promise.resolve({ overlays: [] }); },
      staleTime: Infinity,
    });
    const detailObserver = new QueryObserver(queryClient, {
      queryKey: overlay,
      queryFn: () => { detailReads += 1; return Promise.resolve({ overlay: { revision: 2 } }); },
      staleTime: Infinity,
    });
    const unsubscribeList = listObserver.subscribe(() => undefined);
    const unsubscribeDetail = detailObserver.subscribe(() => undefined);
    let overlayRevision = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions: { "channel.overlays": overlayRevision } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));

    await reconcileDashboardPanelResourceRevisions(queryClient, channelId);
    overlayRevision = 1;
    await reconcileDashboardRealtimeMessage(queryClient, moduleHint("overlay.changed", { overlayId: "overlay-a", revision: 2 }));
    await new Promise((resolve) => { setTimeout(resolve, 320); });

    expect(listReads).toBe(1);
    expect(detailReads).toBe(1);
    unsubscribeList();
    unsubscribeDetail();
    queryClient.clear();
  });

  it("compares exact channel resources on hints and invalidates channel queries on reconnect", async () => {
    const queryClient = new QueryClient();
    const overview = queryKeys.channel(channelId, "overview");
    const system = queryKeys.channel(channelId, "system");
    const channels = queryKeys.channels();
    [overview, system, channels].forEach((key) => { addQuery(queryClient, key); });

    let revisions: Readonly<Record<string, number>> = { "channel.overview": 0, "channel.system": 0, channels: 0 };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));
    await reconcileDashboardPanelResourceRevisions(queryClient, channelId);
    revisions = { "channel.overview": 1, "channel.system": 1, channels: 1 };
    await reconcileDashboardRealtimeMessage(queryClient, moduleHint("stream.state.changed", {
      state: "online", startedAt: "2026-10-09T08:00:00.000Z", changedAt: "2026-10-09T08:00:00.000Z",
    }));
    expect(queryClient.getQueryState(overview)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(system)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(channels)?.isInvalidated).toBe(true);

    [overview, system, channels].forEach((key) => queryClient.setQueryData(key, { ready: true }));
    invalidateDashboardChannelQueries(queryClient, channelId);
    expect(queryClient.getQueryState(overview)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(system)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(channels)?.isInvalidated).toBe(false);
  });

  it("tracks connection state per channel for conditional fallback queries", () => {
    setDashboardRealtimeStatus(channelId, "connected");
    expect(getDashboardRealtimeStatus(channelId)).toBe("connected");
    expect(getDashboardRealtimeStatus("channel-b")).toBe("offline");
  });

  it("refreshes a second client from revisions and repairs a lost hint on focus", async () => {
    const sharedChannel = "revision-two-client";
    const writer = new QueryClient();
    const reader = new QueryClient();
    const writerEvents = queryKeys.channel(sharedChannel, "events", { origin: "twitch" });
    const readerEvents = queryKeys.channel(sharedChannel, "events", { origin: "twitch" });
    const readerAudit = queryKeys.channel(sharedChannel, "audit-log", { person: "user-1" });
    const otherChannelEvents = queryKeys.channel("revision-other-channel", "events");
    [writerEvents].forEach((key) => { addQuery(writer, key); });
    [readerEvents, readerAudit, otherChannelEvents].forEach((key) => { addQuery(reader, key); });
    const vectors = new Map<string, Readonly<Record<string, number>>>([[sharedChannel, {}]]);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "https://brobot.example");
      const requestedChannel = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      return Promise.resolve(new Response(JSON.stringify({ revisions: vectors.get(requestedChannel) ?? {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));

    await Promise.all([
      reconcileDashboardPanelResourceRevisions(writer, sharedChannel),
      reconcileDashboardPanelResourceRevisions(reader, sharedChannel),
    ]);
    vectors.set(sharedChannel, { "channel.events": 1, "channel.audit": 1 });
    const hint: RealtimeMessage = {
      version: 1,
      id: "revision-two-client-hint",
      createdAt: "2026-10-10T08:00:00.000Z",
      channelId: sharedChannel,
      type: "panel.resources.changed",
      payload: {
        resources: ["channel.all"],
        revisions: { "channel.all": 2 },
      },
    };
    const parsedHint = parseRealtimeMessage(JSON.stringify(hint), sharedChannel);
    expect(parsedHint.kind).toBe("message");
    if (parsedHint.kind === "message") await reconcileDashboardRealtimeMessage(reader, parsedHint.message);
    expect(reader.getQueryState(readerEvents)?.isInvalidated).toBe(true);
    expect(reader.getQueryState(readerAudit)?.isInvalidated).toBe(true);
    expect(reader.getQueryState(otherChannelEvents)?.isInvalidated).toBe(false);

    reader.setQueryData(readerEvents, { refreshed: true });
    reader.setQueryData(readerAudit, { refreshed: true });
    vectors.set(sharedChannel, { "channel.events": 2, "channel.audit": 1 });
    await reconcileDashboardPanelResourceRevisions(reader, sharedChannel);
    expect(reader.getQueryState(readerEvents)?.isInvalidated).toBe(true);
    expect(reader.getQueryState(readerAudit)?.isInvalidated).toBe(false);
    writer.clear();
    reader.clear();
  });

  it("rechecks the revision vector when another hint arrives during an in-flight read", async () => {
    vi.useFakeTimers();
    const revisionChannel = "revision-overlap";
    const reader = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const panel = moduleQueryKey(revisionChannel, "chat_voting", "panel");
    let panelReads = 0;
    reader.setQueryData(panel, { revision: 0 });
    const observer = new QueryObserver(reader, {
      queryKey: panel,
      queryFn: () => { panelReads += 1; return Promise.resolve({ revision: panelReads }); },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    let releaseFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    let vector: Readonly<Record<string, number>> = {};
    let revisionReads = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      revisionReads += 1;
      if (revisionReads === 1) return firstResponse;
      return Promise.resolve(new Response(JSON.stringify({ revisions: vector }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));

    const first = reconcileDashboardPanelResourceRevisions(reader, revisionChannel);
    await vi.waitFor(() => { expect(revisionReads).toBe(1); });
    vector = { "module:chat_voting:panel": 1 };
    const second = reconcileDashboardPanelResourceRevisions(reader, revisionChannel);
    releaseFirst?.(new Response(JSON.stringify({ revisions: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);
    expect(revisionReads).toBe(2);
    await vi.waitFor(() => { expect(panelReads).toBe(1); });
    unsubscribe();
    reader.clear();
  });

  it("throttles sequential hints beyond request latency and observes the last committed revision", async () => {
    vi.useFakeTimers();
    const revisionChannel = "revision-sustained-hints";
    const reader = new QueryClient();
    const events = queryKeys.channel(revisionChannel, "events");
    addQuery(reader, events);
    let committedRevision = 0;
    const observedRevisions: number[] = [];
    const requestStarts: number[] = [];
    const fetchRevisions = vi.fn(() => {
      requestStarts.push(Date.now());
      const revision = committedRevision;
      observedRevisions.push(revision);
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(new Response(JSON.stringify({ revisions: { "channel.events": revision } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }, 5);
      });
    });
    vi.stubGlobal("fetch", fetchRevisions);
    const reconciliations: Promise<void>[] = [];
    for (let index = 0; index < 100; index += 1) {
      committedRevision += 1;
      reconciliations.push(reconcileDashboardPanelResourceRevisions(reader, revisionChannel));
      // Each hint arrives after the endpoint would have answered its predecessor.
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(fetchRevisions).toHaveBeenCalledTimes(5);
    expect(requestStarts.slice(1).every((startedAt, index) =>
      startedAt - (requestStarts[index] ?? 0) >= 250)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(reconciliations);
    expect(observedRevisions[0]).toBe(1);
    expect(observedRevisions.at(-1)).toBe(100);
    expect(reader.getQueryState(events)?.isInvalidated).toBe(true);

    // A new burst in the next window keeps exactly one trailing read after it ends.
    committedRevision = 101;
    const next = reconcileDashboardPanelResourceRevisions(reader, revisionChannel);
    committedRevision = 102;
    const trailing = reconcileDashboardPanelResourceRevisions(reader, revisionChannel);
    await vi.advanceTimersByTimeAsync(240);
    expect(fetchRevisions).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(5);
    await Promise.all([next, trailing]);
    expect(observedRevisions.at(-1)).toBe(102);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchRevisions).toHaveBeenCalledTimes(6);
    reader.clear();
  });

  it("refreshes overlapping resource mappings once per query", async () => {
    const revisionChannel = "revision-overlapping-resources";
    const reader = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const affectedKeys = [
      queryKeys.channel(revisionChannel, "overview"),
      dashboardDataKeys.overlays(revisionChannel),
      moduleQueryKey(revisionChannel, "text_library", "library"),
    ] as const;
    const refetches = affectedKeys.map(() => 0);
    const unsubscribers = affectedKeys.map((queryKey, index) => {
      reader.setQueryData(queryKey, { ready: true });
      return new QueryObserver(reader, {
        queryKey,
        queryFn: () => {
          refetches[index] = (refetches[index] ?? 0) + 1;
          return Promise.resolve({ ready: true });
        },
        staleTime: Infinity,
      }).subscribe(() => undefined);
    });
    let vector: Readonly<Record<string, number>> = {};
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions: vector }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));

    await reconcileDashboardPanelResourceRevisions(reader, revisionChannel);
    vector = {
      "channel.overview": 1,
      "channel.modules": 1,
      "channel.overlays": 1,
      "channel.overlay-accesses": 1,
      "channel.library": 1,
    };
    await reconcileDashboardPanelResourceRevisions(reader, revisionChannel);
    await vi.waitFor(() => { expect(refetches).toEqual([1, 1, 1]); });
    await new Promise((resolve) => { setTimeout(resolve, 1_100); });
    expect(refetches).toEqual([1, 1, 1]);

    unsubscribers.forEach((unsubscribe) => { unsubscribe(); });
    reader.clear();
  });

  it.each([
    ["channel.overview", "overview"],
    ["channel.system", "system"],
    ["channel.settings", "settings"],
    ["channel.members", "members"],
    ["channel.modules", "modules"],
    ["channel.events", "events"],
    ["channel.audit", "audit-log"],
    ["channel.variables", "variables"],
    ["channel.overlays", "overlays"],
    ["channel.overlay-accesses", "overlay-access-list"],
    ["channel.library", "library-catalog"],
    ["module:chat_voting:panel", "chat-voting"],
    ["module:votekick:panel", "votekick"],
    ["module:belabox:live", "belabox"],
    ["module:chat_voting:data", "module-data"],
    ["module:ads:schedule", "ads"],
    ["channels", "channel-list"],
  ] as const)("maps revision %s to its query area", async (resource, area) => {
    const revisionChannel = `revision-${area}`;
    const writer = new QueryClient();
    const reader = new QueryClient();
    const affectedKeys: Record<typeof area, readonly (readonly unknown[])[]> = {
      overview: [queryKeys.channel(revisionChannel, "overview")],
      system: [dashboardDataKeys.system(revisionChannel)],
      settings: [queryKeys.channel(revisionChannel, "settings")],
      members: [dashboardDataKeys.members(revisionChannel)],
      modules: [queryKeys.channel(revisionChannel, "modules"), queryKeys.channel(revisionChannel, "overview")],
      events: [queryKeys.channel(revisionChannel, "events", { module: "chat_voting" })],
      "audit-log": [dashboardDataKeys.audit(revisionChannel, { person: "user-1", area: null })],
      variables: [
        dashboardDataKeys.variables(revisionChannel),
        moduleQueryKey(revisionChannel, "text_commands", "commands"),
        moduleQueryKey(revisionChannel, "chat_voting", "settings"),
      ],
      overlays: [dashboardDataKeys.overlays(revisionChannel), dashboardDataKeys.overlay(revisionChannel, "overlay-a")],
      "overlay-access-list": [
        dashboardDataKeys.overlays(revisionChannel),
        dashboardDataKeys.overlayAccesses(revisionChannel, "overlay-a"),
        dashboardDataKeys.legacyOverlayTokens(revisionChannel),
      ],
      "library-catalog": [
        moduleQueryKey(revisionChannel, "text_library", "library"),
        moduleQueryKey(revisionChannel, "timers", "panel"),
        moduleQueryKey(revisionChannel, "faq", "panel"),
        moduleQueryKey(revisionChannel, "text_commands", "template-variables"),
      ],
      "chat-voting": [moduleQueryKey(revisionChannel, "chat_voting", "panel")],
      votekick: [moduleQueryKey(revisionChannel, "votekick", "panel")],
      belabox: [moduleQueryKey(revisionChannel, "belabox", "streams")],
      "module-data": [moduleQueryKey(revisionChannel, "chat_voting", "panel")],
      ads: [moduleQueryKey(revisionChannel, "ads", "schedule")],
      "channel-list": [queryKeys.channels()],
    };
    const affected = affectedKeys[area];
    const unrelated = queryKeys.channel(`other-${revisionChannel}`, "unrelated");
    affected.forEach((key) => { addQuery(writer, key); addQuery(reader, key); });
    addQuery(writer, unrelated);
    addQuery(reader, unrelated);
    const readerRefetches = affected.map(() => 0);
    const observers = affected.map((queryKey, index) => new QueryObserver(reader, {
      queryKey,
      queryFn: () => {
        readerRefetches[index] = (readerRefetches[index] ?? 0) + 1;
        return Promise.resolve({ ready: true });
      },
      staleTime: Infinity,
    }));
    const unsubscribers = observers.map((observer) => observer.subscribe(() => undefined));
    const vectors = new Map<string, Readonly<Record<string, number>>>([[revisionChannel, {}]]);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions: vectors.get(revisionChannel) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));

    await Promise.all([
      reconcileDashboardPanelResourceRevisions(writer, revisionChannel),
      reconcileDashboardPanelResourceRevisions(reader, revisionChannel),
    ]);
    vectors.set(revisionChannel, { [resource]: 1 });
    await reconcileDashboardPanelResourceRevisions(reader, revisionChannel);
    await vi.waitFor(() => { expect(readerRefetches).toEqual(Array.from({ length: affected.length }, () => 1)); });

    expect(writer.getQueryState(affected[0] ?? [])?.isInvalidated).toBe(false);
    expect(reader.getQueryState(unrelated)?.isInvalidated).toBe(false);
    unsubscribers.forEach((unsubscribe) => { unsubscribe(); });
    writer.clear();
    reader.clear();
  });
});

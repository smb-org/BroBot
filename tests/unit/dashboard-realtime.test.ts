import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { parseRealtimeMessage } from "../../src/dashboard/realtime";
import { dashboardDataKeys, queryKeys } from "../../src/dashboard/data/keys";
import {
  getDashboardRealtimeStatus,
  invalidateDashboardChannelQueries,
  invalidateDashboardRealtimeMessage,
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
});

describe("dashboard realtime messages", () => {
  it("accepts module state hints for panel query invalidation", () => {
    const result = parseRealtimeMessage(JSON.stringify({
      version: 1,
      id: "module-sample-1",
      createdAt: "2026-10-09T08:00:00.000Z",
      channelId: "channel-a",
      type: "modul.belabox.sample",
      payload: { at: "2026-10-09T08:00:00.000Z", connected: true },
    }), "channel-a");

    expect(result.kind).toBe("message");
    if (result.kind === "message") expect(result.message.type).toBe("modul.belabox.sample");
  });

  it("invalidates event and originating module queries for event hints", () => {
    const queryClient = new QueryClient();
    const events = dashboardDataKeys.events(channelId, { origin: null, module: null, tone: null, person: null });
    const chatVoting = moduleQueryKey(channelId, "chat_voting", "panel");
    const belabox = moduleQueryKey(channelId, "belabox", "status");
    const unrelated = moduleQueryKey(channelId, "ads", "schedule");
    [events, chatVoting, belabox, unrelated].forEach((key) => { addQuery(queryClient, key); });

    invalidateDashboardRealtimeMessage(queryClient, moduleHint("event_log.new", {
      entries: [
        { eventId: "event-1", createdAt: "2026-10-09T08:00:00.000Z", moduleId: "chat_voting", code: "chat_voting.started", actorUserId: null },
        { eventId: "event-2", createdAt: "2026-10-09T08:00:00.000Z", moduleId: "belabox", code: "belabox.sample", actorUserId: null },
      ],
    }));

    expect(queryClient.getQueryState(events)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(chatVoting)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(belabox)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });

  it("maps variables, overlays, ad schedules, and module hints to their channel data keys", () => {
    const queryClient = new QueryClient();
    const variables = dashboardDataKeys.variables(channelId);
    const overlays = dashboardDataKeys.overlays(channelId);
    const overlay = dashboardDataKeys.overlay(channelId, "overlay-a");
    const textCommands = moduleQueryKey(channelId, "text_commands", "template-variables");
    const ads = moduleQueryKey(channelId, "ads", "schedule");
    const belabox = moduleQueryKey(channelId, "belabox", "status");
    [variables, overlays, overlay, textCommands, ads, belabox].forEach((key) => { addQuery(queryClient, key); });

    invalidateDashboardRealtimeMessage(queryClient, moduleHint("variables.changed", { set: [{ name: "score", value: 1 }], removed: [] }));
    expect(queryClient.getQueryState(variables)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(overlays)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(overlay)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(textCommands)?.isInvalidated).toBe(true);
    queryClient.setQueryData(belabox, { ready: true });

    invalidateDashboardRealtimeMessage(queryClient, moduleHint("overlay.changed", { overlayId: "overlay-a", revision: 2 }));
    expect(queryClient.getQueryState(overlays)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(overlay)?.isInvalidated).toBe(true);

    invalidateDashboardRealtimeMessage(queryClient, moduleHint("ads.schedule.updated", { asOf: "2026-10-09T08:00:00.000Z" }));
    expect(queryClient.getQueryState(ads)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(belabox)?.isInvalidated).toBe(false);

    invalidateDashboardRealtimeMessage(queryClient, moduleHint("modul.belabox.sample", { at: "2026-10-09T08:00:00.000Z" }));
    expect(queryClient.getQueryState(belabox)?.isInvalidated).toBe(true);
  });

  it("invalidates the right module cache for each panel live-state hint", () => {
    const hints = [
      ["chat_voting", "modul.chat_voting.opened"],
      ["chat_voting", "modul.chat_voting.tally"],
      ["belabox", "modul.belabox.state_changed"],
      ["belabox", "modul.belabox.sample"],
      ["votekick", "modul.votekick.opened"],
      ["votekick", "modul.votekick.tally"],
    ] as const;

    for (const [moduleId, type] of hints) {
      const queryClient = new QueryClient();
      const relevant = moduleQueryKey(channelId, moduleId, "panel");
      const unrelated = moduleQueryKey(channelId, "ads", "schedule");
      [relevant, unrelated].forEach((key) => { addQuery(queryClient, key); });

      const parsed = parseRealtimeMessage(JSON.stringify({
        version: 1,
        id: `hint-${type}`,
        createdAt: "2026-10-09T08:00:00.000Z",
        channelId,
        type,
        payload: {},
      }), channelId);
      expect(parsed.kind).toBe("message");
      if (parsed.kind === "message") invalidateDashboardRealtimeMessage(queryClient, parsed.message);

      expect(queryClient.getQueryState(relevant)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
    }
  });

  it("refreshes chat voting when a shared votekick ballot opens or closes", () => {
    const hints = [
      { type: "modul.votekick.opened", payload: { votekickId: "kick-a" }, refreshChatVoting: true },
      { type: "modul.votekick.tally", payload: { status: "running" }, refreshChatVoting: false },
      { type: "modul.votekick.tally", payload: { status: "cancelled" }, refreshChatVoting: true },
    ] as const;

    for (const hint of hints) {
      const queryClient = new QueryClient();
      const chatVoting = moduleQueryKey(channelId, "chat_voting", "panel");
      const votekick = moduleQueryKey(channelId, "votekick", "panel");
      [chatVoting, votekick].forEach((key) => { addQuery(queryClient, key); });

      invalidateDashboardRealtimeMessage(queryClient, moduleHint(hint.type, hint.payload));

      expect(queryClient.getQueryState(votekick)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(chatVoting)?.isInvalidated).toBe(hint.refreshChatVoting);
    }
  });

  it("invalidates channel queries on stream changes and reconnect", () => {
    const queryClient = new QueryClient();
    const overview = queryKeys.channel(channelId, "overview");
    const system = queryKeys.channel(channelId, "system");
    const channels = queryKeys.channels();
    [overview, system, channels].forEach((key) => { addQuery(queryClient, key); });

    invalidateDashboardRealtimeMessage(queryClient, moduleHint("stream.state.changed", {
      state: "online", startedAt: "2026-10-09T08:00:00.000Z", changedAt: "2026-10-09T08:00:00.000Z",
    }));
    expect(queryClient.getQueryState(overview)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(system)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(channels)?.isInvalidated).toBe(true);

    [overview, system, channels].forEach((key) => queryClient.setQueryData(key, { ready: true }));
    invalidateDashboardChannelQueries(queryClient, channelId);
    expect(queryClient.getQueryState(overview)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(system)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(channels)?.isInvalidated).toBe(true);
  });

  it("tracks connection state per channel for conditional fallback queries", () => {
    setDashboardRealtimeStatus(channelId, "connected");
    expect(getDashboardRealtimeStatus(channelId)).toBe("connected");
    expect(getDashboardRealtimeStatus("channel-b")).toBe("offline");
  });
});

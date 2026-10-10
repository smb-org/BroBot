import { describe, expect, it, vi } from "vitest";

import {
  publishStreamStateChanged,
  revokeRealtimeSessionForUser,
  revokeRealtimeUser,
  revokeRealtimeUserFromAllChannels,
} from "../../src/worker/realtime";

describe("realtime stream state publication", () => {
  it("publishes the panel update when overlay recipient selection fails", async () => {
    const published: unknown[][] = [];
    const namespace = {
      idFromName: (channelId: string) => channelId,
      get: () => ({ publish: (messages: readonly unknown[]) => {
        published.push([...messages]);
        return Promise.resolve();
      } }),
    } as unknown as Env["CHANNEL"];
    const database = {
      prepare: (sql: string) => ({
        bind: () => sql.includes("FROM channel_controls AS controls")
          ? { first: () => Promise.resolve(null) }
          : { all: () => Promise.reject(new Error("overlay recipient query failed")) },
      }),
    } as unknown as D1Database;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await publishStreamStateChanged(
      namespace,
      database,
      "channel-a",
      "online",
      "2026-09-27T12:00:00.000Z",
      "2026-09-27T12:00:00.000Z",
      "2026-09-27T12:00:00.000Z",
    );

    expect(published.flat()).toMatchObject([{
      type: "stream.state.changed",
      channelId: "channel-a",
      payload: { state: "online", startedAt: "2026-09-27T12:00:00.000Z" },
    }]);
    warn.mockRestore();
  });

  it("propagates a failed member socket revocation after the membership commit", async () => {
    const revokeUser = vi.fn(() => Promise.reject(new Error("channel unavailable")));
    const namespace = {
      idFromName: (channelId: string) => channelId,
      get: () => ({ revokeUser }),
    } as unknown as Env["CHANNEL"];

    await expect(revokeRealtimeUser(namespace, "channel-a", "user-1"))
      .rejects.toThrow("channel unavailable");
    expect(revokeUser).toHaveBeenCalledWith("user-1");
  });

  it("waits for cross-channel logout closures before propagating a failure", async () => {
    let releaseSecond: (() => void) | undefined;
    const completedChannels: string[] = [];
    const database = {
      prepare: () => ({
        bind: () => ({ all: () => Promise.resolve({ results: [{ channel_id: "channel-a" }, { channel_id: "channel-b" }] }) }),
      }),
    } as unknown as D1Database;
    const namespace = {
      idFromName: (channelId: string) => channelId,
      get: (channelId: string) => ({
        revokeSession: () => channelId === "channel-a"
          ? Promise.reject(new Error("channel-a unavailable"))
          : new Promise<void>((resolve) => { releaseSecond = () => { completedChannels.push(channelId); resolve(); }; }),
      }),
    } as unknown as Env["CHANNEL"];

    const revocation = revokeRealtimeSessionForUser(database, namespace, "user-1", "session-1");
    await vi.waitFor(() => { expect(releaseSecond).toBeDefined(); });
    let settled = false;
    void revocation.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseSecond?.();
    await expect(revocation).rejects.toThrow("channel-a unavailable");
    expect(completedChannels).toEqual(["channel-b"]);
  });

  it("propagates invalid-grant socket revocation failures", async () => {
    const database = {
      prepare: () => ({
        bind: () => ({ all: () => Promise.resolve({ results: [{ channel_id: "channel-a" }] }) }),
      }),
    } as unknown as D1Database;
    const namespace = {
      idFromName: (channelId: string) => channelId,
      get: () => ({ revokeUser: () => Promise.reject(new Error("invalid-grant close failed")) }),
    } as unknown as Env["CHANNEL"];

    await expect(revokeRealtimeUserFromAllChannels(database, namespace, "user-1"))
      .rejects.toThrow("invalid-grant close failed");
  });

  it("propagates database failures while finding sockets to revoke", async () => {
    const database = {
      prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("membership query failed")) }) }),
    } as unknown as D1Database;
    const namespace = {
      idFromName: (channelId: string) => channelId,
      get: () => ({ revokeUser: vi.fn() }),
    } as unknown as Env["CHANNEL"];

    await expect(revokeRealtimeUserFromAllChannels(database, namespace, "user-1"))
      .rejects.toThrow("membership query failed");
  });
});

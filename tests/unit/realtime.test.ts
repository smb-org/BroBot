import { describe, expect, it, vi } from "vitest";

import { publishStreamStateChanged } from "../../src/worker/realtime";

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
});

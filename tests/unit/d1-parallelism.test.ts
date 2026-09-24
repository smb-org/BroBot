import { describe, expect, it } from "vitest";

import { getChannelOverviewForUser, getSystemOverviewForUser } from "../../src/worker/panel/repository";
import { getPanelModuleDataForChannels } from "../../src/worker/panel/module-repository";
import { referencesFor } from "../../src/worker/panel/variable-routes";

const tracingDatabase = (): { db: D1Database; calls: string[] } => {
  const calls: string[] = [];
  const db = {
    prepare: (sql: string) => {
      const statement = {
        bind: () => statement,
        first: () => {
          calls.push(sql);
          return Promise.resolve(null);
        },
        all: () => {
          calls.push(sql);
          return Promise.resolve({ results: [], success: true as const, meta: { changes: 0, size: 0 } });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
};

describe("independent dashboard D1 reads", () => {
  it("starts overview state and module reads before awaiting either", async () => {
    const { db, calls } = tracingDatabase();
    const pending = getChannelOverviewForUser(db, "viewer-1", "kanal-a");

    expect(calls).toHaveLength(3);
    expect(calls.some((sql) => sql.includes("FROM channels AS channel"))).toBe(true);
    expect(calls.some((sql) => sql.includes("FROM channel_modules"))).toBe(true);
    expect(calls.some((sql) => sql.includes("FROM twitch_login_identity"))).toBe(true);
    await pending;
  });

  it("starts system state and subscription reads before awaiting either", async () => {
    const { db, calls } = tracingDatabase();
    const pending = getSystemOverviewForUser(db, "viewer-1", "kanal-a");

    expect(calls).toHaveLength(2);
    expect(calls.some((sql) => sql.includes("FROM channels AS channel"))).toBe(true);
    expect(calls.some((sql) => sql.includes("FROM eventsub_subscriptions"))).toBe(true);
    await pending;
  });

  it("reads broadcaster identity once for a channel batch and fans out module states", async () => {
    const { db, calls } = tracingDatabase();
    const pending = getPanelModuleDataForChannels(db, ["kanal-a", "kanal-b"]);

    expect(calls).toHaveLength(2);
    expect(calls.filter((sql) => sql.includes("FROM twitch_login_identity"))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes("FROM channel_modules"))).toHaveLength(1);
    await pending;
  });

  it("starts all module and overlay variable-reference queries before awaiting results", async () => {
    const { db, calls } = tracingDatabase();
    const pending = referencesFor(db, "kanal-a", "score");

    expect(calls).toHaveLength(4); // three module queries plus the overlay usage query
    await pending;
  });
});

import { describe, expect, it, vi } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { dryRunChatMessage } from "../../src/worker/dry-run";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "dry-run-coverage-channel";

describe("dry-run chat module coverage", () => {
  it("reports every registered chat reader as testable or silent", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      const response = await dryRunChatMessage(
        { DB: database as unknown as D1Database } as unknown as Env,
        CHANNEL_ID,
        {
          text: "hello there",
          sender: { login: "viewer_42", statuses: [] },
          streamState: "online",
          game: null,
          sharedChat: false,
        },
        vi.fn<typeof fetch>(),
        MODULES,
      );
      const chatModules = MODULES.filter((module) => module.eventSubTypes?.includes("channel.chat.message"));

      expect(response.modules.map(({ moduleId }) => moduleId)).toEqual(chatModules.map(({ id }) => id));
      expect(response.modules.every(({ status }) => status !== "not_testable")).toBe(true);
      expect(response.modules.find(({ moduleId }) => moduleId === "timers")).toMatchObject({
        status: "silent",
        reasonCode: "activity_tracking",
        entries: [],
      });
    } finally {
      database.close();
    }
  });
});

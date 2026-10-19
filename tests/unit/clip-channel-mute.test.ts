import { afterEach, describe, expect, it, vi } from "vitest";

import { readBotCredentials } from "../../src/worker/auth/bot-credentials";
import { sendChatMessage } from "../../src/worker/chat";
import { writeModuleAudit } from "../../src/worker/module-audit";
import { helixRequest } from "../../src/worker/twitch/helix";
import { createAndPostConfiguredClipLink } from "../../src/worker/clip";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

vi.mock("../../src/worker/auth/bot-credentials", () => ({ readBotCredentials: vi.fn() }));
vi.mock("../../src/worker/chat", () => ({ sendChatMessage: vi.fn() }));
vi.mock("../../src/worker/module-audit", () => ({ writeModuleAudit: vi.fn() }));
vi.mock("../../src/worker/twitch/helix", () => ({ helixRequest: vi.fn() }));

describe("clip chat channel controls", () => {
  afterEach(() => vi.clearAllMocks());

  it("keeps a confirmed clip but suppresses its chat message when the channel is muted", async () => {
    const database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await database.prepare(
      "INSERT INTO channel_controls (channel_id, muted, updated_at) VALUES (?, 0, ?)",
    ).bind("channel-a", new Date().toISOString()).run();

    vi.mocked(readBotCredentials).mockResolvedValue({ userId: "bot-a", accessToken: "bot-token" });
    vi.mocked(helixRequest)
      .mockResolvedValueOnce({ ok: true, status: 202, data: { data: [{ id: "clip-a" }] } })
      .mockImplementationOnce(async () => {
        await database.prepare("UPDATE channel_controls SET muted = 1, updated_at = ? WHERE channel_id = ?")
          .bind(new Date().toISOString(), "channel-a").run();
        return { ok: true, status: 200, data: { data: [{ id: "clip-a", title: "A moment" }] } };
      });
    vi.mocked(writeModuleAudit).mockResolvedValue(undefined);
    vi.mocked(sendChatMessage).mockImplementation(async (...args) => {
      const stillValid = args[5];
      const allowed = stillValid === undefined ? true : await stillValid();
      return {
        sent: allowed,
        truncated: false,
        delivery: allowed ? "sent" : "not_attempted",
        reason: allowed ? null : "stale_before_send",
        detail: {},
      };
    });

    const result = await createAndPostConfiguredClipLink(
      {
        DB: database as unknown as D1Database,
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
      },
      "channel-a",
      "viewer-a",
      { postClipLinkInChat: true, chatLinkTemplate: "New clip: {clip.title} {clip.url}" },
    );

    expect(result.clip.created).toBe(true);
    expect(sendChatMessage).toHaveBeenCalledOnce();
    expect(result.diagnostics).toContainEqual({
      code: "host.action.suppressed",
      detail: { action: "chat", reason: "channel_muted" },
    });
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "host.chat.sent" }));
    database.close();
  });
});

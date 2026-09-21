import { describe, expect, it } from "vitest";

import { kanalereignisseModul } from "../../src/modules/kanalereignisse";
import type { ModuleEvent } from "../../src/modules/contract";

const event = (subscriptionType: string, payload: Record<string, unknown>, subscriptionVariant?: string): ModuleEvent<Record<string, never>> => ({
  channelId: "kanal-a",
  subscriptionType,
  ...(subscriptionVariant === undefined ? {} : { subscriptionVariant }),
  triggerId: "trigger-1",
  payload,
  settings: {},
  receivedAt: "2026-09-20T10:00:00.000Z",
  actor: null,
  chatStatus: null,
});

describe("Kanalereignisse-Modul", () => {
  it("gibt für alle Ereignisarten niemals Aktionen zurück", async () => {
    const events = [
      event("channel.raid", { viewers: 4 }, "eingehend"),
      event("channel.raid", { viewers: 4 }, "ausgehend"),
      event("channel.shoutout.create", {}),
      event("channel.shoutout.receive", {}),
      event("channel.chat.notification", { notice_type: "sub" }),
      event("channel.chat.notification", { notice_type: "resub" }),
      event("channel.chat.notification", { notice_type: "sub_gift" }),
      event("channel.chat.notification", { notice_type: "community_sub_gift" }),
      event("channel.chat.notification", { notice_type: "announcement" }),
      event("channel.chat.notification", { notice_type: "unbekannt" }),
      event("channel.moderate", { action: "ban", ban: { user_name: "person" } }),
      event("channel.moderate", { action: "timeout", timeout: { user_name: "person", ends_at: "2026-09-20T10:05:00.000Z" } }),
      event("channel.moderate", { action: "untimeout", untimeout: { user_name: "person" } }),
      event("channel.moderate", { action: "unban", unban: { user_name: "person" } }),
      event("channel.moderate", { action: "delete", delete: { user_name: "person", message_body: "text" } }),
      event("channel.moderate", { action: "warn", warn: { user_name: "person" } }),
      event("channel.moderate", { action: "shared_chat_ban" }),
      event("automod.message.hold", { user_name: "person", category: "aggressive", message: { text: "text" } }),
      event("channel.suspicious_user.message", { user_name: "person", low_trust_status: "restricted", message: { text: "text" } }),
      event("channel.suspicious_user.update", { user_name: "person", low_trust_status: "restricted" }),
    ];

    for (const moduleEvent of events) {
      const result = await kanalereignisseModul.handleEvent?.(moduleEvent, {} as never);
      expect(result?.actions).toHaveLength(0);
    }
  });
});

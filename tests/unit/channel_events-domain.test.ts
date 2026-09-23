import { describe, expect, it } from "vitest";

import type { EventSubSubscriptionType } from "../../src/contracts/values";
import { diagnoseChannelEvent } from "../../src/modules/channel_events/domain";

const diagnose = (
  subscriptionType: EventSubSubscriptionType,
  payload: Record<string, unknown>,
  variant?: string,
  receivedAt?: string,
) => diagnoseChannelEvent(subscriptionType, payload, "kanal-a", variant, receivedAt);

describe("channel events domain", () => {
  it("maps incoming and outgoing raids with source/target and viewers", () => {
    expect(diagnose("channel.raid", {
      from_broadcaster_user_name: "Quelle Name",
      from_broadcaster_user_login: "quelle_login",
      viewers: 42,
    }, "incoming")).toEqual([{
      code: "channel_events.raid.incoming",
      detail: { source: "Quelle Name (@quelle_login)", viewers: 42 },
    }]);
    expect(diagnose("channel.raid", {
      to_broadcaster_user_name: "Ziel Name",
      to_broadcaster_user_login: "ziel_login",
      viewers: 17,
    }, "outgoing")).toEqual([{
      code: "channel_events.raid.outgoing",
      detail: { target: "Ziel Name (@ziel_login)", viewers: 17 },
    }]);
  });

  it("maps sent and received shoutouts", () => {
    expect(diagnose("channel.shoutout.create", {
      to_broadcaster_user_name: "Ziel",
      to_broadcaster_user_login: "ziel",
    })).toEqual([{
      code: "channel_events.shoutout.sent",
      detail: { target: "Ziel (@ziel)" },
    }]);
    expect(diagnose("channel.shoutout.receive", {
      from_broadcaster_user_name: "Quelle",
      from_broadcaster_user_login: "quelle",
      viewer_count: 12,
    })).toEqual([{
      code: "channel_events.shoutout.received",
      detail: { source: "Quelle (@quelle)", viewers: 12 },
    }]);
  });

  it("diagnoses stream start and end with a start timestamp", () => {
    expect(diagnose("stream.online", { started_at: "2026-09-19T12:00:00.000Z" })).toEqual([{
      code: "channel_events.stream.online",
      detail: { startedAt: "2026-09-19T12:00:00.000Z" },
    }]);
    expect(diagnose("stream.offline", {})).toEqual([{ code: "channel_events.stream.offline" }]);
  });

  it.each([
    ["sub", "channel_events.chat.sub"],
    ["resub", "channel_events.chat.resub"],
  ])("maps %s with the person involved", (noticeType, code) => {
    expect(diagnose("channel.chat.notification", {
      notice_type: noticeType,
      chatter_user_name: "Alice",
      chatter_user_login: "alice",
      [noticeType]: { sub_tier: "1000" },
    })).toEqual([{
      code,
      detail: { person: "Alice (@alice)", tier: "1000" },
    }]);
  });

  it("maps gift sub, community gift, and announcement with participants", () => {
    expect(diagnose("channel.chat.notification", {
      notice_type: "sub_gift",
      gifter_user_name: "Giftperson",
      recipient_user_name: "Empfänger",
      sub_gift: { sub_tier: "1000" },
    })[0]).toEqual({
      code: "channel_events.chat.gift_sub",
      detail: { gifter: "Giftperson", recipient: "Empfänger", tier: "1000" },
    });
    expect(diagnose("channel.chat.notification", {
      notice_type: "community_sub_gift",
      gifter_user_name: "Giftperson",
      community_sub_gift: { total: 5, sub_tier: "prime" },
    })[0]).toEqual({
      code: "channel_events.chat.community_gift",
      detail: { gifter: "Giftperson", count: 5, tier: "prime" },
    });
    expect(diagnose("channel.chat.notification", {
      notice_type: "announcement",
      chatter_user_name: "Mod",
      message: { text: "Wichtige Ansage" },
    })[0]).toEqual({
      code: "channel_events.chat.announcement",
      detail: { person: "Mod", text: "Wichtige Ansage" },
    });
  });

  it("reports an unknown notice_type exactly once and truncates foreign text", () => {
    const noticeType = "x".repeat(240);
    expect(diagnose("channel.chat.notification", { notice_type: noticeType })).toEqual([{
      code: "channel_events.chat.unknown",
      detail: { art: `${"x".repeat(199)}…` },
    }]);
  });

  it.each([
    ["ban", "channel_events.moderation.ban"],
    ["warn", "channel_events.moderation.warn"],
  ])("maps %s with the affected and acting person plus a reason", (action, code) => {
    expect(diagnose("channel.moderate", {
      action,
      moderator_user_name: "Moderation",
      moderator_user_login: "mod",
      [action]: {
        user_name: "Betroffene Person",
        user_login: "betroffen",
        reason: "Regelverstoß",
      },
    })).toEqual([{
      code,
      detail: {
        person: "Betroffene Person (@betroffen)",
        moderator: "Moderation (@mod)",
        reason: "Regelverstoß",
      },
    }]);
  });

  it("computes the timeout duration from the event time and ends_at", () => {
    expect(diagnose("channel.moderate", {
      action: "timeout",
      moderator_user_name: "Moderation",
      timeout: {
        user_name: "Betroffene Person",
        ends_at: "2026-09-20T10:05:00.000Z",
        reason: "Zu viele Nachrichten",
      },
    }, undefined, "2026-09-20T10:00:00.000Z")).toEqual([{
      code: "channel_events.moderation.timeout",
      detail: {
        person: "Betroffene Person",
        moderator: "Moderation",
        reason: "Zu viele Nachrichten",
        endsAt: "2026-09-20T10:05:00.000Z",
        duration: 300,
      },
    }]);
  });

  it("doesn't report a ban with ends_at as a timeout", () => {
    expect(diagnose("channel.moderate", {
      action: "ban",
      ban: { user_name: "Betroffene Person", ends_at: "2026-09-20T10:05:00.000Z" },
    }, undefined, "2026-09-20T10:00:00.000Z")[0]?.code).toBe("channel_events.moderation.ban");
  });

  it.each([
    ["untimeout", "channel_events.moderation.untimeout"],
    ["unban", "channel_events.moderation.unban"],
  ])("maps %s without a reason as a reversal", (action, code) => {
    expect(diagnose("channel.moderate", {
      action,
      moderator_user_name: "Moderation",
      [action]: { user_name: "Betroffene Person" },
    })).toEqual([{
      code,
      detail: { person: "Betroffene Person", moderator: "Moderation" },
    }]);
  });

  it("maps the deleted message and truncates foreign text", () => {
    expect(diagnose("channel.moderate", {
      action: "delete",
      moderator_user_name: "Moderation",
      delete: {
        user_name: "Betroffene Person",
        message_body: "x".repeat(240),
      },
    })).toEqual([{
      code: "channel_events.moderation.delete",
      detail: {
        person: "Betroffene Person",
        moderator: "Moderation",
        text: `${"x".repeat(199)}…`,
      },
    }]);
  });

  it("reports shared_chat_ban as exactly one unknown moderation action", () => {
    expect(diagnose("channel.moderate", { action: "shared_chat_ban" })).toEqual([{
      code: "channel_events.moderation.unknown",
      detail: { action: "shared_chat_ban" },
    }]);
  });

  it("maps an AutoMod hold with person, category, and message", () => {
    expect(diagnose("automod.message.hold", {
      user_name: "TwitchDev",
      user_login: "twitchdev",
      category: "aggressive",
      message: { text: "Das ist eine zurückgehaltene Nachricht." },
    })).toEqual([{
      code: "channel_events.automod.held",
      detail: {
        person: "TwitchDev (@twitchdev)",
        reason: "aggressive",
        text: "Das ist eine zurückgehaltene Nachricht.",
      },
    }]);
  });

  it("maps a suspicious-user message with documented classification and text", () => {
    expect(diagnose("channel.suspicious_user.message", {
      user_name: "Xemdo",
      user_login: "xemdo",
      low_trust_status: "active_monitoring",
      types: ["ban_evader"],
      ban_evasion_evaluation: "possible",
      message: { text: "Eine auffällige Nachricht." },
    })).toEqual([{
      code: "channel_events.suspicious.message",
      detail: {
        person: "Xemdo (@xemdo)",
        einstufung: "active_monitoring / ban_evader / possible",
        text: "Eine auffällige Nachricht.",
      },
    }]);
  });

  it("distinguishes an escalated classification from a clearance, including the acting person", () => {
    expect(diagnose("channel.suspicious_user.update", {
      user_name: "Xemdo",
      user_login: "xemdo",
      low_trust_status: "restricted",
      moderator_user_name: "BlueLava",
      moderator_user_login: "bluelava",
    })).toEqual([{
      code: "channel_events.suspicious.classified",
      detail: {
        person: "Xemdo (@xemdo)",
        einstufung: "restricted",
        moderator: "BlueLava (@bluelava)",
      },
    }]);
    expect(diagnose("channel.suspicious_user.update", {
      user_name: "Xemdo",
      low_trust_status: "none",
      moderator_user_name: "BlueLava",
    })).toEqual([{
      code: "channel_events.suspicious.cleared",
      detail: {
        person: "Xemdo",
        einstufung: "none",
        moderator: "BlueLava",
      },
    }]);
  });

  it("omits unknown or missing suspicious-user fields", () => {
    expect(diagnose("automod.message.hold", {})).toEqual([{
      code: "channel_events.automod.held",
      detail: {},
    }]);
    expect(diagnose("channel.suspicious_user.message", {
      low_trust_status: "unbekannt",
      types: ["unbekannt"],
      ban_evasion_evaluation: "unbekannt",
      message: { text: 42 },
    })).toEqual([{
      code: "channel_events.suspicious.message",
      detail: {},
    }]);
    expect(diagnose("channel.suspicious_user.update", {
      low_trust_status: "unbekannt",
      moderator_user_name: 42,
    })).toEqual([{
      code: "channel_events.suspicious.classified",
      detail: {},
    }]);
  });

  it("visibly truncates the held-back AutoMod text", () => {
    expect(diagnose("automod.message.hold", {
      user_name: "Person",
      message: "x".repeat(240),
    })).toEqual([{
      code: "channel_events.automod.held",
      detail: { person: "Person", text: `${"x".repeat(199)}…` },
    }]);
  });
});

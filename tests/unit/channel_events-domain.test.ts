import { describe, expect, it } from "vitest";

import type { EventSubSubscriptionType } from "../../src/contracts/values";
import { diagnoseChannelEvent } from "../../src/modules/channel_events/domain";

const diagnose = (
  subscriptionType: EventSubSubscriptionType,
  payload: Record<string, unknown>,
  variant?: string,
  receivedAt?: string,
) => diagnoseChannelEvent(subscriptionType, payload, "kanal-a", variant, receivedAt);

describe("Kanalereignisse-Domain", () => {
  it("bildet eingehende und ausgehende Raids mit Quelle/Ziel und Zuschauern ab", () => {
    expect(diagnose("channel.raid", {
      from_broadcaster_user_name: "Quelle Name",
      from_broadcaster_user_login: "quelle_login",
      viewers: 42,
    }, "incoming")).toEqual([{
      code: "channel_events.raid.incoming",
      detail: { quelle: "Quelle Name (@quelle_login)", viewers: 42 },
    }]);
    expect(diagnose("channel.raid", {
      to_broadcaster_user_name: "Ziel Name",
      to_broadcaster_user_login: "ziel_login",
      viewers: 17,
    }, "outgoing")).toEqual([{
      code: "channel_events.raid.outgoing",
      detail: { ziel: "Ziel Name (@ziel_login)", viewers: 17 },
    }]);
  });

  it("bildet gesendete und empfangene Shoutouts ab", () => {
    expect(diagnose("channel.shoutout.create", {
      to_broadcaster_user_name: "Ziel",
      to_broadcaster_user_login: "ziel",
    })).toEqual([{
      code: "channel_events.shoutout.gesendet",
      detail: { ziel: "Ziel (@ziel)" },
    }]);
    expect(diagnose("channel.shoutout.receive", {
      from_broadcaster_user_name: "Quelle",
      from_broadcaster_user_login: "quelle",
      viewer_count: 12,
    })).toEqual([{
      code: "channel_events.shoutout.empfangen",
      detail: { quelle: "Quelle (@quelle)", viewers: 12 },
    }]);
  });

  it.each([
    ["sub", "channel_events.chat.sub"],
    ["resub", "channel_events.chat.resub"],
  ])("bildet %s mit der beteiligten Person ab", (noticeType, code) => {
    expect(diagnose("channel.chat.notification", {
      notice_type: noticeType,
      chatter_user_name: "Alice",
      chatter_user_login: "alice",
      [noticeType]: { sub_tier: "1000" },
    })).toEqual([{
      code,
      detail: { person: "Alice (@alice)", stufe: "1000" },
    }]);
  });

  it("bildet Gift-Sub, Community-Gift und Ankündigung mit Beteiligten ab", () => {
    expect(diagnose("channel.chat.notification", {
      notice_type: "sub_gift",
      gifter_user_name: "Giftperson",
      recipient_user_name: "Empfänger",
      sub_gift: { sub_tier: "1000" },
    })[0]).toEqual({
      code: "channel_events.chat.gift_sub",
      detail: { spender: "Giftperson", empfaenger: "Empfänger", stufe: "1000" },
    });
    expect(diagnose("channel.chat.notification", {
      notice_type: "community_sub_gift",
      gifter_user_name: "Giftperson",
      community_sub_gift: { total: 5, sub_tier: "prime" },
    })[0]).toEqual({
      code: "channel_events.chat.community_gift",
      detail: { spender: "Giftperson", count: 5, stufe: "prime" },
    });
    expect(diagnose("channel.chat.notification", {
      notice_type: "announcement",
      chatter_user_name: "Mod",
      message: { text: "Wichtige Ansage" },
    })[0]).toEqual({
      code: "channel_events.chat.ankuendigung",
      detail: { person: "Mod", text: "Wichtige Ansage" },
    });
  });

  it("meldet unbekannte notice_type genau einmal und kürzt fremden Text", () => {
    const noticeType = "x".repeat(240);
    expect(diagnose("channel.chat.notification", { notice_type: noticeType })).toEqual([{
      code: "channel_events.chat.unbekannt",
      detail: { kind: `${"x".repeat(199)}…` },
    }]);
  });

  it.each([
    ["ban", "channel_events.moderation.ban"],
    ["warn", "channel_events.moderation.warn"],
  ])("bildet %s mit betroffener und ausführender Person sowie Grund ab", (action, code) => {
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

  it("berechnet die Timeout-Dauer aus Ereigniszeit und ends_at", () => {
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
        ende: "2026-09-20T10:05:00.000Z",
        dauer: 300,
      },
    }]);
  });

  it("gibt einen Ban mit ends_at nicht als Timeout aus", () => {
    expect(diagnose("channel.moderate", {
      action: "ban",
      ban: { user_name: "Betroffene Person", ends_at: "2026-09-20T10:05:00.000Z" },
    }, undefined, "2026-09-20T10:00:00.000Z")[0]?.code).toBe("channel_events.moderation.ban");
  });

  it.each([
    ["untimeout", "channel_events.moderation.untimeout"],
    ["unban", "channel_events.moderation.unban"],
  ])("bildet %s ohne Grund als Rücknahme ab", (action, code) => {
    expect(diagnose("channel.moderate", {
      action,
      moderator_user_name: "Moderation",
      [action]: { user_name: "Betroffene Person" },
    })).toEqual([{
      code,
      detail: { person: "Betroffene Person", moderator: "Moderation" },
    }]);
  });

  it("bildet die gelöschte Nachricht ab und kürzt Fremdtexte", () => {
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

  it("meldet shared_chat_ban als genau eine unbekannte Moderationsaktion", () => {
    expect(diagnose("channel.moderate", { action: "shared_chat_ban" })).toEqual([{
      code: "channel_events.moderation.unbekannt",
      detail: { aktion: "shared_chat_ban" },
    }]);
  });

  it("bildet einen AutoMod-Haltevorgang mit Person, Kategorie und Nachricht ab", () => {
    expect(diagnose("automod.message.hold", {
      user_name: "TwitchDev",
      user_login: "twitchdev",
      category: "aggressive",
      message: { text: "Das ist eine zurückgehaltene Nachricht." },
    })).toEqual([{
      code: "channel_events.automod.halte",
      detail: {
        person: "TwitchDev (@twitchdev)",
        reason: "aggressive",
        text: "Das ist eine zurückgehaltene Nachricht.",
      },
    }]);
  });

  it("bildet eine Verdachtsnachricht mit dokumentierter Einstufung und Text ab", () => {
    expect(diagnose("channel.suspicious_user.message", {
      user_name: "Xemdo",
      user_login: "xemdo",
      low_trust_status: "active_monitoring",
      types: ["ban_evader"],
      ban_evasion_evaluation: "possible",
      message: { text: "Eine auffällige Nachricht." },
    })).toEqual([{
      code: "channel_events.verdacht.nachricht",
      detail: {
        person: "Xemdo (@xemdo)",
        einstufung: "active_monitoring / ban_evader / possible",
        text: "Eine auffällige Nachricht.",
      },
    }]);
  });

  it("trennt verschärfte Einstufung und Entwarnung samt ausführender Person", () => {
    expect(diagnose("channel.suspicious_user.update", {
      user_name: "Xemdo",
      user_login: "xemdo",
      low_trust_status: "restricted",
      moderator_user_name: "BlueLava",
      moderator_user_login: "bluelava",
    })).toEqual([{
      code: "channel_events.verdacht.einstufung",
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
      code: "channel_events.verdacht.entwarnung",
      detail: {
        person: "Xemdo",
        einstufung: "none",
        moderator: "BlueLava",
      },
    }]);
  });

  it("lässt unbekannte oder fehlende Verdachtsfelder weg", () => {
    expect(diagnose("automod.message.hold", {})).toEqual([{
      code: "channel_events.automod.halte",
      detail: {},
    }]);
    expect(diagnose("channel.suspicious_user.message", {
      low_trust_status: "unbekannt",
      types: ["unbekannt"],
      ban_evasion_evaluation: "unbekannt",
      message: { text: 42 },
    })).toEqual([{
      code: "channel_events.verdacht.nachricht",
      detail: {},
    }]);
    expect(diagnose("channel.suspicious_user.update", {
      low_trust_status: "unbekannt",
      moderator_user_name: 42,
    })).toEqual([{
      code: "channel_events.verdacht.einstufung",
      detail: {},
    }]);
  });

  it("kürzt den zurückgehaltenen AutoMod-Text sichtbar", () => {
    expect(diagnose("automod.message.hold", {
      user_name: "Person",
      message: "x".repeat(240),
    })).toEqual([{
      code: "channel_events.automod.halte",
      detail: { person: "Person", text: `${"x".repeat(199)}…` },
    }]);
  });
});

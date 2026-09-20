import { describe, expect, it } from "vitest";

import { diagnostiziereKanalereignis } from "../../src/modules/kanalereignisse/domain";

const diagnose = (
  subscriptionType: string,
  payload: Record<string, unknown>,
  variant?: string,
  receivedAt?: string,
) => diagnostiziereKanalereignis(subscriptionType, payload, "kanal-a", variant, receivedAt);

describe("Kanalereignisse-Domain", () => {
  it("bildet eingehende und ausgehende Raids mit Quelle/Ziel und Zuschauern ab", () => {
    expect(diagnose("channel.raid", {
      from_broadcaster_user_name: "Quelle Name",
      from_broadcaster_user_login: "quelle_login",
      viewers: 42,
    }, "eingehend")).toEqual([{
      code: "kanalereignisse.raid.eingehend",
      detail: { quelle: "Quelle Name (@quelle_login)", zuschauer: 42 },
    }]);
    expect(diagnose("channel.raid", {
      to_broadcaster_user_name: "Ziel Name",
      to_broadcaster_user_login: "ziel_login",
      viewers: 17,
    }, "ausgehend")).toEqual([{
      code: "kanalereignisse.raid.ausgehend",
      detail: { ziel: "Ziel Name (@ziel_login)", zuschauer: 17 },
    }]);
  });

  it("bildet gesendete und empfangene Shoutouts ab", () => {
    expect(diagnose("channel.shoutout.create", {
      to_broadcaster_user_name: "Ziel",
      to_broadcaster_user_login: "ziel",
    })).toEqual([{
      code: "kanalereignisse.shoutout.gesendet",
      detail: { ziel: "Ziel (@ziel)" },
    }]);
    expect(diagnose("channel.shoutout.receive", {
      from_broadcaster_user_name: "Quelle",
      from_broadcaster_user_login: "quelle",
      viewer_count: 12,
    })).toEqual([{
      code: "kanalereignisse.shoutout.empfangen",
      detail: { quelle: "Quelle (@quelle)", zuschauer: 12 },
    }]);
  });

  it.each([
    ["sub", "kanalereignisse.chat.sub"],
    ["resub", "kanalereignisse.chat.resub"],
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
      code: "kanalereignisse.chat.gift_sub",
      detail: { spender: "Giftperson", empfaenger: "Empfänger", stufe: "1000" },
    });
    expect(diagnose("channel.chat.notification", {
      notice_type: "community_sub_gift",
      gifter_user_name: "Giftperson",
      community_sub_gift: { total: 5, sub_tier: "prime" },
    })[0]).toEqual({
      code: "kanalereignisse.chat.community_gift",
      detail: { spender: "Giftperson", anzahl: 5, stufe: "prime" },
    });
    expect(diagnose("channel.chat.notification", {
      notice_type: "announcement",
      chatter_user_name: "Mod",
      message: { text: "Wichtige Ansage" },
    })[0]).toEqual({
      code: "kanalereignisse.chat.ankuendigung",
      detail: { person: "Mod", text: "Wichtige Ansage" },
    });
  });

  it("meldet unbekannte notice_type genau einmal und kürzt fremden Text", () => {
    const noticeType = "x".repeat(240);
    expect(diagnose("channel.chat.notification", { notice_type: noticeType })).toEqual([{
      code: "kanalereignisse.chat.unbekannt",
      detail: { art: `${"x".repeat(199)}…` },
    }]);
  });

  it.each([
    ["ban", "kanalereignisse.moderation.ban"],
    ["warn", "kanalereignisse.moderation.warn"],
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
        grund: "Regelverstoß",
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
      code: "kanalereignisse.moderation.timeout",
      detail: {
        person: "Betroffene Person",
        moderator: "Moderation",
        grund: "Zu viele Nachrichten",
        ende: "2026-09-20T10:05:00.000Z",
        dauer: 300,
      },
    }]);
  });

  it("gibt einen Ban mit ends_at nicht als Timeout aus", () => {
    expect(diagnose("channel.moderate", {
      action: "ban",
      ban: { user_name: "Betroffene Person", ends_at: "2026-09-20T10:05:00.000Z" },
    }, undefined, "2026-09-20T10:00:00.000Z")[0]?.code).toBe("kanalereignisse.moderation.ban");
  });

  it.each([
    ["untimeout", "kanalereignisse.moderation.untimeout"],
    ["unban", "kanalereignisse.moderation.unban"],
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
      code: "kanalereignisse.moderation.delete",
      detail: {
        person: "Betroffene Person",
        moderator: "Moderation",
        text: `${"x".repeat(199)}…`,
      },
    }]);
  });

  it("meldet shared_chat_ban als genau eine unbekannte Moderationsaktion", () => {
    expect(diagnose("channel.moderate", { action: "shared_chat_ban" })).toEqual([{
      code: "kanalereignisse.moderation.unbekannt",
      detail: { aktion: "shared_chat_ban" },
    }]);
  });
});

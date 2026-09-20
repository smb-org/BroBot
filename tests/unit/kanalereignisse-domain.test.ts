import { describe, expect, it } from "vitest";

import { diagnostiziereKanalereignis } from "../../src/modules/kanalereignisse/domain";

const diagnose = (
  subscriptionType: string,
  payload: Record<string, unknown>,
  variant?: string,
) => diagnostiziereKanalereignis(subscriptionType, payload, "kanal-a", variant);

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
});

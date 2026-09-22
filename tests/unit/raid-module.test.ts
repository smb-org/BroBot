import { describe, expect, it } from "vitest";

import { raidModule, processRaid } from "../../src/modules/raid";
import { raidSettingsSchema } from "../../src/modules/raid/contracts";
import type { ModuleEvent } from "../../src/modules/contract";

const event = (
  payload: Record<string, unknown>,
  settings = raidModule.defaultSettings,
  subscriptionVariant = "incoming",
): ModuleEvent<typeof settings> => ({
  channelId: "kanal-a",
  subscriptionType: "channel.raid",
  subscriptionVariant,
  triggerId: "trigger-raid",
  payload,
  settings,
  receivedAt: "2026-09-20T10:00:00.000Z",
  actor: null,
  chatStatus: null,
});

const incomingRaid = (viewers: number): Record<string, unknown> => ({
  from_broadcaster_user_id: "quelle-1",
  from_broadcaster_user_login: "quelle",
  to_broadcaster_user_id: "kanal-a",
  viewers,
});

describe("Raid module", () => {
  it("silently resets old stored thresholds to the new defaults", () => {
    expect(raidSettingsSchema.parse({
      mindestZuschauer: 50,
      textLong: "full",
      textShort: "klein",
    })).toEqual({
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "full",
      textShort: "klein",
    });
  });

  it("subscribes to channel.raid without a broadcaster scope", () => {
    expect(raidModule.eventSubTypes).toEqual(["channel.raid"]);
    expect(raidModule.broadcasterScopes).toBeUndefined();
  });

  it("produces a shoutout and the full chat line at the shoutout threshold", () => {
    const result = processRaid(event(incomingRaid(8), {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "Willkommen {channel} mit {viewers} Zuschauern!",
      textShort: "Danke {channel}!",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", targetChannelId: "quelle-1" },
      { kind: "chat", text: "Willkommen quelle mit 8 Zuschauern!" },
    ]);
  });

  it("produces only the full chat line at the shoutout threshold when the switch is off", () => {
    const result = processRaid(event(incomingRaid(8), {
      shoutoutEnabled: false,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "Voll {channel} {viewers}",
      textShort: "Danke {channel} für {viewers}!",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Voll quelle 8" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.suppressed",
      detail: { reason: "abgeschaltet", viewers: 8, threshold: 3 },
    }]);
  });

  it("produces only the short chat line below the shoutout threshold", () => {
    const result = processRaid(event(incomingRaid(2), {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "Voll {channel} {viewers}",
      textShort: "Danke {channel} für {viewers}!",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Danke quelle für 2!" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.suppressed",
      detail: { reason: "unter_schwelle", viewers: 2, threshold: 3 },
    }]);
  });

  it("applies the shoutout and text thresholds independently", () => {
    const result = processRaid(event(incomingRaid(10), {
      shoutoutEnabled: true,
      shoutoutThreshold: 50,
      textThreshold: 5,
      textLong: "Voll {channel} {viewers}",
      textShort: "Klein {channel} {viewers}",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Voll quelle 10" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.suppressed",
      detail: { reason: "unter_schwelle", viewers: 10, threshold: 50 },
    }]);
  });

  it("reports an outgoing raid and produces no action", () => {
    const result = processRaid(event({
      from_broadcaster_user_id: "kanal-a",
      to_broadcaster_user_id: "ziel-1",
      viewers: 20,
    }, raidModule.defaultSettings, "outgoing"));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "raid.outgoing",
      detail: { targetChannelId: "ziel-1", viewers: 20 },
    }]);
  });

  it("replaces both placeholders and treats a threshold of zero as inclusive", () => {
    const result = processRaid(event(incomingRaid(0), {
      shoutoutEnabled: true,
      shoutoutThreshold: 0,
      textThreshold: 0,
      textLong: "{channel}/{viewers}",
      textShort: "klein",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", targetChannelId: "quelle-1" },
      { kind: "chat", text: "quelle/0" },
    ]);
  });

  it("gives a reason for a raid below the threshold", () => {
    const result = processRaid(event(incomingRaid(2), {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "full",
      textShort: "klein",
    }));

    expect(result.diagnostics).toEqual([{
      code: "shoutout.suppressed",
      detail: { reason: "unter_schwelle", viewers: 2, threshold: 3 },
    }]);
  });

  it("no longer replaces German raid placeholders", () => {
    const result = processRaid(event(incomingRaid(8), {
      shoutoutEnabled: false,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "{kanal} {zuschauer}",
      textShort: "klein",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "{kanal} {zuschauer}" }]);
  });
});

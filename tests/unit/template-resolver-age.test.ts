import { describe, expect, it } from "vitest";

import type { ModuleEvent } from "../../src/modules/contract";
import { createTemplateRenderer, type TemplateResolverSources } from "../../src/worker/template-resolver";

const renderAge = async (
  token: "{followage}" | "{accountage}",
  startedAt: string,
  now: string,
  language: "de" | "en" = "de",
): Promise<string> => {
  const event: ModuleEvent = {
    channelId: "channel-a",
    subscriptionType: "channel.chat.message",
    triggerId: "trigger-1",
    payload: { chatter_user_id: "user-1" },
    settings: {},
    receivedAt: now,
    actor: null,
    chatStatus: null,
  };
  const sources: TemplateResolverSources = {
    streamState: () => Promise.resolve("unknown"),
    channelDetails: () => Promise.resolve(null),
    streamDetails: () => Promise.resolve(null),
    followedAt: () => Promise.resolve(startedAt),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: () => Promise.resolve(startedAt),
    channelLanguage: () => Promise.resolve(language),
    readChannelVariables: () => Promise.resolve({}),
    now: () => Date.parse(now),
  };
  const renderer = createTemplateRenderer(event, "chat_command", [], sources);
  return (await renderer(token, {})).text;
};

describe("calendar age template variables", () => {
  it("counts an exact calendar-year anniversary for followage and account age", async () => {
    expect(await renderAge("{followage}", "2025-09-24T12:00:00.000Z", "2026-09-24T12:00:00.000Z")).toBe("1 Jahr");
    expect(await renderAge("{accountage}", "2025-09-24T12:00:00.000Z", "2026-09-24T12:00:00.000Z", "en")).toBe("1 year");
  });

  it("treats the last day of the month as the anniversary for month-end dates", async () => {
    expect(await renderAge("{followage}", "2025-01-31T12:00:00.000Z", "2025-02-27T12:00:00.000Z")).toBe("0 Monate");
    expect(await renderAge("{followage}", "2025-01-31T12:00:00.000Z", "2025-02-28T12:00:00.000Z")).toBe("1 Monat");
  });

  it("counts a leap-day anniversary on February 28 in a non-leap year", async () => {
    expect(await renderAge("{accountage}", "2024-02-29T12:00:00.000Z", "2025-02-27T12:00:00.000Z", "en")).toBe("11 months");
    expect(await renderAge("{accountage}", "2024-02-29T12:00:00.000Z", "2025-02-28T12:00:00.000Z", "en")).toBe("1 year");
  });
});

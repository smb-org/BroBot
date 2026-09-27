import { describe, expect, it, vi } from "vitest";

import { createTemplateRenderer, type TemplateResolverSources } from "../../src/worker/template-resolver";
import type { ModuleEvent } from "../../src/modules/contract";
import type { TemplateVariable } from "../../src/template";

const event: ModuleEvent = {
  channelId: "fictional-channel",
  subscriptionType: "channel.chat.message",
  triggerId: "fictional-trigger",
  payload: {},
  settings: {},
  receivedAt: "2026-09-27T12:00:00.000Z",
  actor: { userId: "fictional-viewer", login: "viewer", role: null },
  chatStatus: ["viewer"],
};

const variable = (name: string): TemplateVariable => ({ name, sample: "value", maxLength: 30 });

describe("template value providers", () => {
  it("does not re-scan one provider's inserted value for another provider", async () => {
    const resolveSun = vi.fn((names: readonly string[]) => Promise.resolve(names.includes("sun.set")
      ? { "sun.set": "{weather.temp}" }
      : {}));
    const resolveWeather = vi.fn((names: readonly string[]) => Promise.resolve(names.includes("weather.temp")
      ? { "weather.temp": "18 °C" }
      : {}));
    const sources = {
      streamState: () => Promise.resolve("offline" as const),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve(null),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve("en" as const),
      channelTimeZone: () => Promise.resolve("Europe/Paris"),
      readChannelVariables: () => Promise.resolve({}),
      templateValueProviders: [
        { moduleId: "sun", variables: [variable("sun.set")], resolveTemplateValues: resolveSun },
        { moduleId: "weather", variables: [variable("weather.temp")], resolveTemplateValues: resolveWeather },
      ],
    } as unknown as TemplateResolverSources;

    const result = await createTemplateRenderer(event, "event", [], sources)("{sun.set}", {});

    expect(result.text).toBe("{weather.temp}");
    expect(resolveSun).toHaveBeenCalledWith(["sun.set"], expect.any(Object));
    expect(resolveWeather).not.toHaveBeenCalled();
  });
});

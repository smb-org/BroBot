import { describe, expect, it, vi } from "vitest";

import { createTemplateRenderer, type TemplateResolverSources } from "../../src/worker/template-resolver";
import type { ModuleEvent } from "../../src/modules/contract";
import type { TemplateVariable } from "../../src/template";
import { raidModule } from "../../src/modules/raid";
import { variablesForModuleTemplateContext } from "../../src/modules/registry";

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

  it("uses caller-supplied module values without re-entering their provider", async () => {
    const resolveSun = vi.fn(() => Promise.resolve({ "sun.set": "resolved later" }));
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
      ],
    } as unknown as TemplateResolverSources;

    const result = await createTemplateRenderer(event, "event", [], sources)("{sun.set}", { "sun.set": "captured sample" });

    expect(result.text).toBe("captured sample");
    expect(resolveSun).not.toHaveBeenCalled();
  });

  it("asks the text-block provider only for bare names requested by the current template", async () => {
    const resolveBlocks = vi.fn((names: readonly string[]) => Promise.resolve(
      names.includes("welcome") ? { welcome: "Hello from the library" } : {},
    ));
    const sources = {
      DB: {} as D1Database,
      channelInfo: () => Promise.resolve(null),
      channelGameId: () => Promise.resolve(null),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      templateValueProviders: [{ moduleId: "text_library", templateVariableNamespace: "text_blocks" as const, variables: [], resolveTemplateValues: resolveBlocks }],
      streamState: () => Promise.resolve("offline" as const),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve(null),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve("en" as const),
      readChannelVariables: () => Promise.resolve({}),
    } as TemplateResolverSources;
    const chatEvent: ModuleEvent = {
      ...event,
      subscriptionType: "channel.chat.message",
      payload: { broadcaster_user_login: "streamer" },
    };
    const render = createTemplateRenderer(chatEvent, "chat_command", [], sources);

    await expect(render("{welcome} {channel}", {})).resolves.toMatchObject({ text: "Hello from the library streamer" });
    await expect(render("plain text", {})).resolves.toMatchObject({ text: "plain text" });

    expect(resolveBlocks).toHaveBeenCalledTimes(1);
    expect(resolveBlocks).toHaveBeenCalledWith(["welcome"], expect.any(Object));
  });

  it("uses the provider's bilingual unavailable text when resolving its values fails", async () => {
    const sources = {
      channelLanguage: () => Promise.resolve("de" as const),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      streamState: () => Promise.resolve("offline" as const),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve(null),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      readChannelVariables: () => Promise.resolve({}),
      templateValueProviders: [{
        moduleId: "weather",
        variables: [variable("weather.temp")],
        templateUnavailableText: { de: "Wetterdaten fehlen.", en: "Weather data is unavailable." },
        resolveTemplateValues: () => Promise.reject(new Error("Provider unavailable.")),
      }],
    } as unknown as TemplateResolverSources;

    const result = await createTemplateRenderer(event, "event", [], sources)("{weather.temp}", {});

    expect(result.text).toBe("Wetterdaten fehlen.");
  });

  it("keeps event-only raid variables from shadowing host variables in a command preview", async () => {
    const raidVariables = variablesForModuleTemplateContext(raidModule,
      Object.values(raidModule.templateFields ?? {}).flat());
    const resolveRaid = vi.fn(() => Promise.resolve({ channel: "raider", viewers: "999" }));
    const registeredForPreview = raidVariables.filter((entry) => entry.contexts?.includes("chat_command") ?? true);
    const sources = {
      DB: {} as D1Database,
      channelInfo: () => Promise.resolve(null),
      channelGameId: () => Promise.resolve(null),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      templateValueProviders: [{ moduleId: "raid", variables: raidVariables, resolveTemplateValues: resolveRaid }],
      registeredTemplateVariables: registeredForPreview,
      streamState: () => Promise.resolve("offline" as const),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve({ startedAt: "2026-09-27T12:00:00.000Z", viewerCount: 42 }),
      followedAt: () => Promise.resolve(null),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve("en" as const),
      readChannelVariables: () => Promise.resolve({}),
    } as TemplateResolverSources;
    const commandEvent: ModuleEvent = {
      ...event,
      subscriptionType: "channel.chat.message",
      payload: { broadcaster_user_login: "streamer" },
    };

    const result = await createTemplateRenderer(commandEvent, "chat_command", registeredForPreview, sources)("{channel} · {viewers}", {});

    expect(result.text).toBe("streamer · 42");
    expect(resolveRaid).not.toHaveBeenCalled();
  });
});

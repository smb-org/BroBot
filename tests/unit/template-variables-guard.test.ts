import { describe, expect, it } from "vitest";

import { adsSettingsEditorCatalog } from "../../src/modules/ads/panel/locale";
import {
  ADS_TEMPLATE_FIELDS,
  ADS_VARIABLES,
  adsModule,
  decideAdPrewarning,
  processAdBreak,
  renderAdBreakText,
  renderPrewarningText,
} from "../../src/modules/ads";
import {
  DEFAULT_AUTOMATIC_TEXT,
  DEFAULT_MANUAL_TEXT,
  DEFAULT_PREWARNING_TEXT,
} from "../../src/modules/ads/contracts/chat-defaults";
import { raidSettingsEditorCatalog } from "../../src/modules/raid/panel/locale";
import {
  processRaid,
  raidModule,
  renderRaidText,
} from "../../src/modules/raid";
import { RAID_TEMPLATE_FIELDS } from "../../src/modules/raid/contracts";
import {
  DEFAULT_TEXT_LONG,
  DEFAULT_TEXT_SHORT,
} from "../../src/modules/raid/contracts/chat-defaults";
import {
  commandListReply,
  NO_COMMANDS_REPLY,
  TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES,
  TEXT_COMMAND_DEFAULT_TEXTS,
} from "../../src/modules/text_commands/contracts/chat-defaults";
import { textCommandsTexts } from "../../src/modules/text_commands/panel/locale";
import {
  TEXT_COMMAND_TEMPLATE_FIELDS,
  TEXT_COMMAND_VARIABLES,
  type TextCommand,
  type TextCommandRepository,
} from "../../src/modules/text_commands";
import { renderCommandText } from "../../src/modules/text_commands/domain";
import { processTextCommandMessage } from "../../src/modules/text_commands/service";
import type { TemplateVariable } from "../../src/template";
import { unknownTemplateVariables, worstCaseTemplateLength } from "../../src/template";
import type { ModuleEvent } from "../../src/modules/contract";

const templateFor = (variables: readonly TemplateVariable[]): string =>
  `${variables.map(({ name }) => `{${name}}`).join("|")}|{zzz}`;

const commandFor = (text: string): TextCommand => ({
  channelId: "channel-id",
  name: "guard",
  text,
  kind: "text",
  enabled: true,
  minimumTier: "everyone",
  cooldownSeconds: 0,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  responseType: "reply",
  lastUsedAt: null,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
});

const repositoryFor = (command: TextCommand): TextCommandRepository => ({
  list: () => Promise.resolve([command]),
  find: () => Promise.resolve(command),
  findByAlias: () => Promise.resolve(null),
  create: () => Promise.resolve({ ok: true }),
  change: () => Promise.resolve({ ok: true }),
  delete: () => Promise.resolve({ ok: true }),
  claim: () => Promise.resolve({ command, claimed: true }),
});

const textCommandEvent: ModuleEvent = {
  channelId: "channel-id",
  subscriptionType: "channel.chat.message",
  triggerId: "template-guard",
  payload: {
    message: { text: "!guard" },
    broadcaster_user_login: "livechannel",
  },
  settings: {},
  receivedAt: "2026-09-23T00:00:00.000Z",
  actor: { userId: "user-id", login: "alice", role: null },
  chatStatus: ["viewer"],
};

const raidEvent = (viewers: number, settings: typeof raidModule.defaultSettings): ModuleEvent<typeof settings> => ({
  channelId: "channel-id",
  subscriptionType: "channel.raid",
  subscriptionVariant: "incoming",
  triggerId: "template-guard",
  payload: {
    from_broadcaster_user_id: "raider-id",
    from_broadcaster_user_login: "raider",
    to_broadcaster_user_id: "channel-id",
    viewers,
  },
  settings,
  receivedAt: "2026-09-23T00:00:00.000Z",
  actor: null,
  chatStatus: null,
});

const adEvent = (automatic: boolean, settings: typeof adsModule.defaultSettings): ModuleEvent<typeof settings> => ({
  channelId: "channel-id",
  subscriptionType: "channel.ad_break.begin",
  triggerId: "template-guard",
  payload: {
    duration_seconds: 90,
    started_at: "2026-09-23T00:00:00.000Z",
    is_automatic: automatic,
  },
  settings,
  receivedAt: "2026-09-23T00:00:00.000Z",
  actor: null,
  chatStatus: null,
});

const chatText = (result: { actions: readonly { kind: string; text?: string }[] }): string => {
  const action = result.actions.find((candidate) => candidate.kind === "chat");
  if (action?.text === undefined) throw new Error("Expected a chat action");
  return action.text;
};

describe("template declaration guard", () => {
  it("consumes every declaration through its real service path and leaves undeclared tokens literal", async () => {
    const commandTemplate = templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.text.text);
    const commandText = chatText(await processTextCommandMessage(
      textCommandEvent,
      repositoryFor(commandFor(commandTemplate)),
    ));
    expect(commandText).toBe("alice|livechannel|{zzz}");

    const uptime = await processTextCommandMessage(
      { ...textCommandEvent, payload: { ...textCommandEvent.payload, message: { text: "!guard" } } },
      repositoryFor({ ...commandFor(templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.uptime.text)), kind: "uptime" }),
      {
        channelInfo: () => Promise.resolve({ title: "A title", gameName: "A game", startedAt: "2026-09-22T22:00:00.000Z" }),
        channelLanguage: () => Promise.resolve("de"),
      },
    );
    expect(chatText(uptime)).toBe("alice|livechannel|2 Std. 0 Min.|{zzz}");

    const offline = await processTextCommandMessage(
      textCommandEvent,
      repositoryFor({
        ...commandFor("unused"), kind: "uptime",
        offlineText: templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.uptime.offlineText),
      }),
      { channelInfo: () => Promise.resolve({ title: "", gameName: "", startedAt: null }) },
    );
    expect(chatText(offline)).toBe("livechannel|{zzz}");

    const followage = await processTextCommandMessage(
      textCommandEvent,
      repositoryFor({ ...commandFor(templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.followage.text)), kind: "followage" }),
      { followedAt: () => Promise.resolve("2025-09-23T00:00:00.000Z"), channelLanguage: () => Promise.resolve("de") },
    );
    expect(chatText(followage)).toBe("alice|livechannel|1 Jahr|{zzz}");
    const notFollowing = await processTextCommandMessage(
      textCommandEvent,
      repositoryFor({
        ...commandFor("unused"), kind: "followage",
        notFollowingText: templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.followage.notFollowingText),
      }),
      { followedAt: () => Promise.resolve(null) },
    );
    expect(chatText(notFollowing)).toBe("alice|livechannel|{zzz}");
    const unavailable = await processTextCommandMessage(
      textCommandEvent,
      repositoryFor({
        ...commandFor("unused"), kind: "followage",
        unavailableText: templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.followage.unavailableText),
      }),
      { followedAt: () => Promise.resolve("unavailable") },
    );
    expect(chatText(unavailable)).toBe("|{zzz}");

    const game = await processTextCommandMessage(
      textCommandEvent,
      repositoryFor({ ...commandFor(templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.game.text)), kind: "game" }),
      { channelInfo: () => Promise.resolve({ title: "A title", gameName: "A game", startedAt: null }) },
    );
    expect(chatText(game)).toBe("livechannel|A game|A title|{zzz}");

    const shoutout = await processTextCommandMessage(
      { ...textCommandEvent, payload: { ...textCommandEvent.payload, message: { text: "!guard someone" } } },
      repositoryFor({ ...commandFor(templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.shoutout.text)), kind: "shoutout" }),
    );
    expect(chatText(shoutout)).toBe("alice|someone|{zzz}");
    const usage = await processTextCommandMessage(
      textCommandEvent,
      repositoryFor({ ...commandFor("unused"), kind: "shoutout", usageText: templateFor(TEXT_COMMAND_TEMPLATE_FIELDS.shoutout.usageText) }),
    );
    expect(chatText(usage)).toBe("|{zzz}");

    for (const field of ["textLong", "textShort"] as const) {
      const template = templateFor(RAID_TEMPLATE_FIELDS[field]);
      const settings = {
        ...raidModule.defaultSettings,
        [field]: template,
        textThreshold: 3,
        shoutoutEnabled: false,
      };
      const viewers = field === "textLong" ? 7 : 2;
      const result = processRaid(raidEvent(viewers, settings));
      expect(chatText(result)).toBe(`raider|${String(viewers)}|{zzz}`);
    }

    for (const field of ["automatic", "manual"] as const) {
      const template = templateFor(ADS_TEMPLATE_FIELDS[field]);
      const settings = { ...adsModule.defaultSettings, [field]: template };
      expect(chatText(processAdBreak(adEvent(field === "automatic", settings))))
        .toBe("90|{zzz}");
    }

    const prewarningTemplate = templateFor(ADS_TEMPLATE_FIELDS.prewarningText);
    const warning = decideAdPrewarning({
      settings: {
        prewarning: true,
        leadSeconds: 60,
        prewarningText: prewarningTemplate,
      },
      scopeAvailable: true,
      nowAtMs: 0,
      plannedAtMs: 60_000,
      schedule: { nextAdAt: new Date(60_000).toISOString(), lastAdAt: null },
    });
    expect(warning.kind).toBe("announce");
    if (warning.kind === "announce") expect(warning.text).toBe("60|{zzz}");
  });

  it("keeps default chat templates free of unknown variables and within the worst-case limit", () => {
    const defaults: Array<{ text: string; variables: readonly TemplateVariable[] }> = [
      { text: DEFAULT_TEXT_LONG, variables: RAID_TEMPLATE_FIELDS.textLong },
      { text: DEFAULT_TEXT_SHORT, variables: RAID_TEMPLATE_FIELDS.textShort },
      { text: DEFAULT_AUTOMATIC_TEXT, variables: ADS_TEMPLATE_FIELDS.automatic },
      { text: DEFAULT_MANUAL_TEXT, variables: ADS_TEMPLATE_FIELDS.manual },
      { text: DEFAULT_PREWARNING_TEXT, variables: ADS_TEMPLATE_FIELDS.prewarningText },
      { text: TEXT_COMMAND_DEFAULT_TEXTS.uptime, variables: TEXT_COMMAND_TEMPLATE_FIELDS.uptime.text },
      { text: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.offlineText, variables: TEXT_COMMAND_TEMPLATE_FIELDS.uptime.offlineText },
      { text: TEXT_COMMAND_DEFAULT_TEXTS.followage, variables: TEXT_COMMAND_TEMPLATE_FIELDS.followage.text },
      { text: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.notFollowingText, variables: TEXT_COMMAND_TEMPLATE_FIELDS.followage.notFollowingText },
      { text: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.unavailableText, variables: TEXT_COMMAND_TEMPLATE_FIELDS.followage.unavailableText },
      { text: TEXT_COMMAND_DEFAULT_TEXTS.game, variables: TEXT_COMMAND_TEMPLATE_FIELDS.game.text },
      { text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout, variables: TEXT_COMMAND_TEMPLATE_FIELDS.shoutout.text },
      { text: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.usageText, variables: TEXT_COMMAND_TEMPLATE_FIELDS.shoutout.usageText },
      { text: NO_COMMANDS_REPLY, variables: [] },
      { text: commandListReply(["hallo", "wiki"]), variables: [] },
    ];
    for (const { text, variables } of defaults) {
      expect(unknownTemplateVariables(text, variables)).toEqual([]);
      expect(worstCaseTemplateLength(text, variables)).toBeLessThanOrEqual(500);
    }
  });

  it("renders each declaration's sample values through the same domain render functions used by previews", () => {
    const samples = (variables: readonly TemplateVariable[]): Record<string, string> =>
      Object.fromEntries(variables.map(({ name, sample }) => [name, sample]));

    const commandTemplate = templateFor(TEXT_COMMAND_VARIABLES);
    expect(renderCommandText(commandTemplate, {
      user: TEXT_COMMAND_VARIABLES[0].sample,
      channel: TEXT_COMMAND_VARIABLES[1].sample,
    }))
      .toBe("zuschauerin|beispielkanal|{zzz}");

    for (const field of ["textLong", "textShort"] as const) {
      const variables = RAID_TEMPLATE_FIELDS[field];
      const template = templateFor(variables);
      expect(renderRaidText(template, samples(variables) as { channel: string; viewers: string }))
        .toBe("beispielkanal|42|{zzz}");
    }

    for (const field of ["automatic", "manual"] as const) {
      const template = templateFor(ADS_TEMPLATE_FIELDS[field]);
      expect(renderAdBreakText(template, Number(ADS_VARIABLES.duration.sample)))
        .toBe("90|{zzz}");
    }
    const prewarningTemplate = templateFor(ADS_TEMPLATE_FIELDS.prewarningText);
    expect(renderPrewarningText(prewarningTemplate, { seconds: ADS_VARIABLES.seconds.sample }))
      .toBe("60|{zzz}");
  });

  it("provides a non-empty description for every declared variable in both panel languages", () => {
    const catalogues: Record<"text_commands" | "raid" | "ads", {
      de: Readonly<Record<string, string>>;
      en: Readonly<Record<string, string>>;
    }> = {
      text_commands: { de: textCommandsTexts("de").variables, en: textCommandsTexts("en").variables },
      raid: {
        de: Object.fromEntries(Object.values(raidSettingsEditorCatalog("de").fields).flatMap((field) => field.variables ?? []).map(({ name, description }) => [name, description])),
        en: Object.fromEntries(Object.values(raidSettingsEditorCatalog("en").fields).flatMap((field) => field.variables ?? []).map(({ name, description }) => [name, description])),
      },
      ads: {
        de: Object.fromEntries(Object.values(adsSettingsEditorCatalog("de").fields).flatMap((field) => field.variables ?? []).map(({ name, description }) => [name, description])),
        en: Object.fromEntries(Object.values(adsSettingsEditorCatalog("en").fields).flatMap((field) => field.variables ?? []).map(({ name, description }) => [name, description])),
      },
    };
    const declarations: Record<keyof typeof catalogues, readonly TemplateVariable[]> = {
      text_commands: (() => {
        const fields: readonly (readonly TemplateVariable[])[] = [
          TEXT_COMMAND_TEMPLATE_FIELDS.text.text,
          TEXT_COMMAND_TEMPLATE_FIELDS.uptime.text,
          TEXT_COMMAND_TEMPLATE_FIELDS.uptime.offlineText,
          TEXT_COMMAND_TEMPLATE_FIELDS.followage.text,
          TEXT_COMMAND_TEMPLATE_FIELDS.followage.notFollowingText,
          TEXT_COMMAND_TEMPLATE_FIELDS.followage.unavailableText,
          TEXT_COMMAND_TEMPLATE_FIELDS.game.text,
          TEXT_COMMAND_TEMPLATE_FIELDS.shoutout.text,
          TEXT_COMMAND_TEMPLATE_FIELDS.shoutout.usageText,
        ];
        const variables = new Map<string, TemplateVariable>();
        for (const fieldVariables of fields) {
          for (const variable of fieldVariables) variables.set(variable.name, variable);
        }
        return [...variables.values()];
      })(),
      raid: [...RAID_TEMPLATE_FIELDS.textLong],
      ads: [...new Map(Object.values(ADS_TEMPLATE_FIELDS).flat().map((variable) => [variable.name, variable])).values()],
    };

    for (const moduleName of Object.keys(declarations) as (keyof typeof declarations)[]) {
      for (const { name } of declarations[moduleName]) {
        expect(catalogues[moduleName].de[name]?.trim().length).toBeGreaterThan(0);
        expect(catalogues[moduleName].en[name]?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("freezes the template field set of each module", () => {
    expect(Object.keys(TEXT_COMMAND_TEMPLATE_FIELDS)).toEqual(["text", "list", "uptime", "followage", "game", "shoutout"]);
    expect(Object.keys(TEXT_COMMAND_TEMPLATE_FIELDS.uptime)).toEqual(["text", "offlineText"]);
    expect(Object.keys(TEXT_COMMAND_TEMPLATE_FIELDS.followage)).toEqual(["text", "notFollowingText", "unavailableText"]);
    expect(Object.keys(TEXT_COMMAND_TEMPLATE_FIELDS.shoutout)).toEqual(["text", "usageText"]);
    expect(Object.keys(RAID_TEMPLATE_FIELDS)).toEqual(["textLong", "textShort"]);
    expect(Object.keys(ADS_TEMPLATE_FIELDS)).toEqual(["automatic", "manual", "prewarningText"]);
  });

  it("counts the ad duration fallback in the declaration's worst case", () => {
    const text = renderAdBreakText("Pause", 180);
    expect(text.length - "Pause".length).toBeLessThanOrEqual(ADS_VARIABLES.duration.fallbackWhenAbsent);
  });
});

import { describe, expect, it } from "vitest";

import { clipsModule } from "../../src/modules/clips";
import { clipsSettingsSchema } from "../../src/modules/clips/contracts";
import { clipsPanelTexts } from "../../src/modules/clips/panel/locale";

describe("clips settings", () => {
  it("fills the approved defaults for the chat command and automatic clips", () => {
    expect(clipsSettingsSchema.parse({})).toEqual({
      commandMinimumRole: "viewer",
      commandCooldownSeconds: 60,
      postClipLinkInChat: true,
      chatLinkTemplate: "Clip aus dem Stream: {clip.title} {clip.url}",
      automaticClipsEnabled: false,
      automaticThresholdMultiplier: 2.5,
      automaticCooldownSeconds: 900,
    });
  });

  it("rejects roles and cooldowns outside the clips contract", () => {
    expect(clipsSettingsSchema.safeParse({ commandMinimumRole: "everyone" }).success).toBe(false);
    expect(clipsSettingsSchema.safeParse({ commandCooldownSeconds: -1 }).success).toBe(false);
    expect(clipsSettingsSchema.safeParse({ automaticCooldownSeconds: 86401 }).success).toBe(false);
    expect(clipsSettingsSchema.safeParse({ automaticThresholdMultiplier: 0 }).success).toBe(false);
  });

  it("owns its settings in the custom panel with bilingual labels and hints", () => {
    expect(clipsModule.panelManagesSettings).toBe(true);
    expect(clipsModule.panel).toBeDefined();
    expect(clipsModule.settingsEditor).toBeUndefined();

    const fieldCopy = {
      de: {
        commandMinimumRole: [clipsPanelTexts("de").commandRole, ...clipsPanelTexts("de").roleOptions.map(({ inclusion }) => inclusion)],
        commandCooldownSeconds: [clipsPanelTexts("de").commandCooldown, clipsPanelTexts("de").commandCooldownHint],
        postClipLinkInChat: [clipsPanelTexts("de").chatLink, clipsPanelTexts("de").chatLinkHint],
        chatLinkTemplate: [clipsPanelTexts("de").chatMessage, clipsPanelTexts("de").chatMessageHint],
        automaticClipsEnabled: [clipsPanelTexts("de").automatic, clipsPanelTexts("de").automaticHint],
        automaticThresholdMultiplier: [clipsPanelTexts("de").threshold, clipsPanelTexts("de").thresholdHint],
        automaticCooldownSeconds: [clipsPanelTexts("de").automaticCooldown, clipsPanelTexts("de").automaticCooldownHint],
      },
      en: {
        commandMinimumRole: [clipsPanelTexts("en").commandRole, ...clipsPanelTexts("en").roleOptions.map(({ inclusion }) => inclusion)],
        commandCooldownSeconds: [clipsPanelTexts("en").commandCooldown, clipsPanelTexts("en").commandCooldownHint],
        postClipLinkInChat: [clipsPanelTexts("en").chatLink, clipsPanelTexts("en").chatLinkHint],
        chatLinkTemplate: [clipsPanelTexts("en").chatMessage, clipsPanelTexts("en").chatMessageHint],
        automaticClipsEnabled: [clipsPanelTexts("en").automatic, clipsPanelTexts("en").automaticHint],
        automaticThresholdMultiplier: [clipsPanelTexts("en").threshold, clipsPanelTexts("en").thresholdHint],
        automaticCooldownSeconds: [clipsPanelTexts("en").automaticCooldown, clipsPanelTexts("en").automaticCooldownHint],
      },
    };
    const schemaKeys = Object.keys(clipsSettingsSchema.shape).sort((left, right) => left.localeCompare(right));
    for (const language of ["de", "en"] as const) {
      expect(Object.keys(fieldCopy[language]).sort((left, right) => left.localeCompare(right))).toEqual(schemaKeys);
      for (const messages of Object.values(fieldCopy[language])) {
        expect(messages.every((message) => message.trim().length > 0)).toBe(true);
      }
    }
  });
});

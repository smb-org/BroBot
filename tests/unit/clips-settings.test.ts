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
    expect(clipsSettingsSchema.safeParse({ automaticClipsEnabled: true, automaticCooldownSeconds: 0 }).success).toBe(false);
    expect(clipsSettingsSchema.safeParse({ automaticClipsEnabled: false, automaticCooldownSeconds: 0 }).success).toBe(true);
    expect(clipsSettingsSchema.safeParse({ automaticThresholdMultiplier: 0 }).success).toBe(false);
  });

  it("keeps unreleased clip settings visible with neutral bilingual copy", () => {
    expect(clipsPanelTexts("de").lockedLaterVersion).toBe("Kommt in einer späteren Version.");
    expect(clipsPanelTexts("en").lockedLaterVersion).toBe("Coming in a later version.");
    for (const language of ["de", "en"] as const) {
      const labels = clipsPanelTexts(language);
      const copy = Object.values(labels).flatMap((value) => typeof value === "string" ? [value] : []);
      expect(copy.join(" ").toLocaleLowerCase()).not.toMatch(/not implemented|nicht implementiert|helix|code version|codeversion/u);
    }
  });

  it("does not register a chat command before its behavior is available", () => {
    expect(clipsModule.chatCommands).toBeUndefined();
  });

  it("owns its settings in the custom panel with bilingual labels and hints", () => {
    expect(clipsModule.panelManagesSettings).toBe(true);
    expect(clipsModule.panel).toBeDefined();
    expect(clipsModule.settingsEditor).toBeUndefined();

    const fieldCopy = {
      de: {
        commandMinimumRole: [clipsPanelTexts("de").commandRole, ...clipsPanelTexts("de").roleOptions.map(({ label }) => label)],
        commandCooldownSeconds: [clipsPanelTexts("de").commandCooldown],
        postClipLinkInChat: [clipsPanelTexts("de").chatLink, clipsPanelTexts("de").chatLinkEnabled],
        chatLinkTemplate: [clipsPanelTexts("de").chatMessage],
        automaticClipsEnabled: [clipsPanelTexts("de").automatic],
        automaticThresholdMultiplier: [clipsPanelTexts("de").threshold, clipsPanelTexts("de").thresholdUnit],
        automaticCooldownSeconds: [clipsPanelTexts("de").automaticCooldown],
      },
      en: {
        commandMinimumRole: [clipsPanelTexts("en").commandRole, ...clipsPanelTexts("en").roleOptions.map(({ label }) => label)],
        commandCooldownSeconds: [clipsPanelTexts("en").commandCooldown],
        postClipLinkInChat: [clipsPanelTexts("en").chatLink, clipsPanelTexts("en").chatLinkEnabled],
        chatLinkTemplate: [clipsPanelTexts("en").chatMessage],
        automaticClipsEnabled: [clipsPanelTexts("en").automatic],
        automaticThresholdMultiplier: [clipsPanelTexts("en").threshold, clipsPanelTexts("en").thresholdUnit],
        automaticCooldownSeconds: [clipsPanelTexts("en").automaticCooldown],
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

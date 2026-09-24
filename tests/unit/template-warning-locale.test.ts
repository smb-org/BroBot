import { describe, expect, it } from "vitest";

import { adsSettingsEditorCatalog } from "../../src/modules/ads/panel/locale";
import { raidSettingsEditorCatalog } from "../../src/modules/raid/panel/locale";
import { textCommandsTexts } from "../../src/modules/text_commands/panel/locale";

const catalogs = [
  { name: "text commands", messages: (language: "de" | "en") => textCommandsTexts(language).textAreaMessages },
  { name: "raids", messages: (language: "de" | "en") => raidSettingsEditorCatalog(language).templateMessages },
  { name: "ads", messages: (language: "de" | "en") => adsSettingsEditorCatalog(language).templateMessages },
];

describe("template warning messages", () => {
  it.each(catalogs)("keeps $name warnings concise in German and English", ({ messages }) => {
    for (const language of ["de", "en"] as const) {
      const warning = messages(language).unknownVariable("donations", "var.donations") as string;
      expect(warning).toContain("{donations}");
      expect(warning).toContain("{var.donations}");
      expect(warning).not.toContain("{user}");
      expect(warning).toMatch(language === "de" ? /Picker/u : /picker/u);

      const noSuggestion = messages(language).unknownVariable("not_a_variable", null) as string;
      expect(noSuggestion).toContain("{not_a_variable}");
      expect(noSuggestion).toMatch(language === "de" ? /Picker/u : /picker/u);
      expect(noSuggestion).not.toContain("{user}");
      expect(noSuggestion).not.toContain("{var.donations}");
    }
  });
});

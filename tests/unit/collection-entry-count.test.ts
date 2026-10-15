import { describe, expect, it } from "vitest";

import { faqTexts } from "../../src/modules/faq/panel/locale";
import { textCommandsTexts } from "../../src/modules/text_commands/panel/locale";

describe("collection entry count labels", () => {
  it("pluralizes text command counts in German and English", () => {
    expect(textCommandsTexts("de").entryCount(1)).toBe("1 Eintrag");
    expect(textCommandsTexts("de").entryCount(2)).toBe("2 Einträge");
    expect(textCommandsTexts("en").entryCount(1)).toBe("1 entry");
    expect(textCommandsTexts("en").entryCount(2)).toBe("2 entries");
  });

  it("pluralizes FAQ counts in German and English", () => {
    expect(faqTexts("de").entryCount(1)).toBe("1 Eintrag");
    expect(faqTexts("de").entryCount(2)).toBe("2 Einträge");
    expect(faqTexts("en").entryCount(1)).toBe("1 entry");
    expect(faqTexts("en").entryCount(2)).toBe("2 entries");
  });
});

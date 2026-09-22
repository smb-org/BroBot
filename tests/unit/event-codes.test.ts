import { describe, expect, it } from "vitest";

import { EVENT_CODES } from "../../src/contracts/values";
import { eventTexts, eventToneEntries } from "../../src/dashboard/locale";

/**
 * `EVENT_CODES` is the closed union `event_log.code` is written from --
 * `dashboard/locale.ts`'s `eventTexts`/`eventToneEntries` are each
 * `Record<EventCode, ...>`, so the compiler already refuses a build where a
 * code here has no label or no tone entry. This test is the runtime
 * belt-and-suspenders `tests/unit/detail-keys.test.ts` uses for detail
 * keys: it catches a value that reached `event_log.code` through an `as`
 * cast instead of the union, which the compiler cannot.
 */
describe("event codes", () => {
  it("gives every event code a label in both languages", () => {
    for (const code of EVENT_CODES) {
      expect(eventTexts.de[code], code).toBeDefined();
      expect(eventTexts.en[code], code).toBeDefined();
    }
  });

  it("gives every event code a tone entry with a word in both languages", () => {
    for (const code of EVENT_CODES) {
      const entry = eventToneEntries[code];
      expect(entry, code).toBeDefined();
      expect(entry.word.de.length, code).toBeGreaterThan(0);
      expect(entry.word.en.length, code).toBeGreaterThan(0);
    }
  });

  it("lets no German code through", () => {
    const suspicious = EVENT_CODES.filter((code) => /[äöüÄÖÜß]|unbekannt|fehler|fehlgeschlagen|gesendet|gezeichnet|verdacht|einstufung|entwarnung|ankuendigung|halte(?!d)|aktion|modul(?!e)|unterdrueckt|ungueltig|ausgeloest|deaktiviert|berechtigung|abgekuehlt|vorwarnung|zeitplan|uebersprungen|vollzustimmung/.test(code));
    expect(suspicious).toEqual([]);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The project rule (CLAUDE.md): source is English throughout -- identifiers,
 * comments, JSDoc, test names -- except the German half of the bilingual
 * catalogues. This scans every `.ts`, `.tsx`, and `.css` file under `src/` for the two
 * things a stray German fragment shows up as: an umlaut/ß, or one of a
 * short list of common German words as a whole word. CSS is scanned too, so
 * selectors, custom properties, and comments follow the same source rule. It is deliberately a
 * raw-text scan, not an AST walk restricted to string-literal nodes: the
 * rule covers comments and identifiers too, not just string content, so
 * scanning the whole file is the correct scope here (unlike
 * `role-sql-guard.test.ts`, which specifically needs to ignore comments).
 *
 * Allowlist entries are exact file paths with a one-line reason each --
 * no per-line ignores. Each is a dedicated bilingual catalogue (same shape
 * as `dashboard/locale.ts`): English keys, a `de` value half and an `en`
 * value half. If a catalogue file ever gets a German key or identifier
 * instead of just a German *value*, that's still a bug this test won't
 * catch by design (a key is also just a string in the file), so catalogue
 * additions are reviewed by hand for that.
 */
const ALLOWLIST: Record<string, string> = {
  "src/dashboard/locale.ts": "Bilingual DE/EN dashboard text catalogue; only its `de` half is German.",
  "src/dashboard/labels.ts": "Bilingual DE/EN per-page text catalogue (members, platform, roles); only its `de` half is German.",
  "src/dashboard/module-labels.ts": "Bilingual DE/EN module name/status/workspace text catalogue; only its `de` half is German.",
  "src/modules/ads/panel/locale.ts": "Bilingual DE/EN ads panel text catalogue; only its `de` half is German.",
  "src/modules/raid/panel/locale.ts": "Bilingual DE/EN raid panel text catalogue; only its `de` half is German.",
  "src/modules/text_commands/panel/locale.ts": "Bilingual DE/EN text-commands panel text catalogue; only its `de` half is German.",
  "src/modules/ads/contracts/chat-defaults.ts": "Default chat text the bot posts in the channel; chat templates are channel content and stay in the channel language (umbau-plan.md, section on chat templates).",
  "src/modules/raid/contracts/chat-defaults.ts": "Default chat text the bot posts in the channel; chat templates are channel content and stay in the channel language (umbau-plan.md, section on chat templates).",
  "src/modules/text_commands/contracts/chat-defaults.ts": "Default chat text the bot posts in the channel; chat templates are channel content and stay in the channel language (umbau-plan.md, section on chat templates).",
  "src/worker/auth/oauth-error-texts.ts": "Bilingual DE/EN catalogue for OAuth redirect pages the browser shows directly -- no dashboard script sits between Twitch's redirect and the page to translate a code, so this stays prose (see the file's own comment).",
};

const GERMAN_WORDS = [
  "nicht", "konnte", "fehlgeschlagen", "ungültig", "wird", "ist", "und",
  "der", "die", "das", "für", "kein", "keine", "bereits", "zuerst",
  "breit", "schmal", "mittel", "linie", "stark", "erhoben", "ausgestellt",
  "widerrufen", "zeile", "liste",
];
const wordPattern = new RegExp(`\\b(${GERMAN_WORDS.join("|")})\\b`, "iu");
const umlautPattern = /[äöüÄÖÜß]/u;

const srcRoot = path.resolve(import.meta.dirname, "../../src");
const repoRoot = path.resolve(import.meta.dirname, "../..");

const repoRelative = (filePath: string): string =>
  path.relative(repoRoot, filePath).replaceAll(path.sep, "/");

const filesUnder = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
  })
  .sort();

describe("German guard", () => {
  it("keeps every allowlist entry pointed at a file that actually exists", () => {
    const files = new Set(filesUnder(srcRoot).map(repoRelative));
    for (const entry of Object.keys(ALLOWLIST)) {
      expect(files.has(entry), `${entry} (stale allowlist entry)`).toBe(true);
    }
  });

  it("finds no German word or umlaut/ß outside the allowlisted catalogue files", () => {
    const files = filesUnder(srcRoot);
    // Without this floor, the test would pass if the scan silently walked
    // no files -- for example because `srcRoot` stopped resolving.
    expect(files.length).toBeGreaterThan(100);

    const hits: string[] = [];
    for (const filePath of files) {
      const relative = repoRelative(filePath);
      if (Object.prototype.hasOwnProperty.call(ALLOWLIST, relative)) continue;
      const lines = readFileSync(filePath, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (umlautPattern.test(line) || wordPattern.test(line)) {
          hits.push(`${relative}:${String(index + 1)}: ${line.trim().slice(0, 160)}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});

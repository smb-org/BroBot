import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The project rule (CLAUDE.md): source is English throughout -- identifiers,
 * comments, JSDoc, test names -- except the German half of the bilingual
 * catalogues. This scans every `.ts`, `.tsx`, and `.css` file under `src/`
 * for three things a stray German fragment shows up as: an umlaut/ß, one of
 * a short list of common German words as a whole word, or a known German
 * fragment inside a quoted snake_case machine-code value (`germanSnakeCase
 * LiteralsIn`'s comment explains why that third check exists separately).
 * CSS is scanned too, so selectors, custom properties, and comments follow
 * the same source rule. It is deliberately a raw-text scan, not an AST walk
 * restricted to string-literal nodes: the rule covers comments and
 * identifiers too, not just string content, so scanning the whole file is
 * the correct scope here (unlike `role-sql-guard.test.ts`, which
 * specifically needs to ignore comments).
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
  "src/modules/raid/panel/immediate-action-locale.ts": "Bilingual DE/EN raid immediate-action text catalogue; only its `de` half is German.",
  "src/modules/clips/panel/locale.ts": "Bilingual DE/EN clips immediate-action text catalogue; only its `de` half is German.",
  "src/modules/text_commands/panel/locale.ts": "Bilingual DE/EN text-commands panel text catalogue; only its `de` half is German.",
  "src/modules/ads/contracts/chat-defaults.ts": "Default chat text the bot posts in the channel; chat templates are channel content and stay in the channel language (umbau-plan.md, section on chat templates).",
  "src/modules/raid/contracts/chat-defaults.ts": "Default chat text the bot posts in the channel; chat templates are channel content and stay in the channel language (umbau-plan.md, section on chat templates).",
  "src/modules/text_commands/contracts/chat-defaults.ts": "Default chat text the bot posts in the channel; chat templates are channel content and stay in the channel language (umbau-plan.md, section on chat templates).",
  "src/worker/auth/oauth-error-texts.ts": "Bilingual DE/EN catalogue for OAuth redirect pages the browser shows directly -- no dashboard script sits between Twitch's redirect and the page to translate a code, so this stays prose (see the file's own comment).",
  "src/dashboard/events/legacy-reasons.ts": "Migration map from old German event-log reason values (issue #191) to their English replacements -- the old values are map keys, not prose, and have to appear as literal source text for 14 days of event-log retention; see the file's own comment for the drop date.",
};

const GERMAN_WORDS = [
  "nicht", "konnte", "fehlgeschlagen", "ungültig", "wird", "ist", "und",
  "der", "die", "das", "für", "kein", "keine", "bereits", "zuerst",
  "breit", "schmal", "mittel", "linie", "stark", "erhoben", "ausgestellt",
  "widerrufen", "zeile", "liste", "abgeschaltet",
];
const wordPattern = new RegExp(`\\b(${GERMAN_WORDS.join("|")})\\b`, "iu");
const umlautPattern = /[äöüÄÖÜß]/u;

/**
 * A machine-code value made of German words survives the two checks above:
 * transliterated ASCII (`ungueltig`, not `ungültig`) has no umlaut, and an
 * underscore is a word character, so `\bziel\b` never matches inside
 * `ziel_ungueltig` (issue #191 -- these strings shipped as real
 * `EventCode`/reason values before anyone noticed the guard couldn't see
 * them). This second, narrower check looks specifically at quoted
 * snake_case string literals (single, double, or backtick-quoted -- a
 * template literal with `${...}` interpolation doesn't match the
 * plain-snake_case character class, so only a literal value trips this),
 * segment by segment, against a short explicit list of known German
 * fragments. An earlier version also flagged any segment containing a
 * `ue`/`oe`/`ae` letter pair as a possible umlaut transliteration, guarded
 * by an allowlist of common English exceptions -- dropped because the
 * allowlist could never keep up (e.g. "queued_message" false-positived);
 * an explicit fragment list is worth more than a heuristic that needs its
 * own exception list to stay usable.
 */
const GERMAN_SNAKE_FRAGMENTS = new Set([
  "ungueltig", "schwelle", "dauer", "abgeschaltet", "ziel", "quelle", "zuschauer",
]);

/** True when `segment` (one `_`-delimited piece of a lowercase snake_case
 *  token, already stripped of quotes) reads as a German-language machine
 *  code -- see the block comment above. */
const looksGermanSnakeCase = (segment: string): boolean => GERMAN_SNAKE_FRAGMENTS.has(segment);

/** Every quoted (`"..."`, `'...'`, or `` `...` ``), lowercase,
 *  underscore-joined string literal in `line` (`"foo_bar"`, not a bare
 *  `"foo"` -- see `looksGermanSnakeCase`'s comment) where at least one
 *  segment looks German. */
const germanSnakeCaseLiteralsIn = (line: string): string[] => {
  const hits: string[] = [];
  for (const match of line.matchAll(/(["'`])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\1/g)) {
    const value = match[2];
    if (value !== undefined && value.split("_").some(looksGermanSnakeCase)) hits.push(value);
  }
  return hits;
};

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
        const snakeCaseHits = germanSnakeCaseLiteralsIn(line);
        if (umlautPattern.test(line) || wordPattern.test(line) || snakeCaseHits.length > 0) {
          hits.push(`${relative}:${String(index + 1)}: ${line.trim().slice(0, 160)}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("flags German-language snake_case code values without over-flagging ordinary English ones", () => {
    // The values #191 actually shipped, renamed since (see `contracts/
    // values.ts`'s `RaidInvalidReason`/`ShoutoutSuppressedReason`/
    // `AdsSkippedReason`) -- still checked here as regression fixtures, not
    // because they exist in source anymore.
    expect(germanSnakeCaseLiteralsIn('reason: "dauer_null"')).toEqual(["dauer_null"]);
    expect(germanSnakeCaseLiteralsIn('reason: "dauer_ungueltig"')).toEqual(["dauer_ungueltig"]);
    expect(germanSnakeCaseLiteralsIn('reason: "start_ungueltig"')).toEqual(["start_ungueltig"]);
    expect(germanSnakeCaseLiteralsIn('reason: "ziel_ungueltig"')).toEqual(["ziel_ungueltig"]);
    expect(germanSnakeCaseLiteralsIn('reason: "quelle_ungueltig"')).toEqual(["quelle_ungueltig"]);
    expect(germanSnakeCaseLiteralsIn('reason: "zuschauer_ungueltig"')).toEqual(["zuschauer_ungueltig"]);
    expect(germanSnakeCaseLiteralsIn('reason: "unter_schwelle"')).toEqual(["unter_schwelle"]);
    // A single German word with no underscore isn't this check's job --
    // `wordPattern` above already catches "abgeschaltet" as a whole word.
    expect(germanSnakeCaseLiteralsIn('reason: "abgeschaltet"')).toEqual([]);

    // The same fragment, single- and backtick-quoted -- source doesn't only
    // use double quotes.
    expect(germanSnakeCaseLiteralsIn("reason: 'ziel_ungueltig'")).toEqual(["ziel_ungueltig"]);
    expect(germanSnakeCaseLiteralsIn("reason: `ziel_ungueltig`")).toEqual(["ziel_ungueltig"]);
    // Mismatched quote characters around the same text don't count as one
    // literal -- `"ziel_ungueltig'` isn't valid source either way.
    expect(germanSnakeCaseLiteralsIn("reason: \"ziel_ungueltig'")).toEqual([]);
    // A template literal with real interpolation isn't a plain snake_case
    // value, so it doesn't match at all (nothing to flag or not flag).
    expect(germanSnakeCaseLiteralsIn("reason: `ziel_${suffix}`")).toEqual([]);

    // Ordinary English snake_case machine values must not trip it --
    // including ones a dropped `ue`/`oe`/`ae` heuristic used to flag.
    expect(germanSnakeCaseLiteralsIn('code: "request_failed"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('code: "panel_request_not_allowed"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('code: "channel_owner_only_consent_request"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn("status: 'queued_message'")).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('reason: "rate_limited"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('reason: "not_live"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('reason: "duration_zero"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('reason: "below_threshold"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('reason: "target_invalid"')).toEqual([]);
    expect(germanSnakeCaseLiteralsIn('reason: "bot_identity_missing"')).toEqual([]);
  });
});

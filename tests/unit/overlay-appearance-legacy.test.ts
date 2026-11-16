import { describe, expect, it } from "vitest";

import {
  migrateLegacyOverlayStyles,
  replaceOverlayStyleBlock,
  resolveOverlayElementColors,
  type OverlayStyleDocument,
} from "../../src/dashboard/overlay-style-model";
import { MODULE_OVERLAY_ELEMENTS } from "../../src/modules/overlay-element-registry";

// Literal copies of pre-change configs and rendered colors, independent of module defaults.
const plainText = { background: "transparent", text: "rgba(255, 255, 255, 0.96)" };
const statisticsColors = { background: "#0d1015", text: "#f2f5f9", secondaryText: "#a8b2c1" };

interface LegacyCase {
  kind: string;
  oldDefault: Record<string, unknown>;
  oldColors: Record<string, string>;
  custom?: { stored: Record<string, unknown>; colors: Record<string, string>; specific: Record<string, unknown> };
}

const cases: readonly LegacyCase[] = [
  { kind: "ads.countdown", oldDefault: { showSnoozeInfo: false }, oldColors: plainText },
  { kind: "belabox.status", oldDefault: { layout: "compact", unit: "kbps", hideWhenHealthy: false }, oldColors: plainText },
  {
    kind: "chat_voting.tally",
    oldDefault: { layout: "bars", showPercent: true, showCountdown: true, useVoteColors: true, hideAfterCloseSeconds: 15, width: 480 },
    oldColors: plainText,
  },
  { kind: "song_requests.now_playing", oldDefault: { showCover: true, showRequester: true }, oldColors: { background: "#0d1015", text: "#f2f5f9", secondaryText: "#c3cbd7", accent: "#1ed760" } },
  { kind: "song_requests.queue", oldDefault: {}, oldColors: { background: "#0d1015", text: "#f2f5f9", secondaryText: "#c3cbd7", accent: "#8ab4ff" } },
  { kind: "statistics.word_counter", oldDefault: { word: "helo", label: "hello", show: "both" }, oldColors: statisticsColors },
  { kind: "statistics.word_ranking", oldDefault: { scope: "stream", count: 5, bars: true }, oldColors: { ...statisticsColors, accent: "#35557f" } },
  { kind: "text_library.block", oldDefault: { blockName: "" }, oldColors: { background: "transparent", text: "rgba(255, 255, 255, 0.96)", secondaryText: "rgba(255, 255, 255, 0.78)" } },
  { kind: "votekick.tally", oldDefault: { showCountdown: true, hideAfterCloseSeconds: 15 }, oldColors: plainText },
  {
    kind: "quiz.session",
    oldDefault: {
      showQuestionProgress: true, showPercent: true, backgroundColor: "#10141b", textColor: "#f2f5f9",
      secondaryColor: "#a8b2c1", accentColor: "#5fa4ff", correctColor: "#32ca88",
    },
    oldColors: { background: "#10141b", text: "#f2f5f9", secondaryText: "#a8b2c1", accent: "#5fa4ff" },
    custom: {
      stored: { showQuestionProgress: false, showPercent: false, backgroundColor: "#111111", textColor: "#222222", secondaryColor: "#333333", accentColor: "#444444", correctColor: "#555555" },
      colors: { background: "#111111", text: "#222222", secondaryText: "#333333", accent: "#444444" },
      specific: { showQuestionProgress: false, showPercent: false, correctColor: "#555555" },
    },
  },
  {
    kind: "emote_slots.slot",
    oldDefault: { backgroundColor: "#090C10", textColor: "#F2F5F9", secondaryColor: "#C9D1DB", highlightColor: "#2ED3A3", borderColor: "#353E4B" },
    oldColors: { background: "#090C10", text: "#F2F5F9", secondaryText: "#C9D1DB", accent: "#2ED3A3" },
    custom: {
      stored: { backgroundColor: "#111111", textColor: "#222222", secondaryColor: "#333333", highlightColor: "#444444", borderColor: "#555555" },
      colors: { background: "#111111", text: "#222222", secondaryText: "#333333", accent: "#444444" },
      specific: { borderColor: "#555555" },
    },
  },
  {
    kind: "overlay_alerts.alert",
    oldDefault: { textColor: "#ffffff", fontSize: 32 },
    oldColors: { background: "rgb(16 20 27 / 84%)", text: "#ffffff" },
    custom: {
      stored: { textColor: "#abcdef", fontSize: 56 },
      colors: { background: "rgb(16 20 27 / 84%)", text: "#abcdef" },
      specific: { fontSize: 56 },
    },
  },
];

const definitionOf = (kind: string) => {
  const definition = MODULE_OVERLAY_ELEMENTS.find((registered) => registered.definition.kind === kind)?.definition;
  if (definition === undefined) throw new Error(`Element ${kind} is not registered.`);
  return definition;
};

const styleFor = (colors: Readonly<Record<string, string>>): OverlayStyleDocument["elements"][string] => ({
  ...(colors.background === undefined || colors.background === "transparent" || !/^#[0-9a-f]{6}$/iu.test(colors.background) ? {} : { background: { color: colors.background, opacityPercent: 100 } }),
  ...(colors.text === undefined ? {} : { color: colors.text }),
  ...(colors.secondaryText === undefined ? {} : { secondaryTextColor: colors.secondaryText }),
  ...(colors.accent === undefined ? {} : { accentColor: colors.accent }),
});

describe("overlay style legacy compatibility", () => {
  it("covers all 12 registered module elements", () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect(cases.map((entry) => entry.kind).sort(byName)).toEqual(MODULE_OVERLAY_ELEMENTS.map(({ definition }) => definition.kind).sort(byName));
  });

  it.each(cases)("$kind: default legacy config keeps its old rendered colors and options", ({ kind, oldDefault, oldColors }) => {
    const definition = definitionOf(kind);
    const parsed = definition.parseConfig(oldDefault);
    const effective = resolveOverlayElementColors(kind, parsed ?? {}, {}, {});

    expect(parsed).not.toBeNull();
    expect(effective).toMatchObject(oldColors);
    expect(effective.background).toBe(oldColors.background);
    expect(effective.text).toBe(oldColors.text);
    expect(parsed).toMatchObject(Object.fromEntries(Object.entries(oldDefault).filter(([key]) => !["backgroundColor", "textColor", "secondaryColor", "accentColor", "highlightColor"].includes(key))));
  });

  it.each(cases.filter((entry) => entry.custom !== undefined))("$kind: opening migrates legacy colors to the Style document and preserves module options", ({ kind, custom }) => {
    const legacy = custom;
    if (legacy === undefined) throw new Error("Expected legacy config fixture.");
    const definition = definitionOf(kind);
    const parsed = definition.parseConfig(legacy.stored);
    const source = [{ id: "legacy-element", kind, config: parsed ?? {} }];
    const migration = migrateLegacyOverlayStyles(source, { overlay: {}, elements: {} });
    const storedCss = replaceOverlayStyleBlock("", migration.styles, ["legacy-element"]);
    const effective = resolveOverlayElementColors(
      kind,
      migration.elements[0]?.config ?? {},
      migration.styles.elements["legacy-element"] ?? {},
      migration.styles.overlay,
    );

    expect(migration.styles.elements["legacy-element"]).toMatchObject(styleFor(legacy.colors));
    expect(effective).toMatchObject(legacy.colors);
    expect(migration.elements[0]?.config).toMatchObject(legacy.specific);
    expect(migration.elements[0]?.config).not.toHaveProperty("backgroundColor");
    expect(migration.elements[0]?.config).not.toHaveProperty("textColor");
    expect(migration.elements[0]?.config).not.toHaveProperty("secondaryColor");
    expect(migration.elements[0]?.config).not.toHaveProperty("accentColor");
    expect(migration.elements[0]?.config).not.toHaveProperty("highlightColor");
    expect(storedCss).toContain("--brobot-overlay-text-color");
    expect(definition.parseConfig(migration.elements[0]?.config)).toMatchObject(legacy.specific);
  });

  it.each([
    ["quiz.session", { backgroundColor: null, textColor: null, secondaryColor: null, accentColor: null, correctColor: "#32ca88", showPercent: false }, { showPercent: false, correctColor: "#32ca88" }],
    ["overlay_alerts.alert", { textColor: null, fontSize: 56 }, { fontSize: 56 }],
    ["emote_slots.slot", { backgroundColor: null, textColor: null, secondaryColor: null, highlightColor: null, borderColor: "#445566" }, { borderColor: "#445566" }],
    ["emote_slots.slot", { backgroundColor: null, textColor: null, secondaryColor: null, highlightColor: null, borderColor: null }, { borderColor: "#353E4B" }],
  ] as const)("%s: null legacy colors mean default and do not discard other values", (kind, raw, expected) => {
    const definition = definitionOf(kind);
    const parsed = definition.parseConfig(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject(expected);
    const migrated = migrateLegacyOverlayStyles([{ id: "null-element", kind, config: parsed ?? {} }], { overlay: {}, elements: {} });
    const before = resolveOverlayElementColors(kind, parsed ?? {}, {}, {});
    const after = resolveOverlayElementColors(kind, migrated.elements[0]?.config ?? {}, migrated.styles.elements["null-element"] ?? {}, {});
    const normalizedColors = (colors: ReturnType<typeof resolveOverlayElementColors>) => ({
      background: colors.background.toLowerCase(),
      text: colors.text.toLowerCase(),
      ...(colors.secondaryText === undefined ? {} : { secondaryText: colors.secondaryText.toLowerCase() }),
      ...(colors.accent === undefined ? {} : { accent: colors.accent.toLowerCase() }),
    });
    expect(migrated.elements[0]?.config).toMatchObject(expected);
    expect(migrated.elements[0]?.config).not.toHaveProperty("textColor");
    expect(migrated.elements[0]?.config).not.toHaveProperty("backgroundColor");
    expect(normalizedColors(after)).toEqual(normalizedColors(before));
    expect(migrated.styles.elements["null-element"]).toBeDefined();
  });
});

import { describe, expect, it } from "vitest";

import { MODULE_OVERLAY_ELEMENTS } from "../../src/modules/overlay-element-registry";

// Literal copies of the pre-appearance defaults and stored shapes, independent of the element declarations.
const plainText = { background: "transparent", text: "rgba(255, 255, 255, 0.96)" };
const statisticsColors = { background: "#0d1015", text: "#f2f5f9", secondaryText: "#a8b2c1" };

interface LegacyCase {
  kind: string;
  /** The defaultConfig this element had before the shared appearance block. */
  oldDefault: Record<string, unknown>;
  oldColors: Record<string, string>;
  /** Old stored config that carries custom colours, when the old element had any. */
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
  { kind: "statistics.word_counter", oldDefault: { word: "helo", label: "hello", show: "both" }, oldColors: statisticsColors },
  { kind: "statistics.word_ranking", oldDefault: { scope: "stream", count: 5, bars: true }, oldColors: { ...statisticsColors, accent: "#35557f" } },
  {
    kind: "text_library.block",
    oldDefault: { blockName: "" },
    oldColors: { background: "transparent", text: "rgba(255, 255, 255, 0.96)", secondaryText: "rgba(255, 255, 255, 0.78)" },
  },
  { kind: "votekick.tally", oldDefault: { showCountdown: true, hideAfterCloseSeconds: 15 }, oldColors: plainText },
  {
    kind: "quiz.session",
    oldDefault: {
      showQuestionProgress: true, showPercent: true, backgroundColor: "#10141b", textColor: "#f2f5f9",
      secondaryColor: "#a8b2c1", accentColor: "#5fa4ff", correctColor: "#32ca88",
    },
    oldColors: { background: "#10141b", text: "#f2f5f9", secondaryText: "#a8b2c1", accent: "#5fa4ff" },
    custom: {
      stored: {
        showQuestionProgress: false, showPercent: false, backgroundColor: "#111111", textColor: "#222222",
        secondaryColor: "#333333", accentColor: "#444444", correctColor: "#555555",
      },
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

describe("overlay appearance: nothing is lost for stored configs", () => {
  it("covers every registered element", () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect(cases.map((entry) => entry.kind).sort(byName)).toEqual(MODULE_OVERLAY_ELEMENTS.map(({ definition }) => definition.kind).sort(byName));
  });

  it.each(cases)("$kind: the old default config keeps its colours and options", ({ kind, oldDefault, oldColors }) => {
    const definition = definitionOf(kind);
    const parsed = definition.parseConfig(oldDefault);
    const colorKeys = new Set(["backgroundColor", "textColor", "secondaryColor", "accentColor", "highlightColor"]);

    expect(parsed).not.toBeNull();
    expect(parsed?.appearance).toEqual(oldColors);
    expect(definition.appearance.defaults).toEqual(oldColors);
    expect(parsed).toMatchObject(Object.fromEntries(Object.entries(oldDefault).filter(([key]) => !colorKeys.has(key))));
    // The element's own new default must parse to the same effective result.
    expect(definition.parseConfig(definition.defaultConfig)).toEqual(parsed);
  });

  it.each(cases.filter((entry) => entry.custom !== undefined))("$kind: custom stored colours migrate without loss", ({ kind, custom }) => {
    const definition = definitionOf(kind);
    const parsed = definition.parseConfig(custom?.stored);

    expect(parsed?.appearance).toEqual(custom?.colors);
    expect(parsed).toMatchObject(custom?.specific ?? {});
    // Saving the migrated config again (as the editor does) is stable.
    expect(definition.parseConfig(parsed)).toEqual(parsed);
  });
});

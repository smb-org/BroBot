import { describe, expect, it } from "vitest";

import { MODULE_OVERLAY_ELEMENTS } from "../../src/modules/overlay-element-registry";
import { overlayAppearanceContrastRatio } from "../../src/overlay/appearance";

const legacyConfigurations: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "ads.countdown": { showSnoozeInfo: true },
  "belabox.status": { layout: "detail", unit: "mbps", hideWhenHealthy: true },
  "chat_voting.tally": { layout: "strip", showPercent: false, showCountdown: false, useVoteColors: false, hideAfterCloseSeconds: 0, width: 600 },
  "song_requests.now_playing": { showCover: false, showRequester: false },
  "statistics.word_counter": { word: "viewer", label: "Viewer", show: "stream" },
  "statistics.word_ranking": { scope: "total", count: 7, title: "Top words", bars: false },
  "text_library.block": { blockName: "welcome" },
  "votekick.tally": { showCountdown: false, hideAfterCloseSeconds: 0 },
  "quiz.session": {
    showQuestionProgress: false,
    showPercent: false,
    backgroundColor: "#102030",
    textColor: "#203040",
    secondaryColor: "#304050",
    accentColor: "#405060",
    correctColor: "#32ca88",
  },
  "emote_slots.slot": {
    backgroundColor: "#112233",
    textColor: "#223344",
    secondaryColor: "#334455",
    highlightColor: "#445566",
    borderColor: "#556677",
  },
  "overlay_alerts.alert": { textColor: "#abcdef", fontSize: 48 },
};

const legacyAppearanceByKind: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "ads.countdown": {},
  "belabox.status": {},
  "chat_voting.tally": {},
  "song_requests.now_playing": {},
  "statistics.word_counter": {},
  "statistics.word_ranking": {},
  "text_library.block": {},
  "votekick.tally": {},
  "quiz.session": { background: "#102030", text: "#203040", secondaryText: "#304050", accent: "#405060" },
  "emote_slots.slot": { background: "#112233", text: "#223344", secondaryText: "#334455", accent: "#445566" },
  "overlay_alerts.alert": { text: "#abcdef" },
};

const legacyAppearanceKeysByKind: Readonly<Record<string, readonly string[]>> = {
  "ads.countdown": [],
  "belabox.status": [],
  "chat_voting.tally": [],
  "song_requests.now_playing": [],
  "statistics.word_counter": [],
  "statistics.word_ranking": [],
  "text_library.block": [],
  "votekick.tally": [],
  "quiz.session": ["backgroundColor", "textColor", "secondaryColor", "accentColor"],
  "emote_slots.slot": ["backgroundColor", "textColor", "secondaryColor", "highlightColor"],
  "overlay_alerts.alert": ["textColor"],
};

const oldElementSpecificConfig = (kind: string): Readonly<Record<string, unknown>> => Object.fromEntries(
  Object.entries(legacyConfigurations[kind] ?? {}).filter(([key]) => !legacyAppearanceKeysByKind[kind]?.includes(key)),
);

describe("overlay appearance config", () => {
  it.each(MODULE_OVERLAY_ELEMENTS.map(({ definition }) => definition))("keeps the effective colors for the old $kind config", (definition) => {
    const parsed = definition.parseConfig(legacyConfigurations[definition.kind]);

    expect(parsed).not.toBeNull();
    expect(parsed?.appearance).toEqual({
      ...definition.appearance.defaults,
      ...legacyAppearanceByKind[definition.kind],
    });
    expect(parsed).toMatchObject(oldElementSpecificConfig(definition.kind));
  });

  it.each(MODULE_OVERLAY_ELEMENTS.map(({ definition }) => definition))("adds declared defaults when the old $kind config has no colors", (definition) => {
    const colorlessConfig = Object.fromEntries(
      Object.entries(legacyConfigurations[definition.kind] ?? {}).filter(([key]) => !legacyAppearanceKeysByKind[definition.kind]?.includes(key)),
    );
    const parsed = definition.parseConfig(colorlessConfig);

    expect(parsed?.appearance).toEqual(definition.appearance.defaults);
  });

  it("rejects invalid shared and legacy color values", () => {
    const quiz = MODULE_OVERLAY_ELEMENTS.find(({ definition }) => definition.kind === "quiz.session")?.definition;
    const slots = MODULE_OVERLAY_ELEMENTS.find(({ definition }) => definition.kind === "emote_slots.slot")?.definition;

    expect(quiz?.parseConfig({ appearance: { text: "url(javascript:alert(1))" } })).toBeNull();
    expect(quiz?.parseConfig({ appearance: { text: null } })).toBeNull();
    expect(slots?.parseConfig({ highlightColor: "red" })).toBeNull();
  });

  it("keeps transparent backgrounds and computes shared contrast", () => {
    expect(overlayAppearanceContrastRatio("#ffffff", "transparent")).toBeNull();
    expect(overlayAppearanceContrastRatio("#ffffff", "#000000")).toBeGreaterThanOrEqual(21);
  });
});

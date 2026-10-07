import { describe, expect, it } from "vitest";

import { groupOverlayElementPaletteItems, type OverlayElementPaletteItem } from "../../src/dashboard/overlay-element-palette-model";

const categories = { chat: "Chat", interaction: "Interaction", data: "Data", twitch: "Twitch" } as const;

const items: readonly OverlayElementPaletteItem[] = [
  { id: "ads", groupId: "twitch", label: "Ad countdown", description: "Time until next ad break.", moduleName: "Ad breaks" },
  { id: "score", groupId: "variables", label: "score", description: "Current score.", variableName: "score", currentValue: "12" },
  { id: "tally", groupId: "interaction", label: "Voting tally", description: "Live bars for the current vote.", moduleName: "Chat voting" },
  { id: "chat-off", groupId: "chat", label: "Command card", description: "Module is disabled.", moduleName: "Text commands", disabledReason: "Module off" },
  { id: "block", groupId: "chat", label: "Text block", description: "Shows a text library block.", moduleName: "Text library" },
  { id: "weather", groupId: "data", label: "Weather", description: "Current conditions.", moduleName: "Weather" },
];

describe("overlay element palette model", () => {
  it("groups variables first, then follows the module sidebar category order", () => {
    expect(groupOverlayElementPaletteItems(items, categories, "Channel variables").map(({ id, label }) => [id, label])).toEqual([
      ["variables", "Channel variables"],
      ["chat", "Chat"],
      ["interaction", "Interaction"],
      ["data", "Data"],
      ["twitch", "Twitch"],
    ]);
    expect(groupOverlayElementPaletteItems(items, categories, "Channel variables")[1]?.items.map(({ id }) => id)).toEqual(["block", "chat-off"]);
  });

  it("filters names, descriptions, module names, and variable names without empty groups", () => {
    expect(groupOverlayElementPaletteItems(items, categories, "Channel variables", "TEXT LIBRARY").map(({ id, items: groupItems }) => [id, groupItems.map(({ id: itemId }) => itemId)])).toEqual([
      ["chat", ["block"]],
    ]);
    expect(groupOverlayElementPaletteItems(items, categories, "Channel variables", "current score").flatMap(({ items: groupItems }) => groupItems.map(({ id }) => id))).toEqual(["score"]);
  });
});

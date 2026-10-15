import { describe, expect, it } from "vitest";

import {
  currencyTokenTargets,
  isSystemTemplateModuleId,
  keepOnlyActiveKindDraft,
  minimumTierAfterVariableOperation,
  replaceCurrencyTokenAt,
  switchTextCommandKind,
  type CommandDraft,
} from "../../src/modules/text_commands/panel/editor-state";

const draft = (overrides: Partial<CommandDraft> = {}): CommandDraft => ({
  name: "hello",
  enabled: true,
  kind: "text",
  text: "Text response",
  usageText: "Usage response",
  variableAction: { name: "score", operation: "add", amount: 2 },
  timeoutAction: null,
  minimumTier: "everyone",
  cooldownSeconds: 5,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  games: [],
  responseType: "say",
  chatTarget: null,
  kindDrafts: {
    text: {
      text: "Text response",
      usageText: "Usage response",
      variableAction: { name: "score", operation: "add", amount: 2 },
      timeoutAction: null,
    },
  },
  ...overrides,
});

describe("text command editor defaults", () => {
  it("defaults set_argument to moderators until the user chooses a tier in the draft", () => {
    expect(minimumTierAfterVariableOperation("everyone", "set_argument", false)).toBe("moderator");
  });

  it("preserves an explicit everyone choice and existing stronger tiers", () => {
    expect(minimumTierAfterVariableOperation("everyone", "set_argument", true)).toBe("everyone");
    expect(minimumTierAfterVariableOperation("vip", "set_argument", false)).toBe("vip");
  });

  it("does not change the tier for other variable operations", () => {
    expect(minimumTierAfterVariableOperation("everyone", "add", false)).toBe("everyone");
  });

  it("does nothing when the selected response kind is selected again", () => {
    const current = draft({ kind: "shoutout", text: "Custom shoutout text" });
    expect(switchTextCommandKind(current, "shoutout", false)).toBe(current);
  });

  it("restores each response kind draft when switching away and back", () => {
    const current = draft();
    const shoutout = {
      ...switchTextCommandKind(current, "shoutout", false),
      text: "Custom shoutout response",
      usageText: "Custom shoutout usage",
    };
    const list = switchTextCommandKind(shoutout, "list", false);
    const restoredShoutout = switchTextCommandKind(list, "shoutout", false);
    const timeout = {
      ...switchTextCommandKind(restoredShoutout, "timeout", false),
      text: "Custom timeout response",
      timeoutAction: { minSeconds: 30, maxSeconds: 90, fallbackText: "Rejected", reason: "Spam" },
    };
    const restoredTimeout = switchTextCommandKind(switchTextCommandKind(timeout, "text", false), "timeout", false);
    const restoredText = switchTextCommandKind(restoredTimeout, "text", false);

    expect(restoredShoutout).toMatchObject({ kind: "shoutout", text: "Custom shoutout response", usageText: "Custom shoutout usage" });
    expect(restoredTimeout).toMatchObject({ kind: "timeout", text: "Custom timeout response", timeoutAction: { minSeconds: 30, maxSeconds: 90, fallbackText: "Rejected", reason: "Spam" } });
    expect(restoredText).toMatchObject({ kind: "text", text: "Text response", variableAction: { name: "score", operation: "add", amount: 2 } });
  });

  it("keeps only the active kind's draft when preparing a save", () => {
    const switchingDraft = {
      ...draft(),
      kind: "list" as const,
      text: "",
      usageText: "",
      variableAction: null,
      timeoutAction: null,
      kindDrafts: {
        text: { text: "Text response", usageText: "Usage response", variableAction: null, timeoutAction: null },
        list: { text: "", usageText: "", variableAction: null, timeoutAction: null },
      },
    };

    expect(keepOnlyActiveKindDraft(switchingDraft).kindDrafts).toEqual({
      list: { text: "", usageText: "", variableAction: null, timeoutAction: null },
    });
  });

  it("targets currency tokens by field and occurrence", () => {
    const response = "{currency.convert USD EUR} then {currency.convert GBP CAD}";
    const usage = "{currency.convert CHF CNY}";
    const targets = currencyTokenTargets([
      { field: "text", value: response },
      { field: "usageText", value: usage },
    ]);

    expect(targets).toEqual([
      { id: "text:0", field: "text", index: 0, from: "USD", to: "EUR" },
      { id: "text:1", field: "text", index: 1, from: "GBP", to: "CAD" },
      { id: "usageText:0", field: "usageText", index: 0, from: "CHF", to: "CNY" },
    ]);
    expect(replaceCurrencyTokenAt(response, 1, "JPY", "AUD")).toBe("{currency.convert USD EUR} then {currency.convert JPY AUD}");
    expect(usage).toBe("{currency.convert CHF CNY}");
  });

  it("classifies host variables as system variables", () => {
    expect(isSystemTemplateModuleId("host")).toBe(true);
    expect(isSystemTemplateModuleId("core")).toBe(true);
    expect(isSystemTemplateModuleId("text_library")).toBe(false);
  });
});

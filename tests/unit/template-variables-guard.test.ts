import { describe, expect, it } from "vitest";

import { effectiveTemplateVariables, parseTemplateRange, renderTemplate, unknownTemplateVariables } from "../../src/template";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../src/template-variables";
import { systemTemplateVariableLocale } from "../../src/dashboard/locale";
import type { TemplateVariable } from "../../src/template";

describe("template variable catalog", () => {
  it("provides bilingual descriptions and samples for every system variable", () => {
    const names = SYSTEM_TEMPLATE_VARIABLE_LIST.map(({ name }) => name).sort();
    for (const language of ["de", "en"] as const) {
      expect(Object.keys(systemTemplateVariableLocale[language]).sort()).toEqual(names);
      for (const entry of Object.values(systemTemplateVariableLocale[language])) {
        expect(entry.description.trim().length).toBeGreaterThan(0);
        expect(entry.sample.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("freezes system variables behind a module declaration and adds channel variables", () => {
    const moduleVariables: readonly TemplateVariable[] = [
      { name: "channel", group: "event", sample: "raider", maxLength: 25 },
    ];
    const channelVariables: readonly TemplateVariable[] = [
      { name: "var.points", group: "channel", sample: "4", maxLength: 10 },
    ];
    const effective = effectiveTemplateVariables(
      "event",
      moduleVariables,
      channelVariables,
      SYSTEM_TEMPLATE_VARIABLE_LIST,
    );

    expect(effective.filter(({ name }) => name === "channel")).toEqual([
      { ...moduleVariables[0], source: "module" },
    ]);
    expect(effective.find(({ name }) => name === "game")).toMatchObject({ source: "system" });
    expect(effective.find(({ name }) => name === "var.points")).toMatchObject({ source: "channel" });
    expect(effective.some(({ name }) => name === "user")).toBe(false);
  });

  it("renders every effective chat declaration while leaving undeclared names literal", () => {
    const moduleVariables: readonly TemplateVariable[] = [
      { name: "target", group: "context", contexts: ["chat_command"], sample: "friend", maxLength: 25 },
      { name: "args", group: "context", contexts: ["chat_command"], sample: "hello", maxLength: 100 },
      { name: "command", group: "command", contexts: ["chat_command"], sample: "hello", maxLength: 32 },
      { name: "cooldown", group: "command", contexts: ["chat_command"], sample: "5", maxLength: 5 },
      { name: "uses", group: "command", contexts: ["chat_command"], sample: "12", maxLength: 10 },
    ];
    const channelVariables: readonly TemplateVariable[] = [
      { name: "var.points", group: "channel", sample: "42", maxLength: 10 },
    ];
    const declared = effectiveTemplateVariables(
      "chat_command",
      moduleVariables,
      channelVariables,
      SYSTEM_TEMPLATE_VARIABLE_LIST,
    );
    const values = Object.fromEntries(declared.map((variable) => [variable.name, variable.sample]));
    const variableTokens = declared.map(({ name }) => `{${name}}`).join("|");
    const template = `${variableTokens}|{random 1-100}|{pick red|blue}|{missing}`;
    const rendered = renderTemplate(template, values, {
      random: (parameter) => {
        const range = parseTemplateRange(parameter);
        return range === null ? "?" : String(range.min);
      },
      pick: (parameter) => parameter.split("|")[0]?.trim() ?? "",
    }, declared);

    expect(rendered).toBe(`${declared.map(({ sample }) => sample).join("|")}|1|red|{missing}`);
    expect(unknownTemplateVariables(template, declared)).toEqual(["missing"]);
  });
});

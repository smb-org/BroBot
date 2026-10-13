import { describe, expect, it } from "vitest";

import { systemTemplateVariableLocale } from "../../src/dashboard/locale";
import { MODULES } from "../../src/modules/registry";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../src/template-variables";
import type { TemplateVariable } from "../../src/template";
import {
  filterTemplateTextFieldOptions,
  groupTemplateTextFieldOptions,
  prioritizeTemplateTextFieldNamespace,
  type TemplateTextFieldOption,
} from "../../src/dashboard/ui/template-text-field-model";

const groupLabels = {
  module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks",
};

const declaredModuleVariables = (): Array<{ moduleId: string; variable: TemplateVariable }> => MODULES.flatMap((module) => {
  const fields = Object.values(module.templateFields ?? {}).flatMap((variables) => variables ?? []) as TemplateVariable[];
  const seen = new Set<string>();
  return [...fields, ...(module.templateVariableCatalog ?? [])]
    .filter((variable) => {
      if (seen.has(variable.name)) return false;
      seen.add(variable.name);
      return true;
    })
    .map((variable) => ({ moduleId: module.id, variable }));
});

describe("template text field catalogs", () => {
  it("provides a localized label and description for every system variable", () => {
    for (const variable of SYSTEM_TEMPLATE_VARIABLE_LIST) {
      for (const language of ["de", "en"] as const) {
        const copy = systemTemplateVariableLocale[language][variable.name as keyof typeof systemTemplateVariableLocale.de];
        expect(copy.label.trim(), `${language} label for ${variable.name}`).not.toBe("");
        expect(copy.description.trim(), `${language} description for ${variable.name}`).not.toBe("");
      }
    }
  });

  it("provides a localized label and description for every declared module variable", () => {
    for (const { moduleId, variable } of declaredModuleVariables()) {
      expect(variable.picker, `${moduleId} variable ${variable.name}`).toBeDefined();
      for (const language of ["de", "en"] as const) {
        const copy = variable.picker?.[language];
        expect(copy?.label.trim(), `${language} label for ${moduleId}.${variable.name}`).not.toBe("");
        expect(copy?.description.trim(), `${language} description for ${moduleId}.${variable.name}`).not.toBe("");
      }
    }
  });

  it("declares a localized source label and icon for modules that provide template variables", () => {
    for (const module of MODULES) {
      const declared = declaredModuleVariables().some(({ moduleId }) => moduleId === module.id);
      if (!declared) continue;
      expect(module.templateVariableGroup, `picker group for ${module.id}`).toBeDefined();
      for (const language of ["de", "en"] as const) {
        expect(module.templateVariableGroup?.label[language].trim(), `${language} group label for ${module.id}`).not.toBe("");
      }
      expect(module.templateVariableGroup?.icon.paths.length).toBeGreaterThan(0);
    }
  });

  it("matches localized labels and moves a typed namespace group to the top", () => {
    const options: TemplateTextFieldOption[] = [
      {
        name: "game", label: "Current category", description: "Current stream category", sample: "Minecraft", group: "stream", kind: "system",
      },
      {
        name: "sun.set", label: "Sonnenuntergang", description: "Uhrzeit des Sonnenuntergangs", sample: "18:42", group: "time_random", kind: "module",
        sourceGroup: { id: "sun", label: "Sonne", iconPaths: ["M12 3v2"], order: 10 },
      },
    ];

    expect(filterTemplateTextFieldOptions(options, "unterg").map(({ name }) => name)).toEqual(["sun.set"]);
    const groups = groupTemplateTextFieldOptions(options, { groupLabels });
    expect(prioritizeTemplateTextFieldNamespace(groups, "sun.")[0]?.group.id).toBe("module");
    expect(groups.map(({ group }) => group.id)).toEqual(["module", "channel"]);
    expect(groups.find(({ group }) => group.id === "module")?.group.label).toBe("This module");
  });

  it("matches localized descriptions and ranks name or label prefixes first", () => {
    const options: TemplateTextFieldOption[] = [
      { name: "raid_audience", label: "Raid audience", description: "Current viewer count during a raid", sample: "42" },
      { name: "viewer_total", label: "Viewer total", description: "Total viewers", sample: "42" },
    ];

    expect(filterTemplateTextFieldOptions(options, "current viewer count").map(({ name }) => name)).toEqual(["raid_audience"]);
    expect(filterTemplateTextFieldOptions(options, "viewer").map(({ name }) => name)).toEqual(["viewer_total", "raid_audience"]);
  });

  it("shows a duplicate name once across grouped options", () => {
    const options: TemplateTextFieldOption[] = [
      { name: "user", description: "First declaration", sample: "first", kind: "system" },
      { name: "user", description: "Second declaration", sample: "second", kind: "system" },
    ];
    const groups = groupTemplateTextFieldOptions(options, { groupLabels });
    expect(groups.flatMap(({ options: entries }) => entries.map(({ option }) => option.name))).toEqual(["user"]);
    expect(groups.flatMap(({ options: entries }) => entries.map(({ option }) => option.sample))).toEqual(["first"]);
  });
});

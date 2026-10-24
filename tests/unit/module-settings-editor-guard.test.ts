import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import type { SettingsEditorSpec, SettingsFieldSpec } from "../../src/dashboard/ui";

interface DeclarationProbe {
  id: string;
  hasEditor: boolean;
  hasPanel: boolean;
  panelManagesSettings: boolean;
  schemaKeys: readonly string[];
  declaredKeys: readonly string[];
  implicitKeys: readonly string[];
  templateKeys: readonly string[];
  templateFieldKeys: readonly string[];
  locales: Readonly<Record<"de" | "en", Readonly<Record<string, { label?: string; hint?: string }>>>>;
  messageEnabledLabels: Readonly<Record<"de" | "en", string | undefined>>;
}

const flatten = <Settings,>(fields: readonly SettingsFieldSpec<Settings>[]): SettingsFieldSpec<Settings>[] =>
  fields.flatMap((field) => [field, ...(field.kind === "switchCard" && field.children !== undefined ? flatten(field.children) : [])]);

const declarationProblems = (probe: DeclarationProbe): string[] => {
  if (probe.schemaKeys.length === 0) return [];
  if (!probe.hasEditor && !probe.panelManagesSettings) return [`${probe.id} is missing settingsEditor`];
  if (probe.panelManagesSettings && !probe.hasPanel) return [`${probe.id} manages settings without a panel`];
  if (probe.panelManagesSettings && probe.hasEditor) return [`${probe.id} declares both a settings panel and settingsEditor`];
  if (probe.panelManagesSettings) return [];
  const problems: string[] = [];
  const schemaKeys = [...probe.schemaKeys].sort((a, b) => a.localeCompare(b));
  const declaredKeys = [...new Set(probe.declaredKeys)].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(declaredKeys) !== JSON.stringify(schemaKeys)) problems.push(`${probe.id} declaration keys do not match settingsSchema`);
  if (JSON.stringify([...probe.templateKeys].sort((a, b) => a.localeCompare(b))) !== JSON.stringify([...probe.templateFieldKeys].sort((a, b) => a.localeCompare(b)))) {
    problems.push(`${probe.id} template fields do not match templateFields`);
  }
  for (const key of schemaKeys) {
    if (probe.implicitKeys.includes(key)) continue;
    for (const language of ["de", "en"] as const) {
      const copy = probe.locales[language][key];
      if (copy?.label === undefined || copy.label.trim().length === 0) problems.push(`${probe.id}.${key} ${language} missing label`);
      if (copy?.hint === undefined || copy.hint.trim().length === 0) problems.push(`${probe.id}.${key} ${language} missing hint`);
    }
  }
  if (probe.implicitKeys.length > 0) {
    for (const language of ["de", "en"] as const) {
      const label = probe.messageEnabledLabels[language];
      if (label === undefined || label.trim().length === 0) problems.push(`${probe.id} messageEnabledLabel ${language} missing label`);
    }
  }
  return problems;
};

describe("module settings editor declarations", () => {
  it("covers schema keys, templates, and bilingual labels and hints", async () => {
    for (const module of MODULES) {
      const schemaShape = "shape" in module.settingsSchema && typeof module.settingsSchema.shape === "object"
        ? module.settingsSchema.shape as Record<string, unknown>
        : {};
      const schemaKeys = Object.keys(schemaShape);
      if (module.settingsEditor === undefined) {
        expect(declarationProblems({
          id: module.id,
          hasEditor: false,
          hasPanel: module.panel !== undefined,
          panelManagesSettings: module.panelManagesSettings === true,
          schemaKeys,
          declaredKeys: [],
          implicitKeys: [],
          templateKeys: [],
          templateFieldKeys: Object.keys(module.templateFields ?? {}),
          locales: { de: {}, en: {} },
          messageEnabledLabels: { de: undefined, en: undefined },
        }), module.id).toEqual([]);
        continue;
      }
      const definition = (await module.settingsEditor()).default;
      const spec = definition.spec as SettingsEditorSpec<Record<string, unknown>>;
      const fields = flatten(spec.sections.flatMap((section) => section.fields));
      const locales = Object.fromEntries((["de", "en"] as const).map((language) => [
        language,
        Object.fromEntries(Object.entries(definition.locales[language].fields).map(([key, copy]) => [key, { label: copy.label, hint: copy.hint }])),
      ])) as DeclarationProbe["locales"];
      const probe: DeclarationProbe = {
        id: module.id,
        hasEditor: true,
        hasPanel: module.panel !== undefined,
        panelManagesSettings: module.panelManagesSettings === true,
        schemaKeys,
        declaredKeys: fields.flatMap((field) => field.kind === "message"
          ? [field.key, field.enabledKey, ...(field.targetKey === undefined ? [] : [field.targetKey])]
          : [field.key]),
        implicitKeys: fields.filter((field) => field.kind === "message").map((field) => field.enabledKey),
        templateKeys: fields.filter((field) => field.kind === "template" || field.kind === "message").map((field) => field.key),
        templateFieldKeys: Object.keys(module.templateFields ?? {}),
        locales,
        messageEnabledLabels: {
          de: definition.locales.de.messageEnabledLabel,
          en: definition.locales.en.messageEnabledLabel,
        },
      };
      expect(declarationProblems(probe), module.id).toEqual([]);
    }
  });

  it("catches a settings module with no editor and mismatched declaration keys", () => {
    const base: DeclarationProbe = {
      id: "counter-probe",
      hasEditor: true,
      hasPanel: false,
      panelManagesSettings: false,
      schemaKeys: ["value"],
      declaredKeys: ["value"],
      implicitKeys: [],
      templateKeys: [],
      templateFieldKeys: [],
      messageEnabledLabels: { de: undefined, en: undefined },
      locales: {
        de: { value: { label: "Wert", hint: "Ein Wert." } },
        en: { value: { label: "Value", hint: "A value." } },
      },
    };
    expect(declarationProblems({ ...base, hasEditor: false })).toContain("counter-probe is missing settingsEditor");
    expect(declarationProblems({ ...base, hasEditor: false, panelManagesSettings: true })).toContain("counter-probe manages settings without a panel");
    expect(declarationProblems({ ...base, hasEditor: false, hasPanel: true, panelManagesSettings: true })).toEqual([]);
    expect(declarationProblems({ ...base, hasPanel: true, panelManagesSettings: true })).toContain("counter-probe declares both a settings panel and settingsEditor");
    expect(declarationProblems({ ...base, declaredKeys: ["invented"] })).toContain("counter-probe declaration keys do not match settingsSchema");
    expect(declarationProblems({ ...base, declaredKeys: ["value", "invented"] })).toContain("counter-probe declaration keys do not match settingsSchema");
  });

  it("catches missing template declarations and bilingual labels or helper lines", () => {
    const base: DeclarationProbe = {
      id: "counter-probe",
      hasEditor: true,
      hasPanel: false,
      panelManagesSettings: false,
      schemaKeys: ["message"],
      declaredKeys: ["message"],
      implicitKeys: [],
      templateKeys: ["message"],
      templateFieldKeys: ["message"],
      messageEnabledLabels: { de: undefined, en: undefined },
      locales: {
        de: { message: { label: "Nachricht", hint: "Eine Vorlage." } },
        en: { message: { label: "Message", hint: "A template." } },
      },
    };
    expect(declarationProblems({ ...base, templateFieldKeys: [] })).toContain("counter-probe template fields do not match templateFields");
    expect(declarationProblems({ ...base, locales: { ...base.locales, en: { message: { label: "Message", hint: " " } } } }))
      .toContain("counter-probe.message en missing hint");
    expect(declarationProblems({ ...base, locales: { ...base.locales, de: { message: { label: " ", hint: "Eine Vorlage." } } } }))
      .toContain("counter-probe.message de missing label");
  });

  it("allows an empty settings schema without a settings editor", () => {
    expect(declarationProblems({
      id: "empty-module",
      hasEditor: false,
      hasPanel: false,
      panelManagesSettings: false,
      schemaKeys: [],
      declaredKeys: [],
      implicitKeys: [],
      templateKeys: [],
      templateFieldKeys: [],
      locales: { de: {}, en: {} },
      messageEnabledLabels: { de: undefined, en: undefined },
    })).toEqual([]);
  });
});

import type { BotModule } from "./contract";
import { channelEventsModule } from "./channel_events";
import { raidModule } from "./raid";
import { textCommandModule } from "./text_commands";
import { faqModule } from "./faq";
import { adsModule } from "./ads";
import { clipsModule } from "./clips";
import { textLibraryModule } from "./text_library";
import { sunModule } from "./sun";
import { moonModule } from "./moon";
import { weatherModule } from "./weather";
import { currencyModule } from "./currency";
import { apiSourceModule } from "./api_source";
import { timersModule } from "./timers";
import { votekickModule } from "./votekick";
import type { ModuleOverlayElementDefinition } from "./contract";
import type { TemplateVariable } from "../template";
import { TEMPLATE_BARE_VARIABLE_NAME_PATTERN, TEMPLATE_DOTTED_VARIABLE_NAME_PATTERN } from "../contracts/template-names";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../template-variables";

// This is the only place that knows all modules.
export const MODULES: readonly BotModule[] = [textCommandModule, faqModule, textLibraryModule, timersModule, sunModule, moonModule, weatherModule, currencyModule, apiSourceModule, channelEventsModule, adsModule, raidModule, clipsModule, votekickModule];

const HOST_TEMPLATE_VARIABLE_NAMES = new Set(SYSTEM_TEMPLATE_VARIABLE_LIST.map((variable) => variable.name));
const EXISTING_BARE_MODULE_VARIABLES: Readonly<Record<string, ReadonlySet<string>>> = {
  text_commands: new Set(["target", "command", "cooldown", "uses"]),
};
export const validateModuleTemplateVariable = (module: BotModule, name: string): void => {
  if (module.templateVariableNamespace === "text_blocks") {
    if (!TEMPLATE_BARE_VARIABLE_NAME_PATTERN.test(name)) {
      throw new Error(`Text block variable ${name} must be a bare block name.`);
    }
    if (HOST_TEMPLATE_VARIABLE_NAMES.has(name)) {
      throw new Error(`Text block variable ${name} is reserved by the host.`);
    }
    return;
  }
  if (HOST_TEMPLATE_VARIABLE_NAMES.has(name) || EXISTING_BARE_MODULE_VARIABLES[module.id]?.has(name) === true) return;
  if (!TEMPLATE_DOTTED_VARIABLE_NAME_PATTERN.test(name)) {
    throw new Error(`Module template variable ${module.id}.${name} must use a dotted name.`);
  }
};

export const variablesForModuleTemplateContext = (
  module: BotModule,
  variables: readonly TemplateVariable[],
): TemplateVariable[] => variables.map((variable) => {
  if (module.templateContext === undefined) return variable;
  return {
    ...variable,
    contexts: (variable.contexts ?? [module.templateContext]).filter((context) => context === module.templateContext),
  };
});

export const templateVariableGroupForModule = (
  module: BotModule,
  modules: readonly BotModule[] = MODULES,
): (NonNullable<BotModule["templateVariableGroup"]> & { id: string }) | undefined => {
  if (module.templateVariableGroup === undefined) return undefined;
  return {
    ...module.templateVariableGroup,
    id: module.id,
    order: module.templateVariableGroup.order ?? 100 + Math.max(0, modules.indexOf(module)),
  };
};

export const validateModuleTemplateVariables = (modules: readonly BotModule[]): void => {
  for (const module of modules) {
    const templateFields = module.templateFields as Readonly<Record<string, readonly TemplateVariable[] | undefined>> | undefined;
    if (module.templateVariables !== undefined && module.templateVariableNamespace !== "text_blocks" && module.templateVariableCatalog === undefined) {
      throw new Error(`Module ${module.id} must declare a template variable catalog for its dynamic variables.`);
    }
    const variableNames = [
      ...Object.values(templateFields ?? {}).flatMap((variables) => (variables ?? []).map((variable) => variable.name)),
      ...(module.templateVariableCatalog ?? []).map((variable) => variable.name),
    ];
    for (const name of variableNames) validateModuleTemplateVariable(module, name);
    const declaredVariables = [
      ...Object.values(templateFields ?? {}).flatMap((variables) => variables ?? []),
      ...(module.templateVariableCatalog ?? []),
    ];
    if (declaredVariables.length > 0 && module.templateVariableNamespace !== "text_blocks" && module.templateVariableGroup === undefined) {
      throw new Error(`Module ${module.id} must declare a template variable picker group.`);
    }
    for (const variable of declaredVariables) {
      if (variable.picker === undefined) {
        throw new Error(`Module template variable ${module.id}.${variable.name} needs bilingual picker copy.`);
      }
      for (const language of ["de", "en"] as const) {
        const copy = variable.picker[language];
        if (copy.label.trim().length === 0 || copy.description.trim().length === 0) {
          throw new Error(`Module template variable ${module.id}.${variable.name} needs a label and description in ${language}.`);
        }
      }
    }
  }
};

export const validateModuleOverlayElements = (modules: readonly BotModule[]): void => {
  const kinds = new Set<string>();
  for (const module of modules) {
    for (const element of module.overlayElements ?? []) {
      if (!element.kind.startsWith(`${module.id}.`) || element.kind.length === module.id.length + 1) {
        throw new Error(`Overlay element kind ${element.kind} must be prefixed by module id ${module.id}.`);
      }
      if (kinds.has(element.kind)) {
        throw new Error(`Overlay element kind ${element.kind} must be unique across modules.`);
      }
      kinds.add(element.kind);
    }
  }
};

export const validateModuleEventTimeSources = (modules: readonly BotModule[]): void => {
  const ids = new Set<string>();
  for (const module of modules) {
    for (const source of module.eventTimeSources ?? []) {
      if (!/^[a-z][a-z0-9_]*$/u.test(source.id)) {
        throw new Error(`Module event-time source ${module.id}.${source.id} has an invalid id.`);
      }
      const id = `${module.id}.${source.id}`;
      if (ids.has(id)) throw new Error(`Duplicate module event-time source ${id}.`);
      ids.add(id);
      for (const language of ["de", "en"] as const) {
        if (source.label[language].trim().length === 0) {
          throw new Error(`Module event-time source ${id} needs a label in ${language}.`);
        }
      }
    }
  }
};

export const moduleOverlayElementForKind = (
  kind: string,
  modules: readonly BotModule[] = MODULES,
): { module: BotModule; definition: ModuleOverlayElementDefinition } | null => {
  for (const module of modules) {
    const definition = module.overlayElements?.find((element) => element.kind === kind);
    if (definition !== undefined) return { module, definition };
  }
  return null;
};

validateModuleOverlayElements(MODULES);
validateModuleTemplateVariables(MODULES);
validateModuleEventTimeSources(MODULES);

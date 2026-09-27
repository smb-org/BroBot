import type { BotModule } from "./contract";
import { channelEventsModule } from "./channel_events";
import { raidModule } from "./raid";
import { textCommandModule } from "./text_commands";
import { adsModule } from "./ads";
import { clipsModule } from "./clips";
import { textLibraryModule } from "./text_library";
import { sunModule } from "./sun";
import type { ModuleOverlayElementDefinition } from "./contract";
import type { TemplateVariable } from "../template";
import { TEMPLATE_BARE_VARIABLE_NAME_PATTERN, TEMPLATE_DOTTED_VARIABLE_NAME_PATTERN } from "../contracts/template-names";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../template-variables";

// This is the only place that knows all modules.
export const MODULES: readonly BotModule[] = [textCommandModule, textLibraryModule, sunModule, channelEventsModule, adsModule, raidModule, clipsModule];

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

export const validateModuleTemplateVariables = (modules: readonly BotModule[]): void => {
  for (const module of modules) {
    const templateFields = module.templateFields as Readonly<Record<string, readonly TemplateVariable[] | undefined>> | undefined;
    const variableNames = Object.values(templateFields ?? {}).flatMap((variables) =>
      (variables ?? []).map((variable) => variable.name),
    );
    for (const name of variableNames) validateModuleTemplateVariable(module, name);
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

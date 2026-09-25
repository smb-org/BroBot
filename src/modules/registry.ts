import type { BotModule } from "./contract";
import { channelEventsModule } from "./channel_events";
import { raidModule } from "./raid";
import { textCommandModule } from "./text_commands";
import { adsModule } from "./ads";
import { clipsModule } from "./clips";
import type { ModuleOverlayElementDefinition } from "./contract";

// This is the only place that knows all modules.
export const MODULES: readonly BotModule[] = [textCommandModule, channelEventsModule, adsModule, raidModule, clipsModule];

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

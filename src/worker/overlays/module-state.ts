import { moduleOverlayElementForKind, MODULES } from "../../modules/registry";
import type { BotModule, JsonObject } from "../../modules/contract";

interface ModuleOverlayStateInput {
  id: string;
  kind: string;
  config: Readonly<Record<string, unknown>>;
}

interface EnabledModuleRow {
  module_id: string;
  enabled: number;
}

export const hydrateModuleOverlayElements = async <Element extends ModuleOverlayStateInput>(
  db: D1Database,
  channelId: string,
  elements: readonly Element[],
  modules: readonly BotModule[] = MODULES,
): Promise<(Element & { moduleEnabled?: boolean; state?: JsonObject | null })[]> => {
  const moduleElements = elements.flatMap((element) => {
    const declaration = moduleOverlayElementForKind(element.kind, modules);
    return declaration === null ? [] : [{ element, ...declaration }];
  });
  if (moduleElements.length === 0) return elements.map((element) => ({ ...element }));

  const moduleIds = [...new Set(moduleElements.map(({ module }) => module.id))];
  const placeholders = moduleIds.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT module_id, enabled FROM channel_modules
      WHERE channel_id = ? AND module_id IN (${placeholders})`,
  ).bind(channelId, ...moduleIds).all<EnabledModuleRow>();
  const enabledById = new Map(rows.results.map((row) => [row.module_id, row.enabled === 1]));
  const stateByElementId = new Map<string, { moduleEnabled: boolean; state: JsonObject | null }>();

  for (const item of moduleElements) {
    const moduleEnabled = item.module.mandatory === true || enabledById.get(item.module.id) === true;
    let state: JsonObject | null = null;
    if (moduleEnabled && item.definition.initialState !== undefined) {
      const config = item.definition.parseConfig(item.element.config);
      if (config !== null) {
        try {
          state = await item.definition.initialState(db, channelId, config);
        } catch (error: unknown) {
          console.warn(`Module overlay initial state failed for ${item.definition.kind}.`, error);
        }
      }
    }
    stateByElementId.set(item.element.id, { moduleEnabled, state });
  }

  return elements.map((element) => {
    const moduleState = stateByElementId.get(element.id);
    return moduleState === undefined ? { ...element } : { ...element, ...moduleState };
  });
};

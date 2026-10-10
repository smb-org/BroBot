import type { BotModule, ModuleAction, ModuleOverlayHostEvent } from "../modules/contract";
import type { ModuleOverlayRealtimeEnvelope } from "../realtime-contract";
import { MODULES } from "../modules/registry";

const OVERLAY_PAYLOAD_MAXIMUM_BYTES = 4_096;
const OVERLAY_ACTION_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export type ModuleOverlayMessageResult =
  | { outcome: "ready"; message: ModuleOverlayRealtimeEnvelope }
  | { outcome: "no_recipients" }
  | { outcome: "rejected" };

/** Routes declared host-state changes to their module elements before publishing. */
export const prepareModuleOverlayHostEventMessages = async (
  db: D1Database,
  channelId: string,
  event: ModuleOverlayHostEvent,
  modules: readonly BotModule[] = MODULES,
): Promise<ModuleOverlayRealtimeEnvelope[]> => {
  const declarations = modules.flatMap((module) => (module.overlayElements ?? [])
    .filter((definition) => definition.reloadStateOnHostEvents?.includes(event) === true)
    .map((definition) => ({ module, elementKind: definition.kind })));
  const results = await Promise.all(declarations.map(({ module, elementKind }) =>
    prepareModuleOverlayRealtimeMessage(db, channelId, module.id, {
      kind: "overlay",
      type: "state_changed",
      elementKind,
      payload: { reason: event },
    }, module.mandatory === true, modules),
  ));
  return results.flatMap((result) => result.outcome === "ready" ? [result.message] : []);
};

/** Resolves recipients before publish so the Durable Object send path needs no D1 read. */
export const prepareModuleOverlayRealtimeMessage = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
  action: Extract<ModuleAction, { kind: "overlay" }>,
  mandatory = false,
  modules: readonly BotModule[] = MODULES,
): Promise<ModuleOverlayMessageResult> => {
  if (!OVERLAY_ACTION_TYPE_PATTERN.test(action.type) || !action.elementKind.startsWith(`${moduleId}.`) ||
      !modules.find((module) => module.id === moduleId)?.overlayElements?.some(({ kind }) => kind === action.elementKind) ||
      action.recipientConfig !== undefined && (!/^[a-z][A-Za-z0-9_]{0,31}$/u.test(action.recipientConfig.field) ||
        action.recipientConfig.value.length === 0 || action.recipientConfig.value.length > 80)) {
    return { outcome: "rejected" };
  }

  let serializedPayload: string;
  try {
    serializedPayload = JSON.stringify(action.payload);
  } catch {
    return { outcome: "rejected" };
  }
  if (new TextEncoder().encode(serializedPayload).byteLength > OVERLAY_PAYLOAD_MAXIMUM_BYTES) {
    return { outcome: "rejected" };
  }

  const recipientBindings = action.recipientConfig === undefined
    ? [1, null, null]
    : [0, `$.${action.recipientConfig.field}`, action.recipientConfig.value];
  const recipients = await db.prepare(
    `SELECT DISTINCT element.overlay_id
       FROM overlay_elements AS element
      WHERE element.channel_id = ?
        AND element.kind = ?
        AND (? = 1 OR json_extract(element.config_json, ?) = ?)
        AND (? = 1 OR EXISTS (
          SELECT 1 FROM channel_modules AS module
           WHERE module.channel_id = element.channel_id
             AND module.module_id = ? AND module.enabled = 1
        ))
      ORDER BY element.overlay_id`,
  ).bind(channelId, action.elementKind, ...recipientBindings, mandatory ? 1 : 0, moduleId).all<{ overlay_id: string }>();
  const overlayIds = [...new Set(recipients.results.map(({ overlay_id }) => overlay_id))];
  if (overlayIds.length === 0) {
    return { outcome: "no_recipients" };
  }

  return {
    outcome: "ready",
    // moduleId and action.type are runtime strings validated just above against the
    // module registry, not literals the compiler can narrow to the known message
    // types. ponytail: trust the runtime check rather than making this dispatcher
    // generic over every module's literal action types.
    message: {
      version: 1,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      channelId,
      type: `modul.${moduleId}.${action.type}`,
      payload: action.payload,
      overlayIds,
    } as ModuleOverlayRealtimeEnvelope,
  };
};

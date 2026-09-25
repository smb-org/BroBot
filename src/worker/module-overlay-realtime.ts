import type { ModuleAction } from "../modules/contract";
import type { ModuleOverlayRealtimeEnvelope } from "../realtime-contract";

const OVERLAY_PAYLOAD_MAXIMUM_BYTES = 4_096;
const OVERLAY_ACTION_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export type ModuleOverlayMessageResult =
  | { outcome: "ready"; message: ModuleOverlayRealtimeEnvelope }
  | { outcome: "no_recipients" }
  | { outcome: "rejected" };

/** Resolves recipients before publish so the Durable Object send path needs no D1 read. */
export const prepareModuleOverlayRealtimeMessage = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
  action: Extract<ModuleAction, { kind: "overlay" }>,
  mandatory = false,
): Promise<ModuleOverlayMessageResult> => {
  if (!OVERLAY_ACTION_TYPE_PATTERN.test(action.type)) return { outcome: "rejected" };

  let serializedPayload: string;
  try {
    serializedPayload = JSON.stringify(action.payload);
  } catch {
    return { outcome: "rejected" };
  }
  if (new TextEncoder().encode(serializedPayload).byteLength > OVERLAY_PAYLOAD_MAXIMUM_BYTES) {
    return { outcome: "rejected" };
  }

  const recipients = await db.prepare(
    `SELECT DISTINCT element.overlay_id
       FROM overlay_elements AS element
      WHERE element.channel_id = ?
        AND element.kind LIKE ?
        AND (? = 1 OR EXISTS (
          SELECT 1 FROM channel_modules AS module
           WHERE module.channel_id = element.channel_id
             AND module.module_id = ? AND module.enabled = 1
        ))
      ORDER BY element.overlay_id`,
  ).bind(channelId, `${moduleId}.%`, mandatory ? 1 : 0, moduleId).all<{ overlay_id: string }>();
  const overlayIds = [...new Set(recipients.results.map(({ overlay_id }) => overlay_id))];
  if (overlayIds.length === 0) return { outcome: "no_recipients" };

  return {
    outcome: "ready",
    message: {
      version: 1,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      channelId,
      type: `modul.${moduleId}.${action.type}`,
      payload: action.payload,
      overlayIds,
    },
  };
};

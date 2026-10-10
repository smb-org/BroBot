import type { PanelModuleRealtimeEnvelope, PanelModuleRealtimeMessageType, PanelModuleHintPart } from "../realtime-contract";

type PanelModuleHint =
  | { moduleId: "chat_voting"; part: "panel" }
  | { moduleId: "belabox"; part: "live" }
  | { moduleId: "votekick"; part: "panel" | "availability" };

const panelHintType = (moduleId: string, part: PanelModuleHintPart): PanelModuleRealtimeMessageType | null => {
  if (moduleId === "chat_voting" && part === "panel" ||
      moduleId === "belabox" && part === "live" ||
      moduleId === "votekick" && (part === "panel" || part === "availability")) {
    return `modul.${moduleId}.changed` as PanelModuleRealtimeMessageType;
  }
  return null;
};

/** Creates an allowlisted panel hint whose payload is exactly one bounded `part` field. */
export const modulePanelHintMessage = (
  channelId: string,
  moduleId: string,
  part: PanelModuleHintPart,
): PanelModuleRealtimeEnvelope | null => {
  const type = panelHintType(moduleId, part);
  if (type === null) return null;
  const hint: PanelModuleHint = moduleId === "chat_voting"
    ? { moduleId, part: "panel" }
    : moduleId === "belabox"
      ? { moduleId, part: "live" }
      : { moduleId: "votekick", part: part as "panel" | "availability" };
  return {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    channelId,
    type,
    payload: { part: hint.part },
  } as PanelModuleRealtimeEnvelope;
};

/** Sends a panel hint without consulting overlay recipients or carrying module state. */
export const publishModulePanelHint = async (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  moduleId: string,
  part: PanelModuleHintPart,
): Promise<void> => {
  if (namespace === undefined) return;
  const message = modulePanelHintMessage(channelId, moduleId, part);
  if (message === null) return;
  try {
    const object = namespace.get(namespace.idFromName(channelId));
    await object.publish([message]);
  } catch {
    console.warn("Module panel update could not be sent.");
  }
};

import type { PanelChannelRole } from "../panel-contract";

/**
 * Rollen werden im Datenmodell klein geschrieben. In der Oberflaeche steht der
 * Begriff, nicht der Enum-Wert — an beiden Stellen derselbe, damit Panel und
 * Mitgliederliste nicht auseinanderlaufen.
 */
export const roleLabel = (role: PanelChannelRole): string => {
  if (role === "broadcaster") return "Broadcaster";
  if (role === "verwalter") return "Verwalter";
  return "Bediener";
};

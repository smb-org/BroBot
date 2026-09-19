import type { PanelChannelRole } from "../panel-contract";
import { dashboardGemeinsameTexte } from "./locale";

/**
 * Rollen werden im Datenmodell klein geschrieben. In der Oberflaeche steht der
 * Begriff, nicht der Enum-Wert — an beiden Stellen derselbe, damit Panel und
 * Mitgliederliste nicht auseinanderlaufen.
 */
export const roleLabel = (role: PanelChannelRole): string => {
  return dashboardGemeinsameTexte().rollen[role];
};

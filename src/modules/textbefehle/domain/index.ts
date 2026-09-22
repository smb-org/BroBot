import type { ModuleChatStatus } from "../contract";
import type { TextbefehlMindeststufe } from "../contracts";

export const BEFEHLSNAME_MUSTER = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type TextbefehlEingabe =
  | { art: "befehl"; name: string; argumente?: string }
  | { art: "unbekannt" };

export const gueltigerBefehlsname = (name: string): boolean => BEFEHLSNAME_MUSTER.test(name);

export const befehlAusNachricht = (message: string): TextbefehlEingabe | null => {
  const trimmed = message.trim();
  const erstesWort = trimmed.split(/\s+/u)[0];
  if (erstesWort === undefined || !erstesWort.startsWith("!")) return null;
  const name = erstesWort.slice(1);
  if (!gueltigerBefehlsname(name)) return { art: "unbekannt" };
  const argumente = trimmed.slice(erstesWort.length).trim();
  return {
    art: "befehl",
    name,
    ...(argumente.length === 0 ? {} : { argumente }),
  };
};

export const befehlTextMitPlatzhaltern = (text: string, user: string, channel: string): string =>
  text.replaceAll("{user}", user).replaceAll("{channel}", channel);

export const cooldownRestzeit = (zuletztVerwendet: string | null, jetzt: string, cooldownSekunden: number): number => {
  if (zuletztVerwendet === null) return 0;
  const vergangen = Date.parse(jetzt) - Date.parse(zuletztVerwendet);
  if (!Number.isFinite(vergangen) || vergangen < 0) return cooldownSekunden;
  return Math.max(0, Math.ceil(cooldownSekunden - vergangen / 1000));
};

/**
 * Die Stufen sind absichtlich keine Zahlenleiter. Die Statusliste kann mehrere
 * Badges enthalten: Moderator und Broadcaster erfüllen auch „Abonnent“ und
 * „VIP“, ein VIP aber nicht „Abonnent“.
 */
const statusFuerStufe: Record<TextbefehlMindeststufe, readonly ModuleChatStatus[]> = {
  everyone: ["viewer", "subscriber", "vip", "moderator", "broadcaster"],
  subscriber: ["subscriber", "moderator", "broadcaster"],
  vip: ["vip", "moderator", "broadcaster"],
  moderator: ["moderator", "broadcaster"],
  broadcaster: ["broadcaster"],
};

export const chatStatusErfuelltStufe = (
  status: readonly ModuleChatStatus[] | null,
  mindeststufe: TextbefehlMindeststufe,
): boolean => mindeststufe === "everyone"
  || (status !== null && status.some((eintrag) => statusFuerStufe[mindeststufe].includes(eintrag)));

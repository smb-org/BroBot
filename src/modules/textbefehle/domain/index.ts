export const BEFEHLSNAME_MUSTER = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type TextbefehlEingabe =
  | { art: "hinzufuegen"; name: string; text: string }
  | { art: "entfernen"; name: string }
  | { art: "listen" }
  | { art: "ausgeben"; name: string }
  | { art: "unbekannt" };

export const gueltigerBefehlsname = (name: string): boolean => BEFEHLSNAME_MUSTER.test(name);

export const befehlAusNachricht = (message: string): TextbefehlEingabe | null => {
  const trimmed = message.trim();
  const teile = trimmed.split(/\s+/u);
  const erstesWort = teile[0];
  if (erstesWort === undefined || !erstesWort.startsWith("!")) return null;

  const name = erstesWort.slice(1);
  if (name === "befehle" && teile.length === 1) return { art: "listen" };
  if (name !== "befehl") {
    return gueltigerBefehlsname(name) ? { art: "ausgeben", name } : { art: "unbekannt" };
  }

  const addMatch = /^!befehl\s+hinzufuegen\s+(\S+)\s+(.+)$/u.exec(trimmed);
  if (addMatch !== null) return { art: "hinzufuegen", name: addMatch[1] ?? "", text: addMatch[2] ?? "" };
  const removeMatch = /^!befehl\s+entfernen\s+(\S+)$/u.exec(trimmed);
  if (removeMatch !== null) return { art: "entfernen", name: removeMatch[1] ?? "" };
  return { art: "unbekannt" };
};

export const befehlTextMitPlatzhaltern = (text: string, user: string, channel: string): string =>
  text.replaceAll("{user}", user).replaceAll("{channel}", channel);

export const cooldownRestzeit = (zuletztVerwendet: string | null, jetzt: string, cooldownSekunden: number): number => {
  if (zuletztVerwendet === null) return 0;
  const vergangen = Date.parse(jetzt) - Date.parse(zuletztVerwendet);
  if (!Number.isFinite(vergangen) || vergangen < 0) return cooldownSekunden;
  return Math.max(0, Math.ceil(cooldownSekunden - vergangen / 1000));
};

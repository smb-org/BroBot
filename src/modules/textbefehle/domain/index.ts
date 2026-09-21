export const BEFEHLSNAME_MUSTER = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type TextbefehlEingabe =
  | { art: "listen"; name: string; argumente?: string }
  | { art: "ausgeben"; name: string; argumente?: string }
  | { art: "unbekannt" };

export const gueltigerBefehlsname = (name: string): boolean => BEFEHLSNAME_MUSTER.test(name);

export const befehlAusNachricht = (message: string): TextbefehlEingabe | null => {
  const trimmed = message.trim();
  const nameEnde = trimmed.search(/\s/u);
  const name = nameEnde === -1 ? trimmed.slice(1) : trimmed.slice(1, nameEnde);
  const argumente = nameEnde === -1 ? undefined : trimmed.slice(nameEnde).trim();
  const teile = trimmed.split(/\s+/u);
  if (teile[0] === undefined || !teile[0].startsWith("!")) return null;

  if (name === "befehle" && teile.length === 1) return { art: "listen", name };
  if (name !== "befehl") {
    return gueltigerBefehlsname(name)
      ? { art: "ausgeben", name, ...(argumente === undefined || argumente.length === 0 ? {} : { argumente }) }
      : { art: "unbekannt" };
  }

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

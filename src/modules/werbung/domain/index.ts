import type { WerbepausenEreignis } from "../contracts";
import type { WerbungSettings } from "../contracts";

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export type WerbepausenEntscheidung =
  | { kind: "skip"; reason: "dauer_null" | "dauer_ungueltig" | "start_ungueltig"; dauerSekunden: number | null; automatisch: boolean }
  | { kind: "announce"; event: WerbepausenEreignis };

export const entscheideWerbepause = (
  payload: Readonly<Record<string, unknown>>,
): WerbepausenEntscheidung => {
  const dauer = finiteNumber(payload.duration_seconds) ? payload.duration_seconds : null;
  const automatisch = payload.is_automatic === true;
  if (dauer === null || dauer < 0) {
    return { kind: "skip", reason: "dauer_ungueltig", dauerSekunden: dauer, automatisch };
  }
  if (dauer === 0) return { kind: "skip", reason: "dauer_null", dauerSekunden: 0, automatisch };

  const gestartetAm = nonEmptyString(payload.started_at);
  const start = gestartetAm === null ? Number.NaN : Date.parse(gestartetAm);
  if (gestartetAm === null || !Number.isFinite(start)) {
    return { kind: "skip", reason: "start_ungueltig", dauerSekunden: dauer, automatisch };
  }

  const ausloeserLogin = nonEmptyString(payload.requester_user_login) ??
    nonEmptyString(payload.requester_user_name);
  return {
    kind: "announce",
    event: {
      dauerSekunden: dauer,
      gestartetAm,
      endetAm: new Date(start + dauer * 1000).toISOString(),
      automatisch,
      ausloeserLogin,
    },
  };
};

export interface WerbevorwarnungsZeitplan {
  nextAdAt: string | null;
  lastAdAt: string | null;
}

export interface WerbevorwarnungsEingabe {
  settings: Pick<WerbungSettings, "vorwarnung" | "vorlaufSekunden" | "vorwarnungText">;
  scopeVorhanden: boolean;
  jetztAmMs: number;
  geplantAmMs: number;
  schedule: WerbevorwarnungsZeitplan;
}

export type WerbevorwarnungsEntscheidung =
  | { kind: "skip"; reason: "vorwarnung_aus" | "scope_fehlt" | "kein_termin" | "zu_spaet" | "pause_begonnen" | "termin_verschoben"; detail: Readonly<Record<string, string | number | boolean | null>> }
  | { kind: "announce"; text: string; sekunden: number; terminAm: string };

const dateMs = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Der Wecker feuert nie zu früh, aber regelmäßig ein paar Millisekunden zu
 * spät. Ohne Spielraum wäre die verbleibende Zeit deshalb *immer* knapp unter
 * der Vorlaufzeit und die Vorwarnung fiele im Betrieb jedes Mal aus, während
 * ein Test mit exakten Zeiten sie bestehen sieht.
 */
const MINDEST_VORLAUF_MS = 5_000;

/** Zwei Termine innerhalb dieses Fensters sind derselbe Termin. */
const TERMIN_TOLERANZ_MS = 2_000;

const skip = (
  reason: Exclude<WerbevorwarnungsEntscheidung, { kind: "announce" }>["reason"],
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): WerbevorwarnungsEntscheidung => ({ kind: "skip", reason, detail });

export const entscheideWerbevorwarnung = (
  input: WerbevorwarnungsEingabe,
): WerbevorwarnungsEntscheidung => {
  if (!input.settings.vorwarnung) return skip("vorwarnung_aus");
  if (!input.scopeVorhanden) return skip("scope_fehlt", { scope: "channel:read:ads" });

  const nextAdAtMs = dateMs(input.schedule.nextAdAt);
  if (nextAdAtMs === null) return skip("kein_termin");

  const lastAdAtMs = dateMs(input.schedule.lastAdAt);
  if (lastAdAtMs !== null && lastAdAtMs >= input.geplantAmMs) {
    return skip("pause_begonnen", { letztePause: input.schedule.lastAdAt });
  }
  if (Math.abs(nextAdAtMs - input.geplantAmMs) > TERMIN_TOLERANZ_MS) {
    return skip("termin_verschoben", {
      geplant: new Date(input.geplantAmMs).toISOString(),
      aktuell: input.schedule.nextAdAt,
    });
  }

  const verbleibend = nextAdAtMs - input.jetztAmMs;
  if (verbleibend < MINDEST_VORLAUF_MS) {
    return skip("zu_spaet", { verbleibendSekunden: Math.max(0, Math.round(verbleibend / 1000)) });
  }

  // Angesagt wird die tatsächlich verbleibende Zeit, nicht die eingestellte
  // Vorlaufzeit: Weckt der Alarm später oder hat Twitch den Termin leicht
  // verschoben, bliebe der Text sonst falsch.
  const sekunden = Math.round(verbleibend / 1000);
  return {
    kind: "announce",
    text: input.settings.vorwarnungText.replaceAll("{sekunden}", String(sekunden)),
    sekunden,
    terminAm: input.schedule.nextAdAt ?? new Date(nextAdAtMs).toISOString(),
  };
};

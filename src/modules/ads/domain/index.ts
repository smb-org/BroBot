import type { AdBreaksEvent } from "../contracts";
import type { AdsSettings } from "../contracts";

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export type AdBreaksDecision =
  | { kind: "skip"; reason: "dauer_null" | "dauer_ungueltig" | "start_ungueltig"; durationSeconds: number | null; automatic: boolean }
  | { kind: "announce"; event: AdBreaksEvent };

export const decideAdBreak = (
  payload: Readonly<Record<string, unknown>>,
): AdBreaksDecision => {
  const dauer = finiteNumber(payload.duration_seconds) ? payload.duration_seconds : null;
  const automatisch = payload.is_automatic === true;
  if (dauer === null || dauer < 0) {
    return { kind: "skip", reason: "dauer_ungueltig", durationSeconds: dauer, automatic: automatisch };
  }
  if (dauer === 0) return { kind: "skip", reason: "dauer_null", durationSeconds: 0, automatic: automatisch };

  const gestartetAm = nonEmptyString(payload.started_at);
  const start = gestartetAm === null ? Number.NaN : Date.parse(gestartetAm);
  if (gestartetAm === null || !Number.isFinite(start)) {
    return { kind: "skip", reason: "start_ungueltig", durationSeconds: dauer, automatic: automatisch };
  }

  const ausloeserLogin = nonEmptyString(payload.requester_user_login) ??
    nonEmptyString(payload.requester_user_name);
  return {
    kind: "announce",
    event: {
      durationSeconds: dauer,
      startedAt: gestartetAm,
      endsAt: new Date(start + dauer * 1000).toISOString(),
      automatic: automatisch,
      triggerLogin: ausloeserLogin,
    },
  };
};

export interface AdPrewarningSchedule {
  nextAdAt: string | null;
  lastAdAt: string | null;
}

export interface AdPrewarningInput {
  settings: Pick<AdsSettings, "prewarning" | "leadSeconds" | "prewarningText">;
  scopeVorhanden: boolean;
  jetztAmMs: number;
  geplantAmMs: number;
  schedule: AdPrewarningSchedule;
}

export type AdPrewarningDecision =
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
  reason: Exclude<AdPrewarningDecision, { kind: "announce" }>["reason"],
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): AdPrewarningDecision => ({ kind: "skip", reason, detail });

export const decideAdPrewarning = (
  input: AdPrewarningInput,
): AdPrewarningDecision => {
  if (!input.settings.prewarning) return skip("vorwarnung_aus");
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
    text: input.settings.prewarningText.replaceAll("{seconds}", String(sekunden)),
    sekunden,
    terminAm: input.schedule.nextAdAt ?? new Date(nextAdAtMs).toISOString(),
  };
};

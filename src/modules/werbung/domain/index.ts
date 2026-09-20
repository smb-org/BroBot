import type { WerbepausenEreignis } from "../contracts";

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

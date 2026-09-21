import type { WerbungSettings, WerbungZeitplanAntwort } from "../contracts";

const leereEinstellungen: WerbungSettings = {
  automatisch: "",
  manuell: "",
  vorwarnung: true,
  vorlaufSekunden: 60,
  vorwarnungText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
};

const leererZeitplan: WerbungZeitplanAntwort = {
  schedule: {
    nextAdAt: null,
    duration: null,
    lastAdAt: null,
    prerollFreeTime: null,
    snoozeCount: null,
    snoozeRefreshAt: null,
  },
  letzteWerbepausen: [],
  snoozeScopeVorhanden: false,
};

const pathFor = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/werbung/einstellungen`;

const json = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "Anfrage fehlgeschlagen.",
  );
  return body as T;
};

export const ladeWerbungseinstellungen = async (channelId: string): Promise<WerbungSettings> => {
  const response = await fetch(pathFor(channelId));
  const loaded = (await json<{ settings: Partial<WerbungSettings> }>(response)).settings;
  return { ...leereEinstellungen, ...loaded };
};

const zeitplanPathFor = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/werbung/zeitplan`;

export const ladeWerbungZeitplan = async (channelId: string): Promise<WerbungZeitplanAntwort> => {
  const response = await fetch(zeitplanPathFor(channelId));
  const loadedResponse = await json<Partial<WerbungZeitplanAntwort> | null>(response);
  const loaded = loadedResponse !== null && typeof loadedResponse === "object" ? loadedResponse : {};
  return {
    ...leererZeitplan,
    ...loaded,
    schedule: { ...leererZeitplan.schedule, ...(loaded.schedule ?? {}) },
    letzteWerbepausen: loaded.letzteWerbepausen ?? [],
  };
};

export const speichereWerbungseinstellungen = async (
  channelId: string,
  settings: WerbungSettings,
): Promise<void> => {
  const csrfResponse = await fetch("/api/csrf");
  const csrf = await json<{ token: string }>(csrfResponse);
  await json(await fetch(pathFor(channelId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
    body: JSON.stringify(settings),
  }));
};

export const snoozeWerbung = async (channelId: string): Promise<WerbungZeitplanAntwort> => {
  const csrfResponse = await fetch("/api/csrf");
  const csrf = await json<{ token: string }>(csrfResponse);
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/werbung/snooze`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf.token },
  });
  return json<WerbungZeitplanAntwort>(response);
};

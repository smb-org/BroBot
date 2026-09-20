import type { WerbungSettings } from "../contracts";

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
  return (await json<{ settings: WerbungSettings }>(response)).settings;
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

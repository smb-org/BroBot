import type { Textbefehl } from "../contracts";

const pathFor = (channelId: string, name?: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/textbefehle/befehle${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

const json = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "Anfrage fehlgeschlagen.";
    throw new Error(message);
  }
  return body as T;
};

export const ladeTextbefehle = async (channelId: string): Promise<Textbefehl[]> => {
  const response = await fetch(pathFor(channelId));
  const body = await json<{ befehle: Textbefehl[] }>(response);
  return body.befehle;
};

const mutation = async (
  channelId: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, string | number>,
  name?: string,
): Promise<void> => {
  const csrfResponse = await fetch("/api/csrf");
  const csrf = await json<{ token: string }>(csrfResponse);
  const response = await fetch(pathFor(channelId, name), {
    method,
    headers: {
      "X-CSRF-Token": csrf.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await json<unknown>(response);
};

export const legeTextbefehlAn = async (
  channelId: string,
  command: { name: string; text: string; cooldownSekunden: number },
): Promise<void> => mutation(channelId, "POST", command);

export const speichereTextbefehl = async (
  channelId: string,
  command: { name: string; text: string; cooldownSekunden: number },
): Promise<void> => mutation(channelId, "PATCH", {
  text: command.text,
  cooldownSekunden: command.cooldownSekunden,
}, command.name);

export const loescheTextbefehl = async (channelId: string, name: string): Promise<void> =>
  mutation(channelId, "DELETE", undefined, name);


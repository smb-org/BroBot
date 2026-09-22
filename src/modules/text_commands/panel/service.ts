import type { Textbefehl, TextbefehlMindeststufe } from "../contracts";
import { PanelApiError } from "../../../contracts/panel-error";

const pathFor = (channelId: string, name?: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/text_commands/commands${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

const json = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "Anfrage fehlgeschlagen.";
    throw new PanelApiError(response.status, message, body);
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
  body?: Record<string, string | number | boolean>,
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
  command: { name: string; kind: "text" | "list"; text?: string; cooldownSekunden: number },
): Promise<void> => mutation(channelId, "POST", command);

export const speichereTextbefehl = async (
  channelId: string,
  command: { oldName: string; name: string; kind: "text" | "list"; text?: string; cooldownSekunden: number },
): Promise<void> => mutation(channelId, "PATCH", {
  name: command.name,
  kind: command.kind,
  ...(command.text === undefined ? {} : { text: command.text }),
  cooldownSekunden: command.cooldownSekunden,
}, command.oldName);

export const schalteTextbefehl = async (
  channelId: string,
  name: string,
  enabled: boolean,
): Promise<void> => mutation(channelId, "PATCH", { enabled }, name);

export const setzeTextbefehlMindeststufe = async (
  channelId: string,
  name: string,
  mindeststufe: TextbefehlMindeststufe,
): Promise<void> => mutation(channelId, "PATCH", { mindeststufe }, name);

export const loescheTextbefehl = async (channelId: string, name: string): Promise<void> =>
  mutation(channelId, "DELETE", undefined, name);

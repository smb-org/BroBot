import type { TextCommand, TextCommandMinimumTier } from "../contracts";
import { PanelApiError } from "../../../contracts/panel-error";

const pathFor = (channelId: string, name?: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/text_commands/commands${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

const json = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as T;
};

export const loadTextCommands = async (channelId: string): Promise<TextCommand[]> => {
  const response = await fetch(pathFor(channelId));
  const body = await json<{ commands: TextCommand[] }>(response);
  return body.commands;
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

export const createTextCommand = async (
  channelId: string,
  command: { name: string; kind: "text" | "list"; text?: string; cooldownSeconds: number },
): Promise<void> => mutation(channelId, "POST", command);

export const saveTextCommand = async (
  channelId: string,
  command: { oldName: string; name: string; kind: "text" | "list"; text?: string; cooldownSeconds: number },
): Promise<void> => mutation(channelId, "PATCH", {
  name: command.name,
  kind: command.kind,
  ...(command.text === undefined ? {} : { text: command.text }),
  cooldownSeconds: command.cooldownSeconds,
}, command.oldName);

export const toggleTextCommand = async (
  channelId: string,
  name: string,
  enabled: boolean,
): Promise<void> => mutation(channelId, "PATCH", { enabled }, name);

export const setTextCommandMinimumTier = async (
  channelId: string,
  name: string,
  minimumTier: TextCommandMinimumTier,
): Promise<void> => mutation(channelId, "PATCH", { minimumTier: minimumTier }, name);

export const deleteTextCommand = async (channelId: string, name: string): Promise<void> =>
  mutation(channelId, "DELETE", undefined, name);

import type { TextCommand, TextCommandKind, TextCommandMinimumTier, TextCommandResponseType, TextCommandStreamCondition } from "../contracts";
import { PanelApiError } from "../../../contracts/panel-error";
import type { PanelTemplateWarning, PanelTemplateWarningResponse } from "../contract";

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
  body?: unknown,
  name?: string,
  query?: string,
): Promise<readonly PanelTemplateWarning[]> => {
  const csrfResponse = await fetch("/api/csrf");
  const csrf = await json<{ token: string }>(csrfResponse);
  const response = await fetch(`${pathFor(channelId, name)}${query === undefined ? "" : `?${query}`}`, {
    method,
    headers: {
      "X-CSRF-Token": csrf.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (method === "DELETE") {
    await json<unknown>(response);
    return [];
  }
  return (await json<PanelTemplateWarningResponse>(response)).warnings;
};

export const createTextCommand = async (
  channelId: string,
  command: Pick<TextCommand, "name" | "kind" | "text" | "offlineText" | "notFollowingText" | "unavailableText" | "usageText" | "minimumTier" | "cooldownSeconds" | "aliases" | "userCooldownSeconds" | "streamCondition" | "responseType">,
): Promise<readonly PanelTemplateWarning[]> => mutation(channelId, "POST", command);

export const saveTextCommand = async (
  channelId: string,
  command: {
    oldName: string;
    revision: number;
    name: string;
    kind: TextCommandKind;
    text: string;
    offlineText?: string;
    notFollowingText?: string;
    unavailableText?: string;
    usageText?: string;
    minimumTier: TextCommandMinimumTier;
    cooldownSeconds: number;
    aliases: readonly string[];
    userCooldownSeconds: number;
    streamCondition: TextCommandStreamCondition;
    responseType: TextCommandResponseType;
},
): Promise<readonly PanelTemplateWarning[]> => mutation(channelId, "PATCH", {
  revision: command.revision,
  name: command.name,
  kind: command.kind,
  text: command.text,
  offlineText: command.offlineText,
  notFollowingText: command.notFollowingText,
  unavailableText: command.unavailableText,
  usageText: command.usageText,
  minimumTier: command.minimumTier,
  cooldownSeconds: command.cooldownSeconds,
  aliases: command.aliases,
  userCooldownSeconds: command.userCooldownSeconds,
  streamCondition: command.streamCondition,
  responseType: command.responseType,
}, command.oldName);

export const toggleTextCommand = async (
  channelId: string,
  name: string,
  revision: number,
  enabled: boolean,
): Promise<readonly PanelTemplateWarning[]> => mutation(channelId, "PATCH", { revision, enabled }, name);

export const setTextCommandMinimumTier = async (
  channelId: string,
  name: string,
  revision: number,
  minimumTier: TextCommandMinimumTier,
): Promise<readonly PanelTemplateWarning[]> => mutation(channelId, "PATCH", { revision, minimumTier: minimumTier }, name);

export const deleteTextCommand = async (channelId: string, name: string, revision: number): Promise<void> => {
  await mutation(channelId, "DELETE", undefined, name, `revision=${String(revision)}`);
};

import type { TextCommand, TextCommandKind, TextCommandMinimumTier, TextCommandResponseType, TextCommandStreamCondition } from "../contracts";
import type { TextCommandGame as TwitchGame } from "../contracts";
import { PanelApiError } from "../../../contracts/panel-error";
import type { PanelTemplateWarning } from "../contract";
import type { ModuleRegisteredTemplateVariable } from "../../contract";

export interface TextCommandChannelVariable {
  name: string;
  value: number;
  description: string;
}

export interface TextCommandPanelData {
  commands: TextCommand[];
  variables: TextCommandChannelVariable[];
}

export interface TextCommandMutationResult {
  command: TextCommand;
  warnings: readonly PanelTemplateWarning[];
}

export const textBlockNamesForPicker = (variables: readonly ModuleRegisteredTemplateVariable[]): string[] =>
  variables.filter((variable) => variable.isTextBlock).map(({ name }) => name);

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

export const loadTextCommandData = async (channelId: string, signal?: AbortSignal): Promise<TextCommandPanelData> => {
  const response = await fetch(pathFor(channelId), signal === undefined ? undefined : { signal });
  return json<TextCommandPanelData>(response);
};

export const loadTextCommands = async (channelId: string): Promise<TextCommand[]> => (await loadTextCommandData(channelId)).commands;

export const loadRegisteredTemplateVariables = async (channelId: string, signal?: AbortSignal): Promise<readonly ModuleRegisteredTemplateVariable[]> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/template-variables`, signal === undefined ? undefined : { signal });
  return (await json<{ variables: readonly ModuleRegisteredTemplateVariable[] }>(response)).variables;
};

export const searchTextGames = async (channelId: string, query: string): Promise<readonly TwitchGame[]> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/games?q=${encodeURIComponent(query)}`);
  return (await json<{ games: TwitchGame[] }>(response)).games;
};

const mutation = async <Result,>(
  channelId: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  name?: string,
  query?: string,
): Promise<Result> => {
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
  return json<Result>(response);
};

export const createTextCommand = async (
  channelId: string,
  command: Pick<TextCommand, "name" | "kind" | "text" | "offlineText" | "notFollowingText" | "unavailableText" | "usageText" | "minimumTier" | "cooldownSeconds" | "aliases" | "userCooldownSeconds" | "streamCondition" | "games" | "responseType" | "chatTarget" | "variableAction" | "timeoutAction">,
): Promise<TextCommandMutationResult> => mutation<TextCommandMutationResult>(channelId, "POST", command);

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
    games?: TextCommand["games"];
    responseType: TextCommandResponseType;
    chatTarget: TextCommand["chatTarget"];
    variableAction: TextCommand["variableAction"];
    timeoutAction: TextCommand["timeoutAction"];
},
): Promise<TextCommandMutationResult> => mutation<TextCommandMutationResult>(channelId, "PATCH", {
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
  games: command.games ?? [],
  responseType: command.responseType,
  chatTarget: command.chatTarget,
  variableAction: command.variableAction,
  timeoutAction: command.timeoutAction,
}, command.oldName);

export const toggleTextCommand = async (
  channelId: string,
  name: string,
  revision: number,
  enabled: boolean,
): Promise<TextCommandMutationResult> => mutation<TextCommandMutationResult>(channelId, "PATCH", { revision, enabled }, name);

export const setTextCommandMinimumTier = async (
  channelId: string,
  name: string,
  revision: number,
  minimumTier: TextCommandMinimumTier,
): Promise<TextCommandMutationResult> => mutation<TextCommandMutationResult>(channelId, "PATCH", { revision, minimumTier: minimumTier }, name);

export const deleteTextCommand = async (channelId: string, name: string, revision: number): Promise<void> => {
  await mutation<{ ok: true }>(channelId, "DELETE", undefined, name, `revision=${String(revision)}`);
};

import { PanelApiError } from "../../../contracts/panel-error";
import { TEXT_LIBRARY_LIBRARY_PATH, type TextBlock, type TextBlockCategory, type TextLibraryData, type TextBlockUsage, type TwitchGame, type TextBlockMutationInput, type TextBlockSaveInput } from "../contracts";
import type { ModuleRegisteredTemplateVariable } from "../../contract";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../../contract";

export interface TextLibraryPanelData extends TextLibraryData {
  templateVariables: readonly ModuleRegisteredTemplateVariable[];
  channelSettings: { timeZone: string; revision: number };
}

const basePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/text_library`;

const readJson = async <T,>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as T;
};

export const loadTextLibrary = async (channelId: string): Promise<TextLibraryPanelData> => {
  const encodedChannelId = encodeURIComponent(channelId);
  // The three requests are started together first and only then read as JSON.
  // Awaiting each `fetch` inside the `Promise.all([...])` array (as written
  // before) evaluates the array elements one at a time: the second and third
  // `fetch` calls do not even start until the previous one's `await` resolves.
  // Worse, if an earlier response turns out to be an error, `readJson` starts
  // rejecting for it *before* the array literal finishes evaluating -- at
  // that point nothing has attached a handler to that rejection yet (`Promise.all`
  // only runs once all three elements are known), so it surfaces as an
  // unhandled rejection instead of the caller's `catch`.
  const [libraryResponse, registeredResponse, settingsResponse] = await Promise.all([
    fetch(`${basePath(channelId)}${TEXT_LIBRARY_LIBRARY_PATH}`),
    fetch(`/api/channels/${encodedChannelId}/template-variables`),
    fetch(`/api/channels/${encodedChannelId}/settings`),
  ]);
  const [library, registered, channelSettings] = await Promise.all([
    readJson<TextLibraryData>(libraryResponse),
    readJson<{ variables: ModuleRegisteredTemplateVariable[] }>(registeredResponse),
    readJson<{ timeZone: string; revision: number }>(settingsResponse),
  ]);
  return {
    ...library,
    templateVariables: registered.variables,
    channelSettings: {
      timeZone: channelSettings.timeZone || DEFAULT_CHANNEL_TIME_ZONE,
      revision: channelSettings.revision,
    },
  };
};

export const searchTextLibraryGames = async (channelId: string, query: string): Promise<readonly TwitchGame[]> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/games?q=${encodeURIComponent(query)}`);
  return (await readJson<{ games: TwitchGame[] }>(response)).games;
};

let previewCsrfToken: Promise<string> | null = null;

const readPreviewCsrfToken = (): Promise<string> => {
  previewCsrfToken ??= fetch("/api/csrf").then((response) => readJson<{ token: string }>(response)).then(({ token }) => token).catch((error: unknown) => {
    previewCsrfToken = null;
    throw error;
  });
  return previewCsrfToken;
};

export const renderTextLibraryPreview = async (
  channelId: string,
  input: {
    text: string;
    templateContext: "chat_command" | "event";
    streamState: "online" | "offline" | "unknown";
    game: TwitchGame | null;
    chatStatus: readonly ("viewer" | "subscriber" | "vip" | "moderator" | "broadcaster")[] | null;
  },
): Promise<{ text: string; diagnostics: readonly { code: string }[] }> => {
  const csrfToken = await readPreviewCsrfToken();
  return readJson(await fetch(`/api/channels/${encodeURIComponent(channelId)}/template-preview`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
};

const mutate = async <T,>(channelId: string, path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  const response = await fetch(`${basePath(channelId)}${path}`, {
    method,
    headers: {
      "X-CSRF-Token": csrf.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  return readJson<T>(response);
};

export const createTextBlock = async (channelId: string, block: TextBlockMutationInput): Promise<TextBlock> =>
  (await mutate<{ block: TextBlock }>(channelId, "/blocks", "POST", block)).block;

export const saveTextBlock = async (channelId: string, block: TextBlockSaveInput): Promise<TextBlock> =>
  (await mutate<{ block: TextBlock }>(channelId, `/blocks/${encodeURIComponent(block.name)}`, "PATCH", block)).block;

export const deleteTextBlock = async (channelId: string, name: string, revision: number): Promise<void> => {
  await mutate<{ ok: boolean }>(channelId, `/blocks/${encodeURIComponent(name)}?revision=${String(revision)}`, "DELETE");
};

export const createTextCategory = async (channelId: string, name: string): Promise<TextBlockCategory> =>
  (await mutate<{ category: TextBlockCategory }>(channelId, "/categories", "POST", { name })).category;

export const renameTextCategory = async (channelId: string, id: string, name: string): Promise<void> => {
  await mutate<{ ok: boolean }>(channelId, `/categories/${encodeURIComponent(id)}`, "PATCH", { name });
};

export const deleteTextCategory = async (channelId: string, id: string): Promise<void> => {
  await mutate<{ ok: boolean }>(channelId, `/categories/${encodeURIComponent(id)}`, "DELETE");
};

export type { TextBlock, TextBlockUsage, TwitchGame };

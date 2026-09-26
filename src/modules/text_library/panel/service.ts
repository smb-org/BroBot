import { PanelApiError } from "../../../contracts/panel-error";
import { TEXT_LIBRARY_GAME_SEARCH_PATH, TEXT_LIBRARY_LIBRARY_PATH, type TextBlock, type TextBlockCategory, type TextLibraryData, type TextBlockUsage, type TwitchGame, type TextBlockMutationInput } from "../contracts";

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

export const loadTextLibrary = async (channelId: string): Promise<TextLibraryData> =>
  readJson<TextLibraryData>(await fetch(`${basePath(channelId)}${TEXT_LIBRARY_LIBRARY_PATH}`));

export const searchTextLibraryGames = async (channelId: string, query: string): Promise<readonly TwitchGame[]> => {
  const response = await fetch(`${basePath(channelId)}${TEXT_LIBRARY_GAME_SEARCH_PATH}?q=${encodeURIComponent(query)}`);
  return (await readJson<{ games: TwitchGame[] }>(response)).games;
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

export const saveTextBlock = async (channelId: string, block: TextBlockMutationInput): Promise<TextBlock> =>
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

export const saveTextLibraryTimeZone = async (channelId: string, timeZone: string, revision: number): Promise<void> => {
  await mutate<{ ok: boolean }>(channelId, "/settings", "PATCH", { timeZone, revision });
};

export const previewTextBlock = async (
  channelId: string,
  name: string,
  simulation: { streamState: "online" | "offline"; gameId: string | null; chatStatus: readonly string[] | null; now?: number },
): Promise<{ variantId: string | null; text: string; timeZone: string }> =>
  mutate<{ variantId: string | null; text: string; timeZone: string }>(channelId, `/preview/${encodeURIComponent(name)}`, "POST", simulation);

export type { TextBlock, TextBlockUsage, TwitchGame };

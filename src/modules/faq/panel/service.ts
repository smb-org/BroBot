import { PanelApiError } from "../../../contracts/panel-error";
import type { FaqEntry, FaqGame, FaqMutationInput } from "../contracts";

export interface FaqPanelData {
  entries: FaqEntry[];
  blocks: string[];
}

export interface FaqTestResult {
  matches: boolean;
  reason: "matched" | "no_match" | "command_prefix";
  gameId: string | null;
  entry?: { id: string; name: string };
  matchedPattern?: string;
  skippedByGame: readonly { entryId: string; entryName: string; matchedPattern: string; games: readonly string[] }[];
}

const basePath = (channelId: string): string => `/api/channels/${encodeURIComponent(channelId)}/modules/faq`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

export const loadFaqPanel = async (channelId: string, signal?: AbortSignal): Promise<FaqPanelData> => {
  const encoded = encodeURIComponent(channelId);
  const [entriesResponse, variablesResponse] = await Promise.all([
    fetch(`${basePath(channelId)}/entries`, signal === undefined ? undefined : { signal }),
    fetch(`/api/channels/${encoded}/template-variables`, signal === undefined ? undefined : { signal }),
  ]);
  const [entries, variables] = await Promise.all([
    readJson<{ entries: FaqEntry[] }>(entriesResponse),
    readJson<{ variables: { name: string; isTextBlock?: boolean }[] }>(variablesResponse),
  ]);
  return {
    entries: entries.entries,
    blocks: variables.variables.filter((variable) => variable.isTextBlock === true).map(({ name }) => name),
  };
};

export const searchFaqGames = async (channelId: string, query: string): Promise<readonly FaqGame[]> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/games?q=${encodeURIComponent(query)}`);
  return (await readJson<{ games: FaqGame[] }>(response)).games;
};

const mutate = async <Value,>(channelId: string, path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Value> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return readJson<Value>(response);
};

export const createFaqEntry = async (channelId: string, input: FaqMutationInput): Promise<FaqEntry> =>
  (await mutate<{ entry: FaqEntry }>(channelId, "/entries", "POST", input)).entry;

export const updateFaqEntry = async (channelId: string, entry: FaqEntry, input: FaqMutationInput): Promise<FaqEntry> =>
  (await mutate<{ entry: FaqEntry }>(channelId, `/entries/${encodeURIComponent(entry.id)}`, "PATCH", { ...input, revision: entry.revision })).entry;

export const setFaqEntryEnabled = async (channelId: string, entry: FaqEntry, enabled: boolean): Promise<FaqEntry> =>
  (await mutate<{ entry: FaqEntry }>(channelId, `/entries/${encodeURIComponent(entry.id)}/enabled`, "PATCH", { enabled, revision: entry.revision })).entry;

export const moveFaqEntry = async (channelId: string, entry: FaqEntry, direction: "up" | "down"): Promise<void> => {
  await mutate<{ entries: FaqEntry[] }>(channelId, `/entries/${encodeURIComponent(entry.id)}/move`, "POST", { direction, revision: entry.revision });
};

export const deleteFaqEntry = async (channelId: string, entry: FaqEntry): Promise<void> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}/entries/${encodeURIComponent(entry.id)}?revision=${String(entry.revision)}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": token },
  });
  await readJson<unknown>(response);
};

export const testFaqMessage = async (channelId: string, message: string, gameId?: string | null): Promise<FaqTestResult> =>
  mutate<FaqTestResult>(channelId, "/test", "POST", { message, ...(gameId === undefined ? {} : { gameId }) });

export const faqErrorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

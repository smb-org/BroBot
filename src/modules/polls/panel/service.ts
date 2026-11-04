import { PanelApiError } from "../../../contracts/panel-error";
import type { PollsEntry, PollsEntryInput, PollsRun } from "../contracts";

const basePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/polls`;

const POLLS_BROADCASTER_SCOPES = ["channel:manage:polls", "channel:manage:predictions"] as const;

export interface PollsActionReadiness {
  ready: boolean;
  missingScopes: string[];
  metadataUnknown: boolean;
}

const unknownPollsActionReadiness = (): PollsActionReadiness => ({ ready: false, missingScopes: [], metadataUnknown: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : null;

export interface PollsPanelState {
  active: { poll: PollsRun | null; prediction: PollsRun | null };
  open: PollsRun[];
  entries: PollsEntry[];
}

export interface PollsHistoryPage {
  runs: PollsRun[];
  nextCursor: string | null;
}

export const loadPollsActionReadiness = async (channelId: string, signal?: AbortSignal): Promise<PollsActionReadiness> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules`, signal === undefined ? {} : { signal });
  if (!response.ok) throw new Error("Polls broadcaster scope metadata could not be loaded.");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.modules)) return unknownPollsActionReadiness();
  const module: unknown = (payload.modules as unknown[]).find((candidate) => isRecord(candidate) && candidate.id === "polls");
  if (!isRecord(module) || module.broadcasterScopeMetadataUnknown === true) return unknownPollsActionReadiness();
  const required = stringArray(module.requiredBroadcasterScopes);
  const missing = stringArray(module.missingBroadcasterScopes);
  if (required === null || missing === null || !POLLS_BROADCASTER_SCOPES.every((scope) => required.includes(scope))) {
    return unknownPollsActionReadiness();
  }
  const missingScopes = POLLS_BROADCASTER_SCOPES.filter((scope) => missing.includes(scope));
  return { ready: missingScopes.length === 0, missingScopes: [...missingScopes], metadataUnknown: false };
};

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "string" ? payload.error : null;
    throw new PanelApiError(response.status, code, payload);
  }
  return payload as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

const request = async <Value,>(channelId: string, path: string, method: "POST" | "PUT" | "DELETE", value?: unknown): Promise<Value> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, ...(value === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (response.status === 204) return undefined as Value;
  return readJson<Value>(response);
};

export const loadPollsState = async (channelId: string, signal?: AbortSignal): Promise<PollsPanelState> =>
  readJson<PollsPanelState>(await fetch(`${basePath(channelId)}/state`, signal === undefined ? {} : { signal }));

export const loadPollsHistory = async (
  channelId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<PollsHistoryPage> => {
  const search = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return readJson<PollsHistoryPage>(await fetch(
    `${basePath(channelId)}/history${search}`,
    signal === undefined ? {} : { signal },
  ));
};

export const createPollsEntry = async (channelId: string, input: PollsEntryInput): Promise<PollsEntry> =>
  (await request<{ entry: PollsEntry }>(channelId, "/entries", "POST", input)).entry;

export const updatePollsEntry = async (
  channelId: string,
  entryId: string,
  revision: number,
  input: PollsEntryInput,
): Promise<PollsEntry> => (await request<{ entry: PollsEntry }>(
  channelId,
  `/entries/${encodeURIComponent(entryId)}`,
  "PUT",
  { ...input, revision },
)).entry;

export const deletePollsEntry = async (channelId: string, entryId: string): Promise<void> => {
  await request<undefined>(channelId, `/entries/${encodeURIComponent(entryId)}`, "DELETE");
};

export const startPollsEntry = async (channelId: string, entryId: string): Promise<PollsRun> =>
  (await request<{ run: PollsRun }>(channelId, `/entries/${encodeURIComponent(entryId)}/start`, "POST")).run;

export const endPollsRun = async (channelId: string, runId: string): Promise<PollsRun> =>
  (await request<{ run: PollsRun }>(channelId, `/runs/${encodeURIComponent(runId)}/end`, "POST")).run;

export const lockPollsRun = async (channelId: string, runId: string): Promise<PollsRun> =>
  (await request<{ run: PollsRun }>(channelId, `/runs/${encodeURIComponent(runId)}/lock`, "POST")).run;

export const cancelPollsRun = async (channelId: string, runId: string): Promise<PollsRun> =>
  (await request<{ run: PollsRun }>(channelId, `/runs/${encodeURIComponent(runId)}/cancel`, "POST")).run;

export const resolvePollsRun = async (
  channelId: string,
  runId: string,
  winningChoiceId: string,
): Promise<PollsRun> => (await request<{ run: PollsRun }>(
  channelId,
  `/runs/${encodeURIComponent(runId)}/resolve`,
  "POST",
  { winningChoiceId },
)).run;

export const dismissPollsRun = async (channelId: string, runId: string): Promise<PollsRun> =>
  (await request<{ run: PollsRun }>(channelId, `/runs/${encodeURIComponent(runId)}/dismiss`, "POST")).run;

export const loadFreshPrediction = async (
  channelId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<PollsRun> => (await readJson<{ run: PollsRun }>(await fetch(
  `${basePath(channelId)}/runs/${encodeURIComponent(runId)}/fresh`,
  signal === undefined ? {} : { signal },
))).run;

export const reconcilePolls = async (channelId: string, force: boolean): Promise<void> => {
  await request<{ ok: true }>(channelId, "/reconcile", "POST", force ? { force: true } : {});
};

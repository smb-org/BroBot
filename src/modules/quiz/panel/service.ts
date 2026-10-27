import { PanelApiError } from "../../../contracts/panel-error";
import type { QuizSet, QuizSetInput, QuizSetPage } from "../contracts";

const basePath = (channelId: string): string => `/api/channels/${encodeURIComponent(channelId)}/modules/quiz`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : null;
    throw new PanelApiError(response.status, code, payload);
  }
  return payload as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

export const loadQuizSets = async (channelId: string, page: number, search: string, signal?: AbortSignal): Promise<QuizSetPage> => {
  const params = new URLSearchParams({ page: String(page) });
  if (search.trim().length > 0) params.set("q", search.trim());
  return readJson<QuizSetPage>(await fetch(`${basePath(channelId)}/sets?${params.toString()}`, signal === undefined ? {} : { signal }));
};

export const loadQuizSet = async (channelId: string, setId: string, signal?: AbortSignal): Promise<QuizSet> =>
  (await readJson<{ set: QuizSet }>(await fetch(
    `${basePath(channelId)}/sets/${encodeURIComponent(setId)}`,
    signal === undefined ? {} : { signal },
  ))).set;

const mutate = async <Value,>(channelId: string, path: string, method: "POST" | "PUT" | "DELETE", value?: unknown): Promise<Value> => {
  const token = await csrf();
  return readJson<Value>(await fetch(`${basePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, ...(value === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
};

export const createQuizSet = async (channelId: string, name: string): Promise<QuizSet> =>
  (await mutate<{ set: QuizSet }>(channelId, "/sets", "POST", { name })).set;

export const saveQuizSet = async (channelId: string, setId: string, revision: number, input: QuizSetInput): Promise<QuizSet> =>
  (await mutate<{ set: QuizSet }>(channelId, `/sets/${encodeURIComponent(setId)}`, "PUT", { ...input, revision })).set;

export const deleteQuizSet = async (channelId: string, setId: string, revision: number): Promise<void> => {
  await mutate<{ removed: boolean }>(channelId, `/sets/${encodeURIComponent(setId)}?revision=${String(revision)}`, "DELETE");
};

export const quizErrorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

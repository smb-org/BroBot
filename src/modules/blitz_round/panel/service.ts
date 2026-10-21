import { PanelApiError } from "../../../contracts/panel-error";
import { blitzRoundSettingsSchema, type BlitzQuestion, type BlitzQuestionInput, type BlitzQuestionPage, type BlitzRoundSettings } from "../contracts";

const basePath = (channelId: string): string => `/api/channels/${encodeURIComponent(channelId)}/modules/blitz_round`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : null;
    throw new PanelApiError(response.status, code, payload);
  }
  return payload as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

export const loadBlitzQuestions = async (channelId: string, page: number, search: string, signal?: AbortSignal): Promise<BlitzQuestionPage> => {
  const params = new URLSearchParams({ page: String(page) });
  if (search.trim().length > 0) params.set("q", search.trim());
  return readJson<BlitzQuestionPage>(await fetch(`${basePath(channelId)}/questions?${params.toString()}`, signal === undefined ? {} : { signal }));
};

export const loadBlitzQuestion = async (channelId: string, questionId: string, signal?: AbortSignal): Promise<BlitzQuestion> =>
  (await readJson<{ question: BlitzQuestion }>(await fetch(
    `${basePath(channelId)}/questions/${encodeURIComponent(questionId)}`,
    signal === undefined ? {} : { signal },
  ))).question;

export const loadBlitzSettings = async (channelId: string, signal?: AbortSignal): Promise<{ settings: BlitzRoundSettings; revision: number }> => {
  const parsed = await readJson<{ settings: unknown; revision: number }>(await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/blitz_round/settings`, signal === undefined ? {} : { signal }));
  const settings = blitzRoundSettingsSchema.safeParse(parsed.settings);
  if (!settings.success) throw new Error("settings_invalid");
  return { settings: settings.data, revision: parsed.revision };
};

const mutate = async <Value,>(channelId: string, path: string, method: "POST" | "PATCH" | "DELETE", value?: unknown): Promise<Value> => {
  const token = await csrf();
  return readJson<Value>(await fetch(`${basePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, ...(value === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
};

export const createBlitzQuestion = async (channelId: string, input: BlitzQuestionInput): Promise<BlitzQuestion> =>
  (await mutate<{ question: BlitzQuestion }>(channelId, "/questions", "POST", input)).question;

export const updateBlitzQuestion = async (channelId: string, id: string, revision: number, input: BlitzQuestionInput): Promise<BlitzQuestion> =>
  (await mutate<{ question: BlitzQuestion }>(channelId, `/questions/${encodeURIComponent(id)}`, "PATCH", { ...input, revision })).question;

export const deleteBlitzQuestion = async (channelId: string, id: string, revision: number): Promise<void> => {
  await mutate<{ removed: boolean }>(channelId, `/questions/${encodeURIComponent(id)}?revision=${String(revision)}`, "DELETE");
};

export const saveBlitzSettings = async (channelId: string, revision: number, settings: BlitzRoundSettings): Promise<{ settings: BlitzRoundSettings; revision: number }> => {
  const token = await csrf();
  return readJson<{ settings: BlitzRoundSettings; revision: number }>(await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/blitz_round/settings`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ revision, settings }),
  }));
};

export const blitzErrorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

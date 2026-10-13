import { PanelApiError } from "../../../contracts/panel-error";
import { isEventTemplateVariableAvailable } from "../../../contracts/event-template-variables";
import type { TemplateTextFieldVariable } from "../../../dashboard/ui";
import type { ModuleLanguage, TemplateVariable } from "../../contract";
import type { Timer, TimerMutationInput } from "../contracts";

interface TimerEventTimeSource {
  id: string;
  label: Readonly<Record<ModuleLanguage, string>>;
}

export interface TimersPanelData {
  timers: Timer[];
  sources: TimerEventTimeSource[];
  variables: TemplateTextFieldVariable[];
}

const basePath = (channelId: string): string => `/api/channels/${encodeURIComponent(channelId)}/modules/timers`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

export const loadTimersPanel = async (channelId: string, signal?: AbortSignal): Promise<TimersPanelData> => {
  const encoded = encodeURIComponent(channelId);
  const [timersResponse, sourcesResponse, variablesResponse] = await Promise.all([
    fetch(`${basePath(channelId)}/timers`, signal === undefined ? undefined : { signal }),
    fetch(`${basePath(channelId)}/event-time-sources`, signal === undefined ? undefined : { signal }),
    fetch(`/api/channels/${encoded}/template-variables`, signal === undefined ? undefined : { signal }),
  ]);
  const [timers, sources, variables] = await Promise.all([
    readJson<{ timers: Timer[] }>(timersResponse),
    readJson<{ sources: TimerEventTimeSource[] }>(sourcesResponse),
    readJson<{ variables: { name: string; isTextBlock?: boolean; availableInEventTemplates?: boolean; description?: string; sample?: string; group?: TemplateTextFieldVariable["group"]; contexts?: TemplateVariable["contexts"]; parameters?: TemplateTextFieldVariable["parameters"]; parameterDefault?: string }[] }>(variablesResponse),
  ]);
  return {
    timers: timers.timers,
    sources: sources.sources,
    variables: variables.variables.filter(isEventTemplateVariableAvailable).map((variable) => ({
      name: variable.name,
      description: variable.description ?? variable.name,
      sample: variable.sample ?? "",
      ...(variable.group === undefined ? {} : { group: variable.group }),
      ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
      ...(variable.parameters === "choices" || variable.parameters === "currency_pair"
        ? { parameter: { value: variable.parameterDefault ?? (variable.parameters === "choices" ? "a|b|c" : "USD EUR") } }
        : {}),
      kind: "module",
      ...(variable.isTextBlock === true ? { isTextBlock: true } : {}),
    })),
  };
};

const mutate = async <Value,>(channelId: string, path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Value> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as Value;
  return readJson<Value>(response);
};

export const createTimer = async (channelId: string, input: TimerMutationInput): Promise<Timer> =>
  (await mutate<{ timer: Timer }>(channelId, "/timers", "POST", input)).timer;

export const updateTimer = async (channelId: string, timerId: string, input: TimerMutationInput, revision: number): Promise<Timer> =>
  (await mutate<{ timer: Timer }>(channelId, `/timers/${encodeURIComponent(timerId)}`, "PATCH", { ...input, revision })).timer;

export const setTimerEnabled = async (channelId: string, timerId: string, enabled: boolean, revision: number): Promise<Timer> =>
  (await mutate<{ timer: Timer }>(channelId, `/timers/${encodeURIComponent(timerId)}/enabled`, "PATCH", { enabled, revision })).timer;

export const deleteTimer = async (channelId: string, timerId: string, revision: number): Promise<void> => {
  await mutate(channelId, `/timers/${encodeURIComponent(timerId)}?revision=${String(revision)}`, "DELETE");
};

export const previewTimerText = async (channelId: string, messageText: string): Promise<string> => {
  const token = await csrf();
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/template-preview`, {
    method: "POST",
    headers: { "X-CSRF-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: messageText,
      templateContext: "event",
      streamState: "online",
      game: null,
      chatStatus: null,
    }),
  });
  return (await readJson<{ text: string }>(response)).text;
};

export const timerErrorCode = (error: unknown): string | null =>
  error instanceof PanelApiError ? error.code : null;

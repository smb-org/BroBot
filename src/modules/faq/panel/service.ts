import { PanelApiError } from "../../../contracts/panel-error";
import { isEventTemplateVariableAvailable } from "../../../contracts/event-template-variables";
import type { TemplateTextFieldVariable } from "../../../dashboard/ui";
import { SYSTEM_TEMPLATE_VARIABLE_LIST, type TemplateVariable } from "../../contract";
import type { FaqEntry, FaqGame, FaqMutationInput } from "../contracts";

export interface FaqPanelData {
  entries: FaqEntry[];
  orderRevision: number;
  variables: TemplateTextFieldVariable[];
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
    readJson<{ entries: FaqEntry[]; orderRevision: number }>(entriesResponse),
    readJson<{ variables: { name: string; isTextBlock?: boolean; availableInEventTemplates?: boolean; description?: string; sample?: string; group?: TemplateTextFieldVariable["group"]; contexts?: TemplateVariable["contexts"]; parameters?: TemplateTextFieldVariable["parameters"]; parameterDefault?: string }[] }>(variablesResponse),
  ]);
  const systemVariables: TemplateTextFieldVariable[] = SYSTEM_TEMPLATE_VARIABLE_LIST
    .filter(isEventTemplateVariableAvailable)
    .map((variable) => ({
      name: variable.name,
      description: variable.name,
      sample: variable.sample,
      ...(variable.group === undefined ? {} : { group: variable.group }),
      kind: "system",
      ...(variable.external === undefined ? {} : { external: variable.external }),
      ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
      ...(variable.parameters === "choices" || variable.parameters === "currency_pair"
        ? { parameter: { value: variable.parameters === "choices" ? "a|b|c" : "USD EUR" } }
        : {}),
    }));
  const registeredVariables = variables.variables.filter(isEventTemplateVariableAvailable).map((variable) => ({
    name: variable.name,
    description: variable.description ?? variable.name,
    sample: variable.sample ?? "",
    ...(variable.group === undefined ? {} : { group: variable.group }),
    ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
    ...(variable.parameters === "choices" || variable.parameters === "currency_pair"
      ? { parameter: { value: variable.parameterDefault ?? (variable.parameters === "choices" ? "a|b|c" : "USD EUR") } }
      : {}),
    kind: "module" as const,
    ...(variable.isTextBlock === true ? { isTextBlock: true } : {}),
  }));
  const pickerVariables = new Map<string, TemplateTextFieldVariable>();
  [...systemVariables, ...registeredVariables].forEach((variable) => pickerVariables.set(variable.name, variable));
  return {
    entries: entries.entries,
    orderRevision: entries.orderRevision,
    variables: [...pickerVariables.values()],
  };
};

export const searchFaqGames = async (channelId: string, query: string): Promise<readonly FaqGame[]> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/games?q=${encodeURIComponent(query)}`);
  return (await readJson<{ games: FaqGame[] }>(response)).games;
};

export const lookupFaqGames = async (channelId: string, ids: readonly string[]): Promise<readonly FaqGame[]> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/games?ids=${encodeURIComponent(ids.join(","))}`);
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

export const updateFaqEntry = async (channelId: string, entryId: string, input: FaqMutationInput, revision: number): Promise<FaqEntry> =>
  (await mutate<{ entry: FaqEntry }>(channelId, `/entries/${encodeURIComponent(entryId)}`, "PATCH", { ...input, revision })).entry;

export const reorderFaqEntries = async (channelId: string, order: readonly string[], revision: number): Promise<{ entries: FaqEntry[]; orderRevision: number }> =>
  mutate<{ entries: FaqEntry[]; orderRevision: number }>(channelId, "/entries/order", "POST", { order, revision });

export const deleteFaqEntry = async (channelId: string, entryId: string, revision: number): Promise<void> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}/entries/${encodeURIComponent(entryId)}?revision=${String(revision)}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": token },
  });
  await readJson<unknown>(response);
};

export const faqErrorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

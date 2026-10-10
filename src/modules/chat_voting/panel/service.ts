import { PanelApiError } from "../../../contracts/panel-error";
import type { ChatVote, ChatVoteCloseReason, ChatVoteTemplate, ChatVoteTemplateDraft, ChatVoteTerm, ChatVotingKind, ChatVotingTextMode } from "../contracts";

export interface ChatVotingPanelState {
  vote: ChatVote | null;
  counts: readonly number[] | null;
  revision: number;
  terms: readonly ChatVoteTerm[] | null;
  moreTerms: number | null;
  hasOpenBallot: boolean;
  defaultDurationSeconds: number;
}

export interface ChatVoteTemplateListState {
  templates: readonly ChatVoteTemplate[];
  count: number;
  maximum: number;
}

export interface ChatVoteRecentState {
  votes: readonly ChatVote[];
}

const readJson = async <Value>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PanelApiError(
      response.status,
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null,
      body,
    );
  }
  return body as Value;
};

const route = (channelId: string, path: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/chat_voting${path}`;

let cachedCsrfToken: string | null = null;
let csrfTokenRequest: Promise<string> | null = null;

export const loadChatVotingState = async (channelId: string): Promise<ChatVotingPanelState> =>
  readJson<ChatVotingPanelState>(await fetch(route(channelId, "/current")));

const csrfHeader = async (): Promise<string> => {
  if (cachedCsrfToken !== null) return cachedCsrfToken;
  csrfTokenRequest ??= (async () => {
    const { token } = await readJson<{ token: string }>(await fetch("/api/csrf"));
    cachedCsrfToken = token;
    return token;
  })().finally(() => { csrfTokenRequest = null; });
  return csrfTokenRequest;
};

const csrfMutation = async <Value>(
  keepalive: boolean,
  request: (token: string) => Promise<Value>,
): Promise<Value> => {
  const token = keepalive ? cachedCsrfToken : await csrfHeader();
  if (token === null) throw new Error("A cached CSRF token is required for a keepalive save.");
  try {
    return await request(token);
  } catch (error: unknown) {
    if (!(error instanceof PanelApiError) || error.status !== 403 || error.code !== "csrf_invalid") throw error;
    if (cachedCsrfToken === token) cachedCsrfToken = null;
    if (keepalive) throw error;
    return request(await csrfHeader());
  }
};

export const primeChatVotingCsrfToken = async (): Promise<void> => {
  try { await csrfHeader(); } catch { /* An active mutation can retry token loading. */ }
};

export interface StartChatVotingOptions {
  kind: ChatVotingKind;
  optionCount?: number;
  durationSeconds: number;
  textMode?: ChatVotingTextMode;
  labels?: readonly string[];
  title?: string;
}

export interface StartChatVoteTemplateOptions {
  templateId: string;
}

export const startChatVoting = async (channelId: string, options: StartChatVotingOptions | StartChatVoteTemplateOptions): Promise<ChatVote> => {
  return csrfMutation(false, async (token) => (await readJson<{ vote: ChatVote }>(await fetch(route(channelId, "/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({
      ...options,
    }),
}))).vote);
};

export const loadChatVoteTemplates = async (channelId: string): Promise<ChatVoteTemplateListState> =>
  readJson<ChatVoteTemplateListState>(await fetch(route(channelId, "/templates")));

export const loadRecentChatVotes = async (channelId: string): Promise<ChatVoteRecentState> =>
  readJson<ChatVoteRecentState>(await fetch(route(channelId, "/recent")));

export const createChatVoteTemplate = async (channelId: string): Promise<ChatVoteTemplate> => {
  return csrfMutation(false, async (token) => (await readJson<{ template: ChatVoteTemplate }>(await fetch(route(channelId, "/templates"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: "{}",
  }))).template);
};

export const saveChatVoteTemplate = async (
  channelId: string,
  templateId: string,
  baseRevision: number,
  draft: ChatVoteTemplateDraft,
  keepalive = false,
): Promise<ChatVoteTemplate> => {
  return csrfMutation(keepalive, async (token) => (await readJson<{ template: ChatVoteTemplate }>(await fetch(route(channelId, `/templates/${encodeURIComponent(templateId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ ...draft, revision: baseRevision }),
    keepalive,
  }))).template);
};

export const deleteChatVoteTemplate = async (channelId: string, template: ChatVoteTemplate): Promise<void> => {
  await csrfMutation(false, async (token) => readJson<{ ok: true }>(await fetch(route(channelId, `/templates/${encodeURIComponent(template.id)}`), {
    method: "DELETE",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ revision: template.revision }),
  })));
};

export const approveChatVotingTerm = async (channelId: string, pollId: string, term: string): Promise<void> => {
  await csrfMutation(false, async (token) => readJson<{ terms: readonly ChatVoteTerm[]; moreTerms: number; revision: number }>(await fetch(route(channelId, "/approve-term"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ pollId, term }),
  })));
};

export const closeChatVoting = async (channelId: string): Promise<void> => {
  await csrfMutation(false, async (token) => readJson<{ closing: boolean; pollId: string }>(await fetch(route(channelId, "/close"), {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  })));
};

export type { ChatVoteCloseReason };

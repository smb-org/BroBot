import { PanelApiError } from "../../../contracts/panel-error";
import type { ChatVote, ChatVoteCloseReason, ChatVotePreset } from "../contracts";

export interface ChatVotingPanelState {
  vote: ChatVote | null;
  counts: readonly number[] | null;
  revision: number;
  hasOpenBallot: boolean;
  closePending: boolean;
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

export const loadChatVotingState = async (channelId: string): Promise<ChatVotingPanelState> =>
  readJson<ChatVotingPanelState>(await fetch(route(channelId, "/current")));

const csrfHeader = async (): Promise<string> => {
  const token = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return token.token;
};

export const startChatVoting = async (
  channelId: string,
  preset: ChatVotePreset,
  optionCount?: number,
): Promise<ChatVote> => {
  const token = await csrfHeader();
  return (await readJson<{ vote: ChatVote }>(await fetch(route(channelId, "/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ preset, ...(optionCount === undefined ? {} : { optionCount }) }),
  }))).vote;
};

export const closeChatVoting = async (channelId: string): Promise<void> => {
  const token = await csrfHeader();
  await readJson<{ closing: boolean; pollId: string }>(await fetch(route(channelId, "/close"), {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  }));
};

export type { ChatVoteCloseReason };

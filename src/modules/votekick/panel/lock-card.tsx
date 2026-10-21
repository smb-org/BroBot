import { useEffect, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { useModuleQuery } from "../../../dashboard/data";
import type { DashboardLanguage } from "../../../dashboard/locale";
import type { ModulePanelProperties } from "../../contract";
import { loadVotekickPanel, type VotekickPanelData } from "./service";
import { votekickLockCardTexts } from "./locale";
import "./lock-card.css";

export type MutualLockState =
  | { kind: "chat_vote"; title: string | null; until: string }
  | { kind: "votekick"; target: string | null; until: string }
  | { kind: "unknown" }
  | null;

interface ChatVotingLockData {
  vote: { status: string; title: string | null; closesAt: string } | null;
  hasOpenBallot: boolean;
}

const loadChatVotingLockData = async (channelId: string, signal: AbortSignal): Promise<ChatVotingLockData> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/chat_voting/current`, { signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as ChatVotingLockData;
};

const lockStateFromPanelData = (voting: ChatVotingLockData | null, votekicks: VotekickPanelData | null): MutualLockState => {
  const runningVotekick = votekicks?.running;
  if (runningVotekick !== null && runningVotekick !== undefined && runningVotekick.status === "running") {
    return { kind: "votekick", target: runningVotekick.targetLogin ?? runningVotekick.targetUserId ?? null, until: runningVotekick.endsAt };
  }
  const vote = voting?.vote;
  if (vote !== null && vote !== undefined && (vote.status === "open" || vote.status === "closing")) {
    return { kind: "chat_vote", title: vote.title?.trim() || null, until: vote.closesAt };
  }
  if (voting?.hasOpenBallot === true) return { kind: "unknown" };
  return null;
};

const remainingTime = (until: string, now: number, unknownTime: string): string => {
  const end = Date.parse(until);
  if (!Number.isFinite(end)) return unknownTime;
  const seconds = Math.max(0, Math.ceil((end - now) / 1_000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};

export const VotekickLockCard = ({ state, status, language, now }: {
  state: MutualLockState;
  status: "loading" | "error" | "ready";
  language: DashboardLanguage;
  now: number;
}): ReactElement => {
  const words = votekickLockCardTexts(language);
  const active = state !== null;
  const title = state === null || state.kind === "unknown" ? "" : words.currentVote(
    state.kind === "chat_vote" ? state.title ?? words.chatVote : words.votekick(state.target ?? words.unknownTarget),
    remainingTime(state.until, now, words.unknownTime),
  );
  const body = status === "error" ? words.error
    : status === "loading" ? words.loading
      : state === null ? words.noVote
        : state.kind === "unknown" ? words.ballotUnknown : title;

  return <section className="votekick-lock-card" aria-label={words.title} data-state={status}>
    <header className="votekick-lock-card__header"><h2>{words.title}</h2><span className={active ? "is-running" : ""}>{status === "loading" ? words.loading : status === "error" ? words.error : active ? words.running : words.available}</span></header>
    <p className="votekick-lock-card__main" aria-live="polite">{body || " "}</p>
    <p className="votekick-lock-card__reserved">{words.explanation}</p>
  </section>;
};

const VotekickLockPanel = ({ channelId, language = "de" }: ModulePanelProperties): ReactElement => {
  const votingQuery = useModuleQuery(channelId, "chat_voting", "current", (signal) => loadChatVotingLockData(channelId, signal), { refetchInterval: 5_000 });
  const votekickQuery = useModuleQuery(channelId, "votekick", "panel", (signal) => loadVotekickPanel(channelId, signal), { refetchInterval: 5_000 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const isLoading = votingQuery.isPending || votekickQuery.isPending;
  const state = lockStateFromPanelData(votingQuery.data ?? null, votekickQuery.data ?? null);
  const status = votingQuery.isError || votekickQuery.isError ? "error" : isLoading ? "loading" : "ready";
  return <VotekickLockCard state={state} status={status} language={language} now={now} />;
};

export default VotekickLockPanel;

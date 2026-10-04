import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { Button } from "../../../dashboard/ui";
import type { ChatVotePreset } from "../contracts";
import type { ChatVotingPanelState } from "./service";
import { closeChatVoting, loadChatVotingState, startChatVoting } from "./service";
import { chatVotingPanelTexts } from "./locale-panel";

const dateText = (value: string | null, language: DashboardLanguage): string => {
  if (value === null || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
};

export const ChatVotingPanel = ({ channelId, language = "de" }: { channelId: string; language?: DashboardLanguage }): ReactElement => {
  const labels = chatVotingPanelTexts(language);
  const [state, setState] = useState<ChatVotingPanelState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await loadChatVotingState(channelId));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [channelId]);

  useEffect(() => { void Promise.resolve().then(() => refresh()); }, [refresh]);

  useEffect(() => {
    if (state?.vote?.status !== "open") return;
    const poll = (): void => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(poll, 2_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh, state?.vote?.status]);

  const start = async (preset: ChatVotePreset, optionCount?: number): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await startChatVoting(channelId, preset, optionCount);
      await refresh();
      setMessage({ kind: "success", text: labels.open });
    } catch (error: unknown) {
      setMessage({ kind: "error", text: error instanceof Error && "code" in error && error.code === "chat_voting_busy" ? labels.busy : labels.startError });
    } finally {
      setBusy(false);
    }
  };

  const close = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await closeChatVoting(channelId);
      await refresh();
      setMessage({ kind: "success", text: labels.closing });
    } catch {
      setMessage({ kind: "error", text: labels.closeError });
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return <p className={loadFailed ? "form-error" : "loading-line"} role={loadFailed ? "alert" : undefined}>{loadFailed ? labels.loadError : labels.loading}</p>;
  const vote = state.vote;
  const counts = state.counts ?? [];
  const total = counts.reduce((sum, count) => sum + count, 0);

  return <section className="module-stack" aria-label={labels.liveSection}>
    <section className="config-section" aria-label={labels.liveSection}>
      <div className="section-heading"><h2>{labels.liveSection}</h2></div>
      {vote === null ? <p className="empty-state">{labels.noVote}</p> : <>
        <p className="muted">{vote.status === "open" ? labels.open : labels.closed} · {labels.starts(dateText(vote.openedAt, language))}</p>
        {vote.status === "open" ? <p className="muted">{labels.ends(dateText(vote.closesAt, language))}</p> : null}
        <div className="table-wrap">
          <table className="table" aria-label={labels.liveSection}>
            <thead><tr><th scope="col">{labels.option}</th><th scope="col">{labels.voters}</th></tr></thead>
            <tbody>{vote.labels.map((label, index) => <tr key={`${vote.id}-${String(index)}`}>
              <th scope="row">{label}</th>
              <td className="number">{String(counts[index] ?? 0)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="muted">{labels.voterCount(vote.status === "closed" ? vote.voterCount ?? total : total)}</p>
        {vote.status === "open" ? <Button variant="secondary" icon="close" disabled={busy} onClick={() => { void close(); }}>{labels.close}</Button> : null}
      </>}
      {message === null ? null : <p className={message.kind === "error" ? "form-error" : "form-success"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
    </section>
    <section className="config-section" aria-label={labels.startSection}>
      <div className="section-heading"><h2>{labels.startSection}</h2></div>
      <div className="inspector-actions">
        <Button variant="secondary" disabled={busy || vote?.status === "open"} onClick={() => { void start("yes_no"); }}>{labels.yesNo}</Button>
        <Button variant="secondary" disabled={busy || vote?.status === "open"} onClick={() => { void start("scale_5"); }}>{labels.scale}</Button>
        {Array.from({ length: 8 }, (_, index) => index + 2).map((optionCount) => <Button key={optionCount} variant="secondary" disabled={busy || vote?.status === "open"} onClick={() => { void start("options_n", optionCount); }}>{labels.options(optionCount)}</Button>)}
      </div>
    </section>
  </section>;
};

export default ChatVotingPanel;

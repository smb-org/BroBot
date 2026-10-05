import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { Button, Led, NumberField } from "../../../dashboard/ui";
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
  const [message, setMessage] = useState<string | null>(null);
  const [optionCount, setOptionCount] = useState<number | "">(2);

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
    const poll = (): void => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(poll, 2_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);

  const start = async (preset: ChatVotePreset, optionCount?: number): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await startChatVoting(channelId, preset, optionCount);
      await refresh();
    } catch (error: unknown) {
      setMessage(error instanceof Error && "code" in error && error.code === "chat_voting_busy" ? labels.busy : labels.startError);
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
    } catch {
      setMessage(labels.closeError);
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return <p className={loadFailed ? "form-error" : "loading-line"} role={loadFailed ? "alert" : undefined}>{loadFailed ? labels.loadError : labels.loading}</p>;
  const vote = state.vote;
  const counts = state.counts ?? vote?.counts ?? [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const running = vote?.status === "open";
  const closed = vote?.status === "closed";
  const title = vote === null ? labels.currentVote : running ? labels.runningTitle : labels.closedTitle;
  const activeBallot = vote?.status === "open" || state.hasOpenBallot;
  const validOptionCount = typeof optionCount === "number" && Number.isInteger(optionCount) && optionCount >= 2 && optionCount <= 9;

  return <section className="module-stack chat-voting-panel" aria-label={labels.currentVote}>
    <section className="config-section" aria-label={title}>
      <div className="section-heading"><h2>{title}</h2></div>
      {vote === null ? <p className="empty-state">{labels.noVote}</p> : <>
        <div className="chat-voting-panel__status">
          <Led status={running ? "green" : "off"} word={running ? labels.runningStatus : labels.closedStatus} />
          <span className="muted">{labels.starts(dateText(vote.openedAt, language))}</span>
        </div>
        {running ? <p className="muted">{labels.ends(dateText(vote.closesAt, language))}</p> : null}
        <div className="chat-voting-results" aria-label={title}>
          <div className="chat-voting-results__header" aria-hidden="true">
            <span /> <span /> <span>{labels.count}</span> <span>{labels.percent}</span>
          </div>
          {vote.labels.map((label, index) => {
            const count = counts[index] ?? 0;
            const percent = total === 0 ? 0 : Math.round(count * 100 / total);
            return <div className="chat-voting-results__row" key={`${vote.id}-${String(index)}`} role="group" aria-label={labels.resultBar(label, count, percent)}>
              <span className="chat-voting-results__label">{label}</span>
              <span className="chat-voting-results__track" aria-hidden="true"><span style={{ width: `${String(percent)}%` }} /></span>
              <span className="number">{String(count)}</span>
              <span className="number">{String(percent)}%</span>
            </div>;
          })}
        </div>
        <p className="muted">{labels.voterCount(closed ? vote.voterCount ?? total : total)}</p>
        {vote.status === "open" ? <Button variant="secondary" icon="close" disabled={busy} onClick={() => { void close(); }}>{labels.close}</Button> : null}
      </>}
      {message === null ? null : <p className="form-error" role="alert">{message}</p>}
    </section>
    <section className="config-section" aria-label={labels.startSection}>
      <div className="section-heading"><h2>{labels.startSection}</h2></div>
      <div className="chat-voting-start-actions">
        <Button variant="secondary" disabled={busy || activeBallot} onClick={() => { void start("yes_no"); }}>{labels.yesNo}</Button>
        <Button variant="secondary" disabled={busy || activeBallot} onClick={() => { void start("scale_5"); }}>{labels.scale}</Button>
        <div className="chat-voting-options-start">
          <NumberField
            id="chat-voting-option-count"
            label={labels.optionCount}
            value={optionCount}
            min={2}
            max={9}
            step={1}
            increaseLabel={labels.increaseOptionCount}
            decreaseLabel={labels.decreaseOptionCount}
            disabled={busy || activeBallot}
            onChange={setOptionCount}
          />
          <Button variant="secondary" disabled={busy || activeBallot || !validOptionCount} onClick={() => { if (validOptionCount) void start("options_n", optionCount); }}>{labels.startOptions}</Button>
        </div>
      </div>
      {activeBallot ? <p className="muted">{labels.startDisabledReason}</p> : !validOptionCount ? <p className="form-error">{labels.invalidOptionCount}</p> : null}
    </section>
  </section>;
};

export default ChatVotingPanel;

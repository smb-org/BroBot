import type { ReactElement } from "react";

import { Button, EmptyState, Led } from "../../../dashboard/ui";
import type { ChatVoteTerm } from "../contracts";
import { rankVoteTerms } from "../domain";
import type { ChatVotingPanelState } from "./service";
import { chatVotingSavedPanelTexts } from "./locale-saved";
import { timeText } from "./date-range";

export interface ChatVotingLiveBlockProperties {
  state: ChatVotingPanelState | null;
  language: "de" | "en";
  busy: boolean;
  canOperate: boolean;
  onClose: () => void;
  onApprove: (pollId: string, term: string) => void;
}

export function ChatVotingLiveBlock({ state, language, busy, canOperate, onClose, onApprove }: ChatVotingLiveBlockProperties): ReactElement {
  const labels = chatVotingSavedPanelTexts(language);
  const vote = state?.vote ?? null;
  const running = vote?.status === "open";
  const counts = state?.counts ?? vote?.counts ?? [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const textTerms = state?.terms ?? vote?.textResults ?? [];
  const rankedTerms = rankVoteTerms(textTerms);
  const textTotal = textTerms.reduce((sum, entry) => sum + entry.count, 0);
  const termLeader = rankedTerms[0]?.term;
  const leaderCount = Math.max(0, ...counts);
  const leaderIndex = total === 0 ? -1 : counts.findIndex((count) => count === leaderCount);
  const count = vote?.kind === "free_text"
    ? vote.voterCount ?? textTotal
    : vote?.voterCount ?? total;
  const meta = running
    ? labels.votes(count, vote.requestedDurationSeconds === null ? labels.open : timeText(vote.closesAt, language))
    : vote === null ? "" : labels.endedVotes(count);

  if (vote === null) return <section className="chat-voting-live chat-voting-live--empty" aria-label={labels.title}>
    <div className="chat-voting-live__empty"><EmptyState title={labels.noVoteYet} description="" /></div>
  </section>;

  return <section className="chat-voting-live" aria-label={labels.title}>
    <header className="chat-voting-live__header">
      <Led status={running ? "green" : "off"} word={running ? labels.running : labels.ended} />
      <h2 className="chat-voting-live__question" title={vote.title ?? ""}>{vote.title ?? labels.untitled}</h2>
      <span className="chat-voting-live__meta mono">{meta}</span>
      <span className="chat-voting-live__action-slot">{running ? <Button danger onClick={onClose} disabled={busy || !canOperate}>{labels.end}</Button> : null}</span>
    </header>
    {vote.kind === "free_text" ? <div className="chat-voting-live__rows chat-voting-live__rows--free-text" role="list" aria-label={labels.answers}>
      {Array.from({ length: 5 }, (_unused, index) => {
        const entry: ChatVoteTerm | undefined = rankedTerms[index];
        if (entry === undefined) return <div className="chat-voting-results__row chat-voting-results__term-row chat-voting-results__empty-slot" key={vote.id + "-empty-" + String(index)} aria-hidden="true">
          <span className="chat-voting-results__label" />
          <span className="chat-voting-results__track" aria-hidden="true"><span /></span>
          <span className="number">—</span>
          <span className="number">—</span>
          <span className="chat-voting-results__approval" aria-hidden="true" />
        </div>;
        const percent = textTotal === 0 ? 0 : Math.round(entry.count * 100 / textTotal);
        const leading = entry.term === termLeader;
        return <div className="chat-voting-results__row chat-voting-results__term-row" data-leading={leading || undefined} key={vote.id + "-" + entry.term} role="group" aria-label={labels.voteCountAria(entry.term, entry.count, percent)}>
          <span className="chat-voting-results__label" title={entry.term}>{entry.term}</span>
          <span className="chat-voting-results__track" aria-hidden="true"><span style={{ width: String(percent) + "%" }} /></span>
          <span className="number">{String(entry.count)}</span>
          <span className="number">{String(percent)}%</span>
          <span className="chat-voting-results__approval">
            {entry.approved
              ? <span className="muted" title={labels.approved}>{labels.approved}</span>
              : <Button size="compact" disabled={!running || busy || !canOperate} title={labels.approve} ariaLabel={labels.approveTerm(entry.term)} onClick={() => { onApprove(vote.id, entry.term); }}>{labels.approve}</Button>}
          </span>
        </div>;
      })}
    </div> : <div className="chat-voting-live__rows" role="list" aria-label={labels.answers}>
      {vote.labels.map((answer, index) => {
        const amount = counts[index] ?? 0;
        const percent = total === 0 ? 0 : Math.round(amount * 100 / total);
        return <div className="chat-voting-results__row" data-leading={index === leaderIndex || undefined} key={vote.id + "-" + String(index)} role="group" aria-label={labels.voteCountAria(answer, amount, percent)}>
          <span className="number chat-voting-results__key">{String(index + 1)}</span>
          <span className="chat-voting-results__label" title={answer}>{answer}</span>
          <span className="chat-voting-results__track" aria-hidden="true"><span style={{ width: String(percent) + "%" }} /></span>
          <span className="number">{String(amount)}</span>
          <span className="number">{String(percent)}%</span>
        </div>;
      })}
    </div>}
  </section>;
}

import { useMemo, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { rankVoteTerms } from "../domain";
import { chatVoteDefaultColorAt } from "../contracts/vote-colors";
import { chatVotingOverlayLabels } from "./locale";
import { parseTallyState } from "./tally-state";
import { OverlayTally, OverlayTallyOptions, type OverlayTallyRow } from "../../../overlay/tally/OverlayTally";

const Tally = ({ config, state, language = "en" }: ModuleOverlayElementProps): ReactElement | null => {
  const current = useMemo(() => parseTallyState(state), [state]);
  const labels = chatVotingOverlayLabels(language);
  if (current === null || current.counts.length === 0 && current.kind !== "free_text") return null;

  const closed = current.status === "closed";
  const countdownEnabled = config.showCountdown !== false;
  const closesAt = current.closesAt === undefined ? Number.NaN : Date.parse(current.closesAt);
  const timeLimitedOpenVote = countdownEnabled && current.status === "open" &&
    typeof current.requestedDurationSeconds === "number" && current.requestedDurationSeconds > 0 &&
    Number.isFinite(closesAt);
  const hideAfterCloseSeconds = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;
  const width = typeof config.width === "number" && Number.isFinite(config.width)
    ? Math.max(200, Math.min(1920, config.width)) : 480;
  const layout = config.layout === "strip" ? "strip" : "bars";
  const useVoteColors = config.useVoteColors !== false;
  const headerText = current.title?.trim() || (closed ? labels.closed : labels.title);
  const standardRows: OverlayTallyRow[] = current.counts.map((count, index) => ({
    id: String(index),
    label: current.labels?.[index] ?? String(index + 1),
    count,
    ...(useVoteColors && current.answerColors?.[index] !== undefined ? { color: current.answerColors[index] } : {}),
  }));
  const visibleTextTerms = current.termFilterReady === true
    ? current.terms ?? []
    : (current.terms ?? []).filter((entry) => entry.approved);
  const textTerms = current.kind === "free_text" ? rankVoteTerms(visibleTextTerms) : [];
  const textRows: OverlayTallyRow[] = textTerms.slice(0, 5).map((entry, index) => ({
    id: entry.term,
    label: entry.approved ? entry.term : "?",
    count: entry.count,
    title: entry.approved ? entry.term : "?",
    ...(useVoteColors ? { color: chatVoteDefaultColorAt(index) } : {}),
  }));
  const options = current.kind === "free_text" ? textRows : standardRows;
  const textTotal = visibleTextTerms.reduce((sum, entry) => sum + entry.count, 0);

  return <OverlayTally
    id={current.pollId}
    title={headerText}
    open={!closed}
    closesAt={timeLimitedOpenVote ? current.closesAt ?? null : null}
    closedAt={current.closedAt ?? null}
    showCountdown={timeLimitedOpenVote}
    hideAfterCloseSeconds={hideAfterCloseSeconds}
    countdownRemainingLabel={labels.countdownRemaining}
    width={width}
    classPrefix="chat-voting-tally"
    className={`chat-voting-tally--${layout}`}
  >
    <OverlayTallyOptions
      rows={options}
      layout={layout}
      showPercent={config.showPercent !== false}
      variant={current.kind === "free_text" ? "terms" : "standard"}
      emptySlots={current.kind === "free_text" ? 5 : 0}
      classPrefix="chat-voting-tally"
      {...(current.kind === "free_text" ? {
        totalCount: textTotal,
        more: { label: labels.more, count: current.more ?? 0, reserve: true },
      } : {})}
    />
  </OverlayTally>;
};

export default Tally;

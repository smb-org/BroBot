import { useMemo, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { rankVoteTerms } from "../domain";
import { chatVotingOverlayLabels } from "./locale";
import type { TallyState } from "./tally-state";
import { OverlayTally, OverlayTallyOptions, type OverlayTallyRow } from "../../../overlay/tally/OverlayTally";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseState = (value: unknown): TallyState | null => {
  const state = record(value);
  if (state === null || typeof state.pollId !== "string" || !Array.isArray(state.counts) ||
      !state.counts.every(isNonNegativeInteger) ||
      !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) return null;
  const labels = Array.isArray(state.labels) && state.labels.every((label) => typeof label === "string")
    ? state.labels
    : undefined;
  const terms = Array.isArray(state.terms) && state.terms.every((entry) => {
    const term = record(entry);
    return term !== null && typeof term.term === "string" && Array.from(term.term).length <= 25 &&
      isNonNegativeInteger(term.count) && term.count > 0 && typeof term.approved === "boolean";
  }) ? state.terms as TallyState["terms"] : undefined;
  return {
    pollId: state.pollId,
    ...(typeof state.openedAt === "string" ? { openedAt: state.openedAt } : {}),
    ...(typeof state.closesAt === "string" && Number.isFinite(Date.parse(state.closesAt)) ? { closesAt: state.closesAt } : {}),
    ...(state.requestedDurationSeconds === null || typeof state.requestedDurationSeconds === "number" &&
      Number.isSafeInteger(state.requestedDurationSeconds) && state.requestedDurationSeconds > 0
      ? { requestedDurationSeconds: state.requestedDurationSeconds } : {}),
    ...(state.title === null || typeof state.title === "string" && Array.from(state.title).length <= 80 ? { title: state.title } : {}),
    ...(state.status === "open" || state.status === "closed" ? { status: state.status } : {}),
    ...(labels === undefined ? {} : { labels }),
    ...(state.preset === "yes_no" || state.preset === "scale_5" || state.preset === "options_n" ||
      state.preset === "digit_01" || state.preset === "digit_12" || state.preset === "free_text"
      ? { preset: state.preset } : {}),
    ...(typeof state.optionCount === "number" && Number.isInteger(state.optionCount) ? { optionCount: state.optionCount } : {}),
    ...(state.textMode === "first_word" || state.textMode === "whole_message" || state.textMode === null
      ? { textMode: state.textMode } : {}),
    counts: state.counts,
    ...(terms === undefined ? {} : { terms }),
    ...(isNonNegativeInteger(state.more) ? { more: state.more } : {}),
    ...(typeof state.termFilterReady === "boolean" ? { termFilterReady: state.termFilterReady } : {}),
    revision: state.revision as number,
    ...(typeof state.closedAt === "string" ? { closedAt: state.closedAt } : {}),
  };
};

const Tally = ({ config, state, language = "en" }: ModuleOverlayElementProps): ReactElement | null => {
  const current = useMemo(() => parseState(state), [state]);
  const labels = chatVotingOverlayLabels(language);
  if (current === null || current.counts.length === 0 && current.preset !== "free_text") return null;

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
  const headerText = current.title?.trim() || (closed ? labels.closed : labels.title);
  const standardRows: OverlayTallyRow[] = current.counts.map((count, index) => ({
    id: String(index),
    label: current.labels?.[index] ?? String(index + 1),
    count,
  }));
  const visibleTextTerms = current.termFilterReady === true
    ? current.terms ?? []
    : (current.terms ?? []).filter((entry) => entry.approved);
  const textTerms = current.preset === "free_text" ? rankVoteTerms(visibleTextTerms) : [];
  const textRows: OverlayTallyRow[] = textTerms.slice(0, 5).map((entry) => ({
    id: entry.term,
    label: entry.approved ? entry.term : "?",
    count: entry.count,
    title: entry.approved ? entry.term : "?",
  }));
  const options = current.preset === "free_text" ? textRows : standardRows;
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
      variant={current.preset === "free_text" ? "terms" : "standard"}
      emptySlots={current.preset === "free_text" ? 5 : 0}
      classPrefix="chat-voting-tally"
      {...(current.preset === "free_text" ? {
        totalCount: textTotal,
        more: { label: labels.more, count: current.more ?? 0, reserve: true },
      } : {})}
    />
  </OverlayTally>;
};

export default Tally;

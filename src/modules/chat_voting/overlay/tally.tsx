import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { rankVoteTerms } from "../domain";
import { chatVotingOverlayLabels } from "./locale";
import type { TallyState } from "./tally-state";

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
  const incoming = useMemo(() => parseState(state), [state]);
  const current = incoming;
  const [clock, setClock] = useState(() => Date.now());
  const labels = chatVotingOverlayLabels(language);

  useEffect(() => {
    if (current?.status !== "closed") return;
    const closeAt = current.closedAt == null ? Number.NaN : Date.parse(current.closedAt);
    if (!Number.isFinite(closeAt)) return;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [current?.pollId, current?.status, current?.closedAt, config.hideAfterCloseSeconds]);

  const closeAt = current?.closedAt == null ? Number.NaN : Date.parse(current.closedAt);
  const hideAfter = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;
  if (current === null || current.counts.length === 0 && current.preset !== "free_text" ||
      current.status === "closed" && (!Number.isFinite(closeAt) || clock >= closeAt + hideAfter * 1_000)) return null;

  const total = current.counts.reduce((sum, count) => sum + count, 0);
  const rows = current.counts.map((count, index) => ({
    label: current.labels?.[index] ?? String(index + 1),
    count,
    percent: total === 0 ? 0 : Math.round(count * 100 / total),
  }));
  const layout = config.layout === "strip" ? "strip" : "bars";
  const visibleTextTerms = current.termFilterReady === true
    ? current.terms ?? []
    : (current.terms ?? []).filter((entry) => entry.approved);
  const textTerms = current.preset === "free_text" ? rankVoteTerms(visibleTextTerms) : [];
  const textTotal = visibleTextTerms.reduce((sum, entry) => sum + entry.count, 0);
  return <section
    className={`brobot-module-text chat-voting-tally chat-voting-tally--${layout}`}
    aria-label={current.status === "closed" ? labels.closed : labels.title}
    style={{ display: "grid", gap: "0.6em", width: "100%" }}
  >
    {current.status === "closed" ? <strong>{labels.closed}</strong> : null}
    <div className="chat-voting-tally__options" style={{
      display: "flex",
      flexDirection: layout === "strip" ? "row" : "column",
      flexWrap: "wrap",
      gap: "0.65em",
      ...(current.preset === "free_text" && layout === "strip" ? { height: "14.1em" } : {}),
    }}>
      {current.preset === "free_text" ? <>
        {Array.from({ length: 5 }, (_, index) => {
          const entry = textTerms[index];
          const rowStyle = { flex: layout === "strip" ? "1 1 8em" : undefined, minHeight: "2.3em", boxSizing: "border-box" as const };
          if (entry === undefined) return <div className="chat-voting-tally__option" key={`${current.pollId}-empty-${String(index)}`} aria-hidden="true" style={{ ...rowStyle, visibility: "hidden" }}>
            <div className="chat-voting-tally__caption" style={{ display: "flex", justifyContent: "space-between", gap: "0.5em", whiteSpace: "nowrap" }}>
              <span>&nbsp;</span><span>&nbsp;</span>
            </div>
            {layout === "bars" ? <div className="chat-voting-tally__track" style={{ height: "0.45em", borderRadius: "999px", background: "rgba(127, 127, 127, 0.25)" }} /> : null}
          </div>;
          const percent = textTotal === 0 ? 0 : Math.round(entry.count * 100 / textTotal);
          return <div className="chat-voting-tally__option" key={`${current.pollId}-${entry.term}`} style={rowStyle}>
            <div className="chat-voting-tally__caption" style={{ display: "flex", justifyContent: "space-between", gap: "0.5em", whiteSpace: "nowrap" }}>
              <span title={entry.approved ? entry.term : "?"} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.approved ? entry.term : "?"}</span>
              <span>{String(entry.count)}{config.showPercent === false ? "" : ` · ${String(percent)}%`}</span>
            </div>
            {layout === "bars" ? <div className="chat-voting-tally__track" aria-hidden="true" style={{ height: "0.45em", borderRadius: "999px", background: "rgba(127, 127, 127, 0.25)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${String(percent)}%`, borderRadius: "inherit", background: "currentColor", opacity: 0.8 }} />
            </div> : null}
          </div>;
        })}
      </> : rows.map((row, index) => <div className="chat-voting-tally__option" key={`${current.pollId}-${String(index)}`} style={{ flex: layout === "strip" ? "1 1 8em" : undefined }}>
          <div className="chat-voting-tally__caption" style={{ display: "flex", justifyContent: "space-between", gap: "0.5em" }}>
            <span>{row.label}</span>
            <span>{String(row.count)}{config.showPercent === false ? "" : ` · ${String(row.percent)}%`}</span>
          </div>
          {layout === "bars" ? <div className="chat-voting-tally__track" aria-hidden="true" style={{ height: "0.45em", borderRadius: "999px", background: "rgba(127, 127, 127, 0.25)", overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${String(row.percent)}%`, borderRadius: "inherit", background: "currentColor", opacity: 0.8 }} />
          </div> : null}
        </div>)}
    </div>
    {current.preset === "free_text" ? current.more !== undefined && current.more > 0
      ? <div style={{ minHeight: "1.5em" }}>{labels.more}: {String(current.more)}</div>
      : <div aria-hidden="true" style={{ minHeight: "1.5em", visibility: "hidden" }} /> : null}
  </section>;
};

export default Tally;

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";

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
    ...(typeof state.closesAt === "string" && Number.isFinite(Date.parse(state.closesAt)) ? { closesAt: state.closesAt } : {}),
    ...(state.requestedDurationSeconds === null || typeof state.requestedDurationSeconds === "number" &&
      Number.isSafeInteger(state.requestedDurationSeconds) && state.requestedDurationSeconds > 0
      ? { requestedDurationSeconds: state.requestedDurationSeconds } : {}),
    ...(typeof state.serverNow === "string" && Number.isFinite(Date.parse(state.serverNow)) ? { serverNow: state.serverNow } : {}),
    ...(typeof state.serverTimeOffsetMs === "number" && Number.isFinite(state.serverTimeOffsetMs)
      ? { serverTimeOffsetMs: state.serverTimeOffsetMs } : {}),
    ...(typeof state.serverTimeLocalNowMs === "number" && Number.isFinite(state.serverTimeLocalNowMs)
      ? { serverTimeLocalNowMs: state.serverTimeLocalNowMs } : {}),
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

const formatCountdown = (seconds: number): string =>
  `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;

const Tally = ({ config, state, language = "en" }: ModuleOverlayElementProps): ReactElement | null => {
  const incoming = useMemo(() => parseState(state), [state]);
  const current = incoming;
  const [clock, setClock] = useState(() => Date.now());
  const labels = chatVotingOverlayLabels(language);
  const countdownEnabled = config.showCountdown !== false;
  const closesAt = current?.closesAt === undefined ? Number.NaN : Date.parse(current.closesAt);
  const serverTimeOffset = current?.serverTimeOffsetMs;
  const serverTimeLocalNow = current?.serverTimeLocalNowMs ?? clock;
  const timeLimitedOpenVote = countdownEnabled && current?.status === "open" &&
    typeof current.requestedDurationSeconds === "number" && current.requestedDurationSeconds > 0 &&
    Number.isFinite(closesAt) && typeof serverTimeOffset === "number" && Number.isFinite(serverTimeOffset);
  const remainingMilliseconds = timeLimitedOpenVote
    ? closesAt - (Math.max(clock, serverTimeLocalNow) + serverTimeOffset)
    : Number.NaN;
  const countdownSeconds = Number.isFinite(remainingMilliseconds)
    ? Math.max(0, Math.ceil(remainingMilliseconds / 1_000))
    : null;
  const countdownText = countdownSeconds === null ? "" : formatCountdown(countdownSeconds);

  useEffect(() => {
    if (countdownSeconds === null || countdownSeconds === 0) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [countdownSeconds, current?.pollId]);

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
  // Fixed width: the canvas wrapper is content-sized, so a percentage would follow the term length.
  const width = typeof config.width === "number" && Number.isFinite(config.width)
    ? Math.max(200, Math.min(1920, config.width)) : 480;
  const layout = config.layout === "strip" ? "strip" : "bars";
  const visibleTextTerms = current.termFilterReady === true
    ? current.terms ?? []
    : (current.terms ?? []).filter((entry) => entry.approved);
  const textTerms = current.preset === "free_text" ? rankVoteTerms(visibleTextTerms) : [];
  const textTotal = visibleTextTerms.reduce((sum, entry) => sum + entry.count, 0);
  const headerText = current.title?.trim() || (current.status === "closed" ? labels.closed : labels.title);
  const headerTitleStyle: CSSProperties = {
    display: "-webkit-box",
    height: "2.4em",
    minHeight: "2.4em",
    minWidth: 0,
    overflow: "hidden",
    overflowWrap: "anywhere",
    lineHeight: 1.2,
    fontWeight: 700,
    textOverflow: "ellipsis",
    WebkitBoxOrient: "vertical" as const,
    WebkitLineClamp: 2,
  };
  const textRowStyle = {
    flex: layout === "strip" ? "1 1 8em" : undefined,
    minHeight: "2.3em",
    minWidth: 0,
    width: layout === "bars" ? "100%" : undefined,
    boxSizing: "border-box" as const,
  };
  const textCaptionStyle = {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 10rem",
    alignItems: "center",
    gap: "0 0.5em",
    minWidth: 0,
    width: "100%",
    boxSizing: "border-box" as const,
  };
  const textLabelStyle = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };
  const textCountStyle = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "clip",
    textAlign: "right" as const,
    whiteSpace: "nowrap" as const,
    fontSize: "0.5em",
    fontVariantNumeric: "tabular-nums" as const,
  };
  const textTrackStyle = {
    height: "0.45em",
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box" as const,
    borderRadius: "999px",
    background: "rgba(127, 127, 127, 0.25)",
    overflow: "hidden",
  };
  return <section
    className={`brobot-module-text chat-voting-tally chat-voting-tally--${layout}`}
    aria-label={headerText}
    style={{ display: "grid", gap: "0.6em", width: `${String(width)}px`, minWidth: 0, boxSizing: "border-box" }}
  >
    <div
      className="chat-voting-tally__header"
      role="heading"
      aria-level={2}
      aria-label={headerText}
      title={headerText}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 6ch",
        alignItems: "start",
        minWidth: 0,
        height: "2.4em",
        minHeight: "2.4em",
      }}
    >
      <span className="chat-voting-tally__header-title" style={headerTitleStyle}>{headerText}</span>
      <span
        className="chat-voting-tally__countdown"
        role="timer"
        aria-hidden={countdownText.length === 0}
        aria-label={countdownText.length === 0 ? undefined : labels.countdownRemaining(countdownText)}
        style={{
          display: "flex",
          width: "6ch",
          minWidth: "6ch",
          height: "2.4em",
          minHeight: "2.4em",
          alignItems: "center",
          justifyContent: "flex-end",
          textAlign: "right",
          whiteSpace: "nowrap",
          fontFamily: "\"IBM Plex Mono\", ui-monospace, monospace",
          fontVariantNumeric: "tabular-nums",
        }}
      >{countdownText}</span>
    </div>
    <div className="chat-voting-tally__options" style={{
      display: "flex",
      flexDirection: layout === "strip" ? "row" : "column",
      flexWrap: "wrap",
      gap: "0.65em",
      width: "100%",
      minWidth: 0,
      boxSizing: "border-box",
      ...(current.preset === "free_text" && layout === "strip" ? { height: "14.1em" } : {}),
    }}>
      {current.preset === "free_text" ? <>
        {Array.from({ length: 5 }, (_, index) => {
          const entry = textTerms[index];
          if (entry === undefined) return <div className="chat-voting-tally__option" key={`${current.pollId}-empty-${String(index)}`} aria-hidden="true" style={{ ...textRowStyle, visibility: "hidden" }}>
            <div className="chat-voting-tally__caption" style={textCaptionStyle}>
              <span style={textLabelStyle}>&nbsp;</span><span style={textCountStyle}>&nbsp;</span>
            </div>
            {layout === "bars" ? <div className="chat-voting-tally__track" style={textTrackStyle} /> : null}
          </div>;
          const percent = textTotal === 0 ? 0 : Math.round(entry.count * 100 / textTotal);
          return <div className="chat-voting-tally__option" key={`${current.pollId}-${entry.term}`} style={textRowStyle}>
            <div className="chat-voting-tally__caption" style={textCaptionStyle}>
              <span title={entry.approved ? entry.term : "?"} style={textLabelStyle}>{entry.approved ? entry.term : "?"}</span>
              <span style={textCountStyle}>{String(entry.count)}{config.showPercent === false ? "" : ` · ${String(percent)}%`}</span>
            </div>
            {layout === "bars" ? <div className="chat-voting-tally__track" aria-hidden="true" style={textTrackStyle}>
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

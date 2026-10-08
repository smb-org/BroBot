import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import "./overlay-tally.css";

export interface OverlayTallyRow {
  id: string;
  label: string;
  count: number;
  title?: string;
}

export interface OverlayTallyProps {
  id: string;
  title: string;
  open: boolean;
  closesAt?: string | null;
  closedAt?: string | null;
  showCountdown?: boolean;
  hideAfterCloseSeconds?: number;
  countdownRemainingLabel: (time: string) => string;
  summary?: string;
  width?: number;
  classPrefix?: string;
  className?: string;
  children: ReactNode;
}

export interface OverlayTallyOptionsProps {
  rows: readonly OverlayTallyRow[];
  layout: "bars" | "strip";
  showPercent?: boolean;
  variant?: "standard" | "terms";
  emptySlots?: number;
  totalCount?: number;
  classPrefix?: string;
  more?: { label: string; count: number; reserve: boolean };
}

const classNames = (...values: readonly (string | undefined)[]): string => values.filter((value) => value !== undefined && value.length > 0).join(" ");

const formatOverlayCountdown = (seconds: number): string =>
  `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;

export const OverlayTally = ({
  id,
  title,
  open,
  closesAt,
  closedAt,
  showCountdown = true,
  hideAfterCloseSeconds = 15,
  countdownRemainingLabel,
  summary,
  width = 480,
  classPrefix,
  className,
  children,
}: OverlayTallyProps): ReactElement | null => {
  const [, setClock] = useState(0);
  // The countdown is based on the local overlay clock, not update frequency from the server.
  // eslint-disable-next-line react-hooks/purity -- intentional: remaining time is local-clock minus closesAt at render time
  const now = Date.now();
  const [zeroLatchedId, setZeroLatchedId] = useState<string | null>(null);
  const closeTime = closedAt == null ? Number.NaN : Date.parse(closedAt);
  const closeDeadline = closesAt == null ? Number.NaN : Date.parse(closesAt);
  const rawSeconds = showCountdown && open && Number.isFinite(closeDeadline)
    ? Math.max(0, Math.ceil((closeDeadline - now) / 1_000))
    : null;
  if (rawSeconds === 0 && zeroLatchedId !== id) setZeroLatchedId(id);
  const countdownSeconds = open && zeroLatchedId === id ? 0 : rawSeconds;
  const countdownText = countdownSeconds === null ? "" : formatOverlayCountdown(countdownSeconds);

  useEffect(() => {
    if (countdownSeconds === null || countdownSeconds === 0) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [countdownSeconds, id]);

  useEffect(() => {
    if (open || !Number.isFinite(closeTime)) return;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [closeTime, id, open, hideAfterCloseSeconds]);

  if (!open && (!Number.isFinite(closeTime) || now >= closeTime + hideAfterCloseSeconds * 1_000)) return null;

  return <section
    className={classNames("brobot-module-text", "overlay-tally", classPrefix, className)}
    aria-label={title}
    style={{ display: "grid", gap: "0.6em", width: `${String(width)}px`, minWidth: 0, boxSizing: "border-box" }}
  >
    <div
      className={classNames("overlay-tally__header", classPrefix === undefined ? undefined : `${classPrefix}__header`)}
      role="heading"
      aria-level={2}
      aria-label={title}
      title={title}
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 6ch", alignItems: "start", minWidth: 0, height: "2.4em", minHeight: "2.4em" }}
    >
      <span
        className={classNames("overlay-tally__title", classPrefix === undefined ? undefined : `${classPrefix}__header-title`)}
        style={{ display: "-webkit-box", height: "2.4em", minHeight: "2.4em", minWidth: 0, overflow: "hidden", overflowWrap: "anywhere", lineHeight: 1.2, fontWeight: 700, textOverflow: "ellipsis", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}
      >{title}</span>
      <span
        className={classNames("overlay-tally__countdown", classPrefix === undefined ? undefined : `${classPrefix}__countdown`)}
        role="timer"
        aria-hidden={countdownText.length === 0}
        aria-label={countdownText.length === 0 ? undefined : countdownRemainingLabel(countdownText)}
        style={{ display: "flex", width: "6ch", minWidth: "6ch", height: "2.4em", minHeight: "2.4em", alignItems: "center", justifyContent: "flex-end", textAlign: "right", whiteSpace: "nowrap", fontFamily: "\"IBM Plex Mono\", ui-monospace, monospace", fontVariantNumeric: "tabular-nums" }}
      >{countdownText}</span>
    </div>
    {summary === undefined ? null : <div className={classNames("overlay-tally__summary", classPrefix === undefined ? undefined : `${classPrefix}__summary`)} title={summary} style={{ height: "1.5em", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</div>}
    {children}
  </section>;
};

export const OverlayTallyOptions = ({
  rows,
  layout,
  showPercent = true,
  variant = "standard",
  emptySlots = 0,
  totalCount,
  classPrefix,
  more,
}: OverlayTallyOptionsProps): ReactElement => {
  const total = totalCount ?? rows.reduce((sum, row) => sum + row.count, 0);
  const optionsStyle = {
    display: "flex",
    flexDirection: layout === "strip" ? "row" as const : "column" as const,
    flexWrap: "wrap" as const,
    gap: "0.65em",
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box" as const,
    ...(variant === "terms" && layout === "strip" ? { height: "14.1em" } : {}),
  };
  const optionStyle = variant === "terms" ? {
    ...(layout === "strip" ? { flex: "1 1 8em" } : {}),
    minHeight: "2.3em",
    minWidth: 0,
    width: layout === "bars" ? "100%" : undefined,
    boxSizing: "border-box" as const,
  } : layout === "strip" ? { flex: "1 1 8em" } : undefined;
  const trackStyle = {
    height: "0.45em",
    ...(variant === "terms" ? { width: "100%", minWidth: 0, boxSizing: "border-box" as const } : {}),
    borderRadius: "999px",
    background: "rgba(127, 127, 127, 0.25)",
    overflow: "hidden",
  };

  return <>
    <div className={classNames("overlay-tally__options", `overlay-tally__options--${layout}`, `overlay-tally__options--${variant}`, classPrefix === undefined ? undefined : `${classPrefix}__options`)} style={optionsStyle}>
      {rows.map((row) => {
        const percent = total === 0 ? 0 : Math.round(row.count * 100 / total);
        return <div className={classNames("overlay-tally__option", classPrefix === undefined ? undefined : `${classPrefix}__option`)} key={row.id} style={optionStyle}>
          <div className={classNames("overlay-tally__caption", classPrefix === undefined ? undefined : `${classPrefix}__caption`)} style={variant === "terms" ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 10rem", alignItems: "center", gap: "0 0.5em", minWidth: 0, width: "100%", boxSizing: "border-box" } : { display: "flex", justifyContent: "space-between", gap: "0.5em" }}>
            <span className="overlay-tally__label" title={row.title} style={variant === "terms" ? { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}>{row.label}</span>
            <span className="overlay-tally__count" style={variant === "terms" ? { minWidth: 0, overflow: "hidden", textOverflow: "clip", textAlign: "right", whiteSpace: "nowrap", fontSize: "0.5em", fontVariantNumeric: "tabular-nums" } : undefined}>
              {String(row.count)}{showPercent ? ` · ${String(percent)}%` : ""}
            </span>
          </div>
          {layout === "bars" ? <div className={classNames("overlay-tally__track", classPrefix === undefined ? undefined : `${classPrefix}__track`)} aria-hidden="true" style={trackStyle}>
            <span className="overlay-tally__fill" style={{ width: `${String(percent)}%` }} />
          </div> : null}
        </div>;
      })}
      {Array.from({ length: Math.max(0, emptySlots - rows.length) }, (_, index) => (
        <div className={classNames("overlay-tally__option", classPrefix === undefined ? undefined : `${classPrefix}__option`)} key={`empty-${String(index)}`} aria-hidden="true" style={{ ...optionStyle, visibility: "hidden" }}>
          <div className={classNames("overlay-tally__caption", classPrefix === undefined ? undefined : `${classPrefix}__caption`)} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 10rem", alignItems: "center", gap: "0 0.5em", minWidth: 0, width: "100%", boxSizing: "border-box" }}><span className="overlay-tally__label" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>&nbsp;</span><span className="overlay-tally__count" style={{ minWidth: 0, overflow: "hidden", textOverflow: "clip", textAlign: "right", whiteSpace: "nowrap", fontSize: "0.5em", fontVariantNumeric: "tabular-nums" }}>&nbsp;</span></div>
          {layout === "bars" ? <div className={classNames("overlay-tally__track", classPrefix === undefined ? undefined : `${classPrefix}__track`)} style={trackStyle}><span className="overlay-tally__fill" /></div> : null}
        </div>
      ))}
    </div>
    {more === undefined ? null : more.count > 0
      ? <div className="overlay-tally__more" style={{ minHeight: "1.5em" }}>{more.label}: {String(more.count)}</div>
      : more.reserve ? <div className="overlay-tally__more" aria-hidden="true" style={{ minHeight: "1.5em", visibility: "hidden" }} />
        : null}
  </>;
};

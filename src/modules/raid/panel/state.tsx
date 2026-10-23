import { useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { useModuleQuery } from "../../../dashboard/data";
import { LoadStateLines } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { RaidPanelState } from "./service";
import { loadRaidPanelState } from "./service";
import { raidStatePanelTexts } from "./locale";
import { browserTimeZone, formatRelativeTime } from "../../../dashboard/ui/format-relative-time";
import "./state.css";

type RaidStateStatus = "loading" | "error" | "ready";

export const RaidStateCard = ({ state, status, language, now }: {
  state: RaidPanelState | null;
  status: RaidStateStatus;
  language: DashboardLanguage;
  now: number;
}): ReactElement => {
  const words = raidStatePanelTexts(language);
  const statusReady = status === "ready" && state?.ready === true;
  const lastRaid = state?.lastRaid ?? null;
  const lastShoutout = state?.lastShoutout ?? null;
  const relative = (at: string): string => formatRelativeTime(at, new Date(now), language, browserTimeZone()).label;

  return <section className="raid-state-card" aria-label={words.title} data-state={status}>
    <header className="raid-state-card__header">
      <div><h2>{words.title}</h2><strong>{statusReady ? words.ready : status === "error" ? words.errorStatus : status === "loading" ? words.loading : words.waiting}</strong></div>
      <span className={`raid-state-card__status${statusReady ? " is-ready" : ""}`} aria-label={statusReady ? words.ready : words.waiting}>{statusReady ? "✓" : "·"}</span>
    </header>
    <dl className="raid-state-card__rows">
      <div><dt>{words.lastRaid}</dt><dd>{lastRaid === null ? words.noRaid : <>{lastRaid.channel ?? words.unknownChannel} · {relative(lastRaid.at)}</>}</dd></div>
      <div><dt>{words.lastShoutout}</dt><dd>{lastShoutout === null ? words.noShoutout : <>{lastShoutout.channel ?? words.unknownChannel} · {relative(lastShoutout.at)}</>}</dd></div>
    </dl>
    <p className="raid-state-card__reserved" aria-live="polite">{status === "error" ? words.loadError : status === "loading" ? words.loadingDetails : " "}</p>
    <p className="raid-state-card__footnote">{words.threshold(state?.shoutoutThreshold ?? null)}</p>
  </section>;
};

const RaidStatePanel = ({ channelId, language = "de" }: ModulePanelProperties): ReactElement => {
  const query = useModuleQuery(channelId, "raid", "state", (signal) => loadRaidPanelState(channelId, signal), { refetchInterval: 30_000 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return <div className="raid-state-panel">
    {query.data === undefined && query.isPending
      ? <div className="raid-state-card raid-state-card--loading" aria-label={raidStatePanelTexts(language).title}><LoadStateLines rows={4} height={24} /></div>
      : <RaidStateCard state={query.data ?? null} status={query.isError ? "error" : "ready"} language={language} now={now} />}
  </div>;
};

export default RaidStatePanel;

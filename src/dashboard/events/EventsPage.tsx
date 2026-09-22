import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import type { PanelEventEntry, PanelEventFilters, PanelEventsResponse, PanelModuleState } from "../../panel-contract";
import { dashboardCommonTexts, dashboardLanguage, dashboardTexts, eventText, formatNumber, formatTimestamp } from "../locale";
import { moduleName } from "../module-labels";
import { Led, ModuleCount, ModuleHeading, type LedStatus } from "../module-panels";
import { useRealtimeEventFeed, type RealtimeFeedStatus as RealtimeFeedStatusValue } from "../realtime";
import { ListDetail, SubInspector, useInspectorSelection } from "../ui";
import type { LoadState } from "../load-state";
import {
  actorLabel,
  chronological,
  emptyEventFilter,
  eventChipNumber,
  eventDetail,
  eventFilterIsActive,
  eventGroups,
  eventMetadata,
  eventToneFromValue,
  formatEventDetail,
  moduleLabel,
  PERSON_FILTER_DEBOUNCE_MS,
} from "./model";

/** Kept identical to `main.tsx`'s local `ErrorPanel` so this move changes no behaviour. */
const ErrorPanel = ({ message }: { message: string }): ReactElement => (
  <section className="error-panel" data-status="error" role="alert">
    <strong>{dashboardTexts().errors.title}</strong>
    <p>{message}</p>
  </section>
);

const actorCell = (entry: PanelEventEntry, texts: ReturnType<typeof dashboardTexts>): ReactNode =>
  entry.actorDisplayName ?? (entry.actorLogin == null
    ? entry.actorUserId == null ? texts.events.automatic : <span className="mono">{entry.actorUserId}</span>
    : `@${entry.actorLogin}`);

const EventChipPair = ({ code, detail, texts: texts }: { code: string; detail: ReturnType<typeof eventDetail>; texts: ReturnType<typeof dashboardTexts> }): ReactElement => {
  const metadata = eventMetadata(code);
  if (metadata === null) {
    return <span className="event-chip-pair"><span className="event-chip" data-stufe="gezeichnet">{texts.events.unknown}</span></span>;
  }
  const number = eventChipNumber(detail, metadata.numberKey);
  return <span className="event-chip-pair">
    {number === null ? null : <span className="event-chip event-chip--number">{number}</span>}
    <span className="event-chip" data-familie={metadata.family} data-stufe={metadata.tier} data-ton={metadata.tone}>{metadata.word[dashboardLanguage()]}</span>
  </span>;
};

const EventFilterBar = ({
  filters,
  moduleOptions,
  onChange,
}: {
  filters: PanelEventFilters;
  moduleOptions: readonly PanelModuleState[];
  onChange: (filters: PanelEventFilters) => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const [personDraft, setPersonDraft] = useState(filters.person ?? "");
  // The applied filter is the source of truth; the draft follows along when it
  // changes from outside (reset, navigation, second tab). This happens
  // during render instead of in an effect: an effect would show a second
  // pass with a stale value, and React forbids that pattern.
  const [zuletztAngewendet, setZuletztAngewendet] = useState(filters.person);
  if (zuletztAngewendet !== filters.person) {
    setZuletztAngewendet(filters.person);
    setPersonDraft(filters.person ?? "");
  }
  const commitPerson = useCallback((draft: string): void => {
    const value = draft.trim();
    onChange({ ...filters, person: value.length === 0 ? null : value });
  }, [filters, onChange]);
  useEffect(() => {
    if (personDraft.trim() === (filters.person ?? "")) return;
    const timeout = window.setTimeout(() => { commitPerson(personDraft); }, PERSON_FILTER_DEBOUNCE_MS);
    return () => { window.clearTimeout(timeout); };
  }, [commitPerson, filters.person, personDraft]);
  const activeFilter: string[] = [];
  if (filters.origin === "channel") activeFilter.push(texts.events.channelEvents);
  if (filters.origin === "module") activeFilter.push(texts.events.moduleDiagnostics);
  if (filters.module !== null) activeFilter.push(moduleName(filters.module));
  if (filters.tone !== null) activeFilter.push(filters.tone === "info" ? texts.events.info : filters.tone === "warning" ? texts.events.notice : texts.events.error);
  if (filters.person !== null) activeFilter.push(filters.person);
  return <div className="event-filter" aria-label={texts.events.filter}>
    <div className="event-filter__controls">
      <label>{texts.events.origin}<select aria-label={texts.events.origin} value={filters.origin ?? ""} onChange={(event) => { const value = event.target.value; onChange({ ...filters, origin: value === "channel" || value === "module" ? value : null }); }}>
        <option value="">{texts.events.all}</option><option value="channel">{texts.events.channelEvents}</option><option value="module">{texts.events.moduleDiagnostics}</option>
      </select></label>
      <label>{texts.events.moduleFilter}<select aria-label={texts.events.moduleFilter} value={filters.module ?? ""} onChange={(event) => { const value = event.target.value; onChange({ ...filters, module: value.length === 0 ? null : value }); }}>
        <option value="">{texts.events.all}</option>{moduleOptions.map((module) => <option key={module.id} value={module.id}>{moduleName(module.id)}</option>)}
      </select></label>
      <label>{texts.events.tone}<select aria-label={texts.events.tone} value={filters.tone ?? ""} onChange={(event) => { onChange({ ...filters, tone: eventToneFromValue(event.target.value) }); }}>
        <option value="">{texts.events.all}</option><option value="info">{texts.events.info}</option><option value="warning">{texts.events.notice}</option><option value="error">{texts.events.error}</option>
      </select></label>
      <label>{texts.events.person}<input aria-label={texts.events.person} value={personDraft} onChange={(event) => { setPersonDraft(event.target.value); }} onKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); commitPerson(personDraft); }} /></label>
    </div>
    {activeFilter.length === 0 ? null : <div className="form-actions"><p className="muted" aria-live="polite">{texts.events.activeFilters} {activeFilter.join(" · ")}</p><button className="button button--quiet" type="button" onClick={() => { setPersonDraft(""); onChange(emptyEventFilter); }}>{texts.events.resetFilters}</button></div>}
  </div>;
};

const EventFeedEnd = ({
  nextCursor,
  loadingNextPage,
  onNextPage,
}: {
  nextCursor: string | null;
  loadingNextPage: boolean;
  onNextPage: () => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const loadNextPage = useCallback((): void => {
    if (nextCursor !== null && !loadingNextPage) onNextPage();
  }, [loadingNextPage, nextCursor, onNextPage]);
  useEffect(() => {
    if (nextCursor === null) return;
    const onScroll = (): void => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1) loadNextPage();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const end = feedEndRef.current;
    if (end !== null && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting) loadNextPage();
      });
      observer.observe(end);
      return () => { observer.disconnect(); window.removeEventListener("scroll", onScroll); };
    }
    return () => { window.removeEventListener("scroll", onScroll); };
  }, [loadNextPage, nextCursor]);
  return <div
    ref={feedEndRef}
    className="event-feed__end"
    tabIndex={nextCursor === null ? -1 : 0}
    aria-label={nextCursor === null ? undefined : texts.events.loadMoreAtEnd}
    onFocus={loadNextPage}
    onKeyDown={(event) => {
      if (event.key === "End" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        loadNextPage();
      }
    }}
  >
    {loadingNextPage ? <p className="loading-line" role="status">{texts.events.loadingOlder}</p> : nextCursor === null ? <p className="empty-state">{texts.events.feedEnd}</p> : <p className="muted">{texts.events.loadMoreAtEnd}</p>}
  </div>;
};

const realtimeLedStatus = (status: RealtimeFeedStatusValue): LedStatus =>
  status === "connected" ? "green" : status === "renew" ? "red" : status === "offline" ? "off" : "amber";

const RealtimeFeedStatus = ({ status }: { status: RealtimeFeedStatusValue }): ReactElement => {
  const texts = dashboardTexts();
  const label = status === "connected"
    ? texts.events.realtimeConnected
    : status === "connecting"
      ? texts.events.realtimeConnecting
      : status === "reconnecting"
        ? texts.events.realtimeReconnecting
        : status === "renew" ? texts.events.realtimeRenewSession : texts.events.realtimeOffline;
  return <span className="realtime-status" aria-live="polite"><Led status={realtimeLedStatus(status)} label={label} />{status === "renew" ? <a className="profile-link" href="/auth/login">{texts.events.realtimeRenewSession}</a> : null}</span>;
};

export const EventsPage = ({
  channelId,
  eventsState,
  filters,
  moduleOptions,
  onFiltersChange,
  onRefreshFirstPage,
  onNextPage,
  loadingNextPage,
}: {
  channelId: string;
  eventsState: LoadState<PanelEventsResponse>;
  filters: PanelEventFilters;
  moduleOptions: readonly PanelModuleState[];
  onFiltersChange: (filters: PanelEventFilters) => void;
  onRefreshFirstPage: (channelId: string, filters: PanelEventFilters) => Promise<void>;
  onNextPage: () => void;
  loadingNextPage: boolean;
}): ReactElement => {
  const texts = dashboardTexts();
  const feedRef = useRef<HTMLDivElement | null>(null);
  const atBeginning = useCallback((): boolean => {
    const feed = feedRef.current;
    if (feed === null) return true;
    const feedStart = feed.getBoundingClientRect().top + window.scrollY;
    return window.scrollY <= feedStart + 8;
  }, []);
  const scrollToBeginning = useCallback((): void => {
    const feed = feedRef.current;
    if (feed === null) return;
    const feedStart = feed.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, feedStart), behavior: "auto" });
  }, []);
  const realtime = useRealtimeEventFeed({
    channelId,
    filters,
    atBeginning,
    refreshFirstPage: () => onRefreshFirstPage(channelId, filters),
    scrollToBeginning,
  });
  const { selectedKey: selectedGroupKey, select: selectGroup, rowRef: groupRowRef, close: closeGroup } = useInspectorSelection<string>();
  const groups = eventsState.data === null ? [] : eventGroups(eventsState.data.entries);
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? null;
  const selectedHistory = selectedGroup === null ? [] : [...selectedGroup.entries].sort(chronological);
  const eventEntries = eventsState.data?.entries ?? [];
  return (
    <>
      <ModuleHeading kind="events" title={texts.events.title} subtitle={eventsState.data === null ? "" : <ModuleCount count={eventsState.data.entries.length} label={texts.events.count} />} />
      <ListDetail
        onCloseInspector={closeGroup}
        list={
          <section className="content-section" aria-label={texts.events.log}>
            <div className="section-heading"><h2>{texts.events.log}</h2><RealtimeFeedStatus status={realtime.status} /></div>
            <EventFilterBar filters={filters} moduleOptions={moduleOptions} onChange={onFiltersChange} />
            {realtime.pendingCount === 0 ? null : <button className="button realtime-feed__notice" type="button" onClick={realtime.jumpToBeginning} aria-live="polite">{texts.events.realtimeNew(formatNumber(realtime.pendingCount))}</button>}
            {eventsState.status === "loading" && eventsState.data === null ? <p className="loading-line">{texts.events.load}</p> : null}
            {eventsState.error !== null ? <ErrorPanel message={eventsState.error} /> : null}
            {eventsState.data !== null && eventEntries.length === 0 ? <p className="empty-state">{eventFilterIsActive(filters) ? texts.events.noMatches : texts.events.none}</p> : null}
            {eventsState.data !== null ? <>
              {eventEntries.length === 0 ? null : <div ref={feedRef} className="event-feed">
                <div className={eventsState.status === "loading" ? "veraltet" : undefined}>
                  <table className="tabelle event-table">
                    <thead><tr><th scope="col">{texts.events.time}</th><th scope="col">{texts.events.event}</th><th scope="col">{texts.events.module}</th><th scope="col">{texts.events.who}</th></tr></thead>
                    <tbody>{groups.map((group) => {
                      const entry = group.representative;
                      const eventLabel = eventText(entry.code, eventDetail(entry.detail));
                      return <tr key={group.key} ref={groupRowRef(group.key)} tabIndex={0} aria-selected={selectedGroupKey === group.key} onClick={() => { selectGroup(group.key); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectGroup(group.key); } }}><td className="mono" title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</td><td><span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texts={texts} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventLabel}</span></span></td><td className={moduleLabel(entry) === entry.moduleId ? "mono" : undefined}>{moduleLabel(entry)}</td><td>{actorCell(entry, texts)}</td></tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>}
              <EventFeedEnd nextCursor={eventsState.data.nextCursor} loadingNextPage={loadingNextPage} onNextPage={onNextPage} />
            </> : null}
          </section>
        }
        inspector={selectedGroup === null ? null : (
          <SubInspector ariaLabel={texts.events.detail} title={texts.events.operation} identifier={selectedGroup.representative.triggerId || selectedGroup.representative.eventId} closeLabel={dashboardCommonTexts().close} onClose={closeGroup}>
            <dl className="properties"><div><dt>{texts.events.timestamp}</dt><dd className="mono" title={selectedHistory[0]?.createdAt}>{selectedHistory[0] === undefined ? "" : formatTimestamp(selectedHistory[0].createdAt)}</dd></div><div><dt>{texts.events.module}</dt><dd>{Array.from(new Set(selectedHistory.map(moduleLabel))).join(", ")}</dd></div><div><dt>{texts.events.participants}</dt><dd>{Array.from(new Set(selectedHistory.map((entry) => actorLabel(entry, texts)))).join(", ")}</dd></div></dl>
            <div className="inspector-section__heading"><h3>{texts.events.history}</h3></div>
            <ol className="event-history">{selectedHistory.map((entry) => {
              return <li key={entry.eventId}><div className="event-history__heading"><span className="mono">{entry.code}</span><span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texts={texts} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventText(entry.code, eventDetail(entry.detail))}</span></span></div><pre className="event-detail-json">{formatEventDetail(entry.detail)}</pre></li>;
            })}</ol>
          </SubInspector>
        )}
      />
    </>
  );
};

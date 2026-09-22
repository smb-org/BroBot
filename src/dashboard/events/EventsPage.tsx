import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import type { PanelEventEntry, PanelEventFilters, PanelEventsResponse, PanelModuleState } from "../../panel-contract";
import { dashboardCommonTexts, dashboardLanguage, dashboardTexts, eventText, formatNumber, formatTimestamp } from "../locale";
import { moduleName } from "../module-labels";
import { Led, ModuleCount, ModuleHeading, type LedStatus } from "../module-panels";
import { useRealtimeEventFeed, type RealtimeFeedStatus as RealtimeFeedStatusValue } from "../realtime";
import { ChipGroup, EmptyState, ErrorPanel, Field, ListDetail, Select as UiSelect, SubInspector, useInspectorSelection, type SelectOption } from "../ui";
import type { LoadState } from "../load-state";
import {
  actorLabel,
  affectedPersonLabel,
  chronological,
  emptyEventFilter,
  eventChipNumber,
  eventDayGroups,
  eventDetail,
  eventFilterIsActive,
  eventGroups,
  eventMetadata,
  eventToneFromValue,
  formatEventDetail,
  moderatorLabel,
  moduleLabel,
  PERSON_FILTER_DEBOUNCE_MS,
} from "./model";

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

/** Copies to the clipboard when it exists (never in a test/jsdom environment) -- same guard as platform.tsx's invitation link. */
const CopyableId = ({ id, texts }: { id: string; texts: ReturnType<typeof dashboardTexts> }): ReactElement => {
  const [copied, setCopied] = useState(false);
  const copyToClipboard = async (): Promise<void> => {
    const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (text: string) => Promise<void> } | undefined;
    if (clipboard === undefined) return;
    await clipboard.writeText(id);
    setCopied(true);
  };
  return <span className="event-inspector-id">
    {id}
    <button type="button" className="button button--quiet" onClick={() => { void copyToClipboard(); }}>{copied ? texts.events.copied : texts.events.copyId}</button>
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
  const moduleSelectOptions: SelectOption[] = moduleOptions.map((module) => ({ value: module.id, label: moduleName(module.id) }));
  return <div className="event-filter" aria-label={texts.events.filter}>
    <div className="event-filter__controls">
      <ChipGroup
        ariaLabel={texts.events.origin}
        value={filters.origin}
        onChange={(value) => { onChange({ ...filters, origin: value === "channel" || value === "module" ? value : null }); }}
        options={[
          { value: "", label: texts.events.all },
          { value: "channel", label: texts.events.channelEvents },
          { value: "module", label: texts.events.moduleDiagnostics },
        ]}
      />
      <ChipGroup
        ariaLabel={texts.events.tone}
        value={filters.tone}
        onChange={(value) => { onChange({ ...filters, tone: eventToneFromValue(value ?? "") }); }}
        options={[
          { value: "", label: texts.events.all },
          { value: "error", label: texts.events.error },
          { value: "warning", label: texts.events.notice },
          { value: "info", label: texts.events.info },
        ]}
      />
      <UiSelect
        label={texts.events.moduleFilter}
        value={filters.module ?? ""}
        onChange={(value) => { onChange({ ...filters, module: value === "" ? null : value }); }}
        options={[{ value: "", label: texts.events.allModules }, ...moduleSelectOptions]}
      />
      <Field
        label={texts.events.person}
        value={personDraft}
        onChange={setPersonDraft}
        onKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); commitPerson(personDraft); }}
      />
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
  const dayGroups = eventDayGroups(groups);
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? null;
  const selectedHistory = selectedGroup === null ? [] : [...selectedGroup.entries].sort(chronological);
  const triggerNames = Array.from(new Set(selectedHistory.map((entry) => actorLabel(entry, texts))));
  const moderatorNames = Array.from(new Set(
    selectedHistory.map((entry) => moderatorLabel(eventDetail(entry.detail))).filter((name): name is string => name !== null),
  ));
  const affectedNames = Array.from(new Set(
    selectedHistory.map((entry) => affectedPersonLabel(eventDetail(entry.detail))).filter((name): name is string => name !== null),
  ));
  const eventEntries = eventsState.data?.entries ?? [];
  const filterActive = eventFilterIsActive(filters);
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
            {/* Connection lost: nothing could ever be loaded -- distinct from a background refresh failing once data already exists. */}
            {eventsState.status === "error" && eventsState.data === null ? (
              <ErrorPanel
                title={texts.events.connectionLost}
                reason={eventsState.error ?? ""}
                action={{ label: texts.events.retry, onClick: () => { void onRefreshFirstPage(channelId, filters); } }}
              />
            ) : null}
            {eventsState.error !== null && eventsState.data !== null ? <p className="muted" role="alert">{eventsState.error}</p> : null}
            {eventsState.data !== null && eventEntries.length === 0 ? (
              filterActive ? (
                <EmptyState
                  title={texts.events.noMatches}
                  description={`${texts.events.activeFilters} ${[
                    filters.origin === "channel" ? texts.events.channelEvents : null,
                    filters.origin === "module" ? texts.events.moduleDiagnostics : null,
                    filters.module === null ? null : moduleName(filters.module),
                    filters.tone === null ? null : (filters.tone === "info" ? texts.events.info : filters.tone === "warning" ? texts.events.notice : texts.events.error),
                    filters.person,
                  ].filter((value): value is string => value !== null).join(" · ")}`}
                  action={{ label: texts.events.resetFilters, onClick: () => { onFiltersChange(emptyEventFilter); } }}
                />
              ) : <p className="empty-state">{texts.events.none}</p>
            ) : null}
            {eventsState.data !== null ? <>
              {eventEntries.length === 0 ? null : <div ref={feedRef} className="event-feed">
                <div className={eventsState.status === "loading" ? "stale" : undefined}>
                  {dayGroups.map((day) => (
                    <section key={day.key} className="event-day">
                      <h3 className="event-day__heading">{day.label}</h3>
                      <table className="table event-table">
                        <thead><tr><th scope="col">{texts.events.event}</th><th scope="col">{texts.events.module}</th><th scope="col">{texts.events.who}</th><th scope="col">{texts.events.time}</th></tr></thead>
                        <tbody>{day.groups.map((group) => {
                          const entry = group.representative;
                          const eventLabel = eventText(entry.code, eventDetail(entry.detail));
                          return <tr key={group.key} ref={groupRowRef(group.key)} tabIndex={0} aria-selected={selectedGroupKey === group.key} onClick={() => { selectGroup(group.key); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectGroup(group.key); } }}>
                            <td><span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texts={texts} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventLabel}</span></span></td>
                            <td className={moduleLabel(entry) === entry.moduleId ? "mono" : undefined}>{moduleLabel(entry)}</td>
                            <td>{actorCell(entry, texts)}</td>
                            <td className="mono" title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</td>
                          </tr>;
                        })}</tbody>
                      </table>
                    </section>
                  ))}
                </div>
              </div>}
              <EventFeedEnd nextCursor={eventsState.data.nextCursor} loadingNextPage={loadingNextPage} onNextPage={onNextPage} />
            </> : null}
          </section>
        }
        inspector={selectedGroup === null ? null : (
          <SubInspector
            ariaLabel={texts.events.detail}
            title={texts.events.operation}
            identifier={<CopyableId id={selectedGroup.representative.triggerId || selectedGroup.representative.eventId} texts={texts} />}
            closeLabel={dashboardCommonTexts().close}
            onClose={closeGroup}
          >
            <dl className="properties">
              <div><dt>{texts.events.timestamp}</dt><dd className="mono" title={selectedHistory[0]?.createdAt}>{selectedHistory[0] === undefined ? "" : formatTimestamp(selectedHistory[0].createdAt)}</dd></div>
              <div><dt>{texts.events.module}</dt><dd>{Array.from(new Set(selectedHistory.map(moduleLabel))).join(", ")}</dd></div>
              <div><dt>{texts.events.trigger}</dt><dd>{triggerNames.join(", ")}</dd></div>
              {moderatorNames.length === 0 ? null : <div><dt>{texts.events.moderator}</dt><dd>{moderatorNames.join(", ")}</dd></div>}
              {affectedNames.length === 0 ? null : <div><dt>{texts.events.affectedPerson}</dt><dd>{affectedNames.join(", ")}</dd></div>}
            </dl>
            <div className="inspector-section__heading"><h3>{texts.events.history}</h3></div>
            <ol className="event-history">{selectedHistory.map((entry) => {
              return <li key={entry.eventId}>
                <div className="event-history__heading">
                  <span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texts={texts} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventText(entry.code, eventDetail(entry.detail))}</span></span>
                  <span className="mono muted">{entry.code}</span>
                </div>
                <details>
                  <summary>{texts.events.technicalDetails}</summary>
                  <pre className="event-detail-json">{formatEventDetail(entry.detail)}</pre>
                </details>
              </li>;
            })}</ol>
          </SubInspector>
        )}
      />
    </>
  );
};

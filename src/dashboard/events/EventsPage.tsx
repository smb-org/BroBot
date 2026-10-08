import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import type { PanelEventEntry, PanelEventFilters, PanelEventsResponse, PanelModuleState } from "../../panel-contract";
import { EVENT_TONES, type EventTone } from "../../contracts/values";
import { dashboardCommonTexts, dashboardLanguage, dashboardTexts, eventText, formatClockTime, formatNumber, formatTimestamp } from "../locale";
import { moduleName } from "../module-labels";
import { Led, ModuleCount, ModuleHeading, type LedStatus } from "../module-panels";
import { useRealtimeEventFeed, type RealtimeFeedStatus as RealtimeFeedStatusValue } from "../realtime";
import { Icon } from "../ui/Icon";
import { ChipGroup, EmptyState, InspectorSection, ListDetail, ListToolbar, LoadState as UiLoadState, Popover, Select as UiSelect, Skeleton, SubInspector, useInspectorSelection, type SelectOption } from "../ui";
import type { LoadState } from "../load-state";
import {
  actorLabel,
  affectedPersonLabel,
  chronological,
  emptyEventFilter,
  eventCause,
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
    return <span className="event-chip-pair"><span className="event-chip" data-tier="outlined">{texts.events.unknown}</span></span>;
  }
  const number = eventChipNumber(detail, metadata.numberKey);
  return <span className="event-chip-pair">
    {number === null ? null : <span className="event-chip event-chip--number">{number}</span>}
    <span className="event-chip" data-family={metadata.family} data-tier={metadata.tier} data-tone={metadata.tone}>{metadata.word[dashboardLanguage()]}</span>
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
  loadedCount,
  onChange,
}: {
  filters: PanelEventFilters;
  moduleOptions: readonly PanelModuleState[];
  loadedCount: number;
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
  const selectedTones = filters.tones !== undefined && filters.tones.length > 0
    ? filters.tones
    : filters.tone === null ? [] : [filters.tone];
  activeFilter.push(...selectedTones.map((tone) => tone === "info" ? texts.events.info : tone === "warning" ? texts.events.notice : texts.events.error));
  if (filters.person !== null) activeFilter.push(filters.person);
  const moduleSelectOptions: SelectOption[] = moduleOptions.map((module) => ({ value: module.id, label: moduleName(module.id) }));
  const common = dashboardCommonTexts();
  return <ListToolbar
    className="event-filter"
    searchLabel={texts.events.person}
    searchPlaceholder={texts.audit.personPlaceholder}
    searchClearLabel={common.clearSearch}
    searchValue={personDraft}
    onSearchChange={setPersonDraft}
    onSearchKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); commitPerson(personDraft); }}
    filtersLabel={texts.events.filter}
    filters={<>
      <ChipGroup
        className="event-filter__chips"
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
        className="event-filter__chips"
        ariaLabel={texts.events.tone}
        {...(selectedTones.length > 1 ? {
          value: null,
          onChange: () => undefined,
          selectedValues: selectedTones,
          onSelectedValuesChange: (values: readonly string[]) => {
            const tones = values.filter((tone): tone is EventTone => EVENT_TONES.includes(tone as EventTone));
            const nextFilters = { ...filters, tone: tones.length === 1 ? tones[0] ?? null : null };
            delete nextFilters.tones;
            if (tones.length > 1) nextFilters.tones = tones;
            onChange(nextFilters);
          },
          options: [
            { value: "error", label: texts.events.error },
            { value: "warning", label: texts.events.notice },
            { value: "info", label: texts.events.info },
          ],
        } : {
          value: filters.tone,
          onChange: (value: string | null) => {
            const nextFilters = { ...filters, tone: eventToneFromValue(value ?? "") };
            delete nextFilters.tones;
            onChange(nextFilters);
          },
          options: [
            { value: "", label: texts.events.all },
            { value: "error", label: texts.events.error },
            { value: "warning", label: texts.events.notice },
            { value: "info", label: texts.events.info },
          ],
        })}
      />
      <UiSelect
        label={texts.events.moduleFilter}
        value={filters.module ?? ""}
        onChange={(value) => { onChange({ ...filters, module: value === "" ? null : value }); }}
        options={[{ value: "", label: texts.events.allModules }, ...moduleSelectOptions]}
      />
    </>}
    usage={{ count: loadedCount, loaded: true, copy: { countSuffix: "", filteredInfix: common.of, filteredSuffix: "", limitInfix: common.of, limitSuffix: "", loadedSuffix: common.loaded } }}
    {...(activeFilter.length === 0 ? {} : { activeFilters: activeFilter.join(" · "), activeFiltersLabel: texts.events.activeFilters, resetLabel: texts.events.resetFilters, onReset: () => { setPersonDraft(""); onChange(emptyEventFilter); } })}
  />;
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
  const feedEndRef = useRef<HTMLSpanElement | null>(null);
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
  return <span
    ref={feedEndRef}
    className="event-feed__end"
    aria-hidden="true"
  />;
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
    selectedHistory.map((entry) => moderatorLabel(eventDetail(entry.detail, entry.code))).filter((name): name is string => name !== null),
  ));
  const affectedNames = Array.from(new Set(
    selectedHistory.map((entry) => affectedPersonLabel(eventDetail(entry.detail, entry.code))).filter((name): name is string => name !== null),
  ));
  const eventEntries = eventsState.data?.entries ?? [];
  const filterActive = eventFilterIsActive(filters);
  const selectedTones = filters.tones !== undefined && filters.tones.length > 0
    ? filters.tones
    : filters.tone === null ? [] : [filters.tone];
  return (
    <>
      <ModuleHeading kind="events" title={texts.events.title} subtitle={eventsState.data === null
        ? <span className="module-heading__subtitle-placeholder" aria-hidden="true"><ModuleCount count={0} label={texts.events.count} /></span>
        : <ModuleCount count={eventsState.data.entries.length} label={texts.events.count} />} actions={<RealtimeFeedStatus status={realtime.status} />} />
      <ListDetail
        onCloseInspector={closeGroup}
        list={
          <section className="content-section" aria-label={texts.events.log}>
            <div className="section-heading"><h2>{texts.events.log}</h2></div>
            <EventFilterBar filters={filters} moduleOptions={moduleOptions} loadedCount={eventEntries.length} onChange={onFiltersChange} />
            <div className="realtime-feed__notice-slot" data-pending={realtime.pendingCount > 0}>
              {realtime.pendingCount === 0 ? null : <button className="button button--with-icon realtime-feed__notice" type="button" onClick={realtime.jumpToBeginning} aria-live="polite"><Icon name="jumpToTop" size={16} />{texts.events.realtimeNew(formatNumber(realtime.pendingCount))}</button>}
            </div>
            <div className="events-page__pagination-slot">
              {eventsState.data === null ? null : eventsState.data.nextCursor === null
                ? <p className="empty-state">{texts.events.feedEnd}</p>
                : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? texts.events.loadingOlder : texts.events.loadOlder}</button>}
            </div>
            <UiLoadState
              status={eventsState.data === null
                ? eventsState.status === "error" ? "error" : "loading"
                : eventEntries.length === 0 ? "empty" : "success"}
              minHeight={420}
              loading={<Skeleton rows={50} height={34} />}
              empty={filterActive ? (
                <EmptyState
                  title={texts.events.noMatches}
                  description={`${texts.events.activeFilters} ${[
                    filters.origin === "channel" ? texts.events.channelEvents : null,
                    filters.origin === "module" ? texts.events.moduleDiagnostics : null,
                    filters.module === null ? null : moduleName(filters.module),
                    ...selectedTones.map((tone) => tone === "info" ? texts.events.info : tone === "warning" ? texts.events.notice : texts.events.error),
                    filters.person,
                  ].filter((value): value is string => value !== null).join(" · ")}`}
                  action={{ label: texts.events.resetFilters, onClick: () => { onFiltersChange(emptyEventFilter); } }}
                />
              ) : <p className="empty-state">{texts.events.none}</p>}
              error={<EmptyState
                title={texts.events.connectionLost}
                description={eventsState.error ?? texts.events.load}
                action={{ label: texts.events.retry, onClick: () => { void onRefreshFirstPage(channelId, filters); } }}
              />}
            >
              <>
              <div ref={feedRef} className="event-feed">
                <div className={eventsState.status === "loading" ? "stale" : undefined}>
                  {dayGroups.map((day) => (
                    <section key={day.key} className="event-day">
                      <h3 className="event-day__heading">{day.label}</h3>
                      <table className="table event-table">
                        <thead><tr><th scope="col">{texts.events.event}</th><th scope="col">{texts.events.module}</th><th scope="col">{texts.events.who}</th><th scope="col">{texts.events.time}</th></tr></thead>
                        <tbody>{day.groups.map((group) => {
                          const entry = group.representative;
                          const eventLabel = eventText(entry.code, eventDetail(entry.detail, entry.code));
                          const cause = eventCause(entry);
                          return <tr key={group.key} ref={groupRowRef(group.key)} tabIndex={0} aria-selected={selectedGroupKey === group.key} onClick={() => { selectGroup(group.key); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectGroup(group.key); } }}>
                            <td>
                              <span className="event-label event-table__primary">
                                <EventChipPair code={entry.code} detail={eventDetail(entry.detail, entry.code)} texts={texts} />
                                <span className={`event-table__text${eventMetadata(entry.code) === null ? " mono" : ""}`}>{eventLabel}</span>
                                {cause === null ? null : (
                                  <Popover triggerLabel={texts.events.showCause(eventLabel)} icon="cause">
                                    <span className="event-cause">
                                      <span>{cause.text}</span>
                                      {cause.message === null ? null : (
                                        <span className="event-cause__message">
                                          {cause.messageIsFromTwitch ? texts.events.causeTwitchMessage(cause.message) : texts.events.causeDetailMessage(cause.message)}
                                        </span>
                                      )}
                                    </span>
                                  </Popover>
                                )}
                              </span>
                              <span className="event-table__mobile-meta muted">
                                <span className={moduleLabel(entry) === entry.moduleId ? "mono" : undefined} title={moduleLabel(entry)}>{moduleLabel(entry)}</span>
                                <span aria-hidden="true">·</span>
                                <span>{actorCell(entry, texts)}</span>
                                <span aria-hidden="true">·</span>
                                <time className="mono" dateTime={entry.createdAt} title={entry.createdAt}>{formatClockTime(entry.createdAt)}</time>
                              </span>
                            </td>
                            <td className={moduleLabel(entry) === entry.moduleId ? "mono" : undefined} title={moduleLabel(entry)}>{moduleLabel(entry)}</td>
                            <td title={actorLabel(entry, texts)}>{actorCell(entry, texts)}</td>
                            <td className="mono" title={entry.createdAt}>
                              <time dateTime={entry.createdAt} title={entry.createdAt}>{formatClockTime(entry.createdAt)}</time>
                            </td>
                          </tr>;
                        })}</tbody>
                      </table>
                    </section>
                  ))}
                </div>
                <EventFeedEnd nextCursor={eventsState.data?.nextCursor ?? null} loadingNextPage={loadingNextPage} onNextPage={onNextPage} />
              </div>
              </>
            </UiLoadState>
          </section>
        }
        inspector={selectedGroup === null ? null : (
          <SubInspector
            ariaLabel={texts.events.detail}
            title={texts.events.operation}
            identifier={selectedGroup.representative.triggerId || selectedGroup.representative.eventId}
            closeLabel={dashboardCommonTexts().close}
            onClose={closeGroup}
          >
            <InspectorSection title={texts.events.operation}><dl className="properties">
              <div><dt>{texts.events.timestamp}</dt><dd className="mono" title={selectedHistory[0]?.createdAt}>{selectedHistory[0] === undefined ? "" : formatTimestamp(selectedHistory[0].createdAt)}</dd></div>
              <div><dt>{texts.events.module}</dt><dd>{Array.from(new Set(selectedHistory.map(moduleLabel))).join(", ")}</dd></div>
              <div><dt>{texts.events.trigger}</dt><dd>{triggerNames.join(", ")}</dd></div>
              {moderatorNames.length === 0 ? null : <div><dt>{texts.events.moderator}</dt><dd>{moderatorNames.join(", ")}</dd></div>}
              {affectedNames.length === 0 ? null : <div><dt>{texts.events.affectedPerson}</dt><dd>{affectedNames.join(", ")}</dd></div>}
            </dl></InspectorSection>
            <InspectorSection title={texts.events.history}>
            <ol className="event-history">{selectedHistory.map((entry) => {
              return <li key={entry.eventId}>
                <div className="event-history__heading">
                  <span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail, entry.code)} texts={texts} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventText(entry.code, eventDetail(entry.detail, entry.code))}</span></span>
                  <span className="mono muted">{entry.code}</span>
                </div>
                <details>
                  <summary>{texts.events.technicalDetails}</summary>
                  <CopyableId id={entry.triggerId || entry.eventId} texts={texts} />
                  <pre className="event-detail-json">{formatEventDetail(entry.detail, entry.code)}</pre>
                </details>
              </li>;
            })}</ol>
            </InspectorSection>
          </SubInspector>
        )}
      />
    </>
  );
};

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";

import type { PanelAuditEntry, PanelAuditFilters, PanelAuditResponse } from "../../panel-contract";
import { AUDIT_AREAS } from "../../contracts/values";
import { apiErrorText, auditFieldLabel, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatNumber } from "../locale";
import { useChannelSettings } from "../data/channel-settings";
import { browserTimeZone } from "../ui/format-relative-time";
import { ModuleHeading } from "../module-panels";
import { loadModuleSettingsEditor } from "../module-panel-loaders";
import { formatEventDetail } from "../events/model";
import { AuditSentence, Badge, Button, ChipGroup, DataTable, EmptyState, Field, FilterBar, InspectorSection, ListDetail, LoadState as UiLoadState, LoadStateLines, SubInspector, useInspectorSelection, type SettingsEditorCatalog } from "../ui";
import { PanelApiError } from "../api";
import { dashboardDataKeys } from "../data/keys";
import { useAuditQuery } from "../data/lists";
import {
  auditActorLabel,
  auditAreaForAction,
  auditDiffRows,
  auditDiffValueText,
  auditFilterIsActive,
  auditRowLabel,
  auditSentenceText,
  emptyAuditFilter,
  roleText,
  type AuditDiffRow,
} from "./model";

const PERSON_FILTER_DEBOUNCE_MS = 300;

const auditEntriesFromPages = (pages: readonly PanelAuditResponse[]): PanelAuditEntry[] => [
  ...new Map(pages.flatMap((page) => page.entries).map((entry) => [entry.auditId, entry])).values(),
];

const isOlderAuditEntry = (entry: PanelAuditEntry, boundary: PanelAuditEntry): boolean => {
  const entryTime = Date.parse(entry.createdAt);
  const boundaryTime = Date.parse(boundary.createdAt);
  return entryTime < boundaryTime || (entryTime === boundaryTime && entry.auditId < boundary.auditId);
};

const AuditFilterBar = ({
  filters,
  onChange,
  loadedCount,
}: {
  filters: PanelAuditFilters;
  onChange: (filters: PanelAuditFilters) => void;
  loadedCount: number;
}): ReactElement => {
  const texts = dashboardTexts();
  const [personDraft, setPersonDraft] = useState(filters.person ?? "");
  // Same reasoning as the event log's own person filter (`events/EventsPage.tsx`):
  // the applied filter is the source of truth, and the draft only follows it
  // during render (never in an effect) when it changes from outside.
  const [lastApplied, setLastApplied] = useState(filters.person);
  if (lastApplied !== filters.person) {
    setLastApplied(filters.person);
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
  if (filters.area !== null) activeFilter.push(texts.audit.areaLabels[filters.area]);
  if (filters.person !== null) activeFilter.push(filters.person);
  return <FilterBar label={texts.audit.filter} className="event-filter audit-filter" summary={activeFilter.length === 0 ? undefined : <div className="form-actions"><p className="muted" aria-live="polite">{texts.audit.activeFilters} {activeFilter.join(" · ")}</p><button className="button button--quiet" type="button" onClick={() => { setPersonDraft(""); onChange(emptyAuditFilter); }}>{texts.audit.resetFilters}</button></div>}>
      <ChipGroup
        className="event-filter__chips"
        ariaLabel={texts.audit.area}
        value={filters.area}
        onChange={(value) => { onChange({ ...filters, area: value === "" || value === null ? null : value as PanelAuditFilters["area"] }); }}
        options={[
          { value: "", label: texts.audit.allAreas },
          ...AUDIT_AREAS.map((area) => ({ value: area, label: texts.audit.areaLabels[area] })),
        ]}
      />
      <Field
        label={texts.audit.person}
        hint={texts.audit.personHint}
        placeholder={texts.audit.personPlaceholder}
        icon="search"
        value={personDraft}
        onChange={setPersonDraft}
        onKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); commitPerson(personDraft); }}
      />
      <span className="audit-filter__count" aria-live="polite">{formatNumber(loadedCount)} {texts.audit.loaded}</span>
  </FilterBar>;
};

/** Field label + boolean words for a diff row: the module's own settings catalogue when it's loaded and matches, the generic fallback otherwise. */
const diffFieldTexts = (
  row: AuditDiffRow,
  moduleCatalog: SettingsEditorCatalog | null,
  texts: ReturnType<typeof dashboardTexts>,
  language: ReturnType<typeof dashboardLanguage>,
): { label: string; boolWords: { on: string; off: string } } => {
  if (row.fromSettings && moduleCatalog !== null) {
    const field = moduleCatalog.fields[row.key];
    return { label: field?.label ?? auditFieldLabel(row.key, language), boolWords: { on: moduleCatalog.enabledLabel, off: moduleCatalog.disabledLabel } };
  }
  return { label: auditFieldLabel(row.key, language), boolWords: { on: texts.audit.yes, off: texts.audit.no } };
};

const AuditDiffList = ({ rows, moduleCatalog, texts }: {
  rows: readonly AuditDiffRow[];
  moduleCatalog: SettingsEditorCatalog | null;
  texts: ReturnType<typeof dashboardTexts>;
}): ReactElement | null => {
  if (rows.length === 0) return null;
  return <dl className="properties audit-diff">
    {rows.map((row) => {
      const { label, boolWords } = diffFieldTexts(row, moduleCatalog, texts, dashboardLanguage());
      // A member's role diff carries the raw role value (e.g. "operator"), the
      // same one the feed sentence localizes via the role catalogue (#254 review).
      const language = dashboardLanguage();
      const oldText = row.key === "role" ? roleText(row.oldValue, language) ?? auditDiffValueText(row.oldValue, boolWords) : auditDiffValueText(row.oldValue, boolWords);
      const newText = row.key === "role" ? roleText(row.newValue, language) ?? auditDiffValueText(row.newValue, boolWords) : auditDiffValueText(row.newValue, boolWords);
      return <div key={row.key} className="audit-diff__row" data-kind={row.kind}>
        <dt>{label}</dt>
        <dd className="audit-diff__value">
          {row.kind === "changed" ? <><del>{oldText}</del> <span aria-hidden="true">→</span> {newText}</> : null}
          {row.kind === "added" ? <>{texts.audit.newValue}: {newText}</> : null}
          {row.kind === "removed" ? <>{texts.audit.removedValue}: {oldText}</> : null}
          {row.kind === "changed-truncated" ? <>{texts.audit.changedTruncated}</> : null}
        </dd>
      </div>;
    })}
  </dl>;
};

/**
 * Loads the field catalogue for an entry whose diff carries settings fields,
 * lazily while its inspector is open. A `module.enabled` entry can include
 * settings when a row is first created, so it needs the same labels as a
 * settings-change entry.
 */
const useModuleFieldCatalog = (entry: PanelAuditEntry | null): SettingsEditorCatalog | null => {
  const [loaded, setLoaded] = useState<{ moduleId: string; catalog: SettingsEditorCatalog } | null>(null);
  const moduleId = entry?.moduleId ?? null;
  const hasSettingsFields = entry !== null && auditDiffRows(entry.before, entry.after).some((row) => row.fromSettings);
  useEffect(() => {
    if (!hasSettingsFields || moduleId === null) return;
    const definitionPromise = loadModuleSettingsEditor(moduleId);
    if (definitionPromise === null) return;
    let active = true;
    void definitionPromise.then((definition) => {
      if (active) setLoaded({ moduleId, catalog: definition.default.locales[dashboardLanguage()] });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [hasSettingsFields, moduleId]);
  return loaded !== null && loaded.moduleId === moduleId ? loaded.catalog : null;
};

interface AuditPageProperties {
  channelId: string;
  filters: PanelAuditFilters;
  onFiltersChange: (filters: PanelAuditFilters) => void;
}

export const AuditPage = ({ channelId, filters, onFiltersChange }: AuditPageProperties): ReactElement => {
  const query = useAuditQuery(channelId, filters);
  const settingsQuery = useChannelSettings(channelId);
  const timeZoneFallback = settingsQuery.isError;
  const channelTimeZone = timeZoneFallback ? browserTimeZone() : settingsQuery.data?.timeZone ?? null;
  const queryKey = dashboardDataKeys.audit(channelId, filters);
  const identityKey = JSON.stringify(queryKey);
  const pages = query.data?.pages ?? [];
  const entries = auditEntriesFromPages(pages);
  const nextCursor = pages.at(-1)?.nextCursor ?? null;
  const error = query.error instanceof PanelApiError
    ? apiErrorText(query.error.code, dashboardTexts().errors.dataLoadFailed)
    : query.isError ? dashboardTexts().errors.dataLoadFailed : null;
  return <AuditPageContent
    identityKey={identityKey}
    pages={pages}
    channelTimeZone={channelTimeZone}
    timeZoneFallback={timeZoneFallback}
    entries={entries}
    nextCursor={nextCursor}
    filters={filters}
    onFiltersChange={onFiltersChange}
    loading={query.isPending}
    fetching={query.isFetching && !query.isFetchingNextPage}
    error={error}
    loadingNextPage={query.isFetchingNextPage}
    onNextPage={() => { void query.fetchNextPage({ cancelRefetch: false }); }}
    onRetry={async () => {
      const result = await query.refetch();
      return result.data?.pages;
    }}
  />;
};

const AuditPageContent = ({ identityKey, pages, channelTimeZone, timeZoneFallback, entries, nextCursor, filters, onFiltersChange, loading, fetching, error, onNextPage, onRetry, loadingNextPage }: {
  identityKey: string;
  pages: readonly PanelAuditResponse[];
  channelTimeZone: string | null;
  timeZoneFallback: boolean;
  entries: readonly PanelAuditEntry[];
  nextCursor: string | null;
  filters: PanelAuditFilters;
  onFiltersChange: (filters: PanelAuditFilters) => void;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  onNextPage: () => void;
  onRetry: () => Promise<readonly PanelAuditResponse[] | undefined>;
  loadingNextPage: boolean;
}): ReactElement => {
  const texts = dashboardTexts();
  const feedRef = useRef<HTMLElement>(null);
  const identityKeyRef = useRef(identityKey);
  useLayoutEffect(() => {
    identityKeyRef.current = identityKey;
  }, [identityKey]);
  const [snapshot, setSnapshot] = useState(() => ({ identityKey, entries, pageCount: pages.length, awaitingInitialPage: loading }));
  let displaySnapshot = snapshot;
  if (displaySnapshot.identityKey !== identityKey) {
    displaySnapshot = { identityKey, entries, pageCount: pages.length, awaitingInitialPage: loading };
    setSnapshot(displaySnapshot);
  }
  if (displaySnapshot.awaitingInitialPage && !loading) {
    displaySnapshot = { ...displaySnapshot, entries, pageCount: pages.length, awaitingInitialPage: false };
    setSnapshot(displaySnapshot);
  } else if (!displaySnapshot.awaitingInitialPage && pages.length < displaySnapshot.pageCount) {
    displaySnapshot = { ...displaySnapshot, pageCount: pages.length };
    setSnapshot(displaySnapshot);
  } else if (!displaySnapshot.awaitingInitialPage && pages.length > displaySnapshot.pageCount) {
    const loadedOlderEntries = pages.slice(displaySnapshot.pageCount).flatMap((page) => page.entries);
    const seenIds = new Set(displaySnapshot.entries.map((entry) => entry.auditId));
    const boundary = displaySnapshot.entries.at(-1);
    const appendedEntries: PanelAuditEntry[] = [];
    for (const entry of loadedOlderEntries) {
      if (seenIds.has(entry.auditId) || (boundary !== undefined && !isOlderAuditEntry(entry, boundary))) continue;
      seenIds.add(entry.auditId);
      appendedEntries.push(entry);
    }
    displaySnapshot = {
      ...displaySnapshot,
      entries: [...displaySnapshot.entries, ...appendedEntries],
      pageCount: pages.length,
    };
    setSnapshot(displaySnapshot);
  }

  const displayedEntries = displaySnapshot.entries;
  const displayedIds = new Set(displayedEntries.map((entry) => entry.auditId));
  const pendingCount = displaySnapshot.awaitingInitialPage ? 0 : entries.filter((entry) => !displayedIds.has(entry.auditId)).length;
  const refreshSnapshot = (): void => {
    const requestedIdentity = identityKey;
    void onRetry().then((freshPages) => {
      if (identityKeyRef.current !== requestedIdentity) return;
      if (freshPages === undefined) return;
      setSnapshot({ identityKey, entries: auditEntriesFromPages(freshPages), pageCount: freshPages.length, awaitingInitialPage: false });
    });
  };
  const jumpToLatest = (): void => {
    const feed = feedRef.current;
    const scrollRoot = document.querySelector<HTMLElement>(".dashboard-shell__main");
    if (feed !== null && scrollRoot !== null) {
      const feedStart = feed.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top + scrollRoot.scrollTop;
      if (typeof scrollRoot.scrollTo === "function") scrollRoot.scrollTo({ top: Math.max(0, feedStart), behavior: "auto" });
      else scrollRoot.scrollTop = Math.max(0, feedStart);
    } else if (feed !== null && typeof window.scrollTo === "function") {
      const feedStart = feed.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, feedStart), behavior: "auto" });
    }
    setSnapshot({ identityKey, entries, pageCount: pages.length, awaitingInitialPage: false });
  };
  const { selectedKey: selectedAuditId, select: selectAudit, rowRef: auditRowRef, close: closeAudit } = useInspectorSelection<string>(identityKey);
  const selectedAudit = displayedEntries.find((entry) => entry.auditId === selectedAuditId) ?? null;
  const moduleCatalog = useModuleFieldCatalog(selectedAudit);
  const selectedDiffRows = selectedAudit === null ? [] : auditDiffRows(selectedAudit.before, selectedAudit.after);
  const filterActive = auditFilterIsActive(filters);
  return (
    <>
      <ModuleHeading
        kind="audit"
        title={texts.audit.title}
        subtitle={loading && displayedEntries.length === 0
          ? <span className="module-heading__subtitle-placeholder" aria-hidden="true">{texts.audit.entries(0)}</span>
          : texts.audit.entries(displayedEntries.length)}
        actions={<Button variant="neutral" icon="reload" disabled={fetching} onClick={refreshSnapshot}>{texts.audit.refresh}</Button>}
      />
      <ListDetail
        onCloseInspector={closeAudit}
        list={
          <section ref={feedRef} className="content-section audit-page-list" aria-label={texts.audit.title}>
            <AuditFilterBar filters={filters} onChange={onFiltersChange} loadedCount={displayedEntries.length} />
            <div className="audit-pagination" aria-label={texts.audit.olderEntries}>
              <div className="audit-new-entries-slot" aria-live="polite">
                {error !== null && displayedEntries.length > 0
                  ? <div className="audit-request-error"><span role="alert">{error}</span><Button variant="neutral" icon="reload" iconOnly ariaLabel={texts.audit.refresh} disabled={fetching} onClick={refreshSnapshot} /></div>
                  : pendingCount === 0 ? null : <Button variant="neutral" icon="jumpToTop" ariaLabel={`${texts.audit.newEntries(pendingCount)} · ${texts.audit.jumpToLatest}`} onClick={jumpToLatest}>{texts.audit.newEntries(pendingCount)}</Button>}
              </div>
              {nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage || fetching}>{loadingNextPage ? texts.audit.loadingOlderEntries : texts.audit.olderEntries}</button>}
            </div>
            <UiLoadState
              variant="panel-420"
              status={loading && displayedEntries.length === 0
                ? "loading"
                : error !== null && displayedEntries.length === 0 ? "error"
                : displayedEntries.length === 0 ? "empty" : "success"}
              loading={<LoadStateLines rows={50} height={44} />}
              empty={filterActive
                ? <EmptyState title={texts.audit.noMatches} description={texts.audit.activeFilters} action={{ label: texts.audit.resetFilters, onClick: () => { onFiltersChange(emptyAuditFilter); } }} />
                : <p className="empty-state">{texts.audit.empty}</p>}
              error={<p role="alert">{error ?? texts.audit.load}</p>}
              queryError={{ title: texts.audit.loadError, message: error ?? texts.audit.load, onRetry: refreshSnapshot }}
            >
              {displayedEntries.length > 0 ? <>
              <div key={identityKey} className={fetching ? "stale" : undefined} aria-busy={fetching}>
                <DataTable
                  ariaLabel={texts.audit.title}
                  className="audit-sentence-list"
                  rows={displayedEntries.map((entry) => ({
                    ...entry,
                    id: entry.auditId,
                    at: entry.createdAt,
                    moduleGroup: entry.moduleId ?? auditAreaForAction(entry.action),
                  }))}
                  timeZone={channelTimeZone}
                  {...(timeZoneFallback ? { timeZoneFallbackLabel: texts.streamManager.browserTimeZoneFallback } : {})}
                  emptyLabel={texts.audit.empty}
                  selectedId={selectedAuditId}
                  onSelect={selectAudit}
                  rowRef={auditRowRef}
                  columns={[
                    {
                      key: "change",
                      label: texts.audit.changeData,
                      render: (entry) => {
                        const sentence = auditSentenceText(entry, dashboardLanguage());
                        return <span className="audit-sentence-row__sentence">
                          <AuditSentence sentence={sentence} />
                        </span>;
                      },
                    },
                    {
                      key: "area",
                      label: texts.audit.area,
                      moduleGroup: true,
                      render: (entry) => <Badge>{texts.audit.areaLabels[auditAreaForAction(entry.action)]}</Badge>,
                    },
                  ]}
                />
              </div>
            </> : null}
            </UiLoadState>
          </section>
        }
        inspector={selectedAudit === null ? null : (
          <SubInspector ariaLabel={texts.audit.changeData} title={auditRowLabel(selectedAudit, dashboardLanguage())} identifier={selectedAudit.auditId} closeLabel={dashboardCommonTexts().close} onClose={closeAudit}>
            <InspectorSection title={texts.audit.who}>
              <dl className="properties"><div><dt>{texts.audit.who}</dt><dd title={selectedAudit.actorUserId ?? undefined}>{auditActorLabel(selectedAudit)}</dd></div></dl>
            </InspectorSection>
            {selectedDiffRows.length === 0 ? null : <InspectorSection title={texts.audit.changesHeading}>
              <AuditDiffList rows={selectedDiffRows} moduleCatalog={moduleCatalog} texts={texts} />
            </InspectorSection>}
            <details>
              <summary>{texts.events.technicalDetails}</summary>
              <div className="inspector-columns">
                <div><h4>{texts.audit.before}</h4><pre>{formatEventDetail(selectedAudit.before, selectedAudit.action)}</pre></div>
                <div><h4>{texts.audit.after}</h4><pre>{formatEventDetail(selectedAudit.after, selectedAudit.action)}</pre></div>
              </div>
            </details>
          </SubInspector>
        )}
      />
    </>
  );
};

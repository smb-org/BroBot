import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { PanelAuditEntry, PanelAuditFilters, PanelAuditResponse } from "../../panel-contract";
import { AUDIT_AREAS } from "../../contracts/values";
import { MODULES } from "../../modules/registry";
import { auditFieldLabel, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatClockTime, formatDate, formatNumber } from "../locale";
import { ModuleHeading } from "../module-panels";
import { formatEventDetail } from "../events/model";
import { AuditSentence, Badge, ChipGroup, EmptyState, Field, FilterBar, InspectorSection, ListDetail, LoadState as UiLoadState, Skeleton, SubInspector, useInspectorSelection, type SettingsEditorCatalog } from "../ui";
import type { LoadState } from "../load-state";
import {
  auditActorLabel,
  auditAreaForAction,
  auditDayGroups,
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

const AuditFilterBar = ({
  filters,
  onChange,
}: {
  filters: PanelAuditFilters;
  onChange: (filters: PanelAuditFilters) => void;
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

/** Loads the field catalogue for an entry whose diff carries settings fields -- lazily, only while its inspector is open (module settings editors are code-split, see `modules/contract.ts`'s `settingsEditor`). Not just `*.settings_changed`: `module.enabled` (first enable, or a re-enable resetting to defaults) carries settings too, so its diff needs the same labels instead of raw keys. */
const useModuleFieldCatalog = (entry: PanelAuditEntry | null): SettingsEditorCatalog | null => {
  const [loaded, setLoaded] = useState<{ moduleId: string; catalog: SettingsEditorCatalog } | null>(null);
  const moduleId = entry?.moduleId ?? null;
  const hasSettingsFields = entry !== null && auditDiffRows(entry.before, entry.after).some((row) => row.fromSettings);
  useEffect(() => {
    if (!hasSettingsFields || moduleId === null) return;
    const module = MODULES.find((candidate) => candidate.id === moduleId);
    if (module?.settingsEditor === undefined) return;
    let active = true;
    void module.settingsEditor().then((definition) => {
      if (active) setLoaded({ moduleId, catalog: definition.default.locales[dashboardLanguage()] });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [hasSettingsFields, moduleId]);
  return loaded !== null && loaded.moduleId === moduleId ? loaded.catalog : null;
};

interface AuditPageProperties {
  auditState: LoadState<PanelAuditResponse>;
  filters: PanelAuditFilters;
  onFiltersChange: (filters: PanelAuditFilters) => void;
  onNextPage: () => void;
  loadingNextPage: boolean;
}

export const AuditPage = ({ auditState, filters, onFiltersChange, onNextPage, loadingNextPage }: AuditPageProperties): ReactElement => {
  const texts = dashboardTexts();
  const { selectedKey: selectedAuditId, select: selectAudit, rowRef: auditRowRef, close: closeAudit } = useInspectorSelection<string>();
  const selectedAudit = auditState.data?.entries.find((entry) => entry.auditId === selectedAuditId) ?? null;
  const moduleCatalog = useModuleFieldCatalog(selectedAudit);
  const selectedDiffRows = selectedAudit === null ? [] : auditDiffRows(selectedAudit.before, selectedAudit.after);
  const entries = auditState.data?.entries ?? [];
  const dayGroups = auditDayGroups(entries, formatDate);
  const filterActive = auditFilterIsActive(filters);
  return (
    <>
      <ModuleHeading
        kind="audit"
        title={texts.audit.title}
        subtitle={auditState.data === null
          ? <span className="module-heading__subtitle-placeholder" aria-hidden="true"><span className="number">{formatNumber(0)}</span> {texts.audit.entries}</span>
          : <><span className="number">{formatNumber(auditState.data.entries.length)}</span> {texts.audit.entries}</>}
      />
      <ListDetail
        onCloseInspector={closeAudit}
        list={
          <section className="content-section" aria-label={texts.audit.title}>
            <AuditFilterBar filters={filters} onChange={onFiltersChange} />
            <UiLoadState
              status={auditState.data === null
                ? auditState.status === "error" ? "error" : "loading"
                : entries.length === 0 ? "empty" : "success"}
              minHeight={420}
              loading={<Skeleton rows={50} height={44} />}
              empty={filterActive
                ? <EmptyState title={texts.audit.noMatches} description={texts.audit.activeFilters} action={{ label: texts.audit.resetFilters, onClick: () => { onFiltersChange(emptyAuditFilter); } }} />
                : <p className="empty-state">{texts.audit.empty}</p>}
              error={<EmptyState title={texts.audit.loadError} description={texts.audit.load} />}
            >
              {entries.length > 0 ? <>
              <div className={auditState.status === "loading" ? "stale" : undefined}>
                {dayGroups.map((day) => (
                  <section key={day.key} className="event-day">
                    <h3 className="event-day__heading">{day.label}</h3>
                    <div className="audit-sentence-list">
                      {day.entries.map((entry) => {
                        const sentence = auditSentenceText(entry, dashboardLanguage());
                        const area = texts.audit.areaLabels[auditAreaForAction(entry.action)];
                        const time = formatClockTime(entry.createdAt);
                        const accessibleName = [
                          sentence,
                          area,
                          time,
                        ].join(" ");
                        return <button
                          key={entry.auditId}
                          type="button"
                          className="audit-sentence-row"
                          ref={auditRowRef(entry.auditId)}
                          aria-pressed={selectedAuditId === entry.auditId}
                          aria-label={accessibleName}
                          onClick={() => { selectAudit(entry.auditId); }}
                        >
                          <span className="audit-sentence-row__sentence"><AuditSentence sentence={sentence} /></span>
                          <span className="audit-sentence-row__meta">
                            <Badge>{area}</Badge>
                            <time className="mono" dateTime={entry.createdAt} title={entry.createdAt}>{time}</time>
                          </span>
                        </button>;
                      })}
                    </div>
                  </section>
                ))}
              </div>
            </> : null}
            </UiLoadState>
            <div className="audit-page__pagination-slot">
              {auditState.data?.nextCursor === null || auditState.data?.nextCursor === undefined ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? texts.audit.loadingOlderEntries : texts.audit.olderEntries}</button>}
            </div>
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

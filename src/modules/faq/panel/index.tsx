import { useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type ReactElement } from "react";

import { refetchModuleQueryData, runModuleQueryWrite, useChannelSettings, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  Badge,
  Button,
  ChatTargetField,
  ChipsInput,
  CollectionPage,
  ConfirmDialog,
  Field,
  FieldPair,
  GameMultiSelect,
  Icon,
  LoadState,
  LoadStateLines,
  PageHeader,
  RoleThreshold,
  RuleNote,
  Section,
  SegmentChoice,
  SwitchSection,
  TemplateTextField,
  UnitInput,
  mapServerFieldErrors,
  notify,
  registerDashboardNavigationGuard,
  useDraftGuard,
} from "../../../dashboard/ui";
import { renderTemplate, type ModulePanelProperties } from "../../contract";
import type { FaqEntry, FaqGame } from "../contracts";
import { FAQ_ANSWER_MAX_LENGTH, FAQ_COOLDOWN_MAXIMUM_SECONDS, FAQ_COOLDOWN_MINIMUM_SECONDS, FAQ_ENTRY_NAME_MAX_LENGTH, FAQ_MINIMUM_TIERS, FAQ_PATTERN_MAXIMUM_COUNT, FAQ_PATTERN_MAX_LENGTH, FAQ_USER_COOLDOWN_MAXIMUM_SECONDS } from "../contracts";
import { faqMatcherValidationError } from "../domain";
import { formatCharacterCount } from "../../../dashboard/ui/text-length";
import { inputFromDraft, matcherFromDraft, type FaqDraft } from "./draft";
import { faqMatcherValidationReasonText, faqTexts } from "./locale";
import {
  createFaqEntry,
  deleteFaqEntry,
  faqErrorCode,
  loadFaqPanel,
  lookupFaqGames,
  reorderFaqEntries,
  searchFaqGames,
  updateFaqEntry,
  type FaqPanelData,
} from "./service";
import "./panel.css";

const NEW_ENTRY_ID = "__new_faq_entry__";

const emptyDraft = (): FaqDraft => ({
  name: "",
  enabled: true,
  matcherType: "keywords",
  patterns: "",
  answerText: "",
  minimumTier: "everyone",
  cooldownSeconds: FAQ_COOLDOWN_MINIMUM_SECONDS,
  userCooldownSeconds: 0,
  games: [],
  restrictGames: false,
  chatTarget: null,
});

const draftFromEntry = (entry: FaqEntry): FaqDraft => ({
  name: entry.name,
  enabled: entry.enabled,
  matcherType: entry.matcher.type,
  patterns: entry.matcher.type === "keywords" ? entry.matcher.patterns.join("\n") : entry.matcher.pattern,
  answerText: entry.answerText,
  minimumTier: entry.minimumTier,
  cooldownSeconds: entry.cooldownSeconds,
  userCooldownSeconds: entry.userCooldownSeconds,
  games: [...entry.games],
  restrictGames: entry.games.length > 0,
  chatTarget: entry.chatTarget,
});

const faqPanelDataFrom = (value: unknown): FaqPanelData => {
  if (typeof value === "object" && value !== null && "entries" in value && "variables" in value &&
      "orderRevision" in value && Array.isArray(value.entries) && Array.isArray(value.variables)) return value as FaqPanelData;
  return { entries: [], orderRevision: 1, variables: [] };
};

const withFaqEntry = (current: unknown, entry: FaqEntry): FaqPanelData => {
  const data = faqPanelDataFrom(current);
  const exists = data.entries.some((candidate) => candidate.id === entry.id);
  const entries = exists
    ? data.entries.map((candidate) => candidate.id === entry.id ? entry : candidate)
    : [...data.entries, entry];
  return { ...data, entries: entries.sort((left, right) => left.order - right.order) };
};

const withFaqEntries = (current: unknown, entries: FaqEntry[], orderRevision: number): FaqPanelData => ({
  ...faqPanelDataFrom(current),
  entries,
  orderRevision,
});

const withoutFaqEntry = (current: unknown, entryId: string): FaqPanelData => {
  const data = faqPanelDataFrom(current);
  return { ...data, entries: data.entries.filter((entry) => entry.id !== entryId) };
};

const moveEntry = (entries: readonly FaqEntry[], from: number, to: number): FaqEntry[] => {
  if (from < 0 || to < 0 || from >= entries.length || to >= entries.length || from === to) return [...entries];
  const next = [...entries];
  const [entry] = next.splice(from, 1);
  if (entry !== undefined) next.splice(to, 0, entry);
  return next;
};

const entryPatterns = (draft: FaqDraft): string[] => draft.patterns
  .split("\n")
  .map((pattern) => pattern.trim())
  .filter((pattern) => pattern.length > 0);

export default function FaqPanel(properties: ModulePanelProperties): ReactElement {
  return <FaqPanelContent key={properties.channelId} {...properties} />;
}

function FaqPanelContent({ channelId, language, canManage = true, initialSelection, onOpenTestArea }: ModulePanelProperties): ReactElement {
  const labels = faqTexts(language);
  const characterCount = (count: number, maximum: number): string => formatCharacterCount(count, maximum, language ?? "de");
  const channelSettings = useChannelSettings(channelId);
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery(channelId, "faq", "panel", (signal) => loadFaqPanel(channelId, signal));
  const data = query.data;
  const orderedEntries = useMemo(() => data?.entries ?? [], [data?.entries]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [baseline, setBaseline] = useState<FaqDraft>(emptyDraft);
  const [draft, setDraft] = useState<FaqDraft>(emptyDraft);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [pendingPatterns, setPendingPatterns] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [saving, setSaving] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [matcherServerError, setMatcherServerError] = useState<string | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  if (data !== undefined && selectedId === null) {
    const firstEntry = data.entries.find((entry) => entry.id === initialSelection) ?? data.entries[0];
    const next = firstEntry === undefined ? emptyDraft() : draftFromEntry(firstEntry);
    if (initialSelection !== undefined && firstEntry !== undefined) setMobileDetailOpen(true);
    setSelectedId(firstEntry?.id ?? NEW_ENTRY_ID);
    setDraft(next);
    setBaseline(next);
    setDraftRevision(firstEntry?.revision ?? null);
  }

  const isNew = selectedId === NEW_ENTRY_ID;
  const selectedEntry = orderedEntries.find((entry) => entry.id === selectedId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || pendingPatterns.length > 0;
  const input = inputFromDraft(draft);
  const matcherValidation = faqMatcherValidationError(matcherFromDraft(draft));
  const matcherLocalError = matcherValidation === null || (!attemptedSave && draft.patterns.trim().length === 0)
    ? undefined
    : faqMatcherValidationReasonText(matcherValidation.reasonCode, labels) ?? matcherValidation.reason;
  const matcherError = matcherServerError ?? matcherLocalError;
  const answerPreview = useMemo(() => renderTemplate(
    draft.answerText,
    Object.fromEntries((data?.variables ?? []).map(({ name, sample }) => [name, sample])),
  ), [data?.variables, draft.answerText]);
  const searchGames = useCallback((value: string) => searchFaqGames(channelId, value), [channelId]);
  const lookupGames = useCallback((ids: readonly string[]) => lookupFaqGames(channelId, ids), [channelId]);

  const loadSelection = (id: string): void => {
    if (id === NEW_ENTRY_ID) {
      const next = emptyDraft();
      setSelectedId(NEW_ENTRY_ID);
      setDraft(next);
      setBaseline(next);
      setDraftRevision(null);
    } else {
      const entry = data?.entries.find((candidate) => candidate.id === id);
      if (entry === undefined) return;
      const next = draftFromEntry(entry);
      setSelectedId(entry.id);
      setDraft(next);
      setBaseline(next);
      setDraftRevision(entry.revision);
    }
    setPendingPatterns("");
    setAttemptedSave(false);
    setSaveError(undefined);
    setMatcherServerError(undefined);
    setDeleteError(undefined);
  };

  const patchDraft = (change: Partial<FaqDraft>): void => {
    setDraft((current) => ({ ...current, ...change }));
    if ("matcherType" in change) setPendingPatterns("");
    if ("matcherType" in change || "patterns" in change) setMatcherServerError(undefined);
    setSaveError(undefined);
  };

  const resetDraft = (): void => {
    setDraft(baseline);
    setPendingPatterns("");
    setSaveError(undefined);
    setMatcherServerError(undefined);
    setAttemptedSave(false);
  };

  const saveDraft = async (): Promise<string | null> => {
    setAttemptedSave(true);
    setSaveError(undefined);
    if (!canManage) {
      setSaveError(labels.roleLocked);
      return labels.roleLocked;
    }
    // Rejected or uncommitted chip text is part of the draft: never save around it.
    if (pendingPatterns.trim().length > 0) {
      setSaveError(labels.invalid);
      return labels.invalid;
    }
    if (input === null || matcherValidation !== null) {
      const message = matcherLocalError ?? labels.saveError;
      setSaveError(message);
      return message;
    }
    setSaving(true);
    setMatcherServerError(undefined);
    try {
      const saved = await runModuleQueryWrite(queryClient, channelId, "faq", "panel", (revision) =>
        isNew
          ? createFaqEntry(channelId, input)
          : updateFaqEntry(channelId, selectedId ?? "", input, revision ?? draftRevision ?? 1), {
        baselineRevision: isNew ? null : draftRevision,
        updateCache: (current, entry) => withFaqEntry(current, entry),
      });
      const next = draftFromEntry(saved);
      setSelectedId(saved.id);
      setDraft(next);
      setBaseline(next);
      setDraftRevision(saved.revision);
      setPendingPatterns("");
      setSaveError(undefined);
      setMatcherServerError(undefined);
      setAttemptedSave(false);
      return null;
    } catch (failure: unknown) {
      const code = faqErrorCode(failure);
      const fieldErrors = mapServerFieldErrors(failure, {
        "matcher.pattern": "patterns",
        "matcher.patterns": "patterns",
      }, (reasonCode) => faqMatcherValidationReasonText(reasonCode, labels));
      const patternError = fieldErrors.patterns;
      if (patternError !== undefined) {
        setMatcherServerError(patternError);
        setSaveError(undefined);
        return patternError;
      }
      const message = code === "faq_cooldown_too_short" ? labels.cooldownMinError
        : code === "faq_text_input_dependent" ? labels.inputDependentText
          : code === "faq_text_block_missing" ? labels.missingTextBlock
            : code === "faq_entry_limit_reached" ? labels.entryLimit : labels.saveError;
      setSaveError(message);
      return message;
    } finally {
      setSaving(false);
    }
  };

  const draftGuard = useDraftGuard(dirty, saveDraft, resetDraft);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);

  const requestSwitch = (id: string): void => {
    if (id === selectedId) {
      setMobileDetailOpen(true);
      return;
    }
    draftGuard.guardSwitch(() => {
      loadSelection(id);
      setMobileDetailOpen(true);
    });
  };

  async function persistOrder(
    snapshot: readonly FaqEntry[],
    targetIds: readonly string[],
    undoIds: readonly string[],
    revision: number,
    offerUndo: boolean,
  ): Promise<void> {
    if (ordering || !canManage) return;
    const byId = new Map(snapshot.map((entry) => [entry.id, entry]));
    const nextOrder = targetIds.map((id) => byId.get(id)).filter((entry): entry is FaqEntry => entry !== undefined);
    if (nextOrder.length !== snapshot.length || nextOrder.every((entry, index) => snapshot[index]?.id === entry.id)) return;
    setOrdering(true);
    try {
      const savedOrder = await runModuleQueryWrite(queryClient, channelId, "faq", "panel", () =>
        reorderFaqEntries(channelId, nextOrder.map(({ id }) => id), revision), {
        baselineRevision: null,
        updateCache: (current, result) => withFaqEntries(current, result.entries, result.orderRevision),
      });
      if (offerUndo) {
        notify({
          tone: "success",
          message: labels.prioritySaved,
          action: { label: labels.undo, onClick: () => { void persistOrder(savedOrder.entries, undoIds, targetIds, savedOrder.orderRevision, false); } },
        });
      }
    } catch {
      await refetchModuleQueryData<FaqPanelData>(queryClient, channelId, "faq", "panel").catch(() => undefined);
      notify({ tone: "error", message: labels.orderError });
    } finally {
      setOrdering(false);
    }
  }

  const movePriority = (entryId: string, delta: -1 | 1): void => {
    if (ordering || !canManage) return;
    const index = orderedEntries.findIndex((entry) => entry.id === entryId);
    const next = moveEntry(orderedEntries, index, index + delta);
    if (next.every((entry, position) => orderedEntries[position]?.id === entry.id)) return;
    void persistOrder(orderedEntries, next.map((entry) => entry.id), orderedEntries.map((entry) => entry.id), data?.orderRevision ?? 1, true);
  };

  const reorderOnDrop = (event: DragEvent<HTMLDivElement>, targetId: string): void => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain");
    const sourceIndex = orderedEntries.findIndex((entry) => entry.id === sourceId);
    const targetIndex = orderedEntries.findIndex((entry) => entry.id === targetId);
    const next = moveEntry(orderedEntries, sourceIndex, targetIndex);
    if (next.every((entry, index) => orderedEntries[index]?.id === entry.id)) return;
    void persistOrder(orderedEntries, next.map((entry) => entry.id), orderedEntries.map((entry) => entry.id), data?.orderRevision ?? 1, true);
  };

  const remove = async (): Promise<void> => {
    if (selectedEntry === undefined || !canManage) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await runModuleQueryWrite(queryClient, channelId, "faq", "panel", (revision) =>
        deleteFaqEntry(channelId, selectedEntry.id, revision ?? selectedEntry.revision), {
        baselineRevision: selectedEntry.revision,
        updateCache: (current) => withoutFaqEntry(current, selectedEntry.id),
      });
      setDeleteOpen(false);
      const nextEntry = orderedEntries.find((entry) => entry.id !== selectedEntry.id);
      if (nextEntry === undefined) loadSelection(NEW_ENTRY_ID);
      else loadSelection(nextEntry.id);
    } catch {
      setDeleteError(labels.deleteError);
    } finally {
      setDeleting(false);
    }
  };

  const openDelete = (): void => {
    draftGuard.guardSwitch(() => { setDeleteError(undefined); setDeleteOpen(true); });
  };

  const visibleEntries = orderedEntries.filter((entry) => {
    const matchesFilter = filter === "all" || (filter === "active" ? entry.enabled : !entry.enabled);
    const needle = search.trim().toLocaleLowerCase(language === "en" ? "en" : "de");
    const patterns = entry.matcher.type === "keywords" ? entry.matcher.patterns.join(" ") : entry.matcher.pattern;
    return matchesFilter && `${entry.name} ${patterns}`.toLocaleLowerCase(language === "en" ? "en" : "de").includes(needle);
  });
  const selectedIndex = orderedEntries.findIndex((entry) => entry.id === selectedId);
  const listStatus = query.isPending ? "loading" : data === undefined ? "error" : orderedEntries.length === 0 ? "empty" : "success";
  const testAreaDisabled = dirty || selectedEntry === undefined || saving || onOpenTestArea === undefined;
  const saveProps = {
    dirty,
    persistent: true,
    pending: saving,
    ...(saveError === undefined ? {} : { error: saveError }),
    invalid: input === null || matcherValidation !== null || pendingPatterns.trim().length > 0,
    invalidMessage: labels.invalid,
    onSave: () => { void saveDraft(); },
    onInvalidSave: () => { setAttemptedSave(true); },
    onDiscard: resetDraft,
    saveLabel: labels.save,
    discardLabel: labels.discard,
    savedLabel: labels.saved,
    pendingLabel: labels.saving,
  };

  const detail = selectedId === null
    ? <div className="faq-panel__placeholder"><PageHeader title={labels.title} subtitle={labels.noSelection} /></div>
    : <div className="faq-panel__detail">
      <PageHeader
        title={draft.name.trim() || labels.newEntry}
        active={draft.enabled}
        onToggle={(enabled) => { patchDraft({ enabled }); }}
        switchDisabled={!canManage || saving || ordering}
        switchBusy={saving}
        {...(selectedEntry === undefined ? {} : { meta: labels.priorityMeta(selectedIndex + 1) })}
        badges={<Badge>{draft.matcherType === "regex" ? labels.regexCompact : labels.keywordsCompact}</Badge>}
        {...(canManage ? {} : { lockHint: labels.roleLocked })}
        pageActions={<div className="faq-panel__test-area-action">
          <Button
            variant="neutral"
            disabled={testAreaDisabled}
            onClick={() => { if (selectedEntry !== undefined) onOpenTestArea?.("faq", selectedEntry.id); }}
          >{labels.testAreaAction}</Button>
          {testAreaDisabled ? <span>{dirty ? labels.testAreaDirty : labels.testAreaSavedOnly}</span> : null}
        </div>}
        {...(selectedEntry === undefined ? {} : {
          overflow: <Button className="faq-panel__delete-action" variant="subtle" danger="subtle" size="compact" disabled={!canManage || deleting} onClick={openDelete}>
            <Icon name="remove" size={16} />{labels.delete}
          </Button>,
        })}
        save={saveProps}
      />
      <div className="faq-panel__editor">
        {canManage ? null : <RuleNote>{labels.roleLocked}</RuleNote>}
        <div className="faq-panel__editor-grid">
          <div className="faq-panel__column">
            <Section title={labels.triggerSection}>
              <Field
                label={labels.entryNameLabel}
                hint={labels.entryNameHint}
                className="faq-panel__entry-name"
                value={draft.name}
                onChange={(name) => { patchDraft({ name }); }}
                maxLength={FAQ_ENTRY_NAME_MAX_LENGTH}
                countLabel={characterCount}
                disabled={!canManage || saving}
                required
              />
              <SegmentChoice
                label={labels.matcherType}
                value={draft.matcherType}
                onChange={(matcherType) => { patchDraft({ matcherType, patterns: "" }); }}
                options={[
                  { value: "keywords", label: labels.keywordsType, compactLabel: labels.keywordsCompact },
                  { value: "regex", label: labels.regexType, compactLabel: labels.regexCompact },
                ]}
                disabled={!canManage || saving}
              />
              {draft.matcherType === "keywords" ? <ChipsInput
                key={`${selectedId}-patterns`}
                label={labels.patterns}
                values={entryPatterns(draft)}
                onChange={(patterns) => { patchDraft({ patterns: patterns.join("\n") }); }}
                pending={pendingPatterns}
                onPendingChange={setPendingPatterns}
                placeholder={labels.patternsPlaceholder}
                hint={labels.patternsHint}
                {...(matcherError === undefined ? {} : { error: matcherError })}
                validate={(pattern) => pattern.length > FAQ_PATTERN_MAX_LENGTH ? labels.matcherValidationReasons.faq_keywords_invalid : null}
                removeLabel={labels.removePattern}
                listLabel={labels.patterns}
                max={FAQ_PATTERN_MAXIMUM_COUNT}
                separator="comma"
                messages={labels.keywordChipMessages}
                disabled={!canManage || saving}
              /> : <Field
                label={labels.regexPattern}
                hint={labels.regexPatternHint}
                value={draft.patterns}
                onChange={(patterns) => { patchDraft({ patterns }); }}
                maxLength={FAQ_PATTERN_MAX_LENGTH}
                countLabel={characterCount}
                {...(matcherError === undefined ? {} : { error: matcherError })}
                mono
                disabled={!canManage || saving}
                required
              />}
            </Section>
            <Section title={labels.rolesSectionTitle}>
              <RoleThreshold
                label={labels.minimumTier}
                value={draft.minimumTier}
                options={labels.tierOptions}
                onChange={(minimumTier) => {
                  const nextTier = FAQ_MINIMUM_TIERS.find((tier) => tier === minimumTier);
                  if (nextTier !== undefined) patchDraft({ minimumTier: nextTier });
                }}
                disabled={!canManage || saving}
              />
              <RuleNote>{labels.rolesHint}</RuleNote>
            </Section>
          </div>
          <div className="faq-panel__column">
            <Section title={labels.answerSection}>
              <div className="faq-panel__answer-preview">
                <TemplateTextField
                  label={labels.answer}
                  hint={labels.answerHint}
                  value={draft.answerText}
                  onChange={(answerText) => { patchDraft({ answerText }); }}
                  maxLength={FAQ_ANSWER_MAX_LENGTH}
                  variables={data?.variables ?? []}
                  preview={() => answerPreview}
                  previewLabel={labels.previewLabel}
                  previewSpeaker={labels.previewSpeaker}
                  messages={labels.templateMessages}
                  minRows={4}
                  disabled={!canManage || saving}
                  required
                />
              </div>
              <FieldPair>
                <UnitInput
                  label={labels.cooldown}
                  hint={labels.cooldownHint}
                  value={draft.cooldownSeconds}
                  onChange={(cooldownSeconds) => { patchDraft({ cooldownSeconds }); }}
                  min={FAQ_COOLDOWN_MINIMUM_SECONDS}
                  max={FAQ_COOLDOWN_MAXIMUM_SECONDS}
                  suggestions={[30, 120, 300, 900]}
                  unit="s"
                  disabled={!canManage || saving}
                  required
                />
                <UnitInput
                  label={labels.userCooldown}
                  hint={labels.userCooldownHint}
                  value={draft.userCooldownSeconds}
                  onChange={(userCooldownSeconds) => { patchDraft({ userCooldownSeconds }); }}
                  min={0}
                  max={FAQ_USER_COOLDOWN_MAXIMUM_SECONDS}
                  suggestions={[0, 60, 300, 900]}
                  unit="s"
                  disabled={!canManage || saving}
                />
              </FieldPair>
              <ChatTargetField
                label={labels.chatTarget}
                language={language ?? "de"}
                value={draft.chatTarget}
                {...(channelSettings.data?.defaultChatTarget === undefined ? {} : { effectiveDefault: channelSettings.data.defaultChatTarget })}
                onChange={(chatTarget) => { patchDraft({ chatTarget }); }}
                allowed={["all_chats", "source_only", "channel_default", "where_asked"]}
                disabled={!canManage || saving}
              />
            </Section>
          </div>
        </div>
        <SwitchSection
          title={labels.games}
          checked={draft.restrictGames}
          hint={labels.gameFilterHint}
          onChange={(restrictGames) => { patchDraft({ restrictGames, ...(restrictGames ? {} : { games: [] }) }); }}
          disabled={!canManage || saving}
        >
          <GameMultiSelect
            searchGames={searchGames}
            lookupGames={lookupGames}
            value={draft.games}
            onChange={(games: FaqGame[]) => { patchDraft({ games }); }}
            messages={labels.gameMultiSelectMessages}
            visuallyHiddenLabel
            disabled={!canManage || saving}
          />
        </SwitchSection>
      </div>
      <ConfirmDialog
        opened={deleteOpen}
        title={labels.deleteTitle(selectedEntry?.name ?? labels.newEntry)}
        description={labels.deleteConfirm(selectedEntry?.name ?? labels.newEntry)}
        confirmLabel={labels.delete}
        cancelLabel={labels.cancel}
        danger
        pending={deleting}
        {...(deleteError === undefined ? {} : { error: deleteError })}
        onConfirm={() => { void remove(); }}
        onCancel={() => { if (!deleting) setDeleteOpen(false); }}
      />
      <ConfirmDialog
        opened={draftGuard.confirmOpen}
        title={labels.guardTitle}
        description={labels.guardDescription}
        confirmLabel={labels.save}
        cancelLabel={labels.continueEditing}
        alternative={{ label: labels.discard, onClick: draftGuard.discardAndSwitch }}
        pending={draftGuard.saving}
        {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
        onConfirm={() => { void draftGuard.saveAndSwitch(); }}
        onCancel={draftGuard.continueEditing}
      />
    </div>;

  const toolbar = <div className="faq-panel__toolbar">
    <div className="faq-panel__toolbar-top">
      <Field
        label={labels.search}
        variant="search"
        placeholder={labels.searchPlaceholder}
        clearLabel={labels.clearSearch}
        value={search}
        onChange={setSearch}
      />
      <Button variant="primary" disabled={!canManage} onClick={() => { requestSwitch(NEW_ENTRY_ID); }}>
        <Icon name="plus" size={16} />{labels.add}
      </Button>
    </div>
    <div className="faq-panel__filter-row">
      <SegmentChoice
        label={labels.filterLabel}
        size="compact"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: labels.filterAll },
          { value: "active", label: labels.filterActive },
          { value: "paused", label: labels.filterPaused },
        ]}
      />
      <span className="faq-panel__entry-count">{labels.entryCount(visibleEntries.length)}</span>
    </div>
    <RuleNote>{labels.priorityNote}</RuleNote>
  </div>;

  const list = <LoadState
    variant="panel-720"
    status={listStatus}
    loading={<LoadStateLines rows={5} height={50} />}
    empty={<p className="faq-panel__empty">{labels.noEntries}</p>}
    error={<p className="faq-panel__empty">{labels.loadError}</p>}
    queryError={{ message: labels.loadError, onRetry: () => { void query.refetch(); } }}
    refreshError={query.isRefetchError}
  >
    <div className="faq-panel__list">
      {isNew ? <div className="faq-panel__row faq-panel__row--new">
        <span className="faq-panel__rank">{labels.newEntry}</span>
        <button type="button" aria-current="true" className="faq-panel__entry faq-panel__entry--selected" onClick={() => { requestSwitch(NEW_ENTRY_ID); }}>
          <span className="faq-panel__entry-indicator" aria-hidden="true" />
          <span className="faq-panel__entry-copy"><strong>{draft.name.trim() || labels.newEntry}</strong><small>{labels.unsavedNew}</small></span>
        </button>
      </div> : null}
      {visibleEntries.map((entry) => {
        const index = orderedEntries.findIndex((candidate) => candidate.id === entry.id);
        const patternSummary = entry.matcher.type === "keywords"
          ? entry.matcher.patterns.slice(0, 2).join(" · ") + (entry.matcher.patterns.length > 2 ? ` +${String(entry.matcher.patterns.length - 2)}` : "")
          : `${labels.regexType}: ${entry.matcher.pattern}`;
        const onShortcut = (event: KeyboardEvent<HTMLButtonElement>): void => {
          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          event.preventDefault();
          movePriority(entry.id, event.key === "ArrowUp" ? -1 : 1);
        };
        return <div
          className="faq-panel__row"
          key={entry.id}
          onDragOver={(event) => { event.preventDefault(); }}
          onDrop={(event) => { reorderOnDrop(event, entry.id); }}
        >
          <button
            type="button"
            className="faq-panel__drag"
            aria-label={`${labels.keyboardMove}: ${entry.name}`}
            draggable={canManage && !ordering}
            disabled={!canManage || ordering}
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", entry.id);
              event.dataTransfer.effectAllowed = "move";
            }}
          ><Icon name="drag" size={16} /></button>
          <span className="faq-panel__rank">{String(index + 1)}</span>
          <button
            type="button"
            className={`faq-panel__entry${selectedId === entry.id ? " faq-panel__entry--selected" : ""}${entry.enabled ? "" : " faq-panel__entry--paused"}`}
            aria-current={selectedId === entry.id ? "true" : undefined}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onClick={() => { requestSwitch(entry.id); }}
            onKeyDown={onShortcut}
          >
            <span className={`faq-panel__entry-indicator${entry.enabled ? " faq-panel__entry-indicator--on" : ""}`} aria-hidden="true" />
            <span className="faq-panel__entry-copy">
              <strong>{entry.name}{entry.enabled ? null : <em>{labels.filterPaused}</em>}</strong>
              <small>{patternSummary}</small>
            </span>
          </button>
        </div>;
      })}
      {visibleEntries.length === 0 && orderedEntries.length > 0 ? <p className="faq-panel__empty">{labels.emptySearch}</p> : null}
    </div>
  </LoadState>;

  return <div className="faq-panel">
    <CollectionPage
      title={labels.title}
      toolbar={toolbar}
      list={list}
      detail={detail}
      empty={labels.noEntries}
      detailOpen={mobileDetailOpen}
      backLabel={labels.back}
      onCloseDetail={() => { draftGuard.guardSwitch(() => { setMobileDetailOpen(false); }); }}
    />
  </div>;
}

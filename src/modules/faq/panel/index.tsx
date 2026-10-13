import { useCallback, useState, type ReactElement } from "react";

import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, ChatOutputTargetControl, ConfirmDialog, Field, FormDialog, GamePicker, InspectorSection, LoadState, LoadStateLines, UnitInput, Select, TemplateTextField, mapServerFieldErrors, notify } from "../../../dashboard/ui";
import { Switch as SwitchPrimitive } from "../../../dashboard/ui/primitives/switch";
import type { ModulePanelProperties } from "../../contract";
import type { FaqEntry, FaqGame } from "../contracts";
import { FAQ_ANSWER_MAX_LENGTH, FAQ_COOLDOWN_MAXIMUM_SECONDS, FAQ_COOLDOWN_MINIMUM_SECONDS, FAQ_ENTRY_NAME_MAX_LENGTH, FAQ_PATTERN_MAXIMUM_COUNT, FAQ_PATTERN_MAX_LENGTH, FAQ_USER_COOLDOWN_MAXIMUM_SECONDS } from "../contracts";
import { inputFromDraft, type FaqDraft } from "./draft";
import { faqMatcherValidationReasonText, faqTexts } from "./locale";
import {
  createFaqEntry,
  deleteFaqEntry,
  faqErrorCode,
  loadFaqPanel,
  lookupFaqGames,
  moveFaqEntry,
  searchFaqGames,
  setFaqEntryEnabled,
  testFaqMessage,
  updateFaqEntry,
  type FaqTestResult,
  type FaqPanelData,
} from "./service";

const emptyDraft = (): FaqDraft => ({ name: "", matcherType: "keywords", patterns: "", answerText: "", cooldownSeconds: FAQ_COOLDOWN_MINIMUM_SECONDS, userCooldownSeconds: 0, games: [], chatTarget: null });

const draftFromEntry = (entry: FaqEntry): FaqDraft => ({
  name: entry.name,
  matcherType: entry.matcher.type,
  patterns: entry.matcher.type === "keywords" ? entry.matcher.patterns.join("\n") : entry.matcher.pattern,
  answerText: entry.answerText,
  cooldownSeconds: entry.cooldownSeconds,
  userCooldownSeconds: entry.userCooldownSeconds,
  games: [...entry.games],
  chatTarget: entry.chatTarget,
});

const faqPanelDataFrom = (value: unknown): FaqPanelData => {
  if (typeof value === "object" && value !== null && "entries" in value && "variables" in value &&
      Array.isArray(value.entries) && Array.isArray(value.variables)) {
    return value as FaqPanelData;
  }
  return { entries: [], variables: [] };
};

const withFaqEntry = (current: unknown, entry: FaqEntry): FaqPanelData => {
  const data = faqPanelDataFrom(current);
  const found = data.entries.some((candidate) => candidate.id === entry.id);
  const entries = found
    ? data.entries.map((candidate) => candidate.id === entry.id ? entry : candidate)
    : [...data.entries, entry];
  return { ...data, entries: entries.sort((left, right) => left.order - right.order) };
};

const withFaqEntries = (current: unknown, entries: FaqEntry[]): FaqPanelData => ({
  ...faqPanelDataFrom(current),
  entries,
});

const withoutFaqEntry = (current: unknown, entryId: string): FaqPanelData => {
  const data = faqPanelDataFrom(current);
  return { ...data, entries: data.entries.filter((entry) => entry.id !== entryId) };
};

const requireBaselineRevision = (revision: number | null): number => {
  if (revision === null) throw new Error("An existing FAQ entry requires its opening revision.");
  return revision;
};

const matchCopy = (result: FaqTestResult, labels: ReturnType<typeof faqTexts>): string => {
  if (result.reason === "command_prefix") return labels.testCommand;
  if (!result.matches || result.entry === undefined || result.matchedPattern === undefined) return labels.testNoMatch;
  return labels.testMatch(result.entry.name, result.matchedPattern);
};

export default function FaqPanel(properties: ModulePanelProperties): ReactElement {
  return <FaqPanelContent key={properties.channelId} {...properties} />;
}

function FaqPanelContent({ channelId, language, canManage = true }: ModulePanelProperties): ReactElement {
  const labels = faqTexts(language);
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery(channelId, "faq", "panel", (signal) => loadFaqPanel(channelId, signal));
  const data = query.data;
  const loading = query.isPending;
  const [error, setError] = useState<string | null>(null);
  const [matcherError, setMatcherError] = useState<string | null>(null);
  const [draft, setDraft] = useState<FaqDraft | null>(null);
  const [editing, setEditing] = useState<FaqEntry | null>(null);
  const [pending, setPending] = useState(false);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FaqEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState("");
  const [testGame, setTestGame] = useState<FaqGame | null>(null);
  const [testResult, setTestResult] = useState<FaqTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const searchGames = useCallback((query: string) => searchFaqGames(channelId, query), [channelId]);
  const lookupGames = useCallback((ids: readonly string[]) => lookupFaqGames(channelId, ids), [channelId]);

  const openCreate = (): void => { setEditing(null); setDraft(emptyDraft()); setError(null); setMatcherError(null); };
  const openEdit = (entry: FaqEntry): void => { setEditing(entry); setDraft(draftFromEntry(entry)); setError(null); setMatcherError(null); };
  const closeDialog = (): void => { if (!pending) { setDraft(null); setEditing(null); setError(null); setMatcherError(null); } };
  const patchDraft = (change: Partial<FaqDraft>): void => {
    if ("matcherType" in change || "patterns" in change) setMatcherError(null);
    setDraft((current) => current === null ? null : { ...current, ...change });
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    if (typeof draft.cooldownSeconds === "number" && draft.cooldownSeconds < FAQ_COOLDOWN_MINIMUM_SECONDS) {
      setError(labels.cooldownMinError);
      return;
    }
    const input = inputFromDraft(draft);
    if (input === null) { setError(labels.saveError); return; }
    setPending(true);
    setError(null);
    setMatcherError(null);
    try {
      await runModuleQueryWrite(queryClient, channelId, "faq", "panel", (revision) =>
        editing === null ? createFaqEntry(channelId, input) : updateFaqEntry(channelId, editing.id, input, requireBaselineRevision(revision)), {
        baselineRevision: editing?.revision ?? null,
        updateCache: (current, entry) => withFaqEntry(current, entry),
      });
      setDraft(null);
      setEditing(null);
    } catch (failure: unknown) {
      const code = faqErrorCode(failure);
      const fieldErrors = mapServerFieldErrors(failure, {
        "matcher.pattern": "patterns",
        "matcher.patterns": "patterns",
      }, (reasonCode) => faqMatcherValidationReasonText(reasonCode, labels));
      const matcherReason = fieldErrors.patterns;
      if (matcherReason !== undefined) {
        setMatcherError(matcherReason);
        setError(null);
      } else setError(code === "faq_cooldown_too_short" ? labels.cooldownMinError
        : code === "faq_text_input_dependent" ? labels.inputDependentText
        : code === "faq_text_block_missing" ? labels.missingTextBlock
          : code === "faq_entry_limit_reached" ? labels.entryLimit : labels.saveError);
    } finally { setPending(false); }
  };

  const toggle = async (entry: FaqEntry, enabled: boolean): Promise<void> => {
    if (busyEntryId !== null) return;
    setBusyEntryId(entry.id);
    try {
      await runModuleQueryWrite(queryClient, channelId, "faq", "panel", (revision) =>
        setFaqEntryEnabled(channelId, entry.id, enabled, requireBaselineRevision(revision)), {
        baselineRevision: entry.revision,
        updateCache: (current, updated) => withFaqEntry(current, updated),
      });
    }
    catch { notify({ tone: "error", message: labels.saveError }); }
    finally { setBusyEntryId(null); }
  };

  const move = async (entry: FaqEntry, direction: "up" | "down"): Promise<void> => {
    if (busyEntryId !== null) return;
    setBusyEntryId(entry.id);
    try {
      await runModuleQueryWrite(queryClient, channelId, "faq", "panel", (revision) =>
        moveFaqEntry(channelId, entry.id, direction, requireBaselineRevision(revision)), {
        baselineRevision: entry.revision,
        updateCache: (current, entries) => withFaqEntries(current, entries),
      });
    }
    catch { notify({ tone: "error", message: labels.saveError }); }
    finally { setBusyEntryId(null); }
  };

  const remove = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setPending(true);
    setDeleteError(null);
    try {
      const entryId = deleteTarget.id;
      await runModuleQueryWrite(queryClient, channelId, "faq", "panel", (revision) =>
        deleteFaqEntry(channelId, entryId, requireBaselineRevision(revision)), {
        baselineRevision: deleteTarget.revision,
        updateCache: (current) => withoutFaqEntry(current, entryId),
      });
      setDeleteTarget(null);
    }
    catch { setDeleteError(labels.deleteError); }
    finally { setPending(false); }
  };

  const runTest = async (): Promise<void> => {
    if (testMessage.trim().length === 0) { setTestError(labels.testEmpty); setTestResult(null); return; }
    setTestBusy(true);
    setTestError(null);
    try { setTestResult(await testFaqMessage(channelId, testMessage, testGame === null ? undefined : testGame.id)); }
    catch { setTestError(labels.loadError); }
    finally { setTestBusy(false); }
  };

  const orderedEntries = data?.entries ?? [];
  const listStatus = query.isPending ? "loading" : data === undefined ? "error" : orderedEntries.length === 0 ? "empty" : "success";

  return (
    <section aria-label={labels.title}>
      <InspectorSection title={labels.title}>
        <Button variant="primary" disabled={!canManage} onClick={openCreate}>{labels.add}</Button>
        {canManage ? null : <p className="lock-reason">{labels.roleLocked}</p>}
        <LoadState variant="panel-720" status={listStatus}
          loading={<LoadStateLines rows={7} height={34} />}
          empty={<p className="muted">{labels.noEntries}</p>}
          error={<p className="muted">{labels.loadError}</p>}
          queryError={{ message: labels.loadError, onRetry: () => { void query.refetch(); } }}
          refreshError={query.isRefetchError}
        >
        <div className="state-list" style={{ height: "calc(var(--s10) * 18)", overflowY: "auto" }}>
          {orderedEntries.map((entry, index) => (
            <article key={entry.id} className="timer-row">
              <div className="timer-row__copy">
                <strong>{entry.name}</strong>
                <span>{entry.matcher.type === "keywords" ? entry.matcher.patterns.join(" · ") : `${labels.regexType}: ${entry.matcher.pattern}`}</span>
                <span>{labels.answer} · {entry.answerText}</span>
                <span>{labels.cooldown} · {String(entry.cooldownSeconds)} s</span>
                {entry.userCooldownSeconds === 0 ? null : <span>{labels.userCooldown} · {String(entry.userCooldownSeconds)} s</span>}
                {entry.games.length === 0 ? null : <span>{labels.games} · {entry.games.map((game) => game.name).join(", ")}</span>}
              </div>
              <div className="timer-row__actions">
                <SwitchPrimitive
                  aria-label={`${entry.name}: ${entry.enabled ? labels.enabled : labels.disabled}`}
                  checked={entry.enabled}
                  aria-busy={busyEntryId === entry.id}
                  disabled={busyEntryId !== null && busyEntryId !== entry.id || busyEntryId === entry.id}
                  onCheckedChange={(enabled) => { void toggle(entry, enabled); }}
                />
                <Button variant="subtle" ariaLabel={labels.moveUp} disabled={!canManage || index === 0 || busyEntryId !== null} onClick={() => { void move(entry, "up"); }}>↑</Button>
                <Button variant="subtle" ariaLabel={labels.moveDown} disabled={!canManage || index === orderedEntries.length - 1 || busyEntryId !== null} onClick={() => { void move(entry, "down"); }}>↓</Button>
                <Button variant="neutral" disabled={!canManage} onClick={() => { openEdit(entry); }}>{labels.edit}</Button>
                <Button variant="subtle" danger disabled={!canManage} onClick={() => { setDeleteTarget(entry); setDeleteError(null); }}>{labels.delete}</Button>
              </div>
            </article>
          ))}
        </div>
        </LoadState>
      </InspectorSection>

      <InspectorSection title={labels.testHeading}>
        <div className="module-stack">
          <Field label={labels.testMessage} value={testMessage} onChange={setTestMessage} maxLength={500} countLabel={(count, max) => `${String(count)}/${String(max)}`} />
          <GamePicker
            searchGames={searchGames}
            lookupGames={lookupGames}
            value={testGame === null ? [] : [testGame]}
            onChange={(games) => setTestGame(games.at(-1) ?? null)}
            messages={labels.testGamePickerMessages}
          />
          <Button variant="neutral" disabled={testBusy || loading} onClick={() => { void runTest(); }}>{labels.testButton}</Button>
          <div data-testid="faq-test-result-slot" style={{ height: "calc(var(--s10) * 5)", overflowY: "auto" }} aria-live="polite">
            {testError === null ? null : <p className="form-error" role="alert">{testError}</p>}
            {testResult === null ? null : <p role="status">{matchCopy(testResult, labels)}</p>}
            {testResult === null || testResult.skippedByGame.length === 0 ? null : (
              <ul>
                {testResult.skippedByGame.map((skipped) => (
                  <li key={skipped.entryId}>{labels.testSkippedByGame(skipped.entryName, skipped.games.join(", "))}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </InspectorSection>

      <FormDialog
        opened={draft !== null}
        title={editing === null ? labels.create : labels.edit}
        confirmLabel={labels.save}
        cancelLabel={labels.cancel}
        onConfirm={() => { void save(); }}
        onCancel={closeDialog}
        pending={pending}
        confirmDisabled={draft === null || inputFromDraft(draft) === null}
        {...(error === null ? {} : { error })}
      >
        {draft === null ? null : <div className="module-stack">
          <Field label={labels.name} value={draft.name} onChange={(name) => patchDraft({ name })} maxLength={FAQ_ENTRY_NAME_MAX_LENGTH} countLabel={(count, max) => `${String(count)}/${String(max)}`} required />
          <Select
            label={labels.matcherType}
            value={draft.matcherType}
            onChange={(matcherType) => { if (matcherType === "keywords" || matcherType === "regex") patchDraft({ matcherType }); }}
            options={[{ value: "keywords", label: labels.keywordsType }, { value: "regex", label: labels.regexType }]}
            disabled={pending}
          />
          <TemplateTextField
            label={draft.matcherType === "keywords" ? labels.patterns : labels.regexPattern}
            hint={draft.matcherType === "keywords" ? labels.patternsHint : labels.regexPatternHint}
            value={draft.patterns}
            onChange={(patterns) => patchDraft({ patterns })}
            maxLength={draft.matcherType === "keywords" ? FAQ_PATTERN_MAXIMUM_COUNT * (FAQ_PATTERN_MAX_LENGTH + 1) : FAQ_PATTERN_MAX_LENGTH}
            {...(matcherError === null ? {} : { error: matcherError })}
            messages={labels.templateMessages}
            minRows={3}
            disabled={pending}
            required
          />
          <TemplateTextField
            label={labels.answer}
            hint={labels.answerHint}
            value={draft.answerText}
            onChange={(answerText) => patchDraft({ answerText })}
            maxLength={FAQ_ANSWER_MAX_LENGTH}
            variables={data?.variables ?? []}
            messages={labels.templateMessages}
            minRows={2}
            disabled={pending}
            required
          />
          <UnitInput
            label={labels.cooldown}
            hint={labels.cooldownHint}
            value={draft.cooldownSeconds}
            onChange={(cooldownSeconds) => patchDraft({ cooldownSeconds })}
            min={FAQ_COOLDOWN_MINIMUM_SECONDS}
            max={FAQ_COOLDOWN_MAXIMUM_SECONDS}
            unit="s"
            disabled={pending}
            required
          />
          <UnitInput
            label={labels.userCooldown}
            hint={labels.userCooldownHint}
            value={draft.userCooldownSeconds}
            onChange={(userCooldownSeconds) => patchDraft({ userCooldownSeconds })}
            min={0}
            max={FAQ_USER_COOLDOWN_MAXIMUM_SECONDS}
            unit="s"
            disabled={pending}
          />
          <GamePicker
            searchGames={searchGames}
            lookupGames={lookupGames}
            value={draft.games}
            onChange={(games) => patchDraft({ games })}
            disabled={pending}
            messages={labels.gamePickerMessages}
          />
          <ChatOutputTargetControl
            label={labels.chatTarget}
            value={draft.chatTarget}
            onChange={(chatTarget) => patchDraft({ chatTarget })}
            includeWhereAsked
            allowChannelDefault
            disabled={pending}
          />
        </div>}
      </FormDialog>

      <ConfirmDialog
        opened={deleteTarget !== null}
        title={labels.delete}
        description={labels.deleteConfirm}
        confirmLabel={labels.delete}
        cancelLabel={labels.cancel}
        danger
        pending={pending}
        {...(deleteError === null ? {} : { error: deleteError })}
        onConfirm={() => { void remove(); }}
        onCancel={() => { if (!pending) setDeleteTarget(null); }}
      />
    </section>
  );
}

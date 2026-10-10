import { useCallback, useState, type ReactElement } from "react";

import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, ChatOutputTargetControl, ConfirmDialog, Field, FormDialog, GamePicker, InspectorSection, LoadState, NumberField, Select, Skeleton, Switch, TextArea, notify } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { FaqEntry, FaqGame, FaqMutationInput } from "../contracts";
import { FAQ_COOLDOWN_MAXIMUM_SECONDS, FAQ_COOLDOWN_MINIMUM_SECONDS, FAQ_ENTRY_NAME_MAX_LENGTH, FAQ_PATTERN_MAXIMUM_COUNT, FAQ_PATTERN_MAX_LENGTH } from "../contracts";
import { faqTexts } from "./locale";
import {
  createFaqEntry,
  deleteFaqEntry,
  faqErrorCode,
  loadFaqPanel,
  moveFaqEntry,
  searchFaqGames,
  setFaqEntryEnabled,
  testFaqMessage,
  updateFaqEntry,
  type FaqTestResult,
  type FaqPanelData,
} from "./service";

interface FaqDraft {
  name: string;
  patterns: string;
  answerBlock: string;
  cooldownSeconds: number | "";
  games: FaqGame[];
  chatTarget: FaqEntry["chatTarget"];
}

const emptyDraft = (): FaqDraft => ({ name: "", patterns: "", answerBlock: "", cooldownSeconds: FAQ_COOLDOWN_MINIMUM_SECONDS, games: [], chatTarget: "source_only" });

const draftFromEntry = (entry: FaqEntry): FaqDraft => ({
  name: entry.name,
  patterns: entry.matcher.type === "keywords" ? entry.matcher.patterns.join("\n") : "",
  answerBlock: entry.answerBlock,
  cooldownSeconds: entry.cooldownSeconds,
  games: [...entry.games],
  chatTarget: entry.chatTarget,
});

const inputFromDraft = (draft: FaqDraft): FaqMutationInput | null => {
  const patterns = draft.patterns.split("\n").map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  if (draft.name.trim().length === 0 || draft.answerBlock.length === 0 || patterns.length === 0 ||
      patterns.length > FAQ_PATTERN_MAXIMUM_COUNT || patterns.some((pattern) => pattern.length > FAQ_PATTERN_MAX_LENGTH) ||
      typeof draft.cooldownSeconds !== "number" || !Number.isInteger(draft.cooldownSeconds) ||
      draft.cooldownSeconds < FAQ_COOLDOWN_MINIMUM_SECONDS || draft.cooldownSeconds > FAQ_COOLDOWN_MAXIMUM_SECONDS) return null;
  return {
    name: draft.name.trim(),
    matcher: { type: "keywords", patterns },
    answerBlock: draft.answerBlock,
    cooldownSeconds: draft.cooldownSeconds,
    games: draft.games,
    chatTarget: draft.chatTarget,
  };
};

const faqPanelDataFrom = (value: unknown): FaqPanelData => {
  if (typeof value === "object" && value !== null && "entries" in value && "blocks" in value &&
      Array.isArray(value.entries) && Array.isArray(value.blocks)) {
    return value as FaqPanelData;
  }
  return { entries: [], blocks: [] };
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

  const openCreate = (): void => { setEditing(null); setDraft(emptyDraft()); setError(null); };
  const openEdit = (entry: FaqEntry): void => { setEditing(entry); setDraft(draftFromEntry(entry)); setError(null); };
  const closeDialog = (): void => { if (!pending) { setDraft(null); setEditing(null); setError(null); } };
  const patchDraft = (change: Partial<FaqDraft>): void => setDraft((current) => current === null ? null : { ...current, ...change });

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
      setError(code === "faq_cooldown_too_short" ? labels.cooldownMinError
        : code === "faq_block_input_dependent" ? labels.inputDependentBlock
        : code === "faq_block_missing" ? labels.missingBlock
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

  const blockOptions = (data?.blocks ?? []).map((name) => ({ value: name, label: name }));
  const orderedEntries = data?.entries ?? [];
  const listStatus = query.isPending ? "loading" : data === undefined ? "error" : orderedEntries.length === 0 ? "empty" : "success";

  return (
    <section aria-label={labels.title}>
      <InspectorSection title={labels.title}>
        <Button variant="primary" disabled={!canManage} onClick={openCreate}>{labels.add}</Button>
        {canManage ? null : <p className="lock-reason">{labels.roleLocked}</p>}
        <LoadState variant="panel" status={listStatus} minHeight="calc(var(--s10) * 18)"
          loading={<Skeleton rows={7} height={34} />}
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
                <span>{entry.matcher.type === "keywords" ? entry.matcher.patterns.join(" · ") : entry.matcher.pattern}</span>
                <span>{labels.answer} · <code>{entry.answerBlock}</code></span>
                <span>{labels.cooldown} · {String(entry.cooldownSeconds)} s</span>
                {entry.games.length === 0 ? null : <span>{labels.games} · {entry.games.map((game) => game.name).join(", ")}</span>}
              </div>
              <div className="timer-row__actions">
                <Switch
                  ariaLabel={`${entry.name}: ${entry.enabled ? labels.enabled : labels.disabled}`}
                  checked={entry.enabled}
                  disabled={busyEntryId !== null && busyEntryId !== entry.id}
                  pending={busyEntryId === entry.id}
                  onChange={(enabled) => { void toggle(entry, enabled); }}
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
        confirmDisabled={blockOptions.length === 0}
        {...(error === null ? {} : { error })}
      >
        {draft === null ? null : <div className="module-stack">
          <Field label={labels.name} value={draft.name} onChange={(name) => patchDraft({ name })} maxLength={FAQ_ENTRY_NAME_MAX_LENGTH} countLabel={(count, max) => `${String(count)}/${String(max)}`} required />
          <TextArea
            label={labels.patterns}
            hint={labels.patternsHint}
            value={draft.patterns}
            onChange={(patterns) => patchDraft({ patterns })}
            maxLength={FAQ_PATTERN_MAXIMUM_COUNT * (FAQ_PATTERN_MAX_LENGTH + 1)}
            messages={labels.textAreaMessages}
            minRows={3}
            disabled={pending}
            required
          />
          <Select
            label={labels.answer}
            value={draft.answerBlock || null}
            onChange={(answerBlock) => patchDraft({ answerBlock: answerBlock ?? "" })}
            options={blockOptions}
            placeholder={labels.answer}
            disabled={pending}
            required
          />
          {blockOptions.length === 0 ? <p className="muted">{labels.noBlocks}</p> : null}
          <NumberField
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
          <GamePicker
            searchGames={searchGames}
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

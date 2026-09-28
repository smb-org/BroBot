import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Button, ChatOutputTargetControl, ConfirmDialog, Dialog, Field, GamePicker, InspectorSection, NumberField, Select, Switch, TextArea } from "../../../dashboard/ui";
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
  type FaqPanelData,
  type FaqTestResult,
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

const matchCopy = (result: FaqTestResult, labels: ReturnType<typeof faqTexts>): string => {
  if (result.reason === "command_prefix") return labels.testCommand;
  if (!result.matches || result.entry === undefined || result.matchedPattern === undefined) return labels.testNoMatch;
  return labels.testMatch(result.entry.name, result.matchedPattern);
};

export default function FaqPanel({ channelId, language, canManage = true }: ModulePanelProperties): ReactElement {
  const labels = faqTexts(language);
  const [data, setData] = useState<FaqPanelData | null>(null);
  const [loading, setLoading] = useState(true);
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

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try { setData(await loadFaqPanel(channelId)); }
    catch { setError(labels.loadError); }
    finally { setLoading(false); }
  }, [channelId, labels.loadError]);

  useEffect(() => {
    let active = true;
    void loadFaqPanel(channelId)
      .then((value) => { if (active) setData(value); })
      .catch(() => { if (active) setError(labels.loadError); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [channelId, labels.loadError]);

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
      if (editing === null) await createFaqEntry(channelId, input);
      else await updateFaqEntry(channelId, editing, input);
      setDraft(null);
      setEditing(null);
      await reload();
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
    try { await setFaqEntryEnabled(channelId, entry, enabled); await reload(); }
    catch { setError(labels.saveError); }
    finally { setBusyEntryId(null); }
  };

  const move = async (entry: FaqEntry, direction: "up" | "down"): Promise<void> => {
    if (busyEntryId !== null) return;
    setBusyEntryId(entry.id);
    try { await moveFaqEntry(channelId, entry, direction); await reload(); }
    catch { setError(labels.saveError); }
    finally { setBusyEntryId(null); }
  };

  const remove = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setPending(true);
    setDeleteError(null);
    try { await deleteFaqEntry(channelId, deleteTarget); setDeleteTarget(null); await reload(); }
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

  return (
    <section aria-label={labels.title}>
      <InspectorSection title={labels.title}>
        {canManage ? <Button variant="primary" onClick={openCreate}>{labels.add}</Button> : <p className="lock-reason">{labels.roleLocked}</p>}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {loading ? <p className="muted">…</p> : null}
        {!loading && orderedEntries.length === 0 ? <p className="muted">{labels.noEntries}</p> : null}
        <div className="state-list">
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
      </InspectorSection>

      <Dialog opened={draft !== null} title={editing === null ? labels.create : labels.edit} onClose={closeDialog} pending={pending}>
        {draft === null ? null : <form className="module-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
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
          {error === null ? null : <p className="form-error" role="alert">{error}</p>}
          <div className="inspector-actions">
            <Button type="submit" variant="primary" disabled={pending || blockOptions.length === 0}>{labels.save}</Button>
            <Button type="button" variant="subtle" onClick={closeDialog}>{labels.cancel}</Button>
          </div>
        </form>}
      </Dialog>

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

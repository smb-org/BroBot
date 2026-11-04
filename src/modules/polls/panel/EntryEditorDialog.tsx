import { useMemo, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, ConfirmDialog, Dialog, Field, FieldError, SaveStatus, SegmentChoice, SwitchRow, UnitInput, textFieldLength, useDraft, useDraftGuard } from "../../../dashboard/ui";
import type { PollsEntry, PollsEntryInput, PollsKind } from "../contracts";
import { POLLS_ENTRY_LIMITS, pollsEntryInputSchema } from "../contracts";
import { pollsPanelTexts } from "./locale";

export interface PollsEntryDraft {
  kind: PollsKind;
  title: string;
  choices: string[];
  durationSeconds: number | "";
  channelPointsVotingEnabled: boolean;
  channelPointsPerVote: number | "";
}

type EditorField = "title" | "choices" | `choice:${number}` | "durationSeconds" | "channelPointsPerVote";

const payloadFor = (draft: PollsEntryDraft): unknown => ({
  kind: draft.kind,
  title: draft.title,
  choices: draft.choices,
  durationSeconds: typeof draft.durationSeconds === "number" ? draft.durationSeconds : Number.NaN,
  channelPointsVotingEnabled: draft.kind === "poll" && draft.channelPointsVotingEnabled,
  channelPointsPerVote: draft.kind !== "poll" || !draft.channelPointsVotingEnabled
    ? null
    : typeof draft.channelPointsPerVote === "number" ? draft.channelPointsPerVote : null,
});

const fieldForPath = (path: readonly unknown[]): EditorField | null => {
  const field = path[0];
  if (field === "title") return "title";
  if (field === "choices") return Number.isInteger(path[1]) ? `choice:${String(path[1])}` as EditorField : "choices";
  if (field === "durationSeconds") return "durationSeconds";
  if (field === "channelPointsPerVote") return "channelPointsPerVote";
  return null;
};

const serverFieldErrors = (error: unknown, labels: typeof pollsPanelTexts.en): Partial<Record<EditorField, string>> => {
  if (!(error instanceof PanelApiError) || typeof error.details !== "object" || error.details === null || !("fields" in error.details)) return {};
  const fields = error.details.fields;
  if (!Array.isArray(fields)) return {};
  const result: Partial<Record<EditorField, string>> = {};
  for (const field of fields) {
    if (typeof field !== "object" || field === null || !("path" in field)) continue;
    const path: unknown = (field as { path?: unknown }).path;
    if (!Array.isArray(path)) continue;
    const key = fieldForPath(path as readonly unknown[]);
    if (key === null) continue;
    const message = key === "title" ? labels.serverTitleError
      : key.startsWith("choice:") || key === "choices" ? labels.serverChoiceError
        : key === "durationSeconds" ? labels.serverDurationError
          : labels.serverCostError;
    result[key] = message;
  }
  return result;
};

const entrySaveErrorMessage = (error: unknown, labels: typeof pollsPanelTexts.en): string => {
  if (!(error instanceof PanelApiError)) return labels.requestFailed;
  switch (error.code) {
    case "polls_entry_conflict": return labels.conflict;
    case "polls_entry_limit": return labels.entryLimit;
    case "polls_invalid_entry": return labels.invalidEntry;
    case "polls_module_disabled": return labels.moduleDisabled;
    case "polls_management_denied":
    case "polls_precondition_failed": return labels.managementDenied;
    case "polls_rate_limited": return labels.rateLimited;
    case "polls_network": return labels.network;
    case "polls_not_connected": return labels.missingConnection;
    case "polls_token_unavailable": return labels.tokenUnavailable;
    case "polls_scope_missing": return labels.missingScope;
    case "polls_revoked": return labels.revoked;
    case "polls_refresh_failed": return labels.refreshFailed;
    default: return labels.requestFailed;
  }
};

interface EntryEditorDialogProperties {
  language: "de" | "en";
  canOperate: boolean;
  entry: PollsEntry | null;
  initial: PollsEntryDraft;
  onClose: () => void;
  onSave: (input: PollsEntryInput) => Promise<void>;
}

export default function EntryEditorDialog({ language, canOperate, entry, initial, onClose, onSave }: EntryEditorDialogProperties): ReactElement {
  const labels = pollsPanelTexts[language];
  const draft = useDraft(initial);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<EditorField, string>>>({});
  const [saveError, setSaveError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  const parsed = useMemo(() => pollsEntryInputSchema.safeParse(payloadFor(draft.value)), [draft.value]);
  const localErrors = useMemo(() => {
    if (!attempted || parsed.success) return {};
    const errors: Partial<Record<EditorField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = fieldForPath(issue.path);
      if (field === null || errors[field] !== undefined) continue;
      errors[field] = field === "title" ? labels.localTitleError
        : field.startsWith("choice:") ? labels.localChoiceError
          : field === "choices" ? labels.localChoicesError
            : field === "durationSeconds" ? labels.localDurationError
              : labels.localCostError;
    }
    return errors;
  }, [attempted, labels, parsed]);
  const errors = { ...localErrors, ...serverErrors };

  const clearEditorErrors = (): void => {
    setServerErrors({});
    setSaveError(undefined);
    setSaved(false);
  };

  const persistDraft = async (): Promise<string | null> => {
    setAttempted(true);
    setSaved(false);
    setSaveError(undefined);
    setServerErrors({});
    if (!canOperate || !parsed.success) return labels.invalidEntry;
    setPending(true);
    try {
      await onSave(parsed.data);
      draft.accept(draft.value);
      setSaved(true);
      return null;
    } catch (error) {
      const mapped = serverFieldErrors(error, labels);
      setServerErrors(mapped);
      const message = Object.keys(mapped).length > 0 ? labels.invalidEntry : entrySaveErrorMessage(error, labels);
      setSaveError(message);
      return message;
    } finally {
      setPending(false);
    }
  };

  const saveAndClose = async (): Promise<void> => {
    const error = await persistDraft();
    if (error === null) onClose();
  };
  const draftGuard = useDraftGuard(draft.dirty, persistDraft, draft.reset);
  const requestClose = (): void => {
    if (pending) return;
    draftGuard.guardSwitch(onClose);
  };

  const updateChoice = (index: number, value: string): void => {
    clearEditorErrors();
    draft.setValue((current) => ({ ...current, choices: current.choices.map((choice, position) => position === index ? value : choice) }));
  };
  const moveChoice = (index: number, target: number): void => {
    clearEditorErrors();
    draft.setValue((current) => {
      if (target < 0 || target >= current.choices.length) return current;
      const choices = [...current.choices];
      const [choice] = choices.splice(index, 1);
      if (choice === undefined) return current;
      choices.splice(target, 0, choice);
      return { ...current, choices };
    });
  };
  const changeKind = (kind: PollsKind): void => {
    const limits = POLLS_ENTRY_LIMITS[kind];
    draft.setValue((current) => {
      const choices = current.choices.slice(0, limits.choices.maxCount);
      while (choices.length < limits.choices.minCount) choices.push("");
      return {
        ...current,
        kind,
        choices,
        durationSeconds: typeof current.durationSeconds === "number"
          ? Math.max(limits.durationSeconds.min, Math.min(limits.durationSeconds.max, current.durationSeconds))
          : limits.durationSeconds.min,
        channelPointsVotingEnabled: kind === "poll" && current.channelPointsVotingEnabled,
        channelPointsPerVote: kind === "poll" ? current.channelPointsPerVote : "",
      };
    });
    clearEditorErrors();
  };

  const limits = POLLS_ENTRY_LIMITS[draft.value.kind];
  const choiceRows = draft.value.choices.map((choice, index) => ({
    choice,
    index,
    error: errors[`choice:${String(index)}` as `choice:${number}`],
  }));
  const readOnly = !canOperate;
  const formTitle = entry === null ? labels.createEntry : labels.editEntry;

  return <>
    <Dialog opened title={formTitle} onClose={requestClose} pending={pending} className="polls-editor-dialog">
      <div className="polls-editor">
        {entry === null ? <SegmentChoice<PollsKind>
          label={labels.kind}
          value={draft.value.kind}
          onChange={changeKind}
          disabled={pending || readOnly}
          options={[{ value: "poll", label: labels.poll }, { value: "prediction", label: labels.prediction }]}
        /> : <div className="polls-editor__kind"><span className="ui-field__label">{labels.kind}</span><strong>{entry.kind === "poll" ? labels.poll : labels.prediction}</strong></div>}

        <Field
          label={labels.title}
          value={draft.value.title}
          maxLength={limits.title.maxLength}
          countLength={(value) => textFieldLength({}, value)}
          countLabel={(count, maximum) => labels.characterCount(count, maximum)}
          {...(errors.title === undefined ? {} : { error: errors.title })}
          disabled={pending || readOnly}
          required
          autoComplete="off"
          onChange={(title) => { draft.setValue((current) => ({ ...current, title })); clearEditorErrors(); }}
        />

        <div className="polls-editor__choice-section">
          <span className="ui-field__label">{labels.choices}</span>
          <span className="polls-editor__limit-hint">{labels.choicesLimit(limits.choices.minCount, limits.choices.maxCount)}</span>
          {errors.choices === undefined ? null : <FieldError message={errors.choices} />}
          <div className="polls-editor__choices">
            {choiceRows.map(({ choice, index, error: choiceError }) => <div className="polls-editor__choice" key={`${String(index)}:${choice}`}>
              <Field
                label={labels.choice(index + 1)}
                value={choice}
                onChange={(value) => updateChoice(index, value)}
                maxLength={limits.choice.maxLength}
                countLength={(value) => textFieldLength({}, value)}
                countLabel={(count, maximum) => labels.characterCount(count, maximum)}
                {...(choiceError === undefined ? {} : { error: choiceError })}
                disabled={pending || readOnly}
                required
                autoComplete="off"
              />
              <div className="polls-editor__choice-actions">
                <Button size="compact" icon="sortAscending" iconOnly ariaLabel={labels.moveChoiceUp} title={labels.moveChoiceUp} disabled={pending || readOnly || index === 0} onClick={() => moveChoice(index, index - 1)} />
                <Button size="compact" icon="sortDescending" iconOnly ariaLabel={labels.moveChoiceDown} title={labels.moveChoiceDown} disabled={pending || readOnly || index >= draft.value.choices.length - 1} onClick={() => moveChoice(index, index + 1)} />
                <Button size="compact" icon="remove" iconOnly ariaLabel={labels.removeChoice} title={labels.removeChoice} disabled={pending || readOnly || draft.value.choices.length <= limits.choices.minCount} onClick={() => {
                  draft.setValue((current) => ({ ...current, choices: current.choices.filter((_, position) => position !== index) }));
                  clearEditorErrors();
                }} />
              </div>
            </div>)}
          </div>
          <Button size="compact" icon="add" disabled={pending || readOnly || draft.value.choices.length >= limits.choices.maxCount} onClick={() => {
            draft.setValue((current) => ({ ...current, choices: [...current.choices, ""] }));
            clearEditorErrors();
          }}>{labels.addChoice}</Button>
        </div>

        <UnitInput
          label={labels.duration}
          unit={labels.seconds}
          hint={labels.durationLimit(limits.durationSeconds.min, limits.durationSeconds.max)}
          value={draft.value.durationSeconds}
          min={limits.durationSeconds.min}
          max={limits.durationSeconds.max}
          {...(errors.durationSeconds === undefined ? {} : { error: errors.durationSeconds })}
          disabled={pending || readOnly}
          required
          onChange={(durationSeconds) => { draft.setValue((current) => ({ ...current, durationSeconds })); clearEditorErrors(); }}
        />

        {draft.value.kind === "poll" ? <>
          <SwitchRow
            label={labels.channelPointsVoting}
            checked={draft.value.channelPointsVotingEnabled}
            disabled={pending || readOnly}
            onChange={(channelPointsVotingEnabled) => {
              draft.setValue((current) => ({ ...current, channelPointsVotingEnabled,
                channelPointsPerVote: channelPointsVotingEnabled ? typeof current.channelPointsPerVote === "number" ? current.channelPointsPerVote : 100 : "" }));
              clearEditorErrors();
            }}
          />
          {draft.value.channelPointsVotingEnabled ? <UnitInput
            label={labels.channelPointsCost}
            unit={labels.points}
            hint={labels.channelPointsLimit(POLLS_ENTRY_LIMITS.poll.channelPointsPerVote.min, POLLS_ENTRY_LIMITS.poll.channelPointsPerVote.max)}
            value={draft.value.channelPointsPerVote}
            min={POLLS_ENTRY_LIMITS.poll.channelPointsPerVote.min}
            max={POLLS_ENTRY_LIMITS.poll.channelPointsPerVote.max}
            {...(errors.channelPointsPerVote === undefined ? {} : { error: errors.channelPointsPerVote })}
            disabled={pending || readOnly}
            required
            onChange={(channelPointsPerVote) => { draft.setValue((current) => ({ ...current, channelPointsPerVote })); clearEditorErrors(); }}
          /> : null}
        </> : null}

        <div className="polls-editor__error" role="alert" aria-live="polite">{saveError ?? "\u00a0"}</div>
        <SaveStatus
          persistent
          dirty={draft.dirty}
          pending={pending}
          saved={saved}
          invalid={attempted && !parsed.success}
          invalidMessage={labels.invalidEntry}
          saveDisabled={readOnly}
          discardDisabled={readOnly}
          onSave={() => { void saveAndClose(); }}
          onInvalidSave={() => { void saveAndClose(); }}
          onDiscard={requestClose}
          saveLabel={labels.save}
          discardLabel={labels.discard}
          savedLabel={labels.saved}
          pendingLabel={labels.saving}
        />
      </div>
    </Dialog>
    <ConfirmDialog
      opened={draftGuard.confirmOpen}
      title={labels.discardChangesTitle}
      description={labels.discardChangesDescription}
      confirmLabel={labels.discard}
      cancelLabel={labels.continueEditing}
      alternative={{ label: labels.save, onClick: () => { void draftGuard.saveAndSwitch(); } }}
      danger
      pending={draftGuard.saving}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
      onCancel={draftGuard.continueEditing}
      onConfirm={draftGuard.discardAndSwitch}
    />
  </>;
}

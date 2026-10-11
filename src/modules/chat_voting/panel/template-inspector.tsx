import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { ActionMenu, Button, ConfirmDialog, Field, InspectorSection, NumberField, SaveBar, SegmentedControl, SubInspector, Switch, registerDashboardNavigationGuard, useDraft, useDraftGuard } from "../../../dashboard/ui";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient } from "../../../dashboard/data";
import type { ChatVoteTemplate, ChatVoteTemplateDraft } from "../contracts";
import { CHAT_VOTE_TEMPLATE_MAXIMUM, CHAT_VOTING_TITLE_MAX_LENGTH } from "../contracts";
import { isValidTemplateShortcut, normalizeFreeTextVoteForMatching, templateStartProblem, voteLabelLength } from "../domain";
import { chatVotingSavedPanelTexts } from "./locale-saved";
import { createChatVoteTemplate, saveChatVoteTemplate } from "./service";
import type { ChatVoteTemplateListState } from "./service";

export interface TemplateInspectorActions {
  guardSwitch: (proceed: () => void, cancel?: () => void) => void;
  start: () => Promise<void>;
  acceptTemplate: (template: ChatVoteTemplate) => void;
}

export interface ChatVoteTemplateInspectorProperties {
  channelId: string;
  template: ChatVoteTemplate;
  templates: readonly ChatVoteTemplate[];
  isNew: boolean;
  initiallySaved?: boolean;
  language: "de" | "en";
  isRunning: boolean;
  startLockReason: string | null;
  onRegisterActions: (actions: TemplateInspectorActions | null) => void;
  onTemplateSaved: (template: ChatVoteTemplate) => void;
  onClose: () => void;
  onDiscardNew: () => void;
  onStart: (template: ChatVoteTemplate) => Promise<void>;
  onDelete: (template: ChatVoteTemplate) => Promise<void>;
}

const durationPreset = (seconds: number): string => seconds === 0 ? "open"
  : seconds === 60 ? "one" : seconds === 120 ? "two" : seconds === 300 ? "five" : "custom";

const draftFromTemplate = (template: ChatVoteTemplate): ChatVoteTemplateDraft => ({
  shortcut: template.shortcut,
  title: template.title,
  labels: [...template.labels],
  freeTextMode: template.freeTextMode,
  durationSeconds: template.durationSeconds,
});

const blankDraft = (draft: ChatVoteTemplateDraft): boolean =>
  draft.shortcut === null && draft.title.trim().length === 0 && draft.labels.every((label) => label.trim().length === 0) && draft.freeTextMode === null;

export function ChatVoteTemplateInspector({
  channelId,
  template,
  templates,
  isNew,
  initiallySaved = false,
  language,
  isRunning,
  startLockReason,
  onRegisterActions,
  onTemplateSaved,
  onClose,
  onDiscardNew,
  onStart,
  onDelete,
}: ChatVoteTemplateInspectorProperties): ReactElement {
  const labels = chatVotingSavedPanelTexts(language);
  const queryClient = useDashboardQueryClient();
  const initialDraft = useMemo(() => draftFromTemplate(template), [template]);
  const draft = useDraft(initialDraft);
  const draftValue = useRef(draft.value);
  const baselineDraft = useRef(initialDraft);
  const baseRevision = useRef(template.revision);
  const draftGeneration = useRef(0);
  const reloadGeneration = useRef(0);
  const reloadPending = useRef(false);
  const [durationMode, setDurationMode] = useState(() => durationPreset(draft.value.durationSeconds));
  const [customDurationSelected, setCustomDurationSelected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [saved, setSaved] = useState(initiallySaved);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [serverShortcutError, setServerShortcutError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const dirty = isNew || draft.dirty;
  const startProblem = templateStartProblem(draft.value);
  const shortcutError = serverShortcutError ?? (draft.value.shortcut === null ? null
    : !isValidTemplateShortcut(draft.value.shortcut) ? labels.shortcutInvalid
      : templates.some((entry) => entry.id !== template.id && entry.shortcut === draft.value.shortcut) ? labels.shortcutDuplicate
        : null);
  const invalidReason = shortcutError ?? (startProblem === null ? null : labels.problem(startProblem));
  const saveInvalidReason = shortcutError ?? (blankDraft(draft.value) ? labels.emptyDraftError : null);
  const title = draft.value.title.trim() || labels.untitled;
  const yesNoLabels = language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  const isYesNoTemplate = draft.value.freeTextMode === null
    && draft.value.labels.length === 2
    && draft.value.labels.every((label, index) => label.trim().toLocaleLowerCase() === yesNoLabels[index]?.toLocaleLowerCase());

  useEffect(() => {
    const inferredMode = durationPreset(draft.value.durationSeconds);
    if (customDurationSelected || inferredMode === durationMode) return;
    const timer = window.setTimeout(() => { setDurationMode(inferredMode); }, 0);
    return () => window.clearTimeout(timer);
  }, [customDurationSelected, draft.value.durationSeconds, durationMode]);

  const invalidateReload = (): void => {
    reloadGeneration.current += 1;
    reloadPending.current = false;
  };

  const updateDraft = (update: Partial<ChatVoteTemplateDraft>): void => {
    draftGeneration.current += 1;
    invalidateReload();
    const next = { ...draftValue.current, ...update };
    draftValue.current = next;
    draft.setValue(next);
    setSaved(false);
    setSaveError(undefined);
    if ("shortcut" in update) setServerShortcutError(null);
  };

  const saveDraft = async (): Promise<ChatVoteTemplate | null> => {
    if (saving || conflict) return null;
    const submitted = { ...draftValue.current, labels: [...draftValue.current.labels] };
    if (blankDraft(submitted)) {
      setSaveError(labels.emptyDraftError);
      return null;
    }
    setSaving(true);
    setSaveError(undefined);
    setSaved(false);
    try {
      const baselineRevision = isNew ? null : baseRevision.current;
      const next = await runModuleQueryWrite(queryClient, channelId, "chat_voting", "templates", (revision) => {
        if (revision === null) return createChatVoteTemplate(channelId, submitted);
        return saveChatVoteTemplate(channelId, template.id, revision, submitted);
      }, {
        baselineRevision,
        updateCache: (current, updated) => {
          const previous = current === undefined ? {
            templates: [], count: 0, maximum: CHAT_VOTE_TEMPLATE_MAXIMUM,
          } : current as ChatVoteTemplateListState;
          const alreadyListed = previous.templates.some((entry) => entry.id === updated.id);
          return {
            ...previous,
            templates: alreadyListed
              ? previous.templates.map((entry) => entry.id === updated.id ? updated : entry)
              : [updated, ...previous.templates],
            count: isNew && !alreadyListed ? previous.count + 1 : previous.count,
          };
        },
      });
      const acceptedDraft = draftFromTemplate(next);
      const current = draftValue.current;
      baseRevision.current = next.revision;
      baselineDraft.current = acceptedDraft;
      draft.accept(acceptedDraft);
      if (JSON.stringify(current) !== JSON.stringify(submitted)) {
        draftValue.current = current;
        draft.setValue(current);
      } else {
        draftValue.current = acceptedDraft;
      }
      setServerShortcutError(null);
      setConflict(false);
      setSaved(true);
      onTemplateSaved(next);
      return next;
    } catch (error: unknown) {
      if (error instanceof PanelApiError && error.status === 409 && error.code === "chat_vote_template_conflict") {
        setConflict(true);
        setSaveError(undefined);
      } else if (error instanceof PanelApiError && error.status === 409 && error.code === "chat_vote_template_shortcut_conflict") {
        setServerShortcutError(labels.shortcutDuplicate);
        setSaveError(labels.shortcutUnavailable);
      } else if (error instanceof PanelApiError && error.code === "chat_vote_template_limit") {
        setSaveError(labels.templateLimit);
      } else {
        setSaveError(labels.saveError);
      }
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveForGuard = async (): Promise<string | null> => {
    const result = await saveDraft();
    return result === null ? saveError ?? labels.saveError : null;
  };
  const resetDraft = (): void => {
    draftGeneration.current += 1;
    invalidateReload();
    draft.accept(baselineDraft.current);
    draftValue.current = baselineDraft.current;
    setSaveError(undefined);
    setServerShortcutError(null);
    setConflict(false);
    setSaved(false);
  };
  const draftGuard = useDraftGuard(dirty, saveForGuard, resetDraft);

  const acceptTemplate = (accepted: ChatVoteTemplate): void => {
    draftGeneration.current += 1;
    invalidateReload();
    const nextDraft = draftFromTemplate(accepted);
    draftValue.current = nextDraft;
    baselineDraft.current = nextDraft;
    baseRevision.current = accepted.revision;
    draft.accept(nextDraft);
    setDurationMode(durationPreset(nextDraft.durationSeconds));
    setCustomDurationSelected(false);
    setSaved(false);
    setSaveError(undefined);
    setServerShortcutError(null);
    setConflict(false);
  };

  const start = async (): Promise<void> => {
    if (startLockReason !== null || invalidReason !== null || saving || starting || conflict) return;
    setStarting(true);
    try {
      const savedTemplate = dirty ? await saveDraft() : template;
      if (savedTemplate === null) return;
      if (JSON.stringify(draftValue.current) !== JSON.stringify(draftFromTemplate(savedTemplate))) return;
      await onStart(savedTemplate);
    } finally {
      setStarting(false);
    }
  };

  const actions: TemplateInspectorActions = { guardSwitch: draftGuard.guardSwitch, start, acceptTemplate };
  useLayoutEffect(() => {
    onRegisterActions(actions);
    return () => { onRegisterActions(null); };
  });
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);

  const reloadConflict = async (): Promise<void> => {
    if (reloadPending.current) return;
    reloadPending.current = true;
    const requestGeneration = ++reloadGeneration.current;
    const requestDraftGeneration = draftGeneration.current;
    const isCurrentRequest = (): boolean => reloadGeneration.current === requestGeneration
      && draftGeneration.current === requestDraftGeneration;
    try {
      const latest = (await refetchModuleQueryData<ChatVoteTemplateListState>(queryClient, channelId, "chat_voting", "templates"))
        .templates.find((entry) => entry.id === template.id);
      if (!isCurrentRequest()) return;
      if (latest === undefined) {
        setSaveError(labels.conflictReloadMissing);
        return;
      }
      const nextDraft = draftFromTemplate(latest);
      draftGeneration.current += 1;
      baseRevision.current = latest.revision;
      baselineDraft.current = nextDraft;
      draftValue.current = nextDraft;
      draft.accept(nextDraft);
      setCustomDurationSelected(false);
      setConflict(false);
      setSaveError(undefined);
      setSaved(false);
      onTemplateSaved(latest);
    } catch {
      if (isCurrentRequest()) setSaveError(labels.conflictReloadError);
    } finally {
      if (reloadGeneration.current === requestGeneration) reloadPending.current = false;
    }
  };

  const answerError = (index: number): string | undefined => {
    if (draft.value.freeTextMode !== null) return undefined;
    const answer = draft.value.labels[index] ?? "";
    if (voteLabelLength(answer) > 32) return undefined;
    const normalized = normalizeFreeTextVoteForMatching(answer);
    if (normalized.length === 0) return labels.answerRequired;
    return draft.value.labels.some((other, otherIndex) => otherIndex !== index && normalizeFreeTextVoteForMatching(other) === normalized)
      ? labels.answerDuplicate
      : undefined;
  };

  return <>
    <SubInspector
      ariaLabel={labels.question}
      title={labels.editTitle(title)}
      {...(isNew ? {} : { meta: <div className="chat-voting-template-inspector__header-actions"><ActionMenu
        label={labels.templateActions(title)}
        size="md"
        items={[{
          label: labels.delete,
          danger: true,
          onSelect: () => { draftGuard.guardSwitch(() => { setDeleteOpen(true); }); },
        }]}
      /></div> })}
      closeLabel={labels.cancel}
      onClose={() => { draftGuard.guardSwitch(onClose); }}
      className="chat-voting-template-inspector"
    >
      <div className="chat-voting-editor__body">
      <p className="chat-voting-editor__running-note" aria-live="polite">{isRunning ? labels.infoNextStart : " "}</p>
      <InspectorSection title={labels.question}>
        <Field
          id={"chat-vote-title-" + template.id}
          label={labels.question}
          labelHidden
          ariaLabel={labels.question}
          value={draft.value.title}
          maxLength={CHAT_VOTING_TITLE_MAX_LENGTH}
          countLength={voteLabelLength}
          countLabel={(count, maximum) => String(count) + "/" + String(maximum)}
          className="chat-voting-editor__counted-field chat-voting-editor__counted-field--question"
          onChange={(titleValue) => { updateDraft({ title: titleValue }); }}
        />
      </InspectorSection>

      <InspectorSection title={labels.answers}>
        {draft.value.labels.length === 0 ? <div className="chat-voting-editor__ghost-answers" aria-hidden="true">
          <span className="mono">1</span><span>{labels.ghostYes}</span>
          <span className="mono">2</span><span>{labels.ghostNo}</span>
        </div> : <div className="chat-voting-editor__answer-list">{draft.value.labels.map((answer, index) => {
          const answerNumber = index + 1;
          const answerProblem = answerError(index);
          return <div className="chat-voting-editor__answer" key={"answer-" + String(answerNumber)}>
            <span className="mono chat-voting-editor__answer-key" aria-hidden="true">{String(answerNumber)}</span>
            <Field
              id={"chat-vote-answer-" + template.id + "-" + String(index)}
              label={labels.answer(answerNumber)}
              labelHidden
              ariaLabel={labels.answer(answerNumber)}
              value={answer}
              placeholder={labels.answerPlaceholder}
              maxLength={32}
              countLength={voteLabelLength}
              countLabel={(count, maximum) => String(count) + "/" + String(maximum)}
              countWhenNearLimitOnly
              className="chat-voting-editor__counted-field chat-voting-editor__counted-field--answer"
              {...(answerProblem === undefined ? {} : { error: answerProblem })}
              onChange={(value) => {
                const next = [...draft.value.labels];
                next[index] = value;
                updateDraft({ labels: next });
              }}
            />
            <Button
              icon="close"
              iconOnly
              size="compact"
              variant="subtle"
              ariaLabel={labels.removeAnswer(answerNumber)}
              onClick={() => { updateDraft({ labels: draft.value.labels.filter((_label, labelIndex) => labelIndex !== index) }); }}
            />
          </div>;
        })}</div>}
        <div className="chat-voting-editor__answer-actions">
          <Button
            variant="neutral"
            size="compact"
            icon="add"
            disabled={draft.value.labels.length >= 9}
            {...(draft.value.labels.length >= 9 ? { title: labels.maxAnswers } : {})}
            onClick={() => { updateDraft({ labels: [...draft.value.labels, ""] }); }}
          >{labels.addAnswer}</Button>
        </div>
      </InspectorSection>
      <p className="chat-voting-editor__chat-hint">{isYesNoTemplate ? labels.chatHintYesNo : labels.chatHint}</p>

      <InspectorSection title={labels.quickTemplates}>
        <div className="chat-voting-editor__quick-templates">
          <Button size="compact" variant="neutral" onClick={() => { updateDraft({ labels: language === "de" ? ["Ja", "Nein"] : ["Yes", "No"] }); }}>{labels.yesNo}</Button>
          <Button size="compact" variant="neutral" onClick={() => { updateDraft({ labels: ["1", "2", "3", "4", "5"] }); }}>{labels.scale}</Button>
        </div>
      </InspectorSection>

      <section className="chat-voting-editor__switch-section" aria-label={labels.freeText}>
        <Switch
          label={labels.freeText}
          description={labels.freeTextHint}
          layout="card"
          checked={draft.value.freeTextMode !== null}
          onChange={(checked) => { updateDraft({ freeTextMode: checked ? "first_word" : null }); }}
        >
          <SegmentedControl
            label={labels.textMode}
            value={draft.value.freeTextMode ?? "first_word"}
            onChange={(value) => { updateDraft({ freeTextMode: value as "first_word" | "whole_message" }); }}
            options={[{ value: "first_word", label: labels.firstWord }, { value: "whole_message", label: labels.wholeMessage }]}
            size="compact"
          />
        </Switch>
      </section>

      <InspectorSection title={labels.duration}>
        <div className="chat-voting-editor__duration-control">
          <SegmentedControl
            label={labels.duration}
            value={durationMode}
            onChange={(value) => {
              setDurationMode(value);
              setCustomDurationSelected(value === "custom");
              if (value === "open") updateDraft({ durationSeconds: 0 });
              else if (value === "one") updateDraft({ durationSeconds: 60 });
              else if (value === "two") updateDraft({ durationSeconds: 120 });
              else if (value === "five") updateDraft({ durationSeconds: 300 });
            }}
            options={[
              { value: "one", label: labels.oneMinute },
              { value: "two", label: labels.twoMinutes },
              { value: "five", label: labels.fiveMinutes },
              { value: "open", label: labels.open },
              { value: "custom", label: labels.custom },
            ]}
            size="compact"
          />
          <div className="chat-voting-editor__duration-slot">
            <NumberField
              label={labels.seconds}
              ariaLabel={labels.seconds}
              value={draft.value.durationSeconds}
              min={0}
              max={14_400}
              step={30}
              increaseLabel={labels.increase}
              decreaseLabel={labels.decrease}
              unit="s"
              {...(durationMode === "custom" ? { hint: labels.durationHint } : {})}
              disabled={durationMode !== "custom"}
              id={"chat-vote-duration-" + template.id}
              onChange={(value) => { updateDraft({ durationSeconds: typeof value === "number" ? value : 0 }); }}
            />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection title={labels.shortcut}>
        <Field
          id={"chat-vote-shortcut-" + template.id}
          label={labels.shortcut}
          labelHidden
          ariaLabel={labels.shortcut}
          prefix={labels.shortcutPrefix}
          mono
          placeholder="essen"
          value={draft.value.shortcut ?? ""}
          {...(shortcutError === null ? {} : { error: shortcutError })}
          hint={labels.shortcutHint}
          onChange={(value) => { updateDraft({ shortcut: value.length === 0 ? null : value }); }}
        />
      </InspectorSection>
      </div>
      <div className="chat-voting-editor__footer">
        <div className="chat-voting-editor__start-row">
          <span className="chat-voting-editor__start-reason" title={invalidReason ?? startLockReason ?? (conflict ? labels.saveConflict : "")}>{invalidReason ?? startLockReason ?? (conflict ? labels.saveConflict : " ")}</span>
          <Button className="chat-voting-editor__start-button" variant="primary" disabled={startLockReason !== null || invalidReason !== null || saving || starting || conflict} title={invalidReason ?? startLockReason ?? (conflict ? labels.saveConflict : labels.startAction)} onClick={() => { void start(); }}>
            {starting ? labels.saving : labels.startAction}
          </Button>
        </div>
        <SaveBar
          dirty={dirty}
          pending={saving}
          saved={saved || (!dirty && !isNew)}
          persistent
          warnings={dirty ? [labels.unsaved] : []}
          warningStatusLabel={(_warnings, justSaved) => justSaved ? labels.saved : labels.unsaved}
          {...(saveError === undefined ? {} : { error: saveError })}
          invalid={saveInvalidReason !== null}
          {...(saveInvalidReason === null ? {} : { invalidMessage: saveInvalidReason, onInvalidSave: () => { setSaveError(saveInvalidReason); } })}
          {...(conflict ? { conflict: { message: labels.saveConflict, reloadLabel: labels.conflictReload, onReload: () => { void reloadConflict(); } } } : {})}
          discardOnConflict
          onSave={() => { void saveDraft(); }}
          onDiscard={() => { if (isNew) onDiscardNew(); else resetDraft(); }}
          saveLabel={labels.save}
          discardLabel={labels.discard}
          savedLabel={labels.saved}
          pendingLabel={labels.saving}
        />
      </div>
    </SubInspector>
    <ConfirmDialog
      opened={draftGuard.confirmOpen}
      title={labels.discardChangesTitle}
      description={labels.discardChangesDescription}
      confirmLabel={labels.discardAndSwitch}
      cancelLabel={labels.continueEditing}
      onConfirm={draftGuard.discardAndSwitch}
      onCancel={draftGuard.continueEditing}
      pending={draftGuard.saving || saving}
      danger
    />
    <ConfirmDialog
      opened={deleteOpen}
      danger
      title={labels.deleteTitle(title)}
      description={labels.deleteDescription(title, isRunning, template.legacyAlias !== null)}
      confirmLabel={labels.confirmDelete}
      cancelLabel={labels.cancel}
      onConfirm={() => {
        if (deletingRef.current) return;
        deletingRef.current = true;
        setDeleting(true);
        void onDelete(template)
          .then(() => { setDeleteOpen(false); })
          .catch(() => undefined)
          .finally(() => {
            deletingRef.current = false;
            setDeleting(false);
          });
      }}
      onCancel={() => { if (!deletingRef.current) setDeleteOpen(false); }}
      pending={deleting}
    />
  </>;
}

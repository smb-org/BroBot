import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { ActionMenu, Button, ChatPreview, ConfirmDialog, Field, InspectorSection, PageHeader, RuleNote, SaveStatus, SegmentChoice, SwitchSection, TemplateTextField, UnitInput, registerDashboardNavigationGuard, useDraft, useDraftGuard } from "../../../dashboard/ui";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient } from "../../../dashboard/data";
import { dashboardCommonTexts } from "../../../dashboard/locale";
import type { ChatVoteTemplate, ChatVoteTemplateDraft } from "../contracts";
import { CHAT_VOTE_TEMPLATE_MAXIMUM, CHAT_VOTING_TITLE_MAX_LENGTH } from "../contracts";
import { isValidTemplateShortcut, normalizeFreeTextVoteForMatching, voteLabelLength } from "../domain";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { createChatVoteTemplate, saveChatVoteTemplate } from "./service";
import type { ChatVoteTemplateListState } from "./service";

export interface TemplateInspectorActions {
  guardSwitch: (proceed: () => void, cancel?: () => void) => void;
  acceptTemplate: (template: ChatVoteTemplate) => void;
}

export interface ChatVoteTemplateInspectorProperties {
  channelId: string;
  template: ChatVoteTemplate;
  templates: readonly ChatVoteTemplate[];
  isNew: boolean;
  initiallySaved?: boolean;
  language: "de" | "en";
  canManageContent: boolean;
  onRegisterActions: (actions: TemplateInspectorActions | null) => void;
  onTemplateSaved: (template: ChatVoteTemplate) => void;
  onClose: () => void;
  onDiscardNew: () => void;
  onDelete: (template: ChatVoteTemplate) => Promise<void>;
}

const durationPreset = (seconds: number): string => seconds === 0 ? "open"
  : seconds === 60 ? "one" : seconds === 120 ? "two" : seconds === 300 ? "five" : "custom";

const draftFromTemplate = (template: ChatVoteTemplate): ChatVoteTemplateDraft => ({
  shortcut: template.shortcut,
  title: template.title,
  resultText: template.resultText ?? "{vote.result}",
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
  canManageContent,
  onRegisterActions,
  onTemplateSaved,
  onClose,
  onDiscardNew,
  onDelete,
}: ChatVoteTemplateInspectorProperties): ReactElement {
  const labels = chatVotingSavedPanelTexts(language);
  const resultTextCopy = labels.resultText;
  const common = dashboardCommonTexts(language);
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
  const [saved, setSaved] = useState(initiallySaved);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [serverShortcutError, setServerShortcutError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const deletingRef = useRef(false);
  const dirty = canManageContent && (isNew || draft.dirty);
  const shortcutError = serverShortcutError ?? (draft.value.shortcut === null ? null
    : !isValidTemplateShortcut(draft.value.shortcut) ? labels.shortcutInvalid
      : templates.some((entry) => entry.id !== template.id && entry.shortcut === draft.value.shortcut) ? labels.shortcutDuplicate
        : null);
  const saveInvalidReason = shortcutError ?? (blankDraft(draft.value) ? labels.emptyDraftError : null);
  const title = draft.value.title.trim() || labels.untitled;
  const yesNoLabels = language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  const isYesNoTemplate = draft.value.freeTextMode === null
    && draft.value.labels.length === 2
    && draft.value.labels.every((label, index) => label.trim().toLocaleLowerCase() === yesNoLabels[index]?.toLocaleLowerCase());
  const previewOptions = draft.value.freeTextMode === null ? draft.value.labels : [];
  const previewText = `${draft.value.title.trim() || labels.previewQuestion}${previewOptions.length === 0 ? "" : ` — ${previewOptions.map((option, index) => `${String(index + 1)}. ${option}`).join(" · ")}`}`;
  const previewResultText = (text: string, values: Readonly<Record<string, string>>): string => text.replace(/\{([^{}]+)\}/gu, (token, name: string) => values[name] ?? token);
  const previewResult = labels.resultPreview(draft.value.title.trim() || labels.previewQuestion, previewResultText(draft.value.resultText ?? "{vote.result}", {
    "vote.result": language === "de" ? "Pizza: 8 (67%) · Burger: 4 (33%)" : "Pizza: 8 (67%) · Burger: 4 (33%)",
    "vote.title": draft.value.title.trim() || labels.previewQuestion,
    "vote.options": draft.value.labels.map((answer, index) => `${String(index + 1)} = ${answer}`).join(", "),
    "vote.duration": chatVoteDurationText(draft.value.durationSeconds, language),
  }));

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
    if (!canManageContent || saving || conflict) return null;
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

  const actions: TemplateInspectorActions = { guardSwitch: draftGuard.guardSwitch, acceptTemplate };
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
    <section className="chat-voting-template-inspector" role="region" aria-label={labels.question} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canManageContent && dirty && !saving) {
        event.preventDefault();
        void saveDraft();
      }
    }}>
      <PageHeader
        kind="module"
        icon={null}
        title={labels.title}
        titleContent={title}
        headingLevel="h2"
        {...(canManageContent ? { saveStatus: <SaveStatus
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
          savedLabel={labels.savedLabel}
          pendingLabel={labels.saving}
        /> } : {})}
        {...(canManageContent && !isNew ? { actions: <ActionMenu
          label={common.moreActions}
          items={[{ label: labels.delete, danger: true, onSelect: () => {
            draftGuard.guardSwitch(() => { setDeleteError(undefined); setDeleteOpen(true); });
          } }]}
        /> } : {})}
      />
      <div className="chat-voting-editor__body">
      {canManageContent ? <>
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
      <ChatPreview label={labels.preview} speaker={labels.bot} text={previewText} countLabel={labels.previewCountLabel(voteLabelLength(previewText))} />

      <InspectorSection title={labels.quickTemplates}>
        <div className="chat-voting-editor__quick-templates">
          <Button size="compact" variant="neutral" onClick={() => { updateDraft({ labels: language === "de" ? ["Ja", "Nein"] : ["Yes", "No"] }); }}>{labels.yesNo}</Button>
          <Button size="compact" variant="neutral" onClick={() => { updateDraft({ labels: ["1", "2", "3", "4", "5"] }); }}>{labels.scale}</Button>
        </div>
      </InspectorSection>

      <SwitchSection
          className="chat-voting-editor__switch-section"
          title={labels.freeText}
          hint={labels.freeTextHint}
          checked={draft.value.freeTextMode !== null}
          onChange={(checked) => { updateDraft({ freeTextMode: checked ? "first_word" : null }); }}
        >
          <SegmentChoice
            label={labels.textMode}
            value={draft.value.freeTextMode ?? "first_word"}
            onChange={(value) => { updateDraft({ freeTextMode: value }); }}
            options={[{ value: "first_word", label: labels.firstWord }, { value: "whole_message", label: labels.wholeMessage }]}
            size="compact"
          />
      </SwitchSection>

      <InspectorSection title={labels.duration}>
        <div className="chat-voting-editor__duration-control">
          <SegmentChoice
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
            <UnitInput
              label={labels.seconds}
              ariaLabel={labels.seconds}
              value={draft.value.durationSeconds}
              min={0}
              max={14_400}
              step={30}
              unit="s"
              {...(durationMode === "custom" ? { hint: labels.durationHint } : {})}
              disabled={durationMode !== "custom"}
              id={"chat-vote-duration-" + template.id}
              onChange={(value) => { updateDraft({ durationSeconds: typeof value === "number" ? value : 0 }); }}
            />
          </div>
        </div>
      </InspectorSection>

      <InspectorSection title={resultTextCopy.label}>
        <TemplateTextField
          label={resultTextCopy.label}
          hint={resultTextCopy.hint}
          value={draft.value.resultText ?? "{vote.result}"}
          onChange={(resultText) => { updateDraft({ resultText }); }}
          maxLength={500}
          variables={resultTextCopy.variables}
          minRows={2}
          messages={resultTextCopy.templateMessages}
        />
        <ChatPreview
          label={labels.preview}
          speaker={labels.bot}
          text={previewResult}
          countLabel={labels.previewCountLabel(voteLabelLength(previewResult))}
        />
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
      </> : <>
        <RuleNote>{labels.operatorLocked}</RuleNote>
        <dl className="properties chat-voting-template-inspector__properties">
          <div><dt>{labels.question}</dt><dd>{template.title || labels.untitled}</dd></div>
          <div><dt>{labels.answers}</dt><dd>{template.freeTextMode === null ? template.labels.join(", ") : labels.freeText}</dd></div>
          <div><dt>{labels.duration}</dt><dd>{chatVoteDurationText(template.durationSeconds, language)}</dd></div>
          <div><dt>{resultTextCopy.label}</dt><dd>{template.resultText ?? "{vote.result}"}</dd></div>
          <div><dt>{labels.shortcut}</dt><dd>{template.shortcut === null ? "—" : `${labels.shortcutPrefix} ${template.shortcut}`}</dd></div>
        </dl>
      </>}
      </div>
    </section>
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
      description={labels.deleteDescription(title, template.legacyAlias !== null)}
      confirmLabel={labels.confirmDelete}
      cancelLabel={labels.cancel}
      onConfirm={() => {
        if (deletingRef.current) return;
        deletingRef.current = true;
        setDeleting(true);
        void onDelete(template)
          .then(() => { setDeleteOpen(false); setDeleteError(undefined); })
          .catch(() => { setDeleteError(labels.deleteError); })
          .finally(() => {
            deletingRef.current = false;
            setDeleting(false);
          });
      }}
      onCancel={() => { if (!deletingRef.current) setDeleteOpen(false); }}
      pending={deleting}
      {...(deleteError === undefined ? {} : { error: deleteError })}
    />
  </>;
}

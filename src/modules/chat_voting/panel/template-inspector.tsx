import { useState, type ReactElement } from "react";

import { Button, ConfirmDialog, Field, InspectorActions, InspectorSection, NumberField, SegmentedControl, SubInspector, Switch } from "../../../dashboard/ui";
import type { ChatVoteTemplate, ChatVoteTemplateDraft } from "../contracts";
import { CHAT_VOTING_TITLE_MAX_LENGTH } from "../contracts";
import { normalizeFreeTextVoteForMatching, templateStartProblem, voteLabelLength } from "../domain";
import { chatVotingSavedPanelTexts } from "./locale-saved";

export type TemplateSaveState = "saved" | "saving" | "error" | "conflict";

export interface ChatVoteTemplateInspectorProperties {
  template: ChatVoteTemplate;
  draft: ChatVoteTemplateDraft;
  language: "de" | "en";
  saveState: TemplateSaveState;
  shortcutError: string | null;
  isRunning: boolean;
  startLockReason: string | null;
  startBusy: boolean;
  saveTime: string;
  onPresetAnswers: (values: readonly string[]) => void;
  onClose: () => void;
  onChange: (update: Partial<ChatVoteTemplateDraft>) => void;
  onStart: () => void;
  onRetrySave: () => void;
  onDelete: () => Promise<void>;
}

const durationPreset = (seconds: number): string => seconds === 0 ? "open"
  : seconds === 60 ? "one" : seconds === 120 ? "two" : seconds === 300 ? "five" : "custom";

export function ChatVoteTemplateInspector({
  template,
  draft,
  language,
  saveState,
  shortcutError,
  isRunning,
  startLockReason,
  startBusy,
  saveTime,
  onPresetAnswers,
  onClose,
  onChange,
  onStart,
  onRetrySave,
  onDelete,
}: ChatVoteTemplateInspectorProperties): ReactElement {
  const labels = chatVotingSavedPanelTexts(language);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const title = draft.title.trim() || labels.untitled;
  const startProblem = templateStartProblem(draft);
  const invalid = startProblem !== null;
  const yesNoLabels = language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  const isYesNoTemplate = draft.freeTextMode === null
    && draft.labels.length === 2
    && draft.labels.every((label, index) => label.trim().toLocaleLowerCase() === yesNoLabels[index]?.toLocaleLowerCase());
  const durationValue = draft.durationSeconds;
  const saveText = saveState === "saving" ? labels.saving
    : saveState === "error" ? labels.saveError
      : saveState === "conflict" ? labels.saveConflict
        : invalid ? labels.incompleteStatus : labels.savedAt(saveTime);
  const answerError = (index: number): string | undefined => {
    if (draft.freeTextMode !== null) return undefined;
    const answer = draft.labels[index] ?? "";
    if (voteLabelLength(answer) > 32) return undefined;
    const normalized = normalizeFreeTextVoteForMatching(answer);
    if (normalized.length === 0) return labels.answerRequired;
    return draft.labels.some((other, otherIndex) => otherIndex !== index && normalizeFreeTextVoteForMatching(other) === normalized)
      ? labels.answerDuplicate
      : undefined;
  };

  return <>
    <SubInspector
      ariaLabel={labels.question}
      title={labels.editTitle(title)}
      closeLabel={labels.cancel}
      onClose={onClose}
      className="chat-voting-template-inspector"
    >
      <div className="chat-voting-editor__body">
      {isRunning ? <p className="chat-voting-editor__running-note">{labels.infoNextStart}</p> : null}
      <InspectorSection title={labels.question}>
        <Field
          id={"chat-vote-title-" + template.id}
          label={labels.question}
          labelHidden
          ariaLabel={labels.question}
          value={draft.title}
          maxLength={CHAT_VOTING_TITLE_MAX_LENGTH}
          countLength={voteLabelLength}
          countLabel={(count, maximum) => String(count) + "/" + String(maximum)}
          className="chat-voting-editor__counted-field chat-voting-editor__counted-field--question"
          onChange={(titleValue) => { onChange({ title: titleValue }); }}
        />
      </InspectorSection>

      <InspectorSection title={labels.answers}>
        {draft.labels.length === 0 ? <div className="chat-voting-editor__ghost-answers" aria-hidden="true">
          <span className="mono">1</span><span>{labels.ghostYes}</span>
          <span className="mono">2</span><span>{labels.ghostNo}</span>
        </div> : <div className="chat-voting-editor__answer-list">{draft.labels.map((answer, index) => {
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
                const next = [...draft.labels];
                next[index] = value;
                onChange({ labels: next });
              }}
            />
            <Button
              icon="close"
              iconOnly
              size="compact"
              variant="subtle"
              ariaLabel={labels.removeAnswer(answerNumber)}
              onClick={() => { onChange({ labels: draft.labels.filter((_label, labelIndex) => labelIndex !== index) }); }}
            />
          </div>;
        })}</div>}
        <div className="chat-voting-editor__answer-actions">
          <Button
            variant="neutral"
            size="compact"
            icon="add"
            disabled={draft.labels.length >= 9}
            {...(draft.labels.length >= 9 ? { title: labels.maxAnswers } : {})}
            onClick={() => { onChange({ labels: [...draft.labels, ""] }); }}
          >{labels.addAnswer}</Button>
        </div>
      </InspectorSection>
      <p className="chat-voting-editor__chat-hint">{isYesNoTemplate ? labels.chatHintYesNo : labels.chatHint}</p>

      <InspectorSection title={labels.quickTemplates}>
        <div className="chat-voting-editor__quick-templates">
          <Button size="compact" variant="neutral" onClick={() => { onPresetAnswers(language === "de" ? ["Ja", "Nein"] : ["Yes", "No"]); }}>{labels.yesNo}</Button>
          <Button size="compact" variant="neutral" onClick={() => { onPresetAnswers(["1", "2", "3", "4", "5"]); }}>{labels.scale}</Button>
        </div>
      </InspectorSection>

      <section className="chat-voting-editor__switch-section" aria-label={labels.freeText}>
        <Switch
          label={labels.freeText}
          description={labels.freeTextHint}
          layout="card"
          checked={draft.freeTextMode !== null}
          onChange={(checked) => { onChange({ freeTextMode: checked ? "first_word" : null }); }}
        >
          <SegmentedControl
            label={labels.textMode}
            value={draft.freeTextMode ?? "first_word"}
            onChange={(value) => { onChange({ freeTextMode: value as "first_word" | "whole_message" }); }}
            options={[{ value: "first_word", label: labels.firstWord }, { value: "whole_message", label: labels.wholeMessage }]}
            size="compact"
          />
        </Switch>
      </section>

      <InspectorSection title={labels.duration}>
        <div className="chat-voting-editor__duration-control">
          <SegmentedControl
            label={labels.duration}
            value={durationPreset(draft.durationSeconds)}
            onChange={(value) => {
              if (value === "open") onChange({ durationSeconds: 0 });
              else if (value === "one") onChange({ durationSeconds: 60 });
              else if (value === "two") onChange({ durationSeconds: 120 });
              else if (value === "five") onChange({ durationSeconds: 300 });
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
              value={durationValue}
              min={0}
              max={14_400}
              step={30}
              increaseLabel={labels.increase}
              decreaseLabel={labels.decrease}
              unit="s"
              {...(durationPreset(draft.durationSeconds) === "custom" ? { hint: labels.durationHint } : {})}
              disabled={durationPreset(draft.durationSeconds) !== "custom"}
              id={"chat-vote-duration-" + template.id}
              onChange={(value) => { onChange({ durationSeconds: typeof value === "number" ? value : 0 }); }}
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
          value={draft.shortcut ?? ""}
          {...(shortcutError === null ? {} : { error: shortcutError })}
          hint={labels.shortcutHint}
          onChange={(value) => { onChange({ shortcut: value.length === 0 ? null : value }); }}
        />
      </InspectorSection>
      </div>
      <div className="chat-voting-editor__footer">
        <InspectorActions destructive={<Button danger="subtle" size="compact" onClick={() => { setDeleteOpen(true); }}>{labels.delete}</Button>}>
          <span
            className={"mono chat-voting-editor__save-status" + (saveState === "error" || saveState === "conflict" ? " chat-voting-editor__save-status--error" : "")}
            title={saveText}
            aria-live={saveState === "error" || saveState === "conflict" ? "polite" : undefined}
          >{saveText}</span>
          {saveState === "error" ? <Button size="compact" variant="neutral" onClick={onRetrySave}>{labels.retry}</Button> : null}
          <Button className="chat-voting-editor__start-button" variant="primary" disabled={startBusy || invalid || startLockReason !== null} onClick={onStart}>
            {startBusy ? labels.saving : labels.startAction}
          </Button>
        </InspectorActions>
        <p className="chat-voting-editor__start-reason" title={startLockReason ?? (startProblem === null ? "" : labels.problem(startProblem))}>
          {startLockReason ?? (startProblem === null ? "" : labels.problem(startProblem))}
        </p>
      </div>
    </SubInspector>
    <ConfirmDialog
      opened={deleteOpen}
      danger
      title={labels.deleteTitle(title)}
      description={labels.deleteDescription(title, isRunning, template.legacyAlias !== null)}
      confirmLabel={labels.confirmDelete}
      cancelLabel={labels.cancel}
      onConfirm={() => { void onDelete().then(() => { setDeleteOpen(false); }).catch(() => undefined); }}
      onCancel={() => { setDeleteOpen(false); }}
    />
  </>;
}

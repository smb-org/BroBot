import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { ActionMenu, Button, ChatPreview, ConfirmDialog, Field, InspectorSection, PageHeader, SaveStatus, SegmentChoice, SwitchRow, SwitchSection, TemplateTextField, UnitInput, panelTemplateOptions, registeredModuleTemplateGroup, registerDashboardNavigationGuard, useDraft, useDraftGuard } from "../../../dashboard/ui";
import { PopoverContent, PopoverPrimitive } from "../../../dashboard/ui/primitives/popover";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient } from "../../../dashboard/data";
import { useModuleQuery } from "../../../dashboard/data";
import { isEventTemplateVariableAvailable } from "../../../contracts/event-template-variables";
import { dashboardCommonTexts, dashboardTexts } from "../../../dashboard/locale";
import type { ChatVoteTemplate, ChatVoteTemplateDraft } from "../contracts";
import { CHAT_VOTE_TEMPLATE_MAXIMUM, CHAT_VOTING_TITLE_MAX_LENGTH } from "../contracts";
import { isValidTemplateShortcut, normalizeFreeTextVoteForMatching, voteLabelLength } from "../domain";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { chatVoteResultPreview } from "./result-preview";
import { createChatVoteTemplate, loadChatVotingTemplateVariables, saveChatVoteTemplate } from "./service";
import type { ChatVoteTemplateListState } from "./service";
import { CHAT_VOTE_PALETTE, chatVoteDefaultColorAt, nextUnusedChatVoteDefaultColor, normalizeChatVoteColor, voteColorContrastIssue } from "../contracts/vote-colors";

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
  onTemplateSaved: (template: ChatVoteTemplate, originId: string) => void;
  onClose: () => void;
  onDiscardNew: () => void;
  onDelete: (template: ChatVoteTemplate) => Promise<void>;
}

interface CustomColorDraft {
  value: string;
  generation: number;
}

const durationPreset = (seconds: number): string => seconds === 0 ? "open"
  : seconds === 60 ? "one" : seconds === 120 ? "two" : seconds === 300 ? "five" : "custom";

const draftFromTemplate = (template: ChatVoteTemplate): ChatVoteTemplateDraft => ({
  shortcut: template.shortcut,
  title: template.title,
  resultText: template.resultText ?? "{vote.result}",
  labels: [...template.labels],
  answerColors: [...template.answerColors],
  offerInCockpit: template.offerInCockpit,
  freeTextMode: template.freeTextMode,
  durationSeconds: template.durationSeconds,
});

const reconcileAnswerIds = (
  previousLabels: readonly string[],
  previousAnswerIds: readonly string[],
  nextLabels: readonly string[],
  createAnswerId: () => string,
): string[] => {
  const sameSequence = previousLabels.length === nextLabels.length
    && previousLabels.every((label, index) => label === nextLabels[index]);
  if (sameSequence) return nextLabels.map((_label, index) => previousAnswerIds[index] ?? createAnswerId());

  const countLabels = (labels: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    labels.forEach((label) => { counts.set(label, (counts.get(label) ?? 0) + 1); });
    return counts;
  };
  const previousCounts = countLabels(previousLabels);
  const nextCounts = countLabels(nextLabels);
  return nextLabels.map((label) => {
    if (previousCounts.get(label) !== 1 || nextCounts.get(label) !== 1) return createAnswerId();
    const previousIndex = previousLabels.indexOf(label);
    return previousAnswerIds[previousIndex] ?? createAnswerId();
  });
};

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
  const registeredVariablesQuery = useModuleQuery(channelId, "chat_voting", "template-variables", (signal) =>
    loadChatVotingTemplateVariables(channelId, signal));
  const registeredVariables = (registeredVariablesQuery.data ?? []).filter(isEventTemplateVariableAvailable);
  const channelVariables = registeredVariables.filter((variable) => variable.source === "channel" && variable.name.startsWith("var.") && !variable.isTextBlock)
    .map((variable) => ({ name: variable.name.slice("var.".length), value: Number(variable.sample) || 0, description: variable.description ?? "" }));
  const systemVariables = panelTemplateOptions("event", [], channelVariables, language);
  const textBlocks = registeredVariables.filter((variable) => variable.isTextBlock).map((variable) => ({
    name: variable.name,
    label: variable.name,
    description: variable.description ?? variable.name,
    sample: variable.sample,
    group: variable.group ?? "channel" as const,
    kind: "module" as const,
    isTextBlock: true,
  }));
  const moduleVariables = registeredVariables.filter((variable) => !variable.isTextBlock && variable.source !== "system" && variable.source !== "channel")
    .map((variable) => {
      const pickerCopy = variable.picker?.[language];
      const sourceGroup = registeredModuleTemplateGroup(variable, language);
      return {
        name: variable.name,
        label: pickerCopy?.label ?? variable.name,
        description: pickerCopy?.description ?? variable.description ?? variable.name,
        sample: variable.sample,
        ...(pickerCopy?.sample === undefined ? {} : { pickerSample: pickerCopy.sample }),
        group: variable.group ?? "channel" as const,
        kind: "module" as const,
        ...(sourceGroup === undefined ? {} : { sourceGroup }),
        ...(variable.external === undefined ? {} : { external: variable.external }),
        ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
        ...(variable.parameters === "currency_pair" ? { parameter: { value: variable.parameterDefault ?? "USD EUR" } } : {}),
      };
    });
  const resultTextVariables = [...resultTextCopy.variables, ...systemVariables, ...textBlocks, ...moduleVariables];
  const initialDraft = useMemo(() => draftFromTemplate(template), [template]);
  const draft = useDraft(initialDraft);
  const draftValue = useRef(draft.value);
  const baselineDraft = useRef(initialDraft);
  const baseRevision = useRef(template.revision);
  const reloadGeneration = useRef(0);
  const reloadPending = useRef(false);
  const answerIdPrefix = useId().replaceAll(":", "");
  const answerIdSequence = useRef(initialDraft.labels.length);
  const createAnswerId = (): string => `${answerIdPrefix}-answer-${String(++answerIdSequence.current)}`;
  const [answerIds, setAnswerIds] = useState<readonly string[]>(() => initialDraft.labels.map((_label, index) => `${answerIdPrefix}-answer-${String(index + 1)}`));
  const answerIdsRef = useRef(answerIds);
  const [durationMode, setDurationMode] = useState(() => durationPreset(draft.value.durationSeconds));
  const [customDurationSelected, setCustomDurationSelected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(initiallySaved);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [resultTextError, setResultTextError] = useState<string | undefined>();
  const [serverShortcutError, setServerShortcutError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const customColorDraftsRef = useRef<Readonly<Record<string, CustomColorDraft>>>({});
  const customColorEditGeneration = useRef(0);
  const [customColorDrafts, setCustomColorDrafts] = useState<Readonly<Record<string, CustomColorDraft>>>({});
  const deletingRef = useRef(false);
  const updateCustomColorDrafts = (
    update: (current: Readonly<Record<string, CustomColorDraft>>) => Readonly<Record<string, CustomColorDraft>>,
  ): void => {
    const next = update(customColorDraftsRef.current);
    customColorDraftsRef.current = next;
    setCustomColorDrafts(next);
  };
  const clearCustomColorDrafts = (answerId?: string): void => {
    if (answerId === undefined) {
      customColorDraftsRef.current = {};
      setCustomColorDrafts({});
      return;
    }
    updateCustomColorDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== answerId)));
  };
  const hasInvalidCustomColorDraft = Object.values(customColorDrafts).some(({ value }) => normalizeChatVoteColor(value) === null);
  const dirty = canManageContent && (isNew || draft.dirty || hasInvalidCustomColorDraft);
  const shortcutError = serverShortcutError ?? (draft.value.shortcut === null ? null
    : !isValidTemplateShortcut(draft.value.shortcut) ? labels.shortcutInvalid
      : templates.some((entry) => entry.id !== template.id && entry.shortcut === draft.value.shortcut) ? labels.shortcutDuplicate
        : null);
  const answerColorAt = (index: number): string => draft.value.answerColors[index] ?? chatVoteDefaultColorAt(index);
  const answerIdAt = (index: number): string => {
    const answerId = answerIds[index];
    if (answerId === undefined) throw new Error("A chat vote answer is missing its local identity.");
    return answerId;
  };
  const answerColorIssue = (index: number): "format" | "contrast" | "duplicate" | null => {
    const customDraft = customColorDrafts[answerIdAt(index)]?.value;
    if (customDraft !== undefined && normalizeChatVoteColor(customDraft) === null) return "format";
    const color = customDraft === undefined ? answerColorAt(index) : normalizeChatVoteColor(customDraft) ?? answerColorAt(index);
    if (draft.value.answerColors.some((existing, otherIndex) => otherIndex !== index && existing === color)) return "duplicate";
    return voteColorContrastIssue(color);
  };
  const colorError = draft.value.answerColors.length !== draft.value.labels.length
    ? labels.colorDuplicateError
    : draft.value.labels.map((_answer, index) => answerColorIssue(index)).map((issue) => issue === "format" ? labels.colorFormatError
      : issue === "contrast" ? labels.colorContrastError : issue === "duplicate" ? labels.colorDuplicateError : null)
      .find((message) => message !== null) ?? null;
  const unreachableError = draft.value.shortcut === null && !draft.value.offerInCockpit ? labels.shortcutOrCockpit : null;
  const saveInvalidReason = shortcutError ?? unreachableError ?? colorError ?? (blankDraft(draft.value) ? labels.emptyDraftError : null);
  const title = draft.value.title.trim() || labels.untitled;
  const yesNoLabels = language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  const isYesNoTemplate = draft.value.freeTextMode === null
    && draft.value.labels.length === 2
    && draft.value.labels.every((label, index) => label.trim().toLocaleLowerCase() === yesNoLabels[index]?.toLocaleLowerCase());
  const previewOptions = draft.value.freeTextMode === null ? draft.value.labels : [];
  const previewText = `${draft.value.title.trim() || labels.previewQuestion}${previewOptions.length === 0 ? "" : ` — ${previewOptions.map((option, index) => `${String(index + 1)}. ${option}`).join(" · ")}`}`;
  const previewAnswerLabels = draft.value.freeTextMode !== null
    ? [1, 2, 3].map((number) => labels.freeTextPreview(number))
    : draft.value.labels.length === 0 ? [labels.ghostYes, labels.ghostNo]
      : draft.value.labels.map((answer, index) => answer.trim() || labels.answer(index + 1));
  const previewWeights = previewAnswerLabels.map((_answer, index) => [46, 32, 22, 16, 12, 9, 6, 4, 3][index] ?? 2);
  const previewWeightTotal = previewWeights.reduce((total, weight) => total + weight, 0);
  const colorPreviewRows = previewAnswerLabels.map((answer, index) => ({
    answer,
    color: draft.value.freeTextMode !== null ? chatVoteDefaultColorAt(index) : answerColorAt(index),
    percent: Math.round((previewWeights[index] ?? 0) * 100 / previewWeightTotal),
  }));
  const resultVoteResult = "Pizza: 8 (67%) · Burger: 4 (33%)";
  const previewResult = chatVoteResultPreview(language, draft.value.resultText ?? "{vote.result}", draft.value.title.trim() || null, resultVoteResult, {
    "vote.result": resultVoteResult,
    "vote.title": draft.value.title.trim() || labels.previewQuestion,
    "vote.options": draft.value.labels.map((answer, index) => `${String(index + 1)} = ${answer}`).join(", "),
    "vote.duration": chatVoteDurationText(draft.value.durationSeconds, language),
  });

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

  const updateDraft = (update: Partial<ChatVoteTemplateDraft>, options: { keepReloadPending?: boolean } = {}): void => {
    if (options.keepReloadPending !== true) invalidateReload();
    const next = { ...draftValue.current, ...update };
    draftValue.current = next;
    draft.setValue(next);
    setSaved(false);
    setSaveError(undefined);
    if ("shortcut" in update) setServerShortcutError(null);
  };

  const updateAnswerLabels = (nextLabels: readonly string[], nextColors?: readonly string[], nextAnswerIds?: readonly string[]): void => {
    const colors = nextColors === undefined ? [] : [...nextColors];
    if (nextColors === undefined) {
      nextLabels.forEach((_label, index) => {
        colors.push(draftValue.current.answerColors[index] ?? nextUnusedChatVoteDefaultColor(colors));
      });
    }
    const currentAnswerIds = answerIdsRef.current;
    const answerIds = nextAnswerIds ?? [
      ...currentAnswerIds.slice(0, nextLabels.length),
      ...nextLabels.slice(currentAnswerIds.length).map(() => createAnswerId()),
    ];
    answerIdsRef.current = answerIds;
    setAnswerIds(answerIds);
    const remainingAnswerIds = new Set(answerIds);
    updateCustomColorDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => remainingAnswerIds.has(id))));
    updateDraft({ labels: nextLabels, answerColors: colors });
  };

  const changeAnswerColor = (answerId: string, index: number, value: string): void => {
    const generation = ++customColorEditGeneration.current;
    updateCustomColorDrafts((current) => ({ ...current, [answerId]: { value, generation } }));
    const normalized = normalizeChatVoteColor(value);
    if (normalized === null) return;
    const nextColors = draftValue.current.labels.map((_label, colorIndex) => draftValue.current.answerColors[colorIndex] ?? chatVoteDefaultColorAt(colorIndex));
    nextColors[index] = normalized;
    updateDraft({ answerColors: nextColors }, { keepReloadPending: true });
  };

  const applyAnswerColor = (answerId: string, index: number, value: string): void => {
    const normalized = normalizeChatVoteColor(value);
    if (normalized === null) return;
    const nextColors = draftValue.current.labels.map((_label, colorIndex) => draftValue.current.answerColors[colorIndex] ?? chatVoteDefaultColorAt(colorIndex));
    nextColors[index] = normalized;
    updateDraft({ answerColors: nextColors });
    clearCustomColorDrafts(answerId);
  };

  const saveDraft = async (): Promise<string | null> => {
    if (!canManageContent || saving || conflict) return labels.saveError;
    if (saveInvalidReason !== null) {
      setSaveError(labels.invalid);
      return saveInvalidReason;
    }
    const submitted = { ...draftValue.current, labels: [...draftValue.current.labels], answerColors: [...draftValue.current.answerColors] };
    const submittedColorDrafts = { ...customColorDraftsRef.current };
    if (blankDraft(submitted)) {
      setSaveError(labels.emptyDraftError);
      return labels.emptyDraftError;
    }
    setSaving(true);
    setSaveError(undefined);
    setResultTextError(undefined);
    setSaved(false);
    const submittedResultText = submitted.resultText ?? "{vote.result}";
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
      const remainingColorDrafts: Record<string, CustomColorDraft> = {};
      for (const [answerId, currentColorDraft] of Object.entries(customColorDraftsRef.current)) {
        const submittedColorDraft = submittedColorDrafts[answerId];
        if (submittedColorDraft === undefined || currentColorDraft.generation !== submittedColorDraft.generation) {
          remainingColorDrafts[answerId] = currentColorDraft;
        }
      }
      updateCustomColorDrafts(() => remainingColorDrafts);
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
      setSaved(JSON.stringify(current) === JSON.stringify(submitted) && Object.keys(remainingColorDrafts).length === 0);
      onTemplateSaved(next, template.id);
      return null;
    } catch (error: unknown) {
      if (error instanceof PanelApiError && error.status === 409 && error.code === "chat_vote_template_conflict") {
        setConflict(true);
        setSaveError(undefined);
        return labels.saveConflict;
      } else if (error instanceof PanelApiError && error.status === 409 && error.code === "chat_vote_template_shortcut_conflict") {
        setServerShortcutError(labels.shortcutDuplicate);
        setSaveError(labels.shortcutUnavailable);
        return labels.shortcutUnavailable;
      } else if (error instanceof PanelApiError && error.status === 409 && error.code === "chat_voting_result_text_reference_conflict") {
        if ((draftValue.current.resultText ?? "{vote.result}") !== submittedResultText) return labels.unsaved;
        setResultTextError(labels.referenceMissing);
        setSaveError(undefined);
        return labels.referenceMissing;
      } else if (error instanceof PanelApiError && error.code === "chat_vote_template_limit") {
        setSaveError(labels.templateLimit);
        return labels.templateLimit;
      } else {
        setSaveError(labels.saveError);
        return labels.saveError;
      }
    } finally {
      setSaving(false);
    }
  };

  const saveForGuard = (): Promise<string | null> => saveDraft();
  const resetDraft = (): void => {
    invalidateReload();
    const nextAnswerIds = [
      ...answerIdsRef.current.slice(0, baselineDraft.current.labels.length),
      ...baselineDraft.current.labels.slice(answerIdsRef.current.length).map(() => createAnswerId()),
    ];
    answerIdsRef.current = nextAnswerIds;
    setAnswerIds(nextAnswerIds);
    draft.accept(baselineDraft.current);
    draftValue.current = baselineDraft.current;
    setSaveError(undefined);
    setResultTextError(undefined);
    setServerShortcutError(null);
    clearCustomColorDrafts();
    setConflict(false);
    setSaved(false);
  };
  const draftGuard = useDraftGuard(dirty, saveForGuard, resetDraft);

  const acceptTemplate = (accepted: ChatVoteTemplate): void => {
    invalidateReload();
    const nextDraft = draftFromTemplate(accepted);
    const nextAnswerIds = nextDraft.labels.map(() => createAnswerId());
    answerIdsRef.current = nextAnswerIds;
    setAnswerIds(nextAnswerIds);
    draftValue.current = nextDraft;
    baselineDraft.current = nextDraft;
    baseRevision.current = accepted.revision;
    draft.accept(nextDraft);
    setDurationMode(durationPreset(nextDraft.durationSeconds));
    setCustomDurationSelected(false);
    setSaved(false);
    setSaveError(undefined);
    setResultTextError(undefined);
    setServerShortcutError(null);
    clearCustomColorDrafts();
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
    const colorDraftsAtReloadStart = { ...customColorDraftsRef.current };
    const isCurrentRequest = (): boolean => reloadGeneration.current === requestGeneration;
    try {
      const latest = (await refetchModuleQueryData<ChatVoteTemplateListState>(queryClient, channelId, "chat_voting", "templates"))
        .templates.find((entry) => entry.id === template.id);
      if (!isCurrentRequest()) return;
      if (latest === undefined) {
        setSaveError(labels.conflictReloadMissing);
        return;
      }
      const serverDraft = draftFromTemplate(latest);
      const currentAnswerIds = answerIdsRef.current;
      const nextAnswerIds = reconcileAnswerIds(draftValue.current.labels, currentAnswerIds, serverDraft.labels, createAnswerId);
      answerIdsRef.current = nextAnswerIds;
      setAnswerIds(nextAnswerIds);
      const remainingColorDrafts: Record<string, CustomColorDraft> = {};
      const nextColors = [...serverDraft.answerColors];
      nextAnswerIds.forEach((answerId, index) => {
        const currentColorDraft = customColorDraftsRef.current[answerId];
        const colorDraftAtReloadStart = colorDraftsAtReloadStart[answerId];
        if (currentColorDraft === undefined || currentColorDraft.generation === colorDraftAtReloadStart?.generation) return;
        remainingColorDrafts[answerId] = currentColorDraft;
        const normalized = normalizeChatVoteColor(currentColorDraft.value);
        if (normalized !== null) nextColors[index] = normalized;
      });
      const nextDraft = { ...serverDraft, answerColors: nextColors };
      baseRevision.current = latest.revision;
      baselineDraft.current = serverDraft;
      draftValue.current = nextDraft;
      draft.accept(serverDraft);
      if (JSON.stringify(nextDraft) !== JSON.stringify(serverDraft)) draft.setValue(nextDraft);
      updateCustomColorDrafts(() => remainingColorDrafts);
      setCustomDurationSelected(false);
      setConflict(false);
      setSaveError(undefined);
      setResultTextError(undefined);
      setSaved(false);
      onTemplateSaved(latest, template.id);
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
        titleTooltip={title}
        headingLevel="h2"
        {...(canManageContent ? { saveStatus: <SaveStatus
          dirty={dirty}
          pending={saving}
          saved={saved || (!dirty && !isNew)}
          persistent
          warnings={dirty ? [labels.unsaved] : []}
          warningStatusLabel={(_warnings, justSaved) => justSaved ? labels.saved : labels.unsaved}
          {...(saveError === undefined ? {} : { error: saveError })}
          invalid={saveInvalidReason !== null && !hasInvalidCustomColorDraft}
          saveDisabled={hasInvalidCustomColorDraft}
          {...(saveInvalidReason === null ? {} : { invalidMessage: labels.invalid, onInvalidSave: () => { setSaveError(labels.invalid); } })}
          {...(conflict ? { conflict: { message: labels.saveConflict, reloadLabel: labels.conflictReload, onReload: () => { void reloadConflict(); } } } : {})}
          discardOnConflict
          onSave={() => { void saveDraft(); }}
          onDiscard={() => { if (isNew) onDiscardNew(); else resetDraft(); }}
          saveLabel={labels.save}
          discardLabel={labels.discard}
          savedLabel={labels.savedLabel}
          pendingLabel={labels.saving}
        /> } : {})}
        {...(!isNew ? { actions: <ActionMenu
          label={common.moreActions}
          items={[{ label: labels.delete, danger: canManageContent, disabled: !canManageContent, onSelect: () => {
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
          const answerId = answerIdAt(index);
          const answerProblem = answerError(index);
          return <div className="chat-voting-editor__answer" key={answerId}>
            <span className="mono chat-voting-editor__answer-key" aria-hidden="true">{String(answerNumber)}</span>
            <Field
              id={"chat-vote-answer-" + template.id + "-" + answerId}
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
                  updateAnswerLabels(next);
              }}
            />
              {draft.value.freeTextMode === null ? <PopoverPrimitive.Root>
                <PopoverPrimitive.Trigger render={<button
                  aria-label={labels.colorForAnswer(answerNumber)}
                  className="chat-voting-editor__color-trigger"
                  style={{ backgroundColor: answerColorAt(index) }}
                  type="button"
                />} />
                <PopoverContent align="end" side="bottom" role="dialog" aria-label={labels.colorForAnswer(answerNumber)} className="chat-voting-editor__color-popover">
                  <strong>{labels.colorForAnswer(answerNumber)}</strong>
                  <div aria-label={labels.paletteColors} className="chat-voting-editor__color-palette" role="group">
                    {CHAT_VOTE_PALETTE.map((color) => {
                      const used = draft.value.answerColors.some((existing, colorIndex) => colorIndex !== index && existing === color);
                      return <button
                        aria-label={color}
                        aria-pressed={answerColorAt(index) === color}
                        className={answerColorAt(index) === color ? "is-selected" : ""}
                        disabled={used}
                        key={color}
                        onClick={() => { applyAnswerColor(answerId, index, color); }}
                        style={{ backgroundColor: color }}
                        title={color}
                        type="button"
                      />;
                    })}
                  </div>
                  <Field
                    ariaLabel={labels.customHexColor}
                    className="chat-voting-editor__color-field"
                    label={labels.customHexColor}
                    onChange={(value) => { changeAnswerColor(answerId, index, value); }}
                    value={customColorDrafts[answerId]?.value ?? answerColorAt(index)}
                  />
                  <span aria-live="polite" className="chat-voting-editor__color-feedback">
                    {answerColorIssue(index) === "format" ? labels.colorFormatError
                      : answerColorIssue(index) === "contrast" ? labels.colorContrastError
                        : answerColorIssue(index) === "duplicate" ? labels.colorDuplicateError : " "}
                  </span>
                </PopoverContent>
              </PopoverPrimitive.Root> : null}
            <Button
              icon="close"
              iconOnly
              size="compact"
              variant="subtle"
              ariaLabel={labels.removeAnswer(answerNumber)}
              onClick={() => { updateAnswerLabels(draft.value.labels.filter((_label, labelIndex) => labelIndex !== index), draft.value.answerColors.filter((_color, colorIndex) => colorIndex !== index), answerIds.filter((_answerId, answerIndex) => answerIndex !== index)); }}
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
            onClick={() => { updateAnswerLabels([...draft.value.labels, ""]); }}
          >{labels.addAnswer}</Button>
        </div>
        <div aria-label={labels.colorPreview} className="chat-voting-editor__color-preview" data-testid="chat-vote-color-preview">
          <div className="chat-voting-editor__color-preview-heading">
            <strong>{labels.colorPreview}</strong>
            <Button
              icon="reload"
              size="compact"
              variant="subtle"
              disabled={draft.value.freeTextMode !== null}
              onClick={() => {
                updateDraft({ answerColors: draft.value.labels.map((_answer, index) => chatVoteDefaultColorAt(index)) });
                clearCustomColorDrafts();
              }}
            >{labels.restoreDefaults}</Button>
          </div>
          <div className="chat-voting-editor__color-preview-rows">
            {colorPreviewRows.map((row, index) => <div className="chat-voting-editor__color-preview-row" key={`preview-${String(index)}`}>
              <div><strong>{row.answer}</strong><span>{String(row.percent)} %</span></div>
              <span className="chat-voting-editor__color-preview-track"><span style={{ width: `${String(row.percent)}%`, backgroundColor: row.color }} /></span>
            </div>)}
          </div>
        </div>
      </InspectorSection>
      <p className="chat-voting-editor__chat-hint">{isYesNoTemplate ? labels.chatHintYesNo : labels.chatHint}</p>
      <ChatPreview label={labels.preview} speaker={labels.bot} text={previewText} countLabel={labels.previewCountLabel(voteLabelLength(previewText))} />

      <InspectorSection title={labels.quickTemplates}>
        <div className="chat-voting-editor__quick-templates">
          <Button size="compact" variant="neutral" onClick={() => { const next = language === "de" ? ["Ja", "Nein"] : ["Yes", "No"]; updateAnswerLabels(next, next.map((_answer, index) => chatVoteDefaultColorAt(index)), next.map(() => createAnswerId())); }}>{labels.yesNo}</Button>
          <Button size="compact" variant="neutral" onClick={() => { const next = ["1", "2", "3", "4", "5"]; updateAnswerLabels(next, next.map((_answer, index) => chatVoteDefaultColorAt(index)), next.map(() => createAnswerId())); }}>{labels.scale}</Button>
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
            {durationMode === "custom" ? <UnitInput
              label={labels.seconds}
              ariaLabel={labels.seconds}
              value={draft.value.durationSeconds}
              min={0}
              max={14_400}
              step={30}
              unit="s"
              hint={labels.durationHint}
              id={"chat-vote-duration-" + template.id}
              onChange={(value) => { updateDraft({ durationSeconds: typeof value === "number" ? value : 0 }); }}
            /> : null}
          </div>
        </div>
      </InspectorSection>

      <div className="chat-voting-editor__result-text">
        <TemplateTextField
          label={resultTextCopy.label}
          hint={resultTextCopy.hint}
          value={draft.value.resultText ?? "{vote.result}"}
          onChange={(resultText) => { setResultTextError(undefined); updateDraft({ resultText }); }}
          maxLength={500}
          variables={resultTextVariables}
          preview={() => previewResult}
          previewLabel={labels.preview}
          previewSpeaker={labels.bot}
          previewEmptyText={labels.resultPreviewOff}
          minRows={2}
          messages={resultTextCopy.templateMessages}
          {...(resultTextError === undefined ? {} : { error: resultTextError })}
        />
      </div>

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
        <div className="chat-voting-editor__cockpit-offer">
          <SwitchRow
            label={labels.offerInCockpit}
            hint={labels.offerInCockpitHint}
            checked={draft.value.offerInCockpit}
            invalid={unreachableError !== null}
            onChange={(offerInCockpit) => { updateDraft({ offerInCockpit }); }}
          />
          <span aria-live="polite" className="chat-voting-editor__cockpit-feedback">
            {unreachableError ?? " "}
          </span>
        </div>
      </InspectorSection>
      </> : <>
        <dl className="properties chat-voting-template-inspector__properties">
          <div><dt>{labels.question}</dt><dd>{template.title || labels.untitled}</dd></div>
          <div><dt>{labels.answers}</dt><dd>{template.freeTextMode === null ? template.labels.join(", ") : labels.freeText}</dd></div>
          <div><dt>{labels.duration}</dt><dd>{chatVoteDurationText(template.durationSeconds, language)}</dd></div>
          <div><dt>{resultTextCopy.label}</dt><dd>{template.resultText ?? "{vote.result}"}</dd></div>
          <div><dt>{labels.shortcut}</dt><dd>{template.shortcut === null ? "—" : `${labels.shortcutPrefix} ${template.shortcut}`}</dd></div>
          <div><dt>{labels.offerInCockpit}</dt><dd>{template.offerInCockpit ? labels.cockpitOffer : labels.chatOnly}</dd></div>
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
      {...(saveInvalidReason === null && canManageContent ? { alternative: { label: dashboardTexts(language).module.saveAndSwitch, onClick: () => { void draftGuard.saveAndSwitch(); } } } : {})}
      pending={draftGuard.saving || saving}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
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

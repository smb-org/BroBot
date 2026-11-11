import { createElement, lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import {
  ColorField,
  ConfirmDialog,
  Dialog,
  Field,
  FieldError,
  SaveStatus,
  SegmentChoice,
  Select,
  SwitchRow,
  UnitInput,
  registerDashboardNavigationGuard,
  useDraft,
  useDraftGuard,
} from "../../../dashboard/ui";
import type { ChannelPointsActionDefinition, RegisteredChannelPointsAction } from "../../contract";
import {
  channelPointsRewardInputSchema,
  type ChannelPointsReward,
  type ChannelPointsRewardInput,
} from "../contracts";
import type { ChannelPointsModuleAvailability } from "./service";
import { channelPointsPanelTexts } from "./locale";

type Language = "de" | "en";
type ChannelPointsAction = ChannelPointsActionDefinition;
interface ActionEditorProperties {
  config: Readonly<Record<string, unknown>>;
  onChange: (config: Readonly<Record<string, unknown>>) => void;
  language: Language;
}
type ActionEditorLoader = NonNullable<ChannelPointsAction["editor"]>;
const lazyActionEditors = new WeakMap<ActionEditorLoader, LazyExoticComponent<ComponentType<ActionEditorProperties>>>();

const getLazyActionEditor = (loader: ActionEditorLoader): LazyExoticComponent<ComponentType<ActionEditorProperties>> => {
  const existing = lazyActionEditors.get(loader);
  if (existing !== undefined) return existing;
  const created = lazy(loader);
  lazyActionEditors.set(loader, created);
  return created;
};
type EditorField = "title" | "prompt" | "cost" | "globalCooldownSeconds" | "maxPerStream" |
  "maxPerUserPerStream" | "action" | "actionConfig";

interface RewardDraft {
  title: string;
  prompt: string;
  cost: number | "";
  backgroundColor: string | null;
  isUserInputRequired: boolean;
  globalCooldownEnabled: boolean;
  globalCooldownSeconds: number | "";
  maxPerStreamEnabled: boolean;
  maxPerStream: number | "";
  maxPerUserPerStreamEnabled: boolean;
  maxPerUserPerStream: number | "";
  actionModuleId: string;
  actionId: string;
  actionConfig: Record<string, unknown>;
  mode: "auto" | "queue";
  enabled: boolean;
}

const CHAT_ACTION_MODULE_ID = "channel_points";
const CHAT_ACTION_ID = "chat-message";
const defaultActionConfig = (moduleId: string, actionId: string): Record<string, unknown> =>
  moduleId === CHAT_ACTION_MODULE_ID && actionId === CHAT_ACTION_ID
    ? { message: "Danke, {user}!" }
    : {};

const newDraft = (): RewardDraft => ({
  title: "",
  prompt: "",
  cost: 1,
  backgroundColor: null,
  isUserInputRequired: false,
  globalCooldownEnabled: false,
  globalCooldownSeconds: 30,
  maxPerStreamEnabled: false,
  maxPerStream: 1,
  maxPerUserPerStreamEnabled: false,
  maxPerUserPerStream: 1,
  actionModuleId: CHAT_ACTION_MODULE_ID,
  actionId: CHAT_ACTION_ID,
  actionConfig: defaultActionConfig(CHAT_ACTION_MODULE_ID, CHAT_ACTION_ID),
  mode: "auto",
  enabled: true,
});

const draftFromReward = (reward: ChannelPointsReward): RewardDraft => ({
  title: reward.title,
  prompt: reward.prompt ?? "",
  cost: reward.cost,
  backgroundColor: reward.backgroundColor,
  isUserInputRequired: reward.isUserInputRequired,
  globalCooldownEnabled: reward.globalCooldownSeconds !== null,
  globalCooldownSeconds: reward.globalCooldownSeconds ?? 30,
  maxPerStreamEnabled: reward.maxPerStream !== null,
  maxPerStream: reward.maxPerStream ?? 1,
  maxPerUserPerStreamEnabled: reward.maxPerUserPerStream !== null,
  maxPerUserPerStream: reward.maxPerUserPerStream ?? 1,
  actionModuleId: reward.actionModuleId,
  actionId: reward.actionId,
  actionConfig: reward.actionConfig,
  mode: reward.mode,
  enabled: reward.enabled,
});

const actionFor = (
  actions: readonly RegisteredChannelPointsAction[],
  moduleId: string,
  actionId: string,
): ChannelPointsAction | undefined => actions.find(({ moduleId: providerId, definition }) =>
  providerId === moduleId && definition.id === actionId,
)?.definition;

const actionKey = (moduleId: string, actionId: string): string => `${moduleId}:${actionId}`;

const actionFromKey = (key: string): { moduleId: string; actionId: string } | null => {
  const divider = key.indexOf(":");
  return divider < 1 ? null : { moduleId: key.slice(0, divider), actionId: key.slice(divider + 1) };
};

const recordValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const rewardInput = (draft: RewardDraft, actionConfig: Record<string, unknown>): unknown => ({
  title: draft.title,
  prompt: draft.prompt.trim().length === 0 ? null : draft.prompt,
  cost: draft.cost,
  backgroundColor: draft.backgroundColor,
  isUserInputRequired: draft.isUserInputRequired,
  globalCooldownSeconds: draft.globalCooldownEnabled && typeof draft.globalCooldownSeconds === "number"
    ? draft.globalCooldownSeconds : null,
  maxPerStream: draft.maxPerStreamEnabled && typeof draft.maxPerStream === "number" ? draft.maxPerStream : null,
  maxPerUserPerStream: draft.maxPerUserPerStreamEnabled && typeof draft.maxPerUserPerStream === "number"
    ? draft.maxPerUserPerStream : null,
  actionModuleId: draft.actionModuleId,
  actionId: draft.actionId,
  actionConfig,
  mode: draft.mode,
  enabled: draft.enabled,
});

const localErrorsFor = (draft: RewardDraft, labels: typeof channelPointsPanelTexts.en): Partial<Record<EditorField, string>> => {
  const errors: Partial<Record<EditorField, string>> = {};
  const title = draft.title.trim();
  if (title.length === 0) errors.title = labels.required;
  else if (title.length > 45) errors.title = labels.titleLimit;
  if (draft.prompt.length > 200) errors.prompt = labels.promptLimit;
  if (typeof draft.cost !== "number" || !Number.isInteger(draft.cost) || draft.cost < 1 || draft.cost > 1_000_000) {
    errors.cost = labels.costInvalid;
  }
  if (draft.globalCooldownEnabled && (typeof draft.globalCooldownSeconds !== "number" ||
      !Number.isInteger(draft.globalCooldownSeconds) || draft.globalCooldownSeconds < 1 || draft.globalCooldownSeconds > 604_800)) {
    errors.globalCooldownSeconds = labels.limitInvalid;
  }
  if (draft.maxPerStreamEnabled && (typeof draft.maxPerStream !== "number" ||
      !Number.isInteger(draft.maxPerStream) || draft.maxPerStream < 1 || draft.maxPerStream > 1_000_000)) {
    errors.maxPerStream = labels.limitInvalid;
  }
  if (draft.maxPerUserPerStreamEnabled && (typeof draft.maxPerUserPerStream !== "number" ||
      !Number.isInteger(draft.maxPerUserPerStream) || draft.maxPerUserPerStream < 1 || draft.maxPerUserPerStream > 1_000_000)) {
    errors.maxPerUserPerStream = labels.limitInvalid;
  }
  return errors;
};

const mappedApiError = (
  error: unknown,
  labels: typeof channelPointsPanelTexts.en,
): { fields: Partial<Record<EditorField, string>>; message: string; readiness?: string } => {
  if (!(error instanceof PanelApiError)) return { fields: {}, message: labels.requestFailed };
  const fields: Partial<Record<EditorField, string>> = {};
  if (error.code === "channel_points_duplicate_title") fields.title = labels.duplicateTitle;
  if (error.code === "channel_points_reward_limit") return { fields, message: labels.rewardLimit };
  if (error.code?.includes("config_invalid") === true) fields.actionConfig = labels.invalidActionConfig;
  if (error.code === "channel_points_action_needs_input") fields.action = labels.inputRequiredError;
  if (error.code === "channel_points_action_unknown") fields.action = labels.actionUnknown;
  if (error.code === "channel_points_invalid_reward") {
    const details = error.details;
    const invalidFields = typeof details === "object" && details !== null && "fields" in details
      ? (details as { fields?: unknown }).fields
      : null;
    if (Array.isArray(invalidFields)) {
      for (const invalidField of invalidFields) {
        if (typeof invalidField !== "object" || invalidField === null || !("path" in invalidField)) continue;
        const path: unknown = (invalidField as { path?: unknown }).path;
        if (!Array.isArray(path) || typeof path[0] !== "string") continue;
        const name = path[0];
        if (name === "title" || name === "prompt" || name === "cost" || name === "globalCooldownSeconds" ||
            name === "maxPerStream" || name === "maxPerUserPerStream") {
          fields[name] = labels.invalidReward;
        }
        if (name === "actionConfig") fields.actionConfig = labels.invalidActionConfig;
      }
    }
  }
  if (error.code === "channel_points_not_affiliate") {
    return { fields, message: labels.notAffiliate, readiness: labels.notAffiliate };
  }
  if (error.code === "channel_points_scope_missing") {
    const readiness = labels.missingScopes(["channel:read:redemptions", "channel:manage:redemptions"]);
    return { fields, message: readiness, readiness };
  }
  if (["channel_points_not_connected", "channel_points_token_unavailable", "channel_points_revoked", "channel_points_refresh_failed"]
    .includes(error.code ?? "")) {
    return { fields, message: labels.missingAuthorization, readiness: labels.missingAuthorization };
  }
  if (error.code === "channel_points_management_denied") return { fields, message: labels.managementDenied };
  if (error.code === "channel_points_operation_denied") return { fields, message: labels.operationDenied };
  if (error.code === "channel_points_invalid_reward" && Object.keys(fields).length === 0) {
    return { fields, message: labels.invalidReward };
  }
  if (Object.keys(fields).length > 0) return { fields, message: labels.invalidReward };
  return { fields, message: labels.requestFailed };
};

function LazyActionEditor({
  action,
  config,
  onChange,
  language,
}: {
  action: ChannelPointsAction;
  config: Readonly<Record<string, unknown>>;
  onChange: (config: Readonly<Record<string, unknown>>) => void;
  language: Language;
}): ReactElement {
  const Editor = action.editor === undefined ? null : getLazyActionEditor(action.editor);
  if (Editor === null) return <p className="channel-points-editor__note">{channelPointsPanelTexts[language].noActionSettings}</p>;
  return <Suspense fallback={<div className="channel-points-editor__action-loading" role="status">{channelPointsPanelTexts[language].loading}</div>}>
    {createElement(Editor, { config, onChange, language })}
  </Suspense>;
}

export interface RewardEditorDialogProperties {
  language: Language;
  reward: ChannelPointsReward | null;
  channelPointsActions: readonly RegisteredChannelPointsAction[];
  moduleAvailability: readonly ChannelPointsModuleAvailability[];
  onClose: () => void;
  onSave: (input: ChannelPointsRewardInput, rewardId: string | null) => Promise<ChannelPointsReward>;
  onReadinessError: (message: string) => void;
}

export default function RewardEditorDialog({ language, reward, moduleAvailability, channelPointsActions, onClose, onSave, onReadinessError }: RewardEditorDialogProperties): ReactElement {
  const labels = channelPointsPanelTexts[language];
  const initial = reward === null ? newDraft() : draftFromReward(reward);
  const draft = useDraft(initial);
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<EditorField, string>>>({});
  const [saveError, setSaveError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const selectedAction = actionFor(channelPointsActions, draft.value.actionModuleId, draft.value.actionId);
  const selectedProviderState = moduleAvailability.find(({ id }) => id === draft.value.actionModuleId);
  const selectedProviderEnabled = selectedProviderState?.enabled === true;
  const selectedProviderReason = selectedProviderState === undefined
    ? labels.actionProvidersUnavailable
    : labels.actionProviderDisabled;
  const actionConfigResult = selectedAction?.configSchema.safeParse(draft.value.actionConfig);
  const outputConfig = actionConfigResult?.success === true ? recordValue(actionConfigResult.data) : draft.value.actionConfig;
  useEffect(() => {
    if (selectedAction?.requiresUserInput === true && !draft.value.isUserInputRequired) {
      draft.setValue((current) => ({ ...current, isUserInputRequired: true }));
    }
  }, [draft, draft.value.isUserInputRequired, selectedAction]);
  const parsed = useMemo(
    () => channelPointsRewardInputSchema.safeParse(rewardInput(draft.value, outputConfig)),
    [draft.value, outputConfig],
  );
  const localErrors = attempted ? localErrorsFor(draft.value, labels) : {};
  const errors = { ...localErrors, ...serverErrors };
  const actionOptions = channelPointsActions.map(({ moduleId, definition }) => {
    const providerEnabled = moduleAvailability.find((candidate) => candidate.id === moduleId)?.enabled === true;
    return {
      value: actionKey(moduleId, definition.id),
      label: definition.name[language],
      ...(providerEnabled ? {} : {
        description: moduleAvailability.some((candidate) => candidate.id === moduleId)
          ? labels.actionProviderDisabled
          : labels.actionProvidersUnavailable,
        disabled: true,
      }),
    };
  });

  const clearErrors = (): void => {
    setServerErrors({});
    setSaveError(undefined);
    setSaved(false);
  };

  const persistDraft = async (): Promise<string | null> => {
    setAttempted(true);
    setSaved(false);
    setSaveError(undefined);
    setServerErrors({});
    if (selectedAction === undefined) {
      setServerErrors({ action: labels.actionUnknown });
      setSaveError(labels.actionUnknown);
      return labels.actionUnknown;
    }
    if (!selectedProviderEnabled) {
      setServerErrors({ action: selectedProviderReason });
      setSaveError(selectedProviderReason);
      return selectedProviderReason;
    }
    if (selectedAction.requiresUserInput === true && !draft.value.isUserInputRequired) {
      setServerErrors({ action: labels.inputRequiredError });
      setSaveError(labels.inputRequiredError);
      return labels.inputRequiredError;
    }
    const actionConfig = selectedAction.configSchema.safeParse(draft.value.actionConfig);
    if (!actionConfig.success) {
      setServerErrors({ actionConfig: labels.invalidActionConfig });
      setSaveError(labels.invalidActionConfig);
      return labels.invalidActionConfig;
    }
    const validation = channelPointsRewardInputSchema.safeParse(rewardInput(draft.value, recordValue(actionConfig.data)));
    if (!validation.success || Object.keys(localErrorsFor(draft.value, labels)).length > 0) {
      setSaveError(labels.invalidReward);
      return labels.invalidReward;
    }
    setPending(true);
    try {
      await onSave(validation.data, reward?.id ?? null);
      draft.accept(draftFromReward({
        ...validation.data,
        id: reward?.id ?? "new-reward",
        twitchRewardId: reward?.twitchRewardId ?? "new-reward",
        twitchState: "active",
        createdAt: reward?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      setSaved(true);
      return null;
    } catch (error) {
      const mapped = mappedApiError(error, labels);
      setServerErrors(mapped.fields);
      setSaveError(mapped.message);
      if (mapped.readiness !== undefined) onReadinessError(mapped.readiness);
      return mapped.message;
    } finally {
      setPending(false);
    }
  };

  const saveAndClose = async (): Promise<void> => {
    const error = await persistDraft();
    if (error === null) onClose();
  };
  const draftGuard = useDraftGuard(draft.dirty, persistDraft, draft.reset);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);
  const requestClose = (): void => {
    if (!pending) draftGuard.guardSwitch(onClose);
  };

  const update = (next: (current: RewardDraft) => RewardDraft): void => {
    if (pending) return;
    clearErrors();
    draft.setValue(next);
  };

  const setAction = (value: string | null): void => {
    if (value === null) return;
    const selected = actionFromKey(value);
    if (selected === null) return;
    const action = actionFor(channelPointsActions, selected.moduleId, selected.actionId);
    if (action === undefined || moduleAvailability.find(({ id }) => id === selected.moduleId)?.enabled !== true) return;
    update((current) => ({
      ...current,
      actionModuleId: selected.moduleId,
      actionId: selected.actionId,
      actionConfig: defaultActionConfig(selected.moduleId, selected.actionId),
      isUserInputRequired: action.requiresUserInput === true ? true : current.isUserInputRequired,
    }));
  };

  const title = reward === null ? labels.createTitle : labels.editTitle;
  const actionConfigError = errors.actionConfig ?? (
    attempted && actionConfigResult?.success === false ? labels.invalidActionConfig : undefined
  );
  const valid = parsed.success && Object.keys(localErrorsFor(draft.value, labels)).length === 0 &&
    selectedAction !== undefined && selectedProviderEnabled && actionConfigResult?.success === true;

  return <>
    <Dialog opened title={title} onClose={requestClose} pending={pending} className="channel-points-editor-dialog">
      <div className="channel-points-editor">
        <fieldset className="channel-points-editor__form" disabled={pending} aria-label={title}>
          <div className="channel-points-editor__fields">
            <Field
              label={labels.title}
              value={draft.value.title}
              maxLength={45}
              countLabel={labels.counter}
              {...(errors.title === undefined ? {} : { error: errors.title })}
              onChange={(value) => update((current) => ({ ...current, title: value }))}
            />
            <Field
              label={labels.prompt}
              value={draft.value.prompt}
              maxLength={200}
              countLabel={labels.counter}
              {...(errors.prompt === undefined ? {} : { error: errors.prompt })}
              onChange={(value) => update((current) => ({ ...current, prompt: value }))}
            />
            <UnitInput
              label={labels.cost}
              value={draft.value.cost}
              min={1}
              max={1_000_000}
              unit={labels.points}
              {...(errors.cost === undefined ? {} : { error: errors.cost })}
              onChange={(cost) => update((current) => ({ ...current, cost }))}
            />
            <ColorField
              id="channel-points-background-color"
              label={labels.backgroundColor}
              value={draft.value.backgroundColor ?? undefined}
              unsetLabel={labels.unsetColor}
              clearLabel={labels.clearColor}
              onChange={(backgroundColor) => update((current) => ({ ...current, backgroundColor: backgroundColor ?? null }))}
            />
          </div>

          <div className="channel-points-editor__limits">
            <div className="channel-points-limit">
              <SwitchRow
                label={labels.maxPerStream}
                checked={draft.value.maxPerStreamEnabled}
                onChange={(maxPerStreamEnabled) => update((current) => ({ ...current, maxPerStreamEnabled }))}
              />
              {draft.value.maxPerStreamEnabled ? <UnitInput
                label={labels.maxPerStream}
                ariaLabel={labels.maxPerStream}
                value={draft.value.maxPerStream}
                min={1}
                max={1_000_000}
                unit={labels.perStreamUnit}
                {...(errors.maxPerStream === undefined ? {} : { error: errors.maxPerStream })}
                onChange={(maxPerStream) => update((current) => ({ ...current, maxPerStream }))}
              /> : null}
            </div>
            <div className="channel-points-limit">
              <SwitchRow
                label={labels.maxPerUserPerStream}
                checked={draft.value.maxPerUserPerStreamEnabled}
                onChange={(maxPerUserPerStreamEnabled) => update((current) => ({ ...current, maxPerUserPerStreamEnabled }))}
              />
              {draft.value.maxPerUserPerStreamEnabled ? <UnitInput
                label={labels.maxPerUserPerStream}
                ariaLabel={labels.maxPerUserPerStream}
                value={draft.value.maxPerUserPerStream}
                min={1}
                max={1_000_000}
                unit={labels.perPersonUnit}
                {...(errors.maxPerUserPerStream === undefined ? {} : { error: errors.maxPerUserPerStream })}
                onChange={(maxPerUserPerStream) => update((current) => ({ ...current, maxPerUserPerStream }))}
              /> : null}
            </div>
            <div className="channel-points-limit">
              <SwitchRow
                label={labels.cooldown}
                checked={draft.value.globalCooldownEnabled}
                onChange={(globalCooldownEnabled) => update((current) => ({ ...current, globalCooldownEnabled }))}
              />
              {draft.value.globalCooldownEnabled ? <UnitInput
                label={labels.cooldown}
                ariaLabel={labels.cooldown}
                value={draft.value.globalCooldownSeconds}
                min={1}
                max={604_800}
                unit={labels.seconds}
                {...(errors.globalCooldownSeconds === undefined ? {} : { error: errors.globalCooldownSeconds })}
                onChange={(globalCooldownSeconds) => update((current) => ({ ...current, globalCooldownSeconds }))}
              /> : null}
            </div>
          </div>

          <SwitchRow
            label={labels.userInput}
            checked={draft.value.isUserInputRequired || selectedAction?.requiresUserInput === true}
            onChange={(isUserInputRequired) => update((current) => ({ ...current, isUserInputRequired }))}
            {...(selectedAction?.requiresUserInput === true ? { lockedReason: labels.inputLockReason } : {})}
          />

          <div className="channel-points-editor__action">
            <Select
              label={labels.action}
              value={actionKey(draft.value.actionModuleId, draft.value.actionId)}
              options={actionOptions}
              {...(errors.action === undefined ? {} : { error: errors.action })}
              onChange={setAction}
            />
            <div className="channel-points-editor__action-config">
              {selectedAction === undefined
                ? <p className="channel-points-editor__note">{labels.actionUnknown}</p>
                : selectedProviderEnabled
                  ? selectedAction.editor === undefined
                    ? <p className="channel-points-editor__note">{labels.noActionSettings}</p>
                    : <LazyActionEditor
                      action={selectedAction}
                      config={draft.value.actionConfig}
                      language={language}
                      onChange={(actionConfig) => update((current) => ({ ...current, actionConfig: recordValue(actionConfig) }))}
                    />
                  : <p className="channel-points-editor__note">{selectedProviderReason}</p>}
              <FieldError message={actionConfigError} />
            </div>
          </div>

          <SegmentChoice
            label={labels.mode}
            value={draft.value.mode}
            onChange={(mode) => update((current) => ({ ...current, mode }))}
            options={[
              { value: "auto", label: labels.modeAutomatic, description: labels.modeAutomaticDescription },
              { value: "queue", label: labels.modeQueue, description: labels.modeQueueDescription },
            ]}
            reserveError
          />
        </fieldset>

        <SaveStatus
          persistent
          dirty={draft.dirty}
          pending={pending}
          saved={saved}
          {...(saveError === undefined ? {} : { error: saveError })}
          invalid={attempted && !valid}
          invalidMessage={labels.invalidReward}
          discardDisabled={pending}
          onSave={() => { void saveAndClose(); }}
          onInvalidSave={() => setAttempted(true)}
          onDiscard={() => { draft.reset(); setAttempted(false); clearErrors(); }}
          saveLabel={labels.save}
          discardLabel={labels.discard}
          savedLabel={labels.saved}
          pendingLabel={labels.saving}
        />
        <div className="sr-only" aria-live="polite">{saveError ?? ""}</div>
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
      pending={pending || draftGuard.saving}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
      onCancel={draftGuard.continueEditing}
      onConfirm={draftGuard.discardAndSwitch}
    />
  </>;
}

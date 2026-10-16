import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { dashboardLanguage } from "../../../dashboard/locale";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  ActionMenu, Button, ChatPreview, ConfirmDialog, EmptyState, Field, FieldPair, LoadState,
  LoadStateLines, PageHeader, RoleThreshold, RuleNote, SaveStatus, Section, SwitchRow, UnitInput,
  registerDashboardNavigationGuard, useDraft, useDraftGuard,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import {
  clipsSettingsSchema,
  MIN_AUTOMATIC_CLIP_COOLDOWN_SECONDS,
  type ClipsSettings,
  type SessionClipList,
} from "../contracts";
import { clipsPanelTexts } from "./locale";
import { loadClipsSettings, loadSessionClips, saveClipsSettings } from "./service";
import "./clips-panel.css";

type NumberSetting = "commandCooldownSeconds" | "automaticThresholdMultiplier" | "automaticCooldownSeconds";
type ClipsSettingsDraft = Omit<ClipsSettings, NumberSetting> & Record<NumberSetting, number | "">;
type ClipsSettingsData = Awaited<ReturnType<typeof loadClipsSettings>>;
type ClipsDraftKey = keyof ClipsSettingsDraft;

const DEFAULT_SETTINGS = clipsSettingsSchema.parse({});
const asDraft = (settings: ClipsSettings): ClipsSettingsDraft => ({ ...settings });
const overlayDraftKeys = (
  base: ClipsSettingsDraft,
  source: ClipsSettingsDraft,
  keys: Iterable<ClipsDraftKey>,
): ClipsSettingsDraft => {
  const next = { ...base };
  for (const key of keys) Object.assign(next, { [key]: source[key] });
  return next;
};

const validNumber = (value: number | "", minimum: number, maximum: number, integer: boolean): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isInteger(value));

const requireRevision = (revision: number | null): number => {
  if (revision === null || !Number.isSafeInteger(revision)) throw new Error("clips_settings_revision_missing");
  return revision;
};

const formatClipDate = (value: string, language: "de" | "en"): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

interface ClipsSettingsFormProps {
  channelId: string;
  data: ClipsSettingsData;
  language: "de" | "en";
  canManage: boolean;
  labels: ReturnType<typeof clipsPanelTexts>;
  onReload: () => Promise<ClipsSettingsData>;
}

function ClipsSettingsForm({ channelId, data, language, canManage, labels, onReload }: ClipsSettingsFormProps): ReactElement {
  const queryClient = useDashboardQueryClient();
  const draft = useDraft<ClipsSettingsDraft>(asDraft(data.settings));
  const draftRef = useRef(draft.value);
  const [draftRevision, setDraftRevision] = useState(data.revision);
  const pendingSave = useRef<Promise<string | null> | null>(null);
  const reloadTouched = useRef<Set<ClipsDraftKey> | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const dirty = draft.dirty;
  const formDraft = dirty ? draft.value : asDraft(data.settings);
  const conflict = dirty && data.revision !== draftRevision;
  const cooldownInvalid = !validNumber(formDraft.commandCooldownSeconds, 0, 86400, true);
  const multiplierInvalid = !validNumber(formDraft.automaticThresholdMultiplier, 1, 10, false);
  const automaticCooldownMinimum = formDraft.automaticClipsEnabled ? MIN_AUTOMATIC_CLIP_COOLDOWN_SECONDS : 0;
  const automaticCooldownInvalid = !validNumber(formDraft.automaticCooldownSeconds, automaticCooldownMinimum, 86400, true);
  const valid = !cooldownInvalid && !multiplierInvalid && !automaticCooldownInvalid && clipsSettingsSchema.safeParse(formDraft).success;
  const roleLabel = labels.roleOptions.find(({ value }) => value === formDraft.commandMinimumRole)?.label ?? formDraft.commandMinimumRole;
  const formattedThreshold = typeof formDraft.automaticThresholdMultiplier !== "number"
    ? "—"
    : new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 1 })
      .format(formDraft.automaticThresholdMultiplier);

  const discardDraft = useCallback((): void => {
    const latest = asDraft(data.settings);
    draftRef.current = latest;
    draft.accept(latest);
    setDraftRevision(data.revision);
    reloadTouched.current?.clear();
    setSaved(false);
    setSaveError(undefined);
    setAttemptedSave(false);
  }, [data, draft]);

  const saveDraft = useCallback((): Promise<string | null> => {
    if (pendingSave.current !== null) return pendingSave.current;
    if (!canManage || !draft.dirty) return Promise.resolve(null);
    setAttemptedSave(true);
    const parsed = clipsSettingsSchema.safeParse(draft.value);
    if (!parsed.success) return Promise.resolve(labels.invalid);

    setSaving(true);
    setSaveError(undefined);
    const operation = (async (): Promise<string | null> => {
      try {
        const result = await runModuleQueryWrite<{
          settings: ClipsSettings;
          revision: number;
          warnings: readonly unknown[];
        }>(
          queryClient,
          channelId,
          "clips",
          "clips-settings",
          (baselineRevision) => saveClipsSettings(channelId, requireRevision(baselineRevision), parsed.data),
          {
            baselineRevision: draftRevision,
            updateCache: (_current, value) => ({ settings: value.settings, revision: value.revision }),
            relatedParts: [{ moduleId: "clips", part: "settings" }],
          },
        );
        const latest = asDraft(result.settings);
        draftRef.current = latest;
        draft.accept(latest);
        setDraftRevision(result.revision);
        setSaved(true);
        setAttemptedSave(false);
        return null;
      } catch {
        setSaveError(labels.saveError);
        return labels.saveError;
      } finally {
        setSaving(false);
        pendingSave.current = null;
      }
    })();
    pendingSave.current = operation;
    return operation;
  }, [canManage, channelId, draft, draftRevision, labels.invalid, labels.saveError, queryClient]);

  const draftGuard = useDraftGuard(dirty, saveDraft, discardDraft);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);

  const updateSetting = <Key extends keyof ClipsSettingsDraft>(key: Key, value: ClipsSettingsDraft[Key]): void => {
    const current = dirty ? draft.value : asDraft(data.settings);
    if (!dirty) {
      draft.accept(current);
      setDraftRevision(data.revision);
    }
    const next = { ...current, [key]: value };
    draftRef.current = next;
    reloadTouched.current?.add(key);
    draft.setValue(next);
    setSaved(false);
    setSaveError(undefined);
    setAttemptedSave(false);
  };

  const reloadSettings = async (): Promise<void> => {
    if (reloading) return;
    reloadTouched.current = new Set();
    setReloading(true);
    try {
      const result = await onReload();
      const refreshed = asDraft(result.settings);
      const touched = reloadTouched.current;
      const merged = overlayDraftKeys(refreshed, draftRef.current, touched);
      draft.accept(refreshed);
      if (touched.size > 0) draft.setValue(merged);
      draftRef.current = merged;
      setDraftRevision(result.revision);
      setSaved(false);
      setSaveError(undefined);
      setAttemptedSave(false);
    } catch {
      return;
    } finally {
      reloadTouched.current = null;
      setReloading(false);
    }
  };

  const openRestore = (): void => { setRestoreOpen(true); };
  const confirmRestore = (): void => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as ClipsDraftKey[]) reloadTouched.current?.add(key);
    draftRef.current = asDraft(DEFAULT_SETTINGS);
    draft.setValue(asDraft(DEFAULT_SETTINGS));
    setSaved(false);
    setSaveError(undefined);
    setAttemptedSave(false);
    setRestoreOpen(false);
  };

  const saveStatus = canManage ? <SaveStatus
    persistent
    dirty={dirty}
    pending={saving || reloading}
    saved={saved}
    {...(saveError === undefined ? {} : { error: saveError })}
    invalid={attemptedSave && !valid}
    invalidMessage={labels.invalid}
    {...(conflict ? { conflict: {
      message: labels.conflictMessage,
      reloadLabel: labels.reloadSettings,
      onReload: () => { void reloadSettings(); },
    } } : {})}
    onInvalidSave={() => { setAttemptedSave(true); }}
    onSave={() => { void saveDraft(); }}
    onDiscard={discardDraft}
    saveLabel={labels.save}
    discardLabel={labels.discard}
    savedLabel={labels.saved}
    pendingLabel={labels.saving}
    destructive={<ActionMenu
      label={labels.actions}
      items={[{ label: labels.restoreDefaults, disabled: saving || reloading, onSelect: openRestore }]}
    />}
  /> : null;

  return <>
    <PageHeader
      kind="module"
      icon={null}
      title={labels.settingsTitle}
      headingLevel="h2"
      saveStatus={saveStatus}
    />
    {canManage ? <div className="clips-panel__settings">
      <Section title={labels.commandSection}>
        <FieldPair>
          <RoleThreshold
            label={labels.commandRole}
            value={formDraft.commandMinimumRole}
            options={labels.roleOptions}
            disabled={saving}
            onChange={(value) => { updateSetting("commandMinimumRole", value as ClipsSettings["commandMinimumRole"]); }}
          />
          <UnitInput
            id="clips-command-cooldown"
            label={labels.commandCooldown}
            hint={labels.commandCooldownHint}
            unit="s"
            min={0}
            max={86400}
            step={5}
            value={formDraft.commandCooldownSeconds}
            suggestions={[30, 60, 300]}
            disabled={saving}
            {...(attemptedSave && cooldownInvalid ? { error: labels.invalid } : {})}
            onChange={(value) => { updateSetting("commandCooldownSeconds", value); }}
          />
        </FieldPair>
      </Section>

      <Section title={labels.chatLink}>
        <SwitchRow
          label={labels.chatLinkEnabled}
          description={labels.chatLinkHint}
          checked={formDraft.postClipLinkInChat}
          disabled={saving}
          onChange={(value) => { updateSetting("postClipLinkInChat", value); }}
        />
        <div className="clips-panel__message-fields">
          <Field
            id="clips-chat-message"
            label={labels.chatMessage}
            hint={formDraft.postClipLinkInChat ? labels.chatMessageHint : labels.chatMessageDisabledHint}
            value={formDraft.chatLinkTemplate}
            onChange={(value) => { updateSetting("chatLinkTemplate", value); }}
            maxLength={500}
            countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
            disabled={saving || !formDraft.postClipLinkInChat}
            required
          />
          <ChatPreview
            label={labels.preview}
            speaker={labels.previewSpeaker}
            text={formDraft.chatLinkTemplate
              .replaceAll("{clip.title}", labels.previewClipTitle)
              .replaceAll("{clip.url}", labels.previewClipUrl)}
            countLabel={labels.previewCharacters(formDraft.chatLinkTemplate.length)}
          />
        </div>
      </Section>

      <Section title={labels.automaticSection}>
        <SwitchRow
          label={labels.automatic}
          description={labels.automaticHint}
          checked={formDraft.automaticClipsEnabled}
          disabled={saving}
          onChange={(value) => { updateSetting("automaticClipsEnabled", value); }}
        />
        <FieldPair>
          <UnitInput
            id="clips-auto-threshold"
            label={labels.threshold}
            {...(formDraft.automaticClipsEnabled ? { hint: labels.thresholdHint } : {})}
            unit={labels.thresholdUnit}
            min={1}
            max={10}
            step={0.1}
            value={formDraft.automaticThresholdMultiplier}
            suggestions={[1.5, 2, 2.5, 3]}
            disabled={saving || !formDraft.automaticClipsEnabled}
            {...(attemptedSave && multiplierInvalid ? { error: labels.invalid } : {})}
            onChange={(value) => { updateSetting("automaticThresholdMultiplier", value); }}
          />
          <UnitInput
            id="clips-auto-cooldown"
            label={labels.automaticCooldown}
            {...(formDraft.automaticClipsEnabled ? { hint: labels.automaticCooldownHint } : {})}
            unit="s"
            min={automaticCooldownMinimum}
            max={86400}
            step={30}
            value={formDraft.automaticCooldownSeconds}
            suggestions={[300, 900, 1800]}
            disabled={saving || !formDraft.automaticClipsEnabled}
            {...(attemptedSave && automaticCooldownInvalid ? { error: labels.invalid } : {})}
            onChange={(value) => { updateSetting("automaticCooldownSeconds", value); }}
          />
        </FieldPair>
        {formDraft.automaticClipsEnabled ? null : <p className="clips-panel__group-hint">{labels.automaticDisabledHint}</p>}
        <RuleNote>{labels.thresholdRule}</RuleNote>
      </Section>
      <RuleNote>{labels.helixRule}</RuleNote>
    </div> : <div className="clips-panel__readonly">
      <RuleNote>{labels.readOnlyReason}</RuleNote>
      <dl className="clips-panel__properties" aria-label={labels.settingsTitle}>
        <div className="clips-panel__property"><dt>{labels.commandRole}</dt><dd>{roleLabel}</dd></div>
        <div className="clips-panel__property"><dt>{labels.commandCooldown}</dt><dd>{String(formDraft.commandCooldownSeconds)} s</dd></div>
        <div className="clips-panel__property"><dt>{labels.chatLink}</dt><dd>{formDraft.postClipLinkInChat ? labels.enabledValue : labels.disabledValue}</dd></div>
        <div className="clips-panel__property"><dt>{labels.chatMessage}</dt><dd><code>{formDraft.chatLinkTemplate}</code></dd></div>
        <div className="clips-panel__property"><dt>{labels.automatic}</dt><dd>{formDraft.automaticClipsEnabled ? labels.enabledValue : labels.disabledValue}</dd></div>
        <div className="clips-panel__property"><dt>{labels.threshold}</dt><dd>{formattedThreshold} {labels.thresholdUnit}</dd></div>
        <div className="clips-panel__property"><dt>{labels.automaticCooldown}</dt><dd>{String(formDraft.automaticCooldownSeconds)} s</dd></div>
      </dl>
      <RuleNote>{labels.thresholdRule}</RuleNote>
      <RuleNote>{labels.helixRule}</RuleNote>
    </div>}

    <ConfirmDialog
      opened={restoreOpen}
      title={labels.restoreTitle}
      description={labels.restoreDescription}
      confirmLabel={labels.restoreConfirm}
      cancelLabel={labels.cancel}
      onConfirm={confirmRestore}
      onCancel={() => { setRestoreOpen(false); }}
      danger
    />
    <ConfirmDialog
      opened={draftGuard.confirmOpen}
      title={labels.guardTitle}
      description={labels.guardDescription}
      confirmLabel={labels.saveAndLeave}
      cancelLabel={labels.continueEditing}
      alternative={{ label: labels.discardAndLeave, onClick: draftGuard.discardAndSwitch }}
      pending={draftGuard.saving}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
      onConfirm={() => { void draftGuard.saveAndSwitch(); }}
      onCancel={draftGuard.continueEditing}
    />
  </>;
}

export default function ClipsPanel({ channelId, language, canManage = true }: ModulePanelProperties): ReactElement {
  const resolvedLanguage = language ?? dashboardLanguage();
  const labels = useMemo(() => clipsPanelTexts(resolvedLanguage), [resolvedLanguage]);
  const queryClient = useDashboardQueryClient();
  const settingsQuery = useModuleQuery(
    channelId,
    "clips",
    "clips-settings",
    (signal) => loadClipsSettings(channelId, signal),
  );
  const clipsQuery = useModuleQuery<SessionClipList>(
    channelId,
    "clips",
    "session-clips",
    (signal) => loadSessionClips(channelId, signal),
  );
  const [settingsRefreshFailed, setSettingsRefreshFailed] = useState(false);

  const reloadSettings = useCallback(async (): Promise<ClipsSettingsData> => {
    setSettingsRefreshFailed(false);
    try {
      return await refetchModuleQueryData<ClipsSettingsData>(queryClient, channelId, "clips", "clips-settings");
    } catch (error: unknown) {
      setSettingsRefreshFailed(true);
      throw error;
    }
  }, [channelId, queryClient]);

  const reloadClips = (): void => { void clipsQuery.refetch(); };
  const settingsLoadStatus = settingsQuery.data !== undefined ? "success" : settingsQuery.isError ? "error" : "loading";
  const clipLoadStatus = clipsQuery.data === undefined
    ? clipsQuery.isError ? "error" : "loading"
    : clipsQuery.data.clips.length === 0 ? "empty" : "success";
  const settingsRefreshError = settingsQuery.isRefetchError || settingsRefreshFailed;
  const retrySettings = (): void => {
    void reloadSettings().catch(() => undefined);
  };

  return <div className="clips-panel">
    <LoadState
      variant="panel-640"
      className="clips-panel__settings-load-state"
      status={settingsLoadStatus}
      loading={<><p className="clips-panel__loading-status">{labels.settingsLoading}</p><LoadStateLines rows={12} height={40} gap={8} /></>}
      empty={null}
      error={null}
      refreshError={settingsRefreshError}
      queryError={{ message: labels.settingsLoadError, onRetry: retrySettings }}
    >{settingsQuery.data === undefined ? null : <ClipsSettingsForm
      channelId={channelId}
      data={settingsQuery.data}
      language={resolvedLanguage}
      canManage={canManage}
      labels={labels}
      onReload={reloadSettings}
    />}</LoadState>

    <Section title={labels.sessionClips} headingAction={<Button
      size="compact"
      variant="subtle"
      icon="reload"
      onClick={reloadClips}
      disabled={clipsQuery.isFetching}
      ariaLabel={labels.refreshClips}
      title={labels.refreshClips}
    >{labels.refreshClips}</Button>}>
      <LoadState
        variant="panel-0"
        className="clips-panel__clips-load-state"
        status={clipLoadStatus}
        loading={<><span className="sr-only">{labels.clipsLoading}</span><LoadStateLines rows={3} height={48} /></>}
        empty={<EmptyState
          title={labels.sessionClips}
          description={clipsQuery.data?.streamStartedAt === null ? labels.emptyOffline : labels.emptySession}
        />}
        error={null}
        refreshError={clipsQuery.isRefetchError}
        {...(clipsQuery.isError ? { queryError: { message: labels.clipsLoadError, onRetry: reloadClips } } : {})}
      >{clipsQuery.data === undefined ? null : <div className="clips-panel__list">
        {clipsQuery.data.clips.map((clip) => <article className="clips-panel__clip" key={`${clip.clipId}:${clip.createdAt}`}>
          <div className="clips-panel__clip-copy">
            <strong className="clips-panel__clip-title">Clip {clip.clipId}</strong>
            <time className="clips-panel__clip-time" dateTime={clip.createdAt}>{formatClipDate(clip.createdAt, resolvedLanguage)}</time>
          </div>
          <a className="clips-panel__clip-link" href={`https://clips.twitch.tv/${encodeURIComponent(clip.clipId)}`} target="_blank" rel="noreferrer">
            {labels.openClip}
          </a>
        </article>)}
      </div>}</LoadState>
    </Section>
  </div>;
}

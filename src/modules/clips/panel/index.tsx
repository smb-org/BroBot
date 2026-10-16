import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { dashboardLanguage } from "../../../dashboard/locale";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  ActionMenu, Button, ChatPreview, ConfirmDialog, EmptyState, Field, FieldPair, LoadState,
  LoadStateLines, RoleThreshold, RuleNote, SaveStatus, Section, SwitchRow, UnitInput,
  registerDashboardNavigationGuard, useDraftGuard,
} from "../../../dashboard/ui";
import { DisabledFieldReasonContext } from "../../../dashboard/ui/DisabledFieldReason";
import type { ModulePanelProperties } from "../../contract";
import { clipsSettingsSchema, type ClipsSettings, type SessionClipList } from "../contracts";
import { clipsPanelTexts } from "./locale";
import { loadClipsSettings, loadSessionClips, saveClipsSettings } from "./service";
import "./clips-panel.css";

type NumberSetting = "commandCooldownSeconds" | "automaticThresholdMultiplier" | "automaticCooldownSeconds";
type ClipsSettingsDraft = Omit<ClipsSettings, NumberSetting> & Record<NumberSetting, number | "">;

interface ClipsDraftBaseline {
  settings: ClipsSettings;
  revision: number;
}

const DEFAULT_SETTINGS = clipsSettingsSchema.parse({});

const asDraft = (settings: ClipsSettings): ClipsSettingsDraft => ({ ...settings });

const validNumber = (value: number | "", minimum: number, maximum: number, integer: boolean): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isInteger(value));

const requireRevision = (revision: number | null): number => {
  if (revision === null) throw new Error("clips_settings_revision_missing");
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

export default function ClipsPanel({ channelId, language, canManage = true }: ModulePanelProperties): ReactElement {
  const resolvedLanguage = language ?? dashboardLanguage();
  const labels = useMemo(() => clipsPanelTexts(resolvedLanguage), [resolvedLanguage]);
  const queryClient = useDashboardQueryClient();
  const canManageSettings = canManage;
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
  const [draft, setDraft] = useState<ClipsSettingsDraft | null>(null);
  const [draftBaseline, setDraftBaseline] = useState<ClipsDraftBaseline | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [reloadError, setReloadError] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const currentSettings = settingsQuery.data?.settings ?? null;
  const formDraft = draft ?? (currentSettings === null ? null : asDraft(currentSettings));
  const dirty = draft !== null && draftBaseline !== null && JSON.stringify(draftBaseline.settings) !== JSON.stringify(draft);
  const conflict = dirty && settingsQuery.data !== undefined && settingsQuery.data.revision !== draftBaseline.revision;
  const cooldownInvalid = formDraft === null || !validNumber(formDraft.commandCooldownSeconds, 0, 86400, true);
  const multiplierInvalid = formDraft === null || !validNumber(formDraft.automaticThresholdMultiplier, 1, 10, false);
  const automaticCooldownInvalid = formDraft === null || !validNumber(formDraft.automaticCooldownSeconds, 0, 86400, true);
  const valid = formDraft === null
    ? false
    : !cooldownInvalid && !multiplierInvalid && !automaticCooldownInvalid && clipsSettingsSchema.safeParse(formDraft).success;

  const writeDraft = (next: ClipsSettingsDraft): void => {
    const base = draftBaseline ?? (settingsQuery.data === undefined
      ? null
      : { settings: settingsQuery.data.settings, revision: settingsQuery.data.revision });
    if (base === null) return;
    if (JSON.stringify(base.settings) === JSON.stringify(next)) {
      setDraft(null);
      setDraftBaseline(null);
      return;
    }
    setDraftBaseline(base);
    setDraft(next);
  };

  const updateSetting = <Key extends keyof ClipsSettingsDraft>(key: Key, value: ClipsSettingsDraft[Key]): void => {
    if (formDraft !== null) writeDraft({ ...formDraft, [key]: value });
    setSaved(false);
    setSaveError(undefined);
    setAttemptedSave(false);
  };

  const discardDraft = useCallback((): void => {
    setDraft(null);
    setDraftBaseline(null);
    setSaved(false);
    setSaveError(undefined);
    setAttemptedSave(false);
  }, []);

  const reloadSettings = useCallback(async (): Promise<void> => {
    setReloadError(false);
    try {
      await refetchModuleQueryData<Awaited<ReturnType<typeof loadClipsSettings>>>(queryClient, channelId, "clips", "clips-settings");
      setDraft(null);
      setDraftBaseline(null);
      setSaved(false);
    } catch {
      setReloadError(true);
    }
  }, [channelId, queryClient]);

  const saveDraft = useCallback(async (): Promise<string | null> => {
    if (!canManageSettings || draft === null || draftBaseline === null || !dirty || saving) return null;
    setAttemptedSave(true);
    const parsed = clipsSettingsSchema.safeParse(draft);
    if (!parsed.success) return labels.invalid;
    setSaving(true);
    setSaveError(undefined);
    try {
      await runModuleQueryWrite<{
        settings: ClipsSettings;
        revision: number;
        warnings: readonly unknown[];
      }>(
        queryClient,
        channelId,
        "clips",
        "clips-settings",
        (baselineRevision) => saveClipsSettings(
          channelId,
          requireRevision(baselineRevision),
          parsed.data,
        ),
        {
          baselineRevision: draftBaseline.revision,
          updateCache: (_current, value) => ({ settings: value.settings, revision: value.revision }),
          relatedParts: [{ moduleId: "clips", part: "settings" }],
        },
      );
      setDraft(null);
      setDraftBaseline(null);
      setSaved(true);
      setAttemptedSave(false);
      return null;
    } catch {
      setSaveError(labels.saveError);
      return labels.saveError;
    } finally {
      setSaving(false);
    }
  }, [canManageSettings, channelId, dirty, draft, draftBaseline, labels.invalid, labels.saveError, queryClient, saving]);

  const draftGuard = useDraftGuard(dirty, saveDraft, discardDraft);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);

  const settingsLoadStatus = settingsQuery.data !== undefined ? "success" : settingsQuery.isError ? "error" : "loading";
  const clipLoadStatus = clipsQuery.data === undefined
    ? clipsQuery.isError ? "error" : "loading"
    : clipsQuery.data.clips.length === 0 ? "empty" : "success";
  const readOnlyContext = canManageSettings ? null : { id: "clips-read-only", reason: labels.readOnlyReason };
  const openRestore = (): void => { setRestoreOpen(true); };
  const confirmRestore = (): void => {
    writeDraft(asDraft(DEFAULT_SETTINGS));
    setSaved(false);
    setSaveError(undefined);
    setAttemptedSave(false);
    setRestoreOpen(false);
  };
  const reloadClips = (): void => { void clipsQuery.refetch(); };

  return <div className="clips-panel">
    <div className="clips-panel__save-bar">
      <SaveStatus
        persistent
        dirty={dirty}
        pending={saving}
        saved={saved}
        {...(saveError === undefined ? {} : { error: saveError })}
        invalid={attemptedSave && !valid}
        invalidMessage={labels.invalid}
        {...(conflict ? { conflict: {
          message: reloadError ? `${labels.saveError} ${labels.settingsLoadError}` : labels.saveError,
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
          items={[{ label: labels.restoreDefaults, disabled: !canManageSettings || saving, onSelect: openRestore }]}
        />}
      />
    </div>
    {canManageSettings ? null : <RuleNote>{labels.readOnlyReason}</RuleNote>}

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
        variant="panel-260"
        status={clipLoadStatus}
        loading={<><span className="sr-only">{labels.clipsLoading}</span><LoadStateLines rows={3} height={48} /></>}
        empty={<EmptyState
          title={labels.sessionClips}
          description={clipsQuery.data?.streamStartedAt === null ? labels.emptyOffline : labels.emptySession}
        />}
        error={null}
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

    <DisabledFieldReasonContext.Provider value={readOnlyContext}>
      <LoadState
        variant="panel-640"
        status={settingsLoadStatus}
        loading={<><span className="sr-only">{labels.settingsLoading}</span><LoadStateLines rows={8} height={44} /></>}
        empty={null}
        error={null}
        {...(settingsQuery.isError ? { queryError: { message: labels.settingsLoadError, onRetry: () => { void settingsQuery.refetch(); } } } : {})}
      >{formDraft === null ? null : <div className="clips-panel__settings" aria-label={labels.commandSection}>
        <Section title={labels.commandSection}>
          <FieldPair>
            <RoleThreshold
              label={labels.commandRole}
              value={formDraft.commandMinimumRole}
              options={labels.roleOptions}
              disabled={!canManageSettings || saving}
              {...(canManageSettings ? {} : { lockedReason: labels.readOnlyReason })}
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
              disabled={!canManageSettings || saving}
              {...(attemptedSave && cooldownInvalid ? { error: labels.invalid } : {})}
              onChange={(value) => { updateSetting("commandCooldownSeconds", value); }}
            />
          </FieldPair>
        </Section>

        <Section title={labels.chatLink}>
          <SwitchRow
            label={labels.chatLink}
            description={labels.chatLinkHint}
            checked={formDraft.postClipLinkInChat}
            disabled={!canManageSettings || saving}
            {...(canManageSettings ? {} : { lockedReason: labels.readOnlyReason })}
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
              disabled={!canManageSettings || saving || !formDraft.postClipLinkInChat}
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
            disabled={!canManageSettings || saving}
            {...(canManageSettings ? {} : { lockedReason: labels.readOnlyReason })}
            onChange={(value) => { updateSetting("automaticClipsEnabled", value); }}
          />
          <FieldPair>
            <UnitInput
              id="clips-auto-threshold"
              label={labels.threshold}
              hint={formDraft.automaticClipsEnabled ? labels.thresholdHint : labels.automaticDisabledHint}
              unit="×"
              min={1}
              max={10}
              step={0.1}
              value={formDraft.automaticThresholdMultiplier}
              suggestions={[1.5, 2, 2.5, 3]}
              disabled={!canManageSettings || saving || !formDraft.automaticClipsEnabled}
              {...(attemptedSave && multiplierInvalid ? { error: labels.invalid } : {})}
              onChange={(value) => { updateSetting("automaticThresholdMultiplier", value); }}
            />
            <UnitInput
              id="clips-auto-cooldown"
              label={labels.automaticCooldown}
              hint={formDraft.automaticClipsEnabled ? labels.automaticCooldownHint : labels.automaticDisabledHint}
              unit="s"
              min={0}
              max={86400}
              step={30}
              value={formDraft.automaticCooldownSeconds}
              suggestions={[300, 900, 1800]}
              disabled={!canManageSettings || saving || !formDraft.automaticClipsEnabled}
              {...(attemptedSave && automaticCooldownInvalid ? { error: labels.invalid } : {})}
              onChange={(value) => { updateSetting("automaticCooldownSeconds", value); }}
            />
          </FieldPair>
          <RuleNote>{labels.thresholdRule}</RuleNote>
        </Section>
        <RuleNote>{labels.helixRule}</RuleNote>
      </div>}</LoadState>
    </DisabledFieldReasonContext.Provider>

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
  </div>;
}

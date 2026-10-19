import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { dashboardLanguage, dashboardTexts } from "../../../dashboard/locale";
import { moduleQueryKey, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  Button, ConfirmDialog, EmptyState, Field, FieldPair, LoadState, LoadStateLines, PageHeader, RoleThreshold,
  Section, SwitchRow, UnitInput, registerDashboardNavigationGuard, useDraftGuard,
} from "../../../dashboard/ui";
import { PanelApiError } from "../../../contracts/panel-error";
import type { ModulePanelProperties } from "../../contract";
import { clipsSettingsSchema, type ClipsSettings, type SessionClipList } from "../contracts";
import { clipsPanelTexts } from "./locale";
import { loadClipsSettings, loadSessionClips, saveClipsSettings } from "./service";
import "./clips-panel.css";

type ClipsSettingsData = Awaited<ReturnType<typeof loadClipsSettings>>;

const formatClipDate = (value: string, language: "de" | "en"): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

interface ClipsSettingsViewProps {
  channelId: string;
  language: "de" | "en";
  revision: number;
  settings: ClipsSettings;
  refreshFailed: boolean;
  canManage: boolean;
  labels: ReturnType<typeof clipsPanelTexts>;
}

function ClipsSettingsHeader({ refreshFailed, labels, save }: Pick<ClipsSettingsViewProps, "refreshFailed" | "labels"> & {
  save?: Parameters<typeof PageHeader>[0]["save"];
}): ReactElement {
  return <PageHeader
    kind="module"
    icon={null}
    title={labels.settingsTitle}
    meta={<span className="clips-panel__settings-refresh-message" aria-live="polite">
      {refreshFailed ? <span role="alert">{labels.settingsLoadError}</span> : <span aria-hidden="true">&nbsp;</span>}
    </span>}
    headingLevel="h2"
    {...(save === undefined ? {} : { save })}
  />;
}

type ClipsSettingsDraft = Omit<ClipsSettings, "commandCooldownSeconds"> & { commandCooldownSeconds: number | "" };

interface ClipsSettingsDraftState {
  value: ClipsSettingsDraft;
  baseline: ClipsSettingsDraft;
  revision: number;
  sourceSettings: ClipsSettings;
  sourceRevision: number;
}

function ClipsSettingsView({ channelId, language, revision, settings, refreshFailed, canManage, labels }: ClipsSettingsViewProps): ReactElement {
  const queryClient = useDashboardQueryClient();
  const [draft, setDraft] = useState<ClipsSettingsDraftState>(() => ({
    value: settings,
    baseline: settings,
    revision,
    sourceSettings: settings,
    sourceRevision: revision,
  }));
  const dirty = JSON.stringify(draft.value) !== JSON.stringify(draft.baseline);
  if ((draft.sourceSettings !== settings || draft.sourceRevision !== revision) && !dirty) {
    setDraft({ value: settings, baseline: settings, revision, sourceSettings: settings, sourceRevision: revision });
  }
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const parsedSettings = clipsSettingsSchema.safeParse(draft.value);
  const cooldownValue = draft.value.commandCooldownSeconds;
  const cooldownValid = typeof cooldownValue === "number" && Number.isSafeInteger(cooldownValue) &&
    cooldownValue >= 0 && cooldownValue <= 86400;
  const updateDraft = (patch: Partial<ClipsSettingsDraft>): void => {
    setSaved(false);
    setSaveError(undefined);
    setDraft((current) => ({ ...current, value: { ...current.value, ...patch } }));
  };
  const discardDraft = (): void => {
    setDraft({ value: settings, baseline: settings, revision, sourceSettings: settings, sourceRevision: revision });
    setSaved(false);
    setSaveError(undefined);
  };
  const saveDraft = useCallback(async (): Promise<string | null> => {
    if (!canManage || !dirty || pending) return null;
    if (!parsedSettings.success) {
      setSaveError(labels.commandCooldownError);
      return labels.commandCooldownError;
    }
    setPending(true);
    setSaveError(undefined);
    setSaved(false);
    try {
      const result = await runModuleQueryWrite(
        queryClient,
        channelId,
        "clips",
        "clips-settings",
        (baselineRevision) => saveClipsSettings(channelId, baselineRevision ?? draft.revision, parsedSettings.data),
        { baselineRevision: draft.revision, updateCache: (_current, saved) => saved },
      );
      setDraft({
        value: result.settings,
        baseline: result.settings,
        revision: result.revision,
        sourceSettings: result.settings,
        sourceRevision: result.revision,
      });
      setSaved(true);
      return null;
    } catch (error) {
      const message = error instanceof PanelApiError && error.status === 409 ? labels.settingsConflict : labels.settingsSaveError;
      setSaveError(message);
      return message;
    } finally {
      setPending(false);
    }
  }, [canManage, channelId, dirty, draft.revision, labels.commandCooldownError, labels.settingsConflict, labels.settingsSaveError, parsedSettings, pending, queryClient]);
  const draftGuard = useDraftGuard(dirty, saveDraft, discardDraft);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);
  const navigationLabels = dashboardTexts(language).module;

  return <>
    <ClipsSettingsHeader refreshFailed={refreshFailed} labels={labels} save={{
      dirty,
      persistent: true,
      pending,
      saved,
      ...(saveError === undefined ? {} : { error: saveError }),
      saveDisabled: !canManage || !parsedSettings.success,
      onSave: () => { void saveDraft(); },
      onDiscard: discardDraft,
      saveLabel: labels.save,
      discardLabel: labels.discard,
      savedLabel: labels.saved,
      pendingLabel: labels.saving,
    }} />
    <div className="clips-panel__settings">
      <Section title={labels.commandSection}>
        <div className="clips-panel__command-fields">
          <FieldPair>
            <RoleThreshold
              id="clips-command-role"
              label={labels.commandRole}
              value={draft.value.commandMinimumRole}
              options={labels.roleOptions.map((option) => ({ ...option, inclusion: "" }))}
              disabled={!canManage || pending}
              onChange={(commandMinimumRole) => updateDraft({ commandMinimumRole: commandMinimumRole as ClipsSettings["commandMinimumRole"] })}
            />
            <UnitInput
              id="clips-command-cooldown"
              label={labels.commandCooldown}
              unit="s"
              min={0}
              max={86400}
              step={5}
              value={draft.value.commandCooldownSeconds}
              suggestions={[30, 60, 300]}
              {...(cooldownValid ? {} : { error: labels.commandCooldownError })}
              disabled={!canManage || pending}
              onChange={(commandCooldownSeconds) => updateDraft({ commandCooldownSeconds })}
            />
          </FieldPair>
        </div>
      </Section>

      <Section title={labels.chatLink}>
        <SwitchRow
          label={labels.chatLinkEnabled}
          checked={draft.value.postClipLinkInChat}
          disabled={!canManage || pending}
          onChange={(postClipLinkInChat) => updateDraft({ postClipLinkInChat })}
        />
        <Field
          id="clips-chat-message"
          label={labels.chatMessage}
          hint={labels.chatMessageHint}
          value={draft.value.chatLinkTemplate}
          onChange={(chatLinkTemplate) => updateDraft({ chatLinkTemplate })}
          maxLength={500}
          countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
          disabled={!canManage || pending}
          required
        />
      </Section>

      <Section title={labels.automaticSection}>
        <p className="clips-panel__locked-note">{labels.lockedLaterVersion}</p>
        <SwitchRow
          label={labels.automatic}
          checked={settings.automaticClipsEnabled}
          disabled
          onChange={() => undefined}
        />
        <div className="clips-panel__automatic-fields">
          <FieldPair>
            <UnitInput
              id="clips-auto-threshold"
              label={labels.threshold}
              unit={labels.thresholdUnit}
              min={1}
              max={10}
              step={0.1}
              value={settings.automaticThresholdMultiplier}
              suggestions={[1.5, 2, 2.5, 3]}
              disabled
              onChange={() => undefined}
            />
            <UnitInput
              id="clips-auto-cooldown"
              label={labels.automaticCooldown}
              unit="s"
              min={0}
              max={86400}
              step={30}
              value={settings.automaticCooldownSeconds}
              suggestions={[300, 900, 1800]}
              disabled
              onChange={() => undefined}
            />
          </FieldPair>
        </div>
      </Section>
    </div>
    <ConfirmDialog
      opened={draftGuard.confirmOpen}
      title={navigationLabels.unsavedChangesTitle}
      description={navigationLabels.unsavedChangesDescription}
      confirmLabel={navigationLabels.discardAndSwitch}
      cancelLabel={navigationLabels.continueEditing}
      onConfirm={draftGuard.discardAndSwitch}
      onCancel={draftGuard.continueEditing}
      {...(canManage && parsedSettings.success
        ? { alternative: { label: navigationLabels.saveAndSwitch, onClick: () => { void draftGuard.saveAndSwitch(); } } }
        : {})}
      pending={draftGuard.saving || pending}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
      danger
    />
  </>;
}

export default function ClipsPanel({ channelId, language, streamSessionIdentity, canManage = true }: ModulePanelProperties): ReactElement {
  const resolvedLanguage = language ?? dashboardLanguage();
  const labels = useMemo(() => clipsPanelTexts(resolvedLanguage), [resolvedLanguage]);
  const queryClient = useDashboardQueryClient();
  const settingsQuery = useModuleQuery<ClipsSettingsData>(
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
  const refetchClips = clipsQuery.refetch;
  const previousStreamSessionIdentity = useRef(streamSessionIdentity);
  useEffect(() => {
    if (previousStreamSessionIdentity.current === streamSessionIdentity) return;
    previousStreamSessionIdentity.current = streamSessionIdentity;
    const queryKey = moduleQueryKey(channelId, "clips", "session-clips");
    void queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
      if (previousStreamSessionIdentity.current === streamSessionIdentity) void refetchClips();
    });
  }, [channelId, queryClient, refetchClips, streamSessionIdentity]);

  const reloadClips = (): void => { void clipsQuery.refetch(); };
  const settingsLoadStatus = settingsQuery.data !== undefined ? "success" : settingsQuery.isError ? "error" : "loading";
  const clipLoadStatus = clipsQuery.data === undefined
    ? clipsQuery.isError ? "error" : "loading"
    : clipsQuery.data.clips.length === 0 ? "empty" : "success";
  const clipsRefreshFailed = clipsQuery.isRefetchError;

  return <div className="clips-panel">
    <LoadState
      variant="panel-600"
      reserveHeight="var(--clips-panel-settings-reserve-height)"
      className="clips-panel__settings-load-state"
      status={settingsLoadStatus}
      loading={<>
        <ClipsSettingsHeader refreshFailed={false} labels={labels} />
        <p className="clips-panel__loading-status">{labels.settingsLoading}</p>
        <LoadStateLines rows={19} height={40} gap={8} />
      </>}
      empty={null}
      error={null}
      queryError={{ message: labels.settingsLoadError, onRetry: () => { void settingsQuery.refetch(); } }}
    >{settingsQuery.data === undefined ? null : <ClipsSettingsView
      channelId={channelId}
      language={resolvedLanguage}
      revision={settingsQuery.data.revision}
      settings={settingsQuery.data.settings}
      refreshFailed={settingsQuery.isRefetchError}
      canManage={canManage}
      labels={labels}
    />}</LoadState>

    <Section
      title={labels.sessionClips}
      className="clips-panel__clips-section"
      headingAction={<div className="clips-panel__refresh-actions">
        <div className="clips-panel__refresh-error" {...(clipsRefreshFailed ? { role: "alert" as const } : { "aria-hidden": true })}>
          {clipsRefreshFailed ? <>
            <span>{labels.clipsLoadError}</span>
            <Button size="compact" variant="neutral" icon="reload" onClick={reloadClips} disabled={clipsQuery.isFetching}>{labels.retryClips}</Button>
          </> : null}
        </div>
        <Button
          size="compact"
          variant="subtle"
          icon="reload"
          onClick={reloadClips}
          disabled={clipsQuery.isFetching}
          ariaLabel={labels.refreshClips}
          title={labels.refreshClips}
        >{labels.refreshClips}</Button>
      </div>}
    >
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
        {...(clipsQuery.data === undefined && clipsQuery.isError ? { queryError: { message: labels.clipsLoadError, onRetry: reloadClips } } : {})}
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

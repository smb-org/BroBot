import { useEffect, useMemo, useRef, type ReactElement } from "react";

import { dashboardLanguage } from "../../../dashboard/locale";
import { moduleQueryKey, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  Button, EmptyState, Field, FieldPair, LoadState, LoadStateLines, PageHeader, RoleThreshold,
  Section, SwitchRow, UnitInput,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { ClipsSettings, SessionClipList } from "../contracts";
import { clipsPanelTexts } from "./locale";
import { loadClipsSettings, loadSessionClips } from "./service";
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
  settings: ClipsSettings;
  refreshFailed: boolean;
  labels: ReturnType<typeof clipsPanelTexts>;
}

function ClipsSettingsHeader({ refreshFailed, labels }: Pick<ClipsSettingsViewProps, "refreshFailed" | "labels">): ReactElement {
  return <PageHeader
    kind="module"
    icon={null}
    title={labels.settingsTitle}
    meta={<span className="clips-panel__settings-refresh-message" aria-live="polite">
      {refreshFailed ? <span role="alert">{labels.settingsLoadError}</span> : <span aria-hidden="true">&nbsp;</span>}
    </span>}
    headingLevel="h2"
  />;
}

function ClipsSettingsView({ settings, refreshFailed, labels }: ClipsSettingsViewProps): ReactElement {
  return <>
    <ClipsSettingsHeader refreshFailed={refreshFailed} labels={labels} />
    <div className="clips-panel__settings">
      <Section title={labels.commandSection}>
        <p className="clips-panel__locked-note">{labels.lockedLaterVersion}</p>
        <div className="clips-panel__command-fields">
          <FieldPair>
            <RoleThreshold
              id="clips-command-role"
              label={labels.commandRole}
              value={settings.commandMinimumRole}
              options={labels.roleOptions.map((option) => ({ ...option, inclusion: "" }))}
              disabled
              onChange={() => undefined}
            />
            <UnitInput
              id="clips-command-cooldown"
              label={labels.commandCooldown}
              unit="s"
              min={0}
              max={86400}
              step={5}
              value={settings.commandCooldownSeconds}
              suggestions={[30, 60, 300]}
              disabled
              onChange={() => undefined}
            />
          </FieldPair>
        </div>
      </Section>

      {/* The locked command and chat-link behavior is tracked in issue #472. */}
      <Section title={labels.chatLink}>
        <p className="clips-panel__locked-note">{labels.lockedLaterVersion}</p>
        <SwitchRow
          label={labels.chatLinkEnabled}
          checked={settings.postClipLinkInChat}
          disabled
          onChange={() => undefined}
        />
        <Field
          id="clips-chat-message"
          label={labels.chatMessage}
          value={settings.chatLinkTemplate}
          onChange={() => undefined}
          maxLength={500}
          countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
          disabled
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
  </>;
}

export default function ClipsPanel({ channelId, language, streamSessionIdentity }: ModulePanelProperties): ReactElement {
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
      settings={settingsQuery.data.settings}
      refreshFailed={settingsQuery.isRefetchError}
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

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactElement } from "react";

import type { ChannelRole } from "../contracts/values";
import { canManage } from "../contracts/values";
import { PanelApiError, saveChannelTimeZone, type PanelChannelLocation, type PanelChannelSettings } from "./api";
import { ChannelLocationField } from "./ChannelLocationField";
import { ChannelTimeZoneField } from "./ChannelTimeZoneField";
import { mergeChannelSettingsResponse } from "./channel-settings-cache";
import { channelSettingsTexts } from "./channel-settings-locale";
import { useChannelSettings } from "./data/channel-settings";
import { queryKeys } from "./data/keys";
import { dashboardCommonTexts, dashboardLanguage, dashboardTexts, apiErrorText } from "./locale";
import {
  ConfirmDialog,
  LoadState,
  LoadStateLines,
  LockedReason,
  SaveStatus,
  Section,
  SettingsPage,
  StatusLed,
  registerDashboardNavigationGuard,
  useDraftGuard,
} from "./ui";

interface TimeZoneDraft {
  channelId: string;
  baseRevision: number;
  value: string;
}

export const ChannelLocationPage = ({ channelId, role }: { channelId: string; role: ChannelRole }): ReactElement => {
  const language = dashboardLanguage();
  const labels = channelSettingsTexts(language);
  const dashboard = dashboardTexts();
  const common = dashboardCommonTexts();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.channel(channelId, "settings");
  const settingsQuery = useChannelSettings(channelId);
  const settings = settingsQuery.data;
  const settingsReady = settings !== undefined && typeof settings.timeZone === "string" && Number.isSafeInteger(settings.revision) &&
    Number.isSafeInteger(settings.locationRevision);
  const canEdit = canManage(role);
  const [draftState, setDraftState] = useState<TimeZoneDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const hasDraft = draftState?.channelId === channelId;
  const timeZone = settings === undefined ? "" : hasDraft ? draftState.value : settings.timeZone;
  const dirty = settingsReady && timeZone !== settings.timeZone;
  const hasRevisionConflict = dirty && hasDraft && draftState.baseRevision !== settings.revision;
  const readOnlyReasonId = `channel-location-read-only-${channelId}`;

  const writeTimeZoneDraft = (value: string): void => {
    if (!settingsReady || !canEdit) return;
    setDraftState(value === settings.timeZone ? null : { channelId, baseRevision: settings.revision, value });
    setSaveError(undefined);
    setSaved(false);
  };

  const updateSettingsCache = async (update: Partial<PanelChannelSettings>): Promise<void> => {
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<PanelChannelSettings>(queryKey, (current) => current === undefined ? current : mergeChannelSettingsResponse(current, update));
  };
  const locationSaved = async (location: PanelChannelLocation | null, revision: number): Promise<void> => {
    await updateSettingsCache({ location, locationRevision: revision });
  };

  const saveDraft = async (): Promise<string | null> => {
    if (!settingsReady || !canEdit || pending) return labels.saveError;
    if (timeZone.trim().length === 0) return labels.invalid;
    if (hasRevisionConflict) return labels.settingsConflict;
    setPending(true);
    setSaveError(undefined);
    try {
      const revision = hasDraft ? draftState.baseRevision : settings.revision;
      const result = await saveChannelTimeZone(channelId, revision, timeZone.trim());
      await updateSettingsCache({ timeZone: result.timeZone, revision: result.revision });
      setDraftState(null);
      setSaved(true);
      return null;
    } catch (failure: unknown) {
      const fallback = labels.saveError;
      const code = failure instanceof PanelApiError ? failure.code : null;
      const message = code === "channel_settings_conflict" ? labels.settingsConflict : apiErrorText(code, fallback);
      setSaveError(message);
      if (code === "channel_settings_conflict") await settingsQuery.refetch();
      return message;
    } finally {
      setPending(false);
    }
  };

  const discardDraft = (): void => {
    setDraftState(null);
    setSaveError(undefined);
    setSaved(false);
  };
  const navigationGuard = useDraftGuard(dirty, saveDraft, discardDraft);

  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);

  const loadError = settingsQuery.error instanceof PanelApiError
    ? apiErrorText(settingsQuery.error.code, labels.loadError)
    : labels.loadError;
  const saveCluster = !canEdit || !settingsReady ? undefined : <SaveStatus
    dirty={dirty}
    pending={pending}
    persistent
    saved={saved}
    saveDisabled={!validTimeZoneDraft(timeZone)}
    {...(saveError === undefined ? {} : { error: saveError })}
    {...(hasRevisionConflict ? {
      conflict: {
        message: labels.settingsConflict,
        reloadLabel: common.retry,
        onReload: () => { void settingsQuery.refetch().then((result) => { if (!result.isError) discardDraft(); }); },
      },
    } : {})}
    onSave={() => { void saveDraft(); }}
    onDiscard={discardDraft}
    saveLabel={common.save}
    discardLabel={common.discard}
    savedLabel={common.saved}
    pendingLabel={common.saving}
  />;

  return <div className="channel-location-page">
    <SettingsPage
      title={labels.pageTitle}
      meta={labels.pageDescription}
      {...(saveCluster === undefined ? {} : { saveStatus: saveCluster })}
      columns={[
        <Section key="time-zone" title={labels.timeZoneSection}>
          <ChannelTimeZoneField label={labels.timeZone} hint={labels.timeZoneHint} value={timeZone}
            onChange={writeTimeZoneDraft} canEdit disabled={!canEdit || !settingsReady || settingsQuery.isFetching || pending}
            {...(!canEdit ? { describedBy: readOnlyReasonId } : {})} />
        </Section>,
        <Section key="location" title={labels.location}>
          <LoadState variant="panel-260"
            status={!settingsReady ? settingsQuery.isError || settings !== undefined ? "error" : "loading" : "success"}
            loading={<LoadStateLines rows={2} height={58} />}
            empty={<LoadStateLines rows={2} height={58} />}
            error={<p role="alert">{loadError}</p>}
            queryError={{ title: dashboard.errors.dataLoadFailed, message: loadError, onRetry: () => { void settingsQuery.refetch(); } }}>
            {!settingsReady ? null : <>
              <div className="channel-location-page__notice-slot" aria-live="polite">
                {settings.location === null ? <div className="channel-location-page__warning" role="status">
                  <StatusLed state="warn" label={labels.locationMissingWarning} dotOnly />
                  <div><strong>{labels.locationMissing}</strong><span>{labels.locationMissingWarning}</span></div>
                </div> : null}
                <LockedReason id={readOnlyReasonId} {...(!canEdit ? { reason: labels.readOnly } : {})} />
              </div>
              <ChannelLocationField channelId={channelId} language={language} value={settings.location}
                revision={settings.locationRevision} onSaved={locationSaved} channelTimeZone={settings.timeZone}
                onSelectChannelTimeZone={writeTimeZoneDraft} canEdit={canEdit}
                disabled={settingsQuery.isFetching || pending} readOnlyReasonId={readOnlyReasonId} renderReadOnlyReason={false} />
            </>}
          </LoadState>
        </Section>,
      ]}
    />
    <ConfirmDialog opened={navigationGuard.confirmOpen} title={dashboard.module.unsavedChangesTitle}
      description={dashboard.module.unsavedChangesDescription}
      confirmLabel={dashboard.module.discardAndSwitch} cancelLabel={dashboard.module.continueEditing}
      onCancel={navigationGuard.continueEditing} onConfirm={navigationGuard.discardAndSwitch} danger />
  </div>;
};

const validTimeZoneDraft = (timeZone: string): boolean => timeZone.trim().length > 0;

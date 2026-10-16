import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { ChannelRole } from "../contracts/values";
import { canManage } from "../contracts/values";
import { PanelApiError, saveChannelLocation, saveChannelTimeZone, type PanelChannelLocation, type PanelChannelSettings } from "./api";
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

interface ChannelSettingsDraft {
  channelId: string;
  baseRevision: number;
  locationBaseRevision: number;
  timeZone: string;
  location: PanelChannelLocation | null;
}

export const ChannelLocationPage = ({ channelId, role }: { channelId: string; role: ChannelRole }): ReactElement => {
  const language = dashboardLanguage();
  const labels = channelSettingsTexts(language);
  const dashboard = dashboardTexts();
  const common = dashboardCommonTexts();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => queryKeys.channel(channelId, "settings"), [channelId]);
  const settingsQuery = useChannelSettings(channelId);
  const refetchSettings = settingsQuery.refetch;
  const settings = settingsQuery.data;
  const settingsReady = settings !== undefined && typeof settings.timeZone === "string" && Number.isSafeInteger(settings.revision) &&
    Number.isSafeInteger(settings.locationRevision);
  const canEdit = canManage(role);
  const [draftState, setDraftState] = useState<ChannelSettingsDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const draftVersion = useRef(0);
  const hasDraft = draftState?.channelId === channelId;
  const timeZone = !settingsReady ? "" : hasDraft ? draftState.timeZone : settings.timeZone;
  const location = !settingsReady ? null : hasDraft ? draftState.location : settings.location;
  const timeZoneDirty = settingsReady && timeZone !== settings.timeZone;
  const locationDirty = settingsReady && !sameLocation(location, settings.location);
  const dirty = settingsReady && hasDraft && (timeZoneDirty || locationDirty);
  const hasRevisionConflict = dirty && (
    (timeZoneDirty && draftState.baseRevision !== settings.revision) ||
    (locationDirty && draftState.locationBaseRevision !== settings.locationRevision)
  );
  const readOnlyReasonId = `channel-location-read-only-${channelId}`;

  const writeDraft = (update: Partial<Pick<ChannelSettingsDraft, "timeZone" | "location">>): void => {
    if (!settingsReady || !canEdit || pending) return;
    const current = hasDraft ? draftState : {
      channelId,
      baseRevision: settings.revision,
      locationBaseRevision: settings.locationRevision,
      timeZone: settings.timeZone,
      location: settings.location,
    };
    const next = { ...current, ...update };
    draftVersion.current += 1;
    const hasChanges = next.timeZone !== settings.timeZone || !sameLocation(next.location, settings.location);
    setDraftState(hasChanges ? next : null);
    setSaveError(undefined);
    setSaved(false);
  };

  const updateSettingsCache = useCallback(async (update: Partial<PanelChannelSettings>): Promise<void> => {
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<PanelChannelSettings>(queryKey, (current) => current === undefined ? current : mergeChannelSettingsResponse(current, update));
  }, [queryClient, queryKey]);

  const saveDraft = useCallback(async (): Promise<string | null> => {
    if (!settingsReady || !canEdit || pending) return labels.saveError;
    if (!dirty) return null;
    if (!validTimeZoneDraft(timeZone)) return labels.invalid;
    if (hasRevisionConflict) return labels.settingsConflict;

    const draft = draftState;
    const draftVersionAtStart = draftVersion.current;
    setPending(true);
    setSaveError(undefined);
    let savingLocation = false;
    try {
      if (timeZoneDirty) {
        const result = await saveChannelTimeZone(channelId, draft.baseRevision, timeZone.trim());
        await updateSettingsCache({ timeZone: result.timeZone, revision: result.revision });
        setDraftState((current) => current?.channelId === channelId
          ? {
            ...current,
            baseRevision: result.revision,
            ...(draftVersion.current === draftVersionAtStart ? { timeZone: result.timeZone } : {}),
          }
          : current);
      }
      if (locationDirty) {
        savingLocation = true;
        const result = await saveChannelLocation(channelId, draft.locationBaseRevision, location);
        await updateSettingsCache({ location: result.location, locationRevision: result.locationRevision });
        setDraftState((current) => current?.channelId === channelId
          ? { ...current, locationBaseRevision: result.locationRevision }
          : current);
      }
      if (draftVersion.current === draftVersionAtStart) {
        setDraftState(null);
        setSaved(true);
      } else {
        setSaved(false);
      }
      return null;
    } catch (failure: unknown) {
      const code = failure instanceof PanelApiError ? failure.code : null;
      const message = code === "channel_settings_conflict" || code === "channel_location_conflict"
        ? labels.settingsConflict
        : savingLocation ? labels.locationSaveFailed : apiErrorText(code, labels.saveError);
      setSaveError(message);
      if (code === "channel_settings_conflict" || code === "channel_location_conflict") await refetchSettings();
      return message;
    } finally {
      setPending(false);
    }
  }, [canEdit, channelId, dirty, draftState, hasRevisionConflict, labels.invalid, labels.locationSaveFailed,
    labels.saveError, labels.settingsConflict, location, locationDirty, pending, refetchSettings, settingsReady,
    timeZone, timeZoneDirty, updateSettingsCache]);

  const discardDraft = useCallback((): void => {
    if (pending) return;
    draftVersion.current += 1;
    setDraftState(null);
    setSaveError(undefined);
    setSaved(false);
  }, [pending]);
  const navigationGuard = useDraftGuard(dirty, saveDraft, discardDraft);

  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "s" || !canEdit || !dirty) return;
      event.preventDefault();
      void saveDraft();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [canEdit, dirty, saveDraft]);

  const loadError = settingsQuery.error instanceof PanelApiError
    ? apiErrorText(settingsQuery.error.code, labels.loadError)
    : labels.loadError;
  const saveCluster = !canEdit ? undefined : <SaveStatus
    dirty={dirty}
    pending={pending}
    persistent
    saved={saved}
    saveDisabled={!settingsReady || !validTimeZoneDraft(timeZone)}
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
      kind="weather"
      title={labels.pageTitle}
      meta={labels.pageDescription}
      {...(saveCluster === undefined ? {} : { saveStatus: saveCluster })}
      columns={[
        <Section key="time-zone" title={labels.timeZoneSection}>
          {!canEdit ? <dl className="channel-location-page__properties">
            <div><dt>{labels.timeZone}</dt><dd>{settingsReady ? timeZone : "—"}</dd></div>
          </dl> : <ChannelTimeZoneField label={labels.timeZone} hint={labels.timeZoneHint} value={timeZone}
            onChange={(value) => { writeDraft({ timeZone: value }); }} canEdit disabled={!settingsReady || settingsQuery.isFetching || pending} />}
          <LockedReason id={readOnlyReasonId} {...(!canEdit ? { reason: labels.readOnly } : {})} />
        </Section>,
        <Section key="location" title={labels.location}>
          <LoadState variant="panel-260"
            status={!settingsReady ? settingsQuery.isError || settings !== undefined ? "error" : "loading" : "success"}
            loading={<LoadStateLines rows={2} height={58} />}
            empty={<LoadStateLines rows={2} height={58} />}
            error={<p role="alert">{loadError}</p>}
            queryError={{ title: dashboard.errors.dataLoadFailed, message: loadError, onRetry: () => { void settingsQuery.refetch(); } }}>
            {!settingsReady ? null : <>
              {location === null ? <div className="channel-location-page__warning" role="status">
                <StatusLed state="warn" label={labels.locationMissingWarning} dotOnly />
                <div><strong>{labels.locationMissing}</strong><span>{labels.locationMissingWarning}</span></div>
              </div> : null}
              <ChannelLocationField channelId={channelId} language={language} value={location}
                onChange={(value) => { writeDraft({ location: value }); }} channelTimeZone={timeZone}
                onSelectChannelTimeZone={(value) => { writeDraft({ timeZone: value }); }} canEdit={canEdit}
                disabled={settingsQuery.isFetching || pending} readOnlyReasonId={readOnlyReasonId} />
            </>}
          </LoadState>
        </Section>,
      ]}
    />
    <ConfirmDialog opened={navigationGuard.confirmOpen} title={dashboard.module.unsavedChangesTitle}
      description={dashboard.module.unsavedChangesDescription}
      confirmLabel={dashboard.module.discardAndSwitch} cancelLabel={dashboard.module.continueEditing}
      onCancel={navigationGuard.continueEditing} onConfirm={navigationGuard.discardAndSwitch} danger
      pending={navigationGuard.saving || pending} />
  </div>;
};

const sameLocation = (left: PanelChannelLocation | null, right: PanelChannelLocation | null): boolean =>
  left === null ? right === null : right !== null && left.name === right.name && left.latitude === right.latitude &&
    left.longitude === right.longitude && left.timeZone === right.timeZone;

const validTimeZoneDraft = (timeZone: string): boolean => timeZone.trim().length > 0;

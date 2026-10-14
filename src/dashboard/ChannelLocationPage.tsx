import { useQueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";

import type { ChannelRole } from "../contracts/values";
import { canManage } from "../contracts/values";
import { PanelApiError, saveChannelTimeZone, type PanelChannelLocation, type PanelChannelSettings } from "./api";
import { ChannelLocationField } from "./ChannelLocationField";
import { channelSettingsTexts } from "./channel-settings-locale";
import { useChannelSettings } from "./data/channel-settings";
import { queryKeys } from "./data/keys";
import { dashboardLanguage, dashboardTexts, apiErrorText } from "./locale";
import { LoadState, LoadStateLines, PageHeader, Section } from "./ui";

export const ChannelLocationPage = ({ channelId, role }: { channelId: string; role: ChannelRole }): ReactElement => {
  const language = dashboardLanguage();
  const labels = channelSettingsTexts(language);
  const dashboard = dashboardTexts();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.channel(channelId, "settings");
  const settingsQuery = useChannelSettings(channelId);
  const settings = settingsQuery.data;
  const settingsReady = settings !== undefined && typeof settings.timeZone === "string" && Number.isSafeInteger(settings.revision) &&
    Number.isSafeInteger(settings.locationRevision);
  const canEdit = canManage(role);

  const updateSettingsCache = async (update: Partial<PanelChannelSettings>): Promise<void> => {
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<PanelChannelSettings>(queryKey, (current) => current === undefined ? current : { ...current, ...update });
  };
  const locationSaved = async (location: PanelChannelLocation | null, revision: number): Promise<void> => {
    await updateSettingsCache({ location, locationRevision: revision });
  };
  const saveSuggestedTimeZone = async (timeZone: string): Promise<void> => {
    if (!settingsReady) throw new Error("Channel settings are still loading.");
    const result = await saveChannelTimeZone(channelId, settings.revision, timeZone);
    await updateSettingsCache({ timeZone: result.timeZone, revision: result.revision });
  };
  const loadError = settingsQuery.error instanceof PanelApiError
    ? apiErrorText(settingsQuery.error.code, labels.loadError)
    : labels.loadError;

  return <div className="channel-location-page">
    <PageHeader title={labels.pageTitle} meta={labels.pageDescription} />
    <LoadState variant="panel-260"
      status={!settingsReady ? settingsQuery.isError || settings !== undefined ? "error" : "loading" : "success"}
      loading={<LoadStateLines rows={2} height={58} />}
      empty={<LoadStateLines rows={2} height={58} />}
      error={<p role="alert">{loadError}</p>}
      queryError={{ title: dashboard.errors.dataLoadFailed, message: loadError, onRetry: () => { void settingsQuery.refetch(); } }}>
      {!settingsReady ? null : <Section title={labels.location} className="channel-location-page__section">
        <ChannelLocationField channelId={channelId} language={language} value={settings.location}
          revision={settings.locationRevision} onSaved={locationSaved} channelTimeZone={settings.timeZone}
          onSaveChannelTimeZone={saveSuggestedTimeZone} canEdit={canEdit} disabled={settingsQuery.isFetching} />
      </Section>}
    </LoadState>
  </div>;
};

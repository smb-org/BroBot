import { useEffect, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ChannelRole, ChatOutputTarget } from "../contracts/values";
import { canManage } from "../contracts/values";
import type { PanelChannelSettings } from "./api";
import { PanelApiError, saveChannelDefaultChatTarget, saveChannelTimeZone } from "./api";
import { useChannelSettings } from "./data/channel-settings";
import { queryKeys } from "./data/keys";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts } from "./locale";
import { ChannelTimeZoneField } from "./ChannelTimeZoneField";
import { channelSettingsTexts } from "./channel-settings-locale";
import { chatTargetFieldTexts } from "./chat-target-field-locale";
import { mergeChannelSettingsResponse } from "./channel-settings-cache";
import { ChatTargetField, ConfirmDialog, LoadState, LoadStateLines, SaveStatus, Section, registerDashboardNavigationGuard, useDraftGuard } from "./ui";

interface ChannelDefaultsEditorProperties {
  channelId: string;
  role: ChannelRole;
}

interface ChannelDefaultsDraft {
  channelId: string;
  timeZoneRevision: number;
  chatTargetRevision: number;
  timeZone: string;
  chatTarget: ChatOutputTarget;
}

export const ChannelDefaultsEditor = ({ channelId, role }: ChannelDefaultsEditorProperties): ReactElement => {
  const labels = channelSettingsTexts(dashboardLanguage());
  const targetLabels = chatTargetFieldTexts[dashboardLanguage()];
  const common = dashboardCommonTexts();
  const dashboard = dashboardTexts();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.channel(channelId, "settings");
  const settingsQuery = useChannelSettings(channelId);
  const settings = settingsQuery.data;
  const settingsReady = settings !== undefined && typeof settings.timeZone === "string" && Number.isSafeInteger(settings.revision) &&
    Number.isSafeInteger(settings.defaultChatTargetRevision);
  const [draftState, setDraftState] = useState<ChannelDefaultsDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const canEdit = canManage(role);
  const draftForChannel = draftState?.channelId === channelId;
  const timeZoneDraftMatchesSettings = settings !== undefined && draftForChannel && draftState.timeZoneRevision === settings.revision;
  const chatTargetDraftMatchesSettings = settings !== undefined && draftForChannel && draftState.chatTargetRevision === settings.defaultChatTargetRevision;
  const timeZone = settings === undefined ? "" : timeZoneDraftMatchesSettings ? draftState.timeZone : settings.timeZone;
  const chatTarget = settings === undefined ? "source_only" : chatTargetDraftMatchesSettings ? draftState.chatTarget : settings.defaultChatTarget;
  const chatTargetLabel = chatTarget === "all_chats" ? targetLabels.allChats
    : chatTarget === "source_only" ? targetLabels.onlyOurChat : targetLabels.automatic;
  const dirty = settings !== undefined && (timeZone !== settings.timeZone || chatTarget !== settings.defaultChatTarget);

  const writeDraft = (next: Partial<Pick<ChannelDefaultsDraft, "timeZone" | "chatTarget">>): void => {
    if (!settingsReady) return;
    setDraftState({
      channelId,
      timeZoneRevision: settings.revision,
      chatTargetRevision: settings.defaultChatTargetRevision,
      timeZone,
      chatTarget,
      ...next,
    });
    setSaveError(undefined);
    setSaved(false);
  };

  const updateSettingsCache = async (update: Partial<PanelChannelSettings>): Promise<void> => {
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<PanelChannelSettings>(queryKey, (current) => current === undefined ? current : mergeChannelSettingsResponse(current, update));
  };

  const saveDraft = async (): Promise<string | null> => {
    if (!settingsReady || !canEdit || pending) return labels.saveError;
    if (timeZone.trim().length === 0) return labels.invalid;
    setPending(true);
    setSaveError(undefined);
    try {
      let currentTimeZoneRevision = settings.revision;
      let currentChatTargetRevision = settings.defaultChatTargetRevision;
      if (timeZone !== settings.timeZone) {
        const result = await saveChannelTimeZone(channelId, currentTimeZoneRevision, timeZone.trim());
        currentTimeZoneRevision = result.revision;
        await updateSettingsCache({ timeZone: result.timeZone, revision: result.revision });
        setDraftState({ channelId, timeZoneRevision: result.revision, chatTargetRevision: currentChatTargetRevision, timeZone: result.timeZone, chatTarget });
      }
      if (chatTarget !== settings.defaultChatTarget) {
        const result = await saveChannelDefaultChatTarget(channelId, currentChatTargetRevision, chatTarget);
        currentChatTargetRevision = result.defaultChatTargetRevision;
        await updateSettingsCache({ defaultChatTarget: result.defaultChatTarget, defaultChatTargetRevision: result.defaultChatTargetRevision });
        setDraftState({ channelId, timeZoneRevision: currentTimeZoneRevision, chatTargetRevision: currentChatTargetRevision, timeZone, chatTarget: result.defaultChatTarget });
      }
      setDraftState(null);
      setSaved(true);
      return null;
    } catch (error: unknown) {
      const fallback = labels.saveError;
      const message = error instanceof PanelApiError ? apiErrorText(error.code, fallback) : fallback;
      setSaveError(message);
      return message;
    } finally {
      setPending(false);
    }
  };

  const discard = (): void => {
    setDraftState(null);
    setSaveError(undefined);
    setSaved(false);
  };
  const navigationGuard = useDraftGuard(dirty, saveDraft, discard);

  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);

  return <Section title={labels.section} className="channel-defaults-editor">
    <LoadState variant={canEdit ? "panel-178" : "panel-0"}
      status={!settingsReady ? settingsQuery.isError || settings !== undefined ? "error" : "loading" : "success"}
      loading={<LoadStateLines rows={2} height={58} />}
      empty={<LoadStateLines rows={2} height={58} />}
      error={<p role="alert">{labels.loadError}</p>}
      queryError={{ title: dashboard.errors.dataLoadFailed, message: labels.loadError, onRetry: () => { void settingsQuery.refetch(); } }}>
      {!settingsReady ? null : !canEdit ? <>
        <p className="lock-reason">{labels.readOnly}</p>
        <dl className="properties channel-defaults-editor__properties">
          <div><dt>{labels.timeZone}</dt><dd>{timeZone}</dd></div>
          <div><dt>{labels.defaultChatTarget}</dt><dd>{chatTargetLabel}</dd></div>
        </dl>
      </> : <>
        <div className="channel-defaults-editor__fields">
          <div className="channel-defaults-editor__field">
            <ChannelTimeZoneField label={labels.timeZone} hint={labels.timeZoneHint} value={timeZone}
              onChange={(value) => { writeDraft({ timeZone: value }); }} canEdit disabled={pending} />
          </div>
          <div className="channel-defaults-editor__field channel-defaults-editor__field--chat-target">
            <ChatTargetField label={labels.defaultChatTarget} value={chatTarget}
              allowed={["all_chats", "source_only", "where_asked"]}
              onChange={(value) => { if (value !== null) writeDraft({ chatTarget: value }); }}
              disabled={pending} />
            <p className="muted channel-defaults-editor__hint">{labels.defaultChatTargetHint}</p>
          </div>
        </div>
        <SaveStatus dirty={dirty} pending={pending} persistent {...(saveError === undefined ? {} : { error: saveError })} saved={saved}
          onSave={() => { void saveDraft(); }} onDiscard={discard}
          saveLabel={common.save} discardLabel={common.discard} savedLabel={common.saved} pendingLabel={common.saving} />
      </>}
    </LoadState>
    <ConfirmDialog opened={navigationGuard.confirmOpen} title={dashboard.module.unsavedChangesTitle}
      description={dashboard.module.unsavedChangesDescription}
      confirmLabel={dashboard.module.discardAndSwitch} cancelLabel={dashboard.module.continueEditing}
      onCancel={navigationGuard.continueEditing} onConfirm={navigationGuard.discardAndSwitch} danger />
  </Section>;
};

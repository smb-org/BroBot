import { useEffect, useState, type ReactElement } from "react";

import { refetchModuleQueryData, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardTexts } from "../../../dashboard/locale";
import {
  Button,
  ConfirmDialog,
  Icon,
  SaveStatus,
  Section,
  Select,
  SwitchRow,
  notify,
  registerDashboardNavigationGuard,
  useDraft,
  useDraftGuard,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { DiscordRoleMappings } from "../contracts";
import { discordCatalog } from "../locale";
import {
  previewDiscordMappings,
  readDiscordChatHint,
  request,
  readDiscordServer,
  saveDiscordChatHint,
  saveDiscordMappings,
  type DiscordMappingPreview,
  type DiscordServerRead,
} from "./service";
import { DiscordServerStatus } from "./status";
import "./panel.css";

type DiscordPanelText = (typeof discordCatalog)[keyof typeof discordCatalog];
type NavigationLabels = ReturnType<typeof dashboardTexts>["module"];
type ConflictKind = "changed" | "disconnected";

type PanelFeedback = {
  source: "callback" | "local" | "reload-failed";
  message: string;
};

type ConflictReloadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; kind: ConflictKind };

interface DiscordCallbackResult {
  key: string;
  state: string;
}

interface DiscordCallbackDestination extends DiscordCallbackResult {
  channelId: string;
}

type MappingSaveResult = { mappings: DiscordRoleMappings } | { error: string; fixedMessage?: boolean };

let navigationCallbackDestination: DiscordCallbackDestination | null | undefined;
let consumedCallbackKey: string | null = null;

/**
 * The OAuth callback redirects here with `?discord=<state>`, but the dashboard router
 * canonicalizes the address bar before this lazy panel mounts. The navigation entry still
 * carries the URL the page was loaded with; only the matching channel panel consumes it.
 */
const readNavigationCallbackDestination = (): DiscordCallbackDestination | null => {
  if (navigationCallbackDestination !== undefined) return navigationCallbackDestination;
  const [navigation] = performance.getEntriesByType("navigation");
  const destination = navigation === undefined ? new URL(window.location.href) : new URL(navigation.name);
  let destinationChannelId: string | null = null;
  const match = /^\/channels\/([^/]+)\/modules\/discord$/u.exec(destination.pathname);
  if (match?.[1] !== undefined) {
    try { destinationChannelId = decodeURIComponent(match[1]); } catch { destinationChannelId = null; }
  }
  const state = destination.searchParams.get("discord");
  navigationCallbackDestination = destinationChannelId === null || state === null
    ? null
    : { channelId: destinationChannelId, state, key: `${destination.pathname}?discord=${state}` };
  return navigationCallbackDestination;
};

const readCallbackResult = (channelId: string): DiscordCallbackResult | null => {
  const destination = readNavigationCallbackDestination();
  if (destination === null || destination.channelId !== channelId || destination.key === consumedCallbackKey) return null;
  return { key: destination.key, state: destination.state };
};

const consumeCallbackResult = (result: DiscordCallbackResult | null): void => {
  if (result !== null && readNavigationCallbackDestination()?.key === result.key) consumedCallbackKey = result.key;
};

interface DiscordMappingsEditorProperties {
  guildId: string;
  server: DiscordServerRead;
  canManage: boolean;
  pending: boolean;
  blocked: boolean;
  text: DiscordPanelText;
  navigationLabels: NavigationLabels;
  onUserAction: () => void;
  onPreview: (guildId: string, mappings: DiscordRoleMappings) => Promise<DiscordMappingPreview>;
  onSave: (guildId: string, mappings: DiscordRoleMappings) => Promise<MappingSaveResult>;
}

const previewLine = (
  text: DiscordPanelText,
  template: "mappingPreviewGain" | "mappingPreviewLose",
  entry: { count: number; roleName: string },
): string => text[template].replace("{count}", String(entry.count)).replace("{role}", entry.roleName);

function DiscordMappingsEditor({ guildId, server, canManage, pending, blocked, text, navigationLabels, onUserAction, onPreview, onSave }: DiscordMappingsEditorProperties): ReactElement {
  const [draftOriginGuildId] = useState(guildId);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [preview, setPreview] = useState<DiscordMappingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const draft = useDraft<DiscordRoleMappings>(server.mappings);
  const draftDirty = draft.dirty;
  const roles = server.roles;
  const rolePosition = new Map<string, number>(roles.map((role) => [role.id, role.position] as const));
  const canSaveForShownGuild = draftOriginGuildId === guildId;

  useEffect(() => {
    if (!draftDirty) draft.accept(server.mappings);
  }, [draft.accept, draftDirty, server.mappings]);

  const save = async (confirmed = false): Promise<string | null> => {
    onUserAction();
    if (!draft.dirty) return null;
    if (!canManage || pending || blocked) return text.saveError;
    if (!canSaveForShownGuild) return text.mappingServerChanged;
    setSaveError(undefined);
    setSaved(false);
    if (!confirmed) {
      setPreviewing(true);
      try {
        const nextPreview = await onPreview(draftOriginGuildId, draft.value);
        if (nextPreview.gain.count === 0 && nextPreview.lose.every(({ count }) => count === 0)) {
          return await save(true);
        }
        setPreview(nextPreview);
        return null;
      } catch {
        setSaveError(text.saveError);
        return text.saveError;
      } finally {
        setPreviewing(false);
      }
    }
    const result = await onSave(draftOriginGuildId, draft.value);
    if ("mappings" in result) {
      draft.accept(result.mappings);
      setSaved(true);
      return null;
    }
    if (result.fixedMessage !== true) setSaveError(result.error);
    return result.error;
  };

  const guard = useDraftGuard(draft.dirty, save, draft.reset);
  useEffect(() => registerDashboardNavigationGuard(guard.guardSwitch), [guard.guardSwitch]);

  const roleOptions = (rankType: keyof DiscordRoleMappings): Array<{ value: string; label: string; selectedLabel?: string }> => {
    const current = draft.value[rankType];
    const options: Array<{ value: string; label: string; selectedLabel?: string }> = [{ value: "", label: text.noRole }];
    for (const role of roles) {
      const tooHigh = server.botHighestRolePosition !== null && role.position >= server.botHighestRolePosition;
      options.push({
        value: role.id,
        label: `${tooHigh ? "⚠ " : ""}${role.name}`,
        ...(tooHigh ? { selectedLabel: `${role.name} ⚠` } : {}),
      });
    }
    if (current !== null && !rolePosition.has(current)) {
      const missingLabel = server.rolesAvailable ? text.deletedRole : text.roleUnavailable;
      options.push({ value: current, label: `${missingLabel} (${current})`, selectedLabel: `${missingLabel} (${current})` });
    }
    return options;
  };
  const roleIsTooHigh = (rankType: keyof DiscordRoleMappings): boolean => {
    const selected = draft.value[rankType];
    const position = selected === null ? undefined : rolePosition.get(selected);
    return position !== undefined && server.botHighestRolePosition !== null && position >= server.botHighestRolePosition;
  };

  return <Section title={text.mappingSection}>
    <div className="discord-server-panel__mapping-fields">
      {(["vip", "moderator"] as const).map((rankType) => {
        const roleTooHigh = roleIsTooHigh(rankType);
        return <div className="discord-server-panel__mapping-field" key={rankType}>
          <Select
            label={rankType === "vip" ? text.vipRole : text.moderatorRole}
            value={draft.value[rankType] ?? ""}
            onChange={(roleId) => {
              onUserAction();
              setSaved(false);
              setSaveError(undefined);
              draft.setValue((current) => ({ ...current, [rankType]: roleId === null || roleId.length === 0 ? null : roleId }));
            }}
            options={roleOptions(rankType)}
            placeholder={text.selectRole}
            disabled={!canManage || pending || blocked || previewing || !canSaveForShownGuild}
            compact
          />
          <div className="discord-server-panel__warning" role="status">{roleTooHigh ? text.roleTooHigh : " "}</div>
        </div>;
      })}
    </div>
    <p className="discord-server-panel__hint">{text.subscriberHint}</p>
    <SaveStatus
      persistent
      dirty={draft.dirty}
      pending={pending || previewing}
      saved={saved}
      {...(saveError === undefined ? {} : { error: saveError })}
      saveDisabled={!canManage || blocked || !canSaveForShownGuild}
      saveLabel={text.save}
      discardLabel={text.discard}
      savedLabel={text.saved}
      pendingLabel={text.save}
      onSave={() => { void save(); }}
      onDiscard={() => { onUserAction(); draft.reset(); setSaved(false); setSaveError(undefined); }}
    />
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={navigationLabels.unsavedChangesTitle}
      description={navigationLabels.unsavedChangesDescription}
      confirmLabel={navigationLabels.discardAndSwitch}
      cancelLabel={navigationLabels.continueEditing}
      alternative={{ label: navigationLabels.saveAndSwitch, onClick: () => { void guard.saveAndSwitch(); } }}
      onConfirm={guard.discardAndSwitch}
      onCancel={guard.continueEditing}
      pending={guard.saving || pending}
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
      danger
    />
    <ConfirmDialog
      opened={preview !== null}
      title={text.mappingPreviewTitle}
      description={preview === null ? text.mappingPreviewDescription : [
        text.mappingPreviewDescription,
        ...(preview.gain.count > 0 ? [previewLine(text, "mappingPreviewGain", preview.gain)] : []),
        ...preview.lose.filter(({ count }) => count > 0).map((entry) => previewLine(text, "mappingPreviewLose", entry)),
      ].join("\n")}
      confirmLabel={text.mappingPreviewConfirm}
      cancelLabel={text.cancel}
      pending={pending}
      onConfirm={() => { setPreview(null); void save(true); }}
      onCancel={() => { setPreview(null); }}
    />
  </Section>;
}

function DiscordChatHintSettings({
  channelId, server, canManage, pending, text,
}: {
  channelId: string;
  server: DiscordServerRead;
  canManage: boolean;
  pending: boolean;
  text: DiscordPanelText;
}): ReactElement {
  const hintQuery = useModuleQuery(channelId, "discord", "settings", (signal) => readDiscordChatHint(channelId, signal));
  const currentHint = hintQuery.data?.settings.chatHintEnabled ?? server.chatHintEnabled;
  const settingsRevision = hintQuery.data?.revision ?? server.hintSettingsRevision;
  const draft = useDraft({ chatHintEnabled: currentHint });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const disabled = !canManage || pending || server.teardown || server.disconnecting;

  useEffect(() => {
    if (!draft.dirty) draft.accept({ chatHintEnabled: currentHint });
  }, [draft.accept, draft.dirty, currentHint]);

  const save = async (): Promise<void> => {
    if (!draft.dirty || disabled) return;
    setSaved(false);
    setSaveError(undefined);
    try {
      const result = await saveDiscordChatHint(channelId, draft.value.chatHintEnabled, settingsRevision);
      draft.accept(result.settings);
      setSaved(true);
      notify({ tone: "success", message: text.chatHintSaved });
    } catch {
      setSaveError(text.chatHintSaveError);
    }
  };

  return <Section title={text.chatHintSection}>
    <SwitchRow
      label={text.chatHintLabel}
      description={text.chatHintDescription}
      checked={draft.value.chatHintEnabled}
      disabled={disabled}
      pending={pending}
      onChange={(chatHintEnabled) => { setSaved(false); setSaveError(undefined); draft.setValue({ chatHintEnabled }); }}
    />
    <SaveStatus
      persistent
      dirty={draft.dirty}
      pending={pending}
      saved={saved}
      {...(saveError === undefined ? {} : { error: saveError })}
      saveDisabled={disabled}
      saveLabel={text.save}
      discardLabel={text.discard}
      savedLabel={text.chatHintSaved}
      pendingLabel={text.save}
      onSave={() => { void save(); }}
      onDiscard={() => { draft.reset(); setSaved(false); setSaveError(undefined); }}
    />
  </Section>;
}

function DiscordInfoChannelLink({ text }: { text: DiscordPanelText }): ReactElement {
  const [copied, setCopied] = useState(false);
  const link = new URL("/discord/link", window.location.origin).toString();
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return <Section title={text.linkForInfoChannel}>
    <p className="discord-server-panel__hint">{text.linkForInfoChannelDescription}</p>
    <div className="discord-server-panel__info-link">
      <code>{link}</code>
      <Button variant="secondary" icon="copy" onClick={() => { void copy(); }}>{copied ? text.copiedLink : text.copyLink}</Button>
    </div>
  </Section>;
}

function DiscordServerPanel({ channelId, language = "de", canManage = false }: ModulePanelProperties): ReactElement {
  const activeLanguage = language === "en" ? "en" : "de";
  const text = discordCatalog[activeLanguage];
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery<DiscordServerRead>(channelId, "discord", "server", (signal) => readDiscordServer(channelId, signal), {
    refetchInterval: (current) => current.state.data?.disconnecting === true || current.state.data?.teardown === true ? 1_000 : false,
  });
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [conflictReload, setConflictReload] = useState<ConflictReloadState>({ status: "idle" });
  const [callbackResult] = useState(() => readCallbackResult(channelId));
  const navigationLabels = dashboardTexts(activeLanguage).module;
  const callbackMessages: Record<string, string> = {
    "already-connected": text.alreadyConnected,
    connected: text.serverConnected,
    error: text.callbackError,
    unavailable: text.serverNotAvailable,
    disconnected: text.disconnectSuccess,
    "server-changed": text.mappingServerChanged,
  };
  const callbackMessage = callbackResult === null ? null : callbackMessages[callbackResult.state] ?? null;
  const [feedback, setFeedback] = useState<PanelFeedback | null>(() => callbackMessage === null
    ? null
    : { source: "callback", message: callbackMessage });

  useEffect(() => consumeCallbackResult(callbackResult), [callbackResult]);

  const dismissCallbackFeedback = (): void => {
    setFeedback((current) => current?.source === "callback" ? null : current);
  };

  const reloadConflictStatus = async (kind: ConflictKind): Promise<void> => {
    setConflictReload({ status: "loading" });
    setFeedback({ source: "local", message: text.mappingStatusReloading });
    setPending(true);
    try {
      await refetchModuleQueryData<DiscordServerRead>(queryClient, channelId, "discord", "server");
      setConflictReload({ status: "idle" });
      setFeedback({
        source: "local",
        message: kind === "disconnected" ? text.mappingServerDisconnected : text.mappingServerChanged,
      });
    } catch {
      setConflictReload({ status: "failed", kind });
      setFeedback({ source: "reload-failed", message: text.mappingStatusReloadFailed });
    } finally {
      setPending(false);
    }
  };

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "discord"] });
  };

  async function saveMappings(originGuildId: string, mappings: DiscordRoleMappings): Promise<MappingSaveResult> {
    const shownGuildId = query.data?.connection?.guildId;
    if (!canManage || pending) return { error: text.saveError };
    if (originGuildId !== shownGuildId) {
      const message = shownGuildId === undefined ? text.mappingServerDisconnected : text.mappingServerChanged;
      setFeedback({ source: "local", message });
      return { error: message, fixedMessage: true };
    }
    setPending(true);
    setFeedback(null);
    try {
      const saved = await saveDiscordMappings(channelId, originGuildId, mappings);
      await refresh();
      notify({ tone: "success", message: text.saved });
      return { mappings: saved.mappings };
    } catch (error: unknown) {
      if (error instanceof Error && (error.message === "discord_server_changed" || error.message === "discord_server_not_connected")) {
        const kind: ConflictKind = error.message === "discord_server_not_connected" ? "disconnected" : "changed";
        await reloadConflictStatus(kind);
        const message = kind === "disconnected" ? text.mappingServerDisconnected : text.mappingServerChanged;
        return { error: message, fixedMessage: true };
      }
      return { error: text.saveError };
    } finally {
      setPending(false);
    }
  }

  const previewMappings = async (originGuildId: string, mappings: DiscordRoleMappings): Promise<DiscordMappingPreview> =>
    await previewDiscordMappings(channelId, originGuildId, mappings);

  const connect = async (): Promise<void> => {
    dismissCallbackFeedback();
    setPending(true);
    try {
      const result = await request<{ authorizationUrl: string }>(channelId, "server/oauth/start", "POST");
      window.location.assign(result.authorizationUrl);
    } catch {
      notify({ tone: "error", message: text.connectError });
      setPending(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (pending) return;
    dismissCallbackFeedback();
    setPending(true);
    try {
      const result = await request<{ disconnecting?: boolean; remaining?: number } | undefined>(channelId, "server/disconnect", "POST");
      setDisconnectOpen(false);
      setFeedback(result?.disconnecting === true ? null : { source: "local", message: text.disconnectSuccess });
      await refresh();
    } catch {
      notify({ tone: "error", message: text.disconnectError });
    } finally {
      setPending(false);
    }
  };

  const server = query.data;
  const state = server?.state ?? (query.isError ? "could_not_check" : "not_available");
  const serverActionsDisabled = !canManage || pending || conflictReload.status !== "idle" ||
    server?.teardown === true || server?.disconnecting === true;
  const lifecycleMessage = server === undefined ? null
    : server.teardown ? text.teardownStatus.replace("{count}", String(server.teardownRemaining))
      : server.disconnecting ? text.disconnectingStatus.replace("{count}", String(server.teardownRemaining))
        : server.locked || server.globalTokenLocked ? text.lockedStatus : null;

  if (query.data === undefined && query.isLoading) {
    return <div className="module-stack discord-server-panel"><Section title={text.serverSection}><div className="discord-server-panel__reserved"><span aria-hidden="true">{" "}</span></div></Section></div>;
  }

  return <div className="module-stack discord-server-panel">
    <Section title={text.serverSection}>
      <DiscordServerStatus state={state} language={activeLanguage} />
      <div className="discord-server-panel__message" role="status" aria-live="polite">
        {lifecycleMessage ?? feedback?.message ?? " "}
        {feedback?.source === "reload-failed" && conflictReload.status === "failed"
          ? <button
            type="button"
            className="discord-server-panel__retry"
            disabled={pending}
            onClick={() => { void reloadConflictStatus(conflictReload.kind); }}
          >{text.retry}</button>
          : null}
      </div>
      {server === undefined || !server.configured ? null : server.connection === null
        ? <div className="discord-server-panel__actions">
          <Button variant="primary" icon="link" disabled={serverActionsDisabled} onClick={() => { void connect(); }}>{text.connectServer}</Button>
        </div>
        : <>
          <div className="discord-server-panel__guild">
            <Icon name="shield-check" size={20} />
            <span>{server.guildName ?? server.connection.guildId}</span>
          </div>
          <div className="discord-server-panel__actions">
            <Button variant="secondary" disabled={serverActionsDisabled} onClick={() => { dismissCallbackFeedback(); setDisconnectOpen(true); }}>{text.disconnectServer}</Button>
          </div>
        </>}
    </Section>

    {conflictReload.status === "idle" && server !== undefined && server.configured && server.connection !== null
      ? <DiscordMappingsEditor
        key={server.connection.guildId}
        guildId={server.connection.guildId}
        server={server}
        canManage={canManage}
        pending={pending}
        blocked={server.teardown || server.disconnecting}
        text={text}
        navigationLabels={navigationLabels}
        onUserAction={dismissCallbackFeedback}
        onPreview={previewMappings}
        onSave={saveMappings}
      />
      : null}

    {server !== undefined && server.configured
      ? <DiscordChatHintSettings channelId={channelId} server={server} canManage={canManage} pending={pending} text={text} />
      : null}
    <DiscordInfoChannelLink text={text} />

    <ConfirmDialog
      opened={disconnectOpen}
      title={text.disconnectConfirmTitle}
      description={text.disconnectConfirmDescription}
      confirmLabel={text.disconnectConfirm}
      cancelLabel={text.cancel}
      danger
      pending={pending || conflictReload.status !== "idle"}
      onConfirm={() => { void disconnect(); }}
      onCancel={() => { setDisconnectOpen(false); }}
    />
  </div>;
}

export default DiscordServerPanel;

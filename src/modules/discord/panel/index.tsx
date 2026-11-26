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
  notify,
  registerDashboardNavigationGuard,
  useDraft,
  useDraftGuard,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { DiscordRoleMappings } from "../contracts";
import { discordCatalog } from "../locale";
import { request, readDiscordServer, saveDiscordMappings, type DiscordServerRead } from "./service";
import { DiscordServerStatus } from "./status";
import "./panel.css";

type DiscordPanelText = (typeof discordCatalog)[keyof typeof discordCatalog];
type NavigationLabels = ReturnType<typeof dashboardTexts>["module"];

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
  text: DiscordPanelText;
  navigationLabels: NavigationLabels;
  onSave: (guildId: string, mappings: DiscordRoleMappings) => Promise<MappingSaveResult>;
}

function DiscordMappingsEditor({ guildId, server, canManage, pending, text, navigationLabels, onSave }: DiscordMappingsEditorProperties): ReactElement {
  const [draftOriginGuildId] = useState(guildId);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const draft = useDraft<DiscordRoleMappings>(server.mappings);
  const draftDirty = draft.dirty;
  const roles = server.roles;
  const rolePosition = new Map<string, number>(roles.map((role) => [role.id, role.position] as const));
  const canSaveForShownGuild = draftOriginGuildId === guildId;

  useEffect(() => {
    if (!draftDirty) draft.accept(server.mappings);
  }, [draft.accept, draftDirty, server.mappings]);

  const save = async (): Promise<string | null> => {
    if (!draft.dirty) return null;
    if (!canManage || pending) return text.saveError;
    if (!canSaveForShownGuild) return text.mappingServerChanged;
    setSaveError(undefined);
    setSaved(false);
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
              setSaved(false);
              setSaveError(undefined);
              draft.setValue((current) => ({ ...current, [rankType]: roleId === null || roleId.length === 0 ? null : roleId }));
            }}
            options={roleOptions(rankType)}
            placeholder={text.selectRole}
            disabled={!canManage || pending || !canSaveForShownGuild}
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
      pending={pending}
      saved={saved}
      {...(saveError === undefined ? {} : { error: saveError })}
      saveDisabled={!canManage || !canSaveForShownGuild}
      saveLabel={text.save}
      discardLabel={text.discard}
      savedLabel={text.saved}
      pendingLabel={text.save}
      onSave={() => { void save(); }}
      onDiscard={() => { draft.reset(); setSaved(false); setSaveError(undefined); }}
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
  </Section>;
}

function DiscordServerPanel({ channelId, language = "de", canManage = false }: ModulePanelProperties): ReactElement {
  const activeLanguage = language === "en" ? "en" : "de";
  const text = discordCatalog[activeLanguage];
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery<DiscordServerRead>(channelId, "discord", "server", (signal) => readDiscordServer(channelId, signal));
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<string | null>(null);
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

  useEffect(() => consumeCallbackResult(callbackResult), [callbackResult]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "discord"] });
  };

  async function saveMappings(originGuildId: string, mappings: DiscordRoleMappings): Promise<MappingSaveResult> {
    const shownGuildId = query.data?.connection?.guildId;
    if (!canManage || pending) return { error: text.saveError };
    if (originGuildId !== shownGuildId) {
      const message = shownGuildId === undefined ? text.mappingServerDisconnected : text.mappingServerChanged;
      setLocalFeedback(message);
      return { error: message, fixedMessage: true };
    }
    setPending(true);
    setLocalFeedback(null);
    try {
      const saved = await saveDiscordMappings(channelId, originGuildId, mappings);
      await refresh();
      notify({ tone: "success", message: text.saved });
      return { mappings: saved.mappings };
    } catch (error: unknown) {
      if (error instanceof Error && (error.message === "discord_server_changed" || error.message === "discord_server_not_connected")) {
        try {
          await refetchModuleQueryData<DiscordServerRead>(queryClient, channelId, "discord", "server");
        } catch {
          // The conflict message remains useful even if the follow-up status read also fails.
        }
        const message = error.message === "discord_server_not_connected" ? text.mappingServerDisconnected : text.mappingServerChanged;
        setLocalFeedback(message);
        return { error: message, fixedMessage: true };
      }
      return { error: text.saveError };
    } finally {
      setPending(false);
    }
  }

  const connect = async (): Promise<void> => {
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
    setPending(true);
    try {
      await request(channelId, "server/disconnect", "POST");
      setDisconnectOpen(false);
      setLocalFeedback(text.disconnectSuccess);
      await refresh();
    } catch {
      notify({ tone: "error", message: text.disconnectError });
    } finally {
      setPending(false);
    }
  };

  const server = query.data;
  const state = server?.state ?? (query.isError ? "could_not_check" : "not_available");

  if (query.data === undefined && query.isLoading) {
    return <div className="module-stack discord-server-panel"><Section title={text.serverSection}><div className="discord-server-panel__reserved"><span aria-hidden="true">{" "}</span></div></Section></div>;
  }

  return <div className="module-stack discord-server-panel">
    <Section title={text.serverSection}>
      <DiscordServerStatus state={state} language={activeLanguage} />
      <div className="discord-server-panel__message" role="status" aria-live="polite">{localFeedback ?? callbackMessage ?? " "}</div>
      {server === undefined || !server.configured ? null : server.connection === null
        ? <div className="discord-server-panel__actions">
          <Button variant="primary" icon="link" disabled={!canManage || pending} onClick={() => { void connect(); }}>{text.connectServer}</Button>
        </div>
        : <>
          <div className="discord-server-panel__guild">
            <Icon name="shield-check" size={20} />
            <span>{server.guildName ?? server.connection.guildId}</span>
          </div>
          <div className="discord-server-panel__actions">
            <Button variant="secondary" disabled={!canManage || pending} onClick={() => { setDisconnectOpen(true); }}>{text.disconnectServer}</Button>
          </div>
        </>}
    </Section>

    {server !== undefined && server.configured && server.connection !== null
      ? <DiscordMappingsEditor
        key={server.connection.guildId}
        guildId={server.connection.guildId}
        server={server}
        canManage={canManage}
        pending={pending}
        text={text}
        navigationLabels={navigationLabels}
        onSave={saveMappings}
      />
      : null}

    <ConfirmDialog
      opened={disconnectOpen}
      title={text.disconnectConfirmTitle}
      description={text.disconnectConfirmDescription}
      confirmLabel={text.disconnectConfirm}
      cancelLabel={text.cancel}
      danger
      pending={pending}
      onConfirm={() => { void disconnect(); }}
      onCancel={() => { setDisconnectOpen(false); }}
    />
  </div>;
}

export default DiscordServerPanel;

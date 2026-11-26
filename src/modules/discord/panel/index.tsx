import { useEffect, useState, type ReactElement } from "react";

import { useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
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

const emptyMappings: DiscordRoleMappings = { vip: null, moderator: null };

let callbackStateConsumed = false;

/**
 * The OAuth callback redirects here with `?discord=<state>`, but the dashboard router
 * canonicalizes the address bar before this lazy panel mounts. The navigation entry still
 * carries the URL the page was loaded with; the hint is shown once per page load.
 */
const readCallbackState = (): string | null => {
  if (callbackStateConsumed) return null;
  const [navigation] = performance.getEntriesByType("navigation");
  const search = navigation === undefined ? window.location.search : new URL(navigation.name).search;
  return new URLSearchParams(search).get("discord");
};

function DiscordServerPanel({ channelId, language = "de", canManage = false }: ModulePanelProperties): ReactElement {
  const activeLanguage = language === "en" ? "en" : "de";
  const text = discordCatalog[activeLanguage];
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery<DiscordServerRead>(channelId, "discord", "server", (signal) => readDiscordServer(channelId, signal));
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [callbackState, setCallbackState] = useState<string | null>(readCallbackState);
  const callbackMessages: Record<string, string> = {
    "already-connected": text.alreadyConnected,
    connected: text.serverConnected,
    error: text.callbackError,
    unavailable: text.serverNotAvailable,
    disconnected: text.disconnectSuccess,
  };
  const callbackMessage = callbackState === null ? null : callbackMessages[callbackState] ?? null;
  const draft = useDraft<DiscordRoleMappings>(query.data?.mappings ?? emptyMappings);
  const { accept: acceptDraft, dirty: draftDirty } = draft;
  const guard = useDraftGuard(draft.dirty, save, draft.reset);

  useEffect(() => {
    if (query.data !== undefined && !draftDirty) acceptDraft(query.data.mappings);
  }, [acceptDraft, draftDirty, query.data]);
  useEffect(() => registerDashboardNavigationGuard(guard.guardSwitch), [guard.guardSwitch]);
  useEffect(() => { callbackStateConsumed = true; }, []);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "discord"] });
  };

  async function save(): Promise<string | null> {
    if (!canManage || !draft.dirty || pending) return null;
    setPending(true);
    setSaveError(undefined);
    setSaved(false);
    try {
      const result = await saveDiscordMappings(channelId, draft.value);
      draft.accept(result.mappings);
      await refresh();
      setSaved(true);
      notify({ tone: "success", message: text.saved });
      return null;
    } catch {
      setSaveError(text.saveError);
      return text.saveError;
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
      draft.accept(emptyMappings);
      setCallbackState("disconnected");
      await refresh();
    } catch {
      notify({ tone: "error", message: text.disconnectError });
    } finally {
      setPending(false);
    }
  };

  const server = query.data;
  const state = server?.state ?? (query.isError ? "could_not_check" : "not_available");
  const roles = server?.roles ?? [];
  const rolePosition = new Map<string, number>(roles.map((role) => [role.id, role.position] as const));
  const roleOptions = (rankType: keyof DiscordRoleMappings): Array<{ value: string; label: string; selectedLabel?: string }> => {
    const current = draft.value[rankType];
    const options: Array<{ value: string; label: string; selectedLabel?: string }> = [{ value: "", label: text.noRole }];
    for (const role of roles) {
      const tooHigh = server?.botHighestRolePosition !== null && server?.botHighestRolePosition !== undefined &&
        role.position >= server.botHighestRolePosition;
      options.push({
        value: role.id,
        label: `${tooHigh ? "⚠ " : ""}${role.name}`,
        ...(tooHigh ? { selectedLabel: `${role.name} ⚠` } : {}),
      });
    }
    if (current !== null && !rolePosition.has(current)) {
      const missingLabel = server?.rolesAvailable === true ? text.deletedRole : text.roleUnavailable;
      options.push({ value: current, label: `${missingLabel} (${current})`, selectedLabel: `${missingLabel} (${current})` });
    }
    return options;
  };
  const roleIsTooHigh = (rankType: keyof DiscordRoleMappings): boolean => {
    const selected = draft.value[rankType];
    const position = selected === null ? undefined : rolePosition.get(selected);
    return position !== undefined && server?.botHighestRolePosition !== null && server?.botHighestRolePosition !== undefined &&
      position >= server.botHighestRolePosition;
  };

  if (query.data === undefined && query.isLoading) {
    return <div className="module-stack discord-server-panel"><Section title={text.serverSection}><div className="discord-server-panel__reserved"><span aria-hidden="true">{" "}</span></div></Section></div>;
  }

  return <div className="module-stack discord-server-panel">
    <Section title={text.serverSection}>
      <DiscordServerStatus state={state} language={activeLanguage} />
      <div className="discord-server-panel__message" role="status" aria-live="polite">{callbackMessage ?? " "}</div>
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

    {server?.configured && server.connection !== null ? <Section title={text.mappingSection}>
      <div className="discord-server-panel__mapping-fields">
        {(["vip", "moderator"] as const).map((rankType) => {
          const roleTooHigh = roleIsTooHigh(rankType);
          return <div className="discord-server-panel__mapping-field" key={rankType}>
            <Select
              label={rankType === "vip" ? text.vipRole : text.moderatorRole}
              value={draft.value[rankType] ?? ""}
              onChange={(roleId) => {
                setSaved(false);
                draft.setValue((current) => ({ ...current, [rankType]: roleId === null || roleId.length === 0 ? null : roleId }));
              }}
              options={roleOptions(rankType)}
              placeholder={text.selectRole}
              disabled={!canManage || pending}
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
        saveDisabled={!canManage}
        saveLabel={text.save}
        discardLabel={text.discard}
        savedLabel={text.saved}
        pendingLabel={text.save}
        onSave={() => { void save(); }}
        onDiscard={() => { draft.reset(); setSaved(false); setSaveError(undefined); }}
      />
    </Section> : null}

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

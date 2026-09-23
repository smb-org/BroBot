import { useCallback, useMemo, useState, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { TextCommand } from "../modules/text_commands/contracts";
import { loadTextCommands } from "../modules/text_commands/panel/service";
import { canManage, type ChannelRole } from "../contracts/values";
import type { PanelMember, PanelModuleState } from "../panel-contract";
import { createClip, fetchMembers, sendManualShoutout, setChannelModuleEnabled, startCommercial } from "./api";
import { dashboardTexts } from "./locale";
import { moduleDescription, moduleName, moduleWorkspaceTexts } from "./module-labels";
import { ModuleIcon } from "./module-panels";
import type { DashboardRoute } from "./router";
import { Spotlight, type SpotlightItem } from "./ui";

const SHOUTOUT_KEYWORD = "shoutout";

interface ChannelSpotlightProperties {
  channelId: string;
  ownRole: ChannelRole;
  streamState?: "online" | "offline" | null | undefined;
  modules: PanelModuleState[];
  onNavigate: (route: DashboardRoute) => void;
  /** Set right before navigating to the text_commands module, so its panel can pre-select the command. */
  onOpenCommand: (commandName: string) => void;
}

/**
 * ⌘K/Ctrl+K (#164): finds modules, text commands, members, and runs a
 * small set of registered actions for the current channel. Explicitly not
 * a navigation replacement -- selecting a module or member still opens
 * that page, same as clicking it would.
 */
export const ChannelSpotlight = ({ channelId, ownRole, streamState, modules, onNavigate, onOpenCommand }: ChannelSpotlightProperties): ReactElement => {
  const texts = dashboardTexts();
  const manageable = canManage(ownRole);
  const [commands, setCommands] = useState<TextCommand[]>([]);
  const [members, setMembers] = useState<PanelMember[]>([]);
  const [query, setQuery] = useState("");

  // Loaded on open, not on mount: Spotlight is mounted on every
  // channel/module route so it's ready for mod+K, but most page visits
  // never open it -- fetching commands/members eagerly would be a
  // background request on every navigation for a feature nobody used yet.
  const loadResultData = useCallback((): void => {
    loadTextCommands(channelId).then(setCommands).catch(() => { setCommands([]); });
    fetchMembers(channelId).then((data) => { setMembers(data.members); }).catch(() => { setMembers([]); });
  }, [channelId]);

  const moduleItems = useMemo<SpotlightItem[]>(() => MODULES.map((module) => {
    const description = moduleDescription(module.id);
    const accessibleDescription = module.mandatory === true
      ? `${description === null ? "" : `${description} `}${moduleWorkspaceTexts().mandatoryReason}`
      : description;
    return {
      id: `module:${module.id}`,
      label: moduleName(module.id),
      icon: <ModuleIcon moduleId={module.id} className="spotlight-module-icon" />,
      ...(accessibleDescription === null || accessibleDescription.length === 0 ? {} : { description: accessibleDescription }),
      group: texts.spotlight.groupModules,
      onTrigger: () => { onNavigate({ kind: "module", channelId, moduleId: module.id }); },
    };
  }), [channelId, onNavigate, texts.spotlight.groupModules]);

  const commandItems = useMemo<SpotlightItem[]>(() => commands.map((command) => ({
    id: `command:${command.name}`,
    label: `!${command.name}`,
    description: texts.spotlight.openCommand(command.name),
    icon: <ModuleIcon moduleId="text_commands" className="spotlight-module-icon" />,
    group: texts.spotlight.groupCommands,
    keywords: [command.name],
    onTrigger: () => {
      onOpenCommand(command.name);
      onNavigate({ kind: "module", channelId, moduleId: "text_commands" });
    },
  })), [commands, channelId, onNavigate, onOpenCommand, texts.spotlight]);

  const memberItems = useMemo<SpotlightItem[]>(() => members.map((member) => ({
    id: `member:${member.userId}`,
    label: member.displayName ?? member.login ?? member.userId,
    description: texts.spotlight.openMember,
    icon: "member",
    group: texts.spotlight.groupMembers,
    ...(member.login === null ? {} : { keywords: [member.login] }),
    onTrigger: () => { onNavigate({ kind: "channel", channelId, section: "members" }); },
  })), [members, channelId, onNavigate, texts.spotlight]);

  const adsEnabled = modules.find((candidate) => candidate.id === "ads")?.enabled === true;
  const shoutoutLogin = query.toLowerCase().startsWith(`${SHOUTOUT_KEYWORD} `)
    ? query.slice(SHOUTOUT_KEYWORD.length + 1).trim()
    : "";

  const actionItems = useMemo<SpotlightItem[]>(() => {
    const managementLockReason = manageable ? undefined : texts.module.managementLocked;
    return [
      {
        id: "action:ad-now",
        label: texts.streamManager.runAd("60"),
        group: texts.spotlight.groupActions,
        keywords: ["ad", "werbung", "commercial"],
        disabled: !manageable || streamState === "offline",
        ...(managementLockReason !== undefined ? { disabledReason: managementLockReason } : streamState === "offline" ? { disabledReason: texts.streamManager.adDisabledOffline } : {}),
        icon: "ad",
        onTrigger: () => { void startCommercial(channelId, 60); },
      },
      {
        id: "action:ads-off",
        label: texts.spotlight.adOff,
        group: texts.spotlight.groupActions,
        // Full phrases, not just "ads": two actions sharing a bare "ads"
        // keyword would both survive a query for either of them.
        keywords: ["ads off", "werbung aus"],
        disabled: !manageable || !adsEnabled,
        ...(managementLockReason === undefined ? {} : { disabledReason: managementLockReason }),
        icon: <ModuleIcon moduleId="ads" className="spotlight-module-icon" />,
        onTrigger: () => { void setChannelModuleEnabled(channelId, "ads", false); },
      },
      {
        id: "action:ads-on",
        label: texts.spotlight.adOn,
        group: texts.spotlight.groupActions,
        keywords: ["ads on", "werbung an"],
        disabled: !manageable || adsEnabled,
        ...(managementLockReason === undefined ? {} : { disabledReason: managementLockReason }),
        icon: <ModuleIcon moduleId="ads" className="spotlight-module-icon" />,
        onTrigger: () => { void setChannelModuleEnabled(channelId, "ads", true); },
      },
      {
        id: "action:clip",
        label: texts.streamManager.createClip,
        group: texts.spotlight.groupActions,
        keywords: ["clip"],
        icon: "clip",
        onTrigger: () => { void createClip(channelId); },
      },
      {
        id: "action:shoutout",
        label: texts.streamManager.sendShoutout,
        description: texts.spotlight.shoutoutHint,
        group: texts.spotlight.groupActions,
        keywords: [SHOUTOUT_KEYWORD],
        icon: "shoutout",
        disabled: shoutoutLogin.length === 0,
        disabledReason: texts.spotlight.shoutoutMissingLogin,
        onTrigger: () => { void sendManualShoutout(channelId, shoutoutLogin); },
      },
    ];
  }, [texts, manageable, adsEnabled, channelId, shoutoutLogin, streamState]);

  const items = [...actionItems, ...moduleItems, ...commandItems, ...memberItems];

  return (
    <Spotlight
      items={items}
      emptyMessage={texts.spotlight.empty}
      placeholder={texts.spotlight.placeholder}
      query={query}
      onQueryChange={setQuery}
      onOpen={loadResultData}
    />
  );
};

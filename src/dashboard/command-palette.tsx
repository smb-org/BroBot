import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { TextCommand } from "../modules/text_commands/contracts";
import { loadTextCommands } from "../modules/text_commands/panel/service";
import { canManage, type ChannelRole } from "../contracts/values";
import type { PanelModuleState } from "../panel-contract";
import { PanelApiError, createClip, fetchChannelVariables, sendManualShoutout, setChannelModuleEnabled, startCommercial, type PanelChannelVariable } from "./api";
import { dispatchDashboardAuthenticationRequired } from "./data/events";
import { refreshAfterModuleToggle } from "./data/module-toggle";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { apiErrorText, channelVariablesTexts, dashboardLanguage, dashboardTexts, immediateActionUnavailableReasonText } from "./locale";
import { moduleDescription, moduleName, moduleWorkspaceTexts } from "./module-labels";
import { ModuleIcon, NavigationIcon } from "./module-panels";
import { dashboardNavigationGroups } from "./nav-pages";
import { dashboardRoutePath, dashboardRouteRequiresBot, type DashboardRoute } from "./router";
import { readRecentTargets, rememberRecentTarget, RECENT_TARGET_LIMIT } from "./command-palette-recents";
import { notify, CommandPalette, type CommandPaletteItem } from "./ui";

const SHOUTOUT_KEYWORD = "shoutout";

const botBlocksRoute = (route: DashboardRoute, botSignedIn: boolean | undefined): boolean =>
  botSignedIn === false && dashboardRouteRequiresBot(route);

/**
 * Presence and availability for a module's immediate action, from the exact
 * same source Stream Manager reads (`ImmediateActions` in stream-manager.tsx)
 * -- so the command palette can't offer an action for a disabled module.
 */
const moduleImmediateActionAvailability = (
  moduleId: string,
  modules: readonly Pick<PanelModuleState, "id" | "enabled">[],
  streamState: "online" | "offline" | null | undefined,
): { offered: boolean; disabledReason: string | null } => {
  const module = MODULES.find((entry) => entry.id === moduleId);
  const state = modules.find((entry) => entry.id === moduleId);
  if (module?.immediateActions === undefined || state === undefined || !state.enabled) {
    return { offered: false, disabledReason: null };
  }
  const availability = evaluateImmediateActionAvailability(module.immediateActions.requires, streamState);
  return {
    offered: true,
    disabledReason: availability.reason === null ? null : immediateActionUnavailableReasonText(availability.reason),
  };
};

interface ChannelCommandPaletteProperties {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string | null;
  ownRole: ChannelRole | null;
  viewerUserId?: string | null;
  route?: DashboardRoute;
  /** Account-wide platform admin flag (#208) -- same gate `PanelSidebar` uses to show the platform page, never the per-channel "operator" role. */
  isPlatformAdmin?: boolean;
  /** Whether the installation bot is signed in; undefined while its status is unknown. */
  botSignedIn?: boolean;
  streamState?: "online" | "offline" | null | undefined;
  modules: PanelModuleState[];
  onNavigate: (route: DashboardRoute, onNavigated?: () => void) => void;
  /** Set after navigation succeeds, so its panel can pre-select the command. */
  onOpenCommand: (commandName: string) => void;
  /** Set after navigation succeeds, scoped to the channel the variable belongs to (#208). */
  onOpenVariable: (channelId: string, variableName: string) => void;
}

const variableDescription = (variable: PanelChannelVariable): string =>
  variable.description.trim().length > 0 ? variable.description : channelVariablesTexts().noDescription;

const recentTargetPathForRoute = (route: DashboardRoute, channelId: string | null): string | null => {
  if (channelId === null) return null;
  if (route.kind === "module" && route.channelId === channelId) {
    return dashboardRoutePath({ kind: "module", channelId, moduleId: route.moduleId });
  }
  if (route.kind === "channel" && route.channelId === channelId) {
    return dashboardRoutePath({ kind: "channel", channelId, section: route.section });
  }
  return null;
};

/** Cmd/Ctrl+K finds navigation, text commands, variables, and channel actions. */
export const ChannelCommandPalette = ({ open, onOpenChange, channelId, ownRole, viewerUserId = null, route, isPlatformAdmin = false, botSignedIn, streamState, modules, onNavigate, onOpenCommand, onOpenVariable }: ChannelCommandPaletteProperties): ReactElement => {
  const texts = dashboardTexts();
  const manageable = ownRole !== null && canManage(ownRole);
  const [commands, setCommands] = useState<TextCommand[]>([]);
  const [variables, setVariables] = useState<readonly PanelChannelVariable[]>([]);
  const [query, setQuery] = useState("");
  const currentTargetPath = route === undefined ? null : recentTargetPathForRoute(route, channelId);
  const recentTargetPaths = useMemo(() => {
    const stored = readRecentTargets(viewerUserId, channelId ?? "");
    return currentTargetPath === null
      ? stored
      : [currentTargetPath, ...stored.filter((path) => path !== currentTargetPath)].slice(0, RECENT_TARGET_LIMIT);
  }, [channelId, currentTargetPath, viewerUserId]);

  useEffect(() => {
    if (currentTargetPath === null || channelId === null) return;
    rememberRecentTarget(viewerUserId, channelId, currentTargetPath);
  }, [channelId, currentTargetPath, viewerUserId]);

  // Loaded on open, not on mount: the command palette stays mounted in the shell
  // so the sidebar trigger and shortcut work from every route, but most page visits
  // never open it -- fetching commands/variables eagerly would be a
  // background request on every navigation for a feature nobody used yet.
  const loadResultData = useCallback((): void => {
    if (channelId === null) return;
    loadTextCommands(channelId).then(setCommands).catch(() => { setCommands([]); });
    fetchChannelVariables(channelId).then((data) => { setVariables(data.variables); }).catch(() => { setVariables([]); });
  }, [channelId]);

  const navigationItems = useMemo<CommandPaletteItem[]>(() => dashboardNavigationGroups(
    { isPlatformAdmin },
    channelId ?? "",
    texts,
    MODULES,
    modules,
    ownRole,
    dashboardLanguage(),
    (moduleId) => moduleName(moduleId),
  ).flatMap((group) => group.entries.map((entry) => {
    const module = entry.moduleId === undefined ? undefined : MODULES.find((candidate) => candidate.id === entry.moduleId);
    const description = entry.description ?? (entry.moduleId === undefined ? undefined : moduleDescription(entry.moduleId)) ?? undefined;
    const accessibleDescription = module?.mandatory === true
      ? `${description === undefined ? "" : `${description} `}${module.mandatoryReason?.[dashboardLanguage()] ?? moduleWorkspaceTexts().mandatoryReason}`
      : description;
    const blockedByBot = botBlocksRoute(entry.route, botSignedIn);
    const moduleState = entry.moduleId === undefined ? undefined : modules.find((candidate) => candidate.id === entry.moduleId);
    return {
      id: entry.id,
      label: entry.label,
      recentTargetPath: dashboardRoutePath(entry.route),
      ...(entry.iconKind === null
        ? entry.moduleId === undefined ? {} : { icon: <ModuleIcon moduleId={entry.moduleId} className="command-palette-module-icon" /> }
        : { icon: <NavigationIcon kind={entry.iconKind} className="command-palette-module-icon" /> }),
      ...(accessibleDescription === undefined || accessibleDescription.length === 0 ? {} : { description: accessibleDescription }),
      group: group.heading,
      ...(moduleState?.enabled === false ? { stateLabel: texts.navigation.moduleOff } : {}),
      keywords: [...entry.keywords],
      ...(blockedByBot ? { disabled: true, disabledReason: texts.blocking.botTitle } : {}),
      onTrigger: () => { onNavigate(entry.route); },
    };
  })), [botSignedIn, channelId, isPlatformAdmin, modules, onNavigate, ownRole, texts]);

  const commandItems = useMemo<CommandPaletteItem[]>(() => channelId === null ? [] : commands.map((command) => {
    const route: DashboardRoute = { kind: "module", channelId, moduleId: "text_commands" };
    const blockedByBot = botBlocksRoute(route, botSignedIn);
    return {
      id: `command:${command.name}`,
      label: `!${command.name}`,
      description: texts.commandPalette.openCommand(command.name),
      icon: <ModuleIcon moduleId="text_commands" className="command-palette-module-icon" />,
      group: texts.commandPalette.groupCommands,
      keywords: [command.name],
      ...(blockedByBot ? { disabled: true, disabledReason: texts.blocking.botTitle } : {}),
      onTrigger: () => {
        onNavigate(route, () => { onOpenCommand(command.name); });
      },
    };
  }), [botSignedIn, commands, channelId, onNavigate, onOpenCommand, texts.blocking.botTitle, texts.commandPalette]);

  const variableItems = useMemo<CommandPaletteItem[]>(() => channelId === null ? [] : variables.map((variable) => ({
    id: `variable:${variable.name}`,
    label: `{var.${variable.name}}`,
    description: variableDescription(variable),
    icon: <NavigationIcon kind="variable" className="command-palette-module-icon" />,
    group: texts.commandPalette.groupVariables,
    keywords: [variable.name],
    onTrigger: () => {
      onNavigate({ kind: "channel", channelId, section: "variables" }, () => { onOpenVariable(channelId, variable.name); });
    },
  })), [variables, channelId, onNavigate, onOpenVariable, texts.commandPalette]);

  const adsEnabled = modules.find((candidate) => candidate.id === "ads")?.enabled === true;
  const shoutoutLogin = query.toLowerCase().startsWith(`${SHOUTOUT_KEYWORD} `)
    ? query.slice(SHOUTOUT_KEYWORD.length + 1).trim()
    : "";

  const queryClient = useQueryClient();
  const toggleAds = useCallback(async (enabled: boolean): Promise<void> => {
    if (channelId === null) return;
    try {
      await setChannelModuleEnabled(channelId, "ads", enabled);
    } catch (error) {
      // Same reporting as the other module toggles; a 401 also needs the
      // sign-in recovery that the QueryCache would trigger for queries.
      const fallback = dashboardTexts().errors.changeFailed;
      notify({ tone: "error", message: error instanceof PanelApiError ? apiErrorText(error.code, fallback) : fallback });
      if (error instanceof PanelApiError && error.status === 401) dispatchDashboardAuthenticationRequired();
      return;
    }
    await refreshAfterModuleToggle(queryClient, channelId);
  }, [channelId, queryClient]);
  const actionItems = useMemo<CommandPaletteItem[]>(() => {
    if (channelId === null) return [];
    const managementLockReason = manageable ? undefined : texts.module.managementLocked;
    // Ad now, clip, and shoutout are the same immediate actions Stream
    // Manager offers. Ads require management rights; clips and shoutouts stay
    // available to every member. Each also reports its stream-state reason.
    const adNow = moduleImmediateActionAvailability("ads", modules, streamState);
    const clip = moduleImmediateActionAvailability("clips", modules, streamState);
    const shoutout = moduleImmediateActionAvailability("raid", modules, streamState);
    const items: CommandPaletteItem[] = [];
    if (adNow.offered) {
      const adNowDisabledReason = !manageable ? texts.module.managementLocked : adNow.disabledReason;
      items.push({
        id: "action:ad-now",
        label: texts.streamManager.runAd("60"),
        group: texts.commandPalette.groupActions,
        keywords: ["ad", "werbung", "commercial"],
        disabled: adNowDisabledReason !== null,
        ...(adNowDisabledReason === null ? {} : { disabledReason: adNowDisabledReason }),
        icon: "ad",
        onTrigger: () => { if (manageable) void startCommercial(channelId, 60); },
      });
    }
    items.push(
      {
        id: "action:ads-off",
        label: texts.commandPalette.adOff,
        group: texts.commandPalette.groupActions,
        // Full phrases, not just "ads": two actions sharing a bare "ads"
        // keyword would both survive a query for either of them.
        keywords: ["ads off", "werbung aus"],
        disabled: !manageable || !adsEnabled,
        ...(managementLockReason === undefined ? {} : { disabledReason: managementLockReason }),
        icon: <ModuleIcon moduleId="ads" className="command-palette-module-icon" />,
        onTrigger: () => { void toggleAds(false); },
      },
      {
        id: "action:ads-on",
        label: texts.commandPalette.adOn,
        group: texts.commandPalette.groupActions,
        keywords: ["ads on", "werbung an"],
        disabled: !manageable || adsEnabled,
        ...(managementLockReason === undefined ? {} : { disabledReason: managementLockReason }),
        icon: <ModuleIcon moduleId="ads" className="command-palette-module-icon" />,
        onTrigger: () => { void toggleAds(true); },
      },
    );
    if (clip.offered) {
      items.push({
        id: "action:clip",
        label: texts.streamManager.createClip,
        group: texts.commandPalette.groupActions,
        keywords: ["clip"],
        icon: "clip",
        disabled: clip.disabledReason !== null,
        ...(clip.disabledReason === null ? {} : { disabledReason: clip.disabledReason }),
        onTrigger: () => { void createClip(channelId); },
      });
    }
    if (shoutout.offered) {
      items.push({
        id: "action:shoutout",
        label: texts.streamManager.sendShoutout,
        description: texts.commandPalette.shoutoutHint,
        group: texts.commandPalette.groupActions,
        keywords: [SHOUTOUT_KEYWORD],
        icon: "shoutout",
        disabled: shoutout.disabledReason !== null || shoutoutLogin.length === 0,
        disabledReason: shoutout.disabledReason ?? texts.commandPalette.shoutoutMissingLogin,
        onTrigger: () => { void sendManualShoutout(channelId, shoutoutLogin); },
      });
    }
    return items;
  }, [texts, manageable, adsEnabled, channelId, shoutoutLogin, streamState, modules, toggleAds]);

  const targetItems = navigationItems;
  const recentItems = recentTargetPaths.flatMap((path, index) => {
    const target = targetItems.find((item) => item.recentTargetPath === path);
    return target === undefined ? [] : [{
      ...target,
      id: `recent:${String(index)}:${target.id}`,
      group: texts.commandPalette.groupRecentTargets,
    }];
  });
  const items = [...recentItems, ...actionItems, ...navigationItems, ...commandItems, ...variableItems];

  const setPaletteOpen = (nextOpen: boolean): void => {
    if (!nextOpen) setQuery("");
    onOpenChange(nextOpen);
  };

  return (
    <CommandPalette
      items={items}
      emptyMessage={texts.commandPalette.empty}
      title={texts.commandPalette.title}
      description={texts.commandPalette.description}
      placeholder={texts.commandPalette.placeholder}
      navigateHint={texts.commandPalette.navigateHint}
      openHint={texts.commandPalette.openHint}
      open={open}
      onOpenChange={setPaletteOpen}
      query={query}
      onQueryChange={setQuery}
      onOpen={loadResultData}
    />
  );
};

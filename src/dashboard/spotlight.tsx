import { useCallback, useMemo, useState, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { TextCommand } from "../modules/text_commands/contracts";
import { loadTextCommands } from "../modules/text_commands/panel/service";
import { canManage, type ChannelRole } from "../contracts/values";
import type { PanelModuleState } from "../panel-contract";
import { createClip, fetchChannelVariables, sendManualShoutout, setChannelModuleEnabled, startCommercial, type PanelChannelVariable } from "./api";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { channelVariablesTexts, dashboardTexts, immediateActionUnavailableReasonText } from "./locale";
import { moduleDescription, moduleName, moduleWorkspaceTexts } from "./module-labels";
import { ModuleIcon, NavigationIcon } from "./module-panels";
import { navPageGroupHeading, visibleNavPages } from "./nav-pages";
import { dashboardRouteRequiresBot, type DashboardRoute } from "./router";
import { Spotlight, type SpotlightItem } from "./ui";

const SHOUTOUT_KEYWORD = "shoutout";

/**
 * Presence and availability for a module's immediate action, from the exact
 * same source Stream Manager reads (`ImmediateActions` in stream-manager.tsx)
 * -- so Spotlight can't offer an action for a disabled module, or gate one
 * behind a role the endpoint itself doesn't require (#178's ad-now/operator
 * bug came from a Spotlight-only `manageable` check no module declares).
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

interface ChannelSpotlightProperties {
  channelId: string;
  ownRole: ChannelRole;
  /** Account-wide platform admin flag (#208) -- same gate `PanelSidebar` uses to show the platform page, never the per-channel "operator" role. */
  isPlatformAdmin?: boolean;
  /** Whether the installation bot is signed in; undefined while its status is unknown. */
  botSignedIn?: boolean;
  streamState?: "online" | "offline" | null | undefined;
  modules: PanelModuleState[];
  onNavigate: (route: DashboardRoute) => void;
  /** Set right before navigating to the text_commands module, so its panel can pre-select the command. */
  onOpenCommand: (commandName: string) => void;
  /** Set right before navigating to the variables page, so it can pre-select the variable (#208). */
  onOpenVariable: (variableName: string) => void;
}

const variableDescription = (variable: PanelChannelVariable): string =>
  variable.description.trim().length > 0 ? variable.description : channelVariablesTexts().noDescription;

/**
 * ⌘K/Ctrl+K (#164): finds every sidebar page, modules, text commands,
 * channel variables, and runs a small set of registered actions for the
 * current channel. Explicitly not a navigation replacement -- selecting a
 * page, module, or variable still opens it, same as clicking it would.
 * Per-member search was removed in #208: finding individual people wasn't
 * useful here, and the sidebar's "Mitglieder" page (still indexed below)
 * covers it.
 */
export const ChannelSpotlight = ({ channelId, ownRole, isPlatformAdmin = false, botSignedIn, streamState, modules, onNavigate, onOpenCommand, onOpenVariable }: ChannelSpotlightProperties): ReactElement => {
  const texts = dashboardTexts();
  const manageable = canManage(ownRole);
  const [commands, setCommands] = useState<TextCommand[]>([]);
  const [variables, setVariables] = useState<readonly PanelChannelVariable[]>([]);
  const [query, setQuery] = useState("");

  // Loaded on open, not on mount: Spotlight is mounted on every
  // channel/module route so it's ready for mod+K, but most page visits
  // never open it -- fetching commands/variables eagerly would be a
  // background request on every navigation for a feature nobody used yet.
  const loadResultData = useCallback((): void => {
    loadTextCommands(channelId).then(setCommands).catch(() => { setCommands([]); });
    fetchChannelVariables(channelId).then((data) => { setVariables(data.variables); }).catch(() => { setVariables([]); });
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

  // Every sidebar page, indexed from the same `NAV_PAGES` list `PanelSidebar`
  // renders from (#208) -- a page added there appears here too, and the
  // platform page is gated by the same account-wide flag the sidebar uses.
  const pageItems = useMemo<SpotlightItem[]>(() => visibleNavPages({ isPlatformAdmin }).map((page) => {
    const pageRoute = page.route(channelId);
    const blockedByBot = botSignedIn === false && dashboardRouteRequiresBot(pageRoute);
    return {
      id: `page:${page.id}`,
      label: page.label(texts),
      icon: <NavigationIcon kind={page.iconKind} className="spotlight-module-icon" />,
      group: navPageGroupHeading(page.group, texts),
      keywords: [...page.keywords],
      ...(blockedByBot ? { disabled: true, disabledReason: texts.blocking.botTitle } : {}),
      onTrigger: () => { onNavigate(pageRoute); },
    };
  }), [botSignedIn, channelId, isPlatformAdmin, onNavigate, texts]);

  const variableItems = useMemo<SpotlightItem[]>(() => variables.map((variable) => ({
    id: `variable:${variable.name}`,
    label: `{var.${variable.name}}`,
    description: variableDescription(variable),
    icon: <NavigationIcon kind="variable" className="spotlight-module-icon" />,
    group: texts.spotlight.groupVariables,
    keywords: [variable.name],
    onTrigger: () => {
      onOpenVariable(variable.name);
      onNavigate({ kind: "channel", channelId, section: "variables" });
    },
  })), [variables, channelId, onNavigate, onOpenVariable, texts.spotlight]);

  const adsEnabled = modules.find((candidate) => candidate.id === "ads")?.enabled === true;
  const shoutoutLogin = query.toLowerCase().startsWith(`${SHOUTOUT_KEYWORD} `)
    ? query.slice(SHOUTOUT_KEYWORD.length + 1).trim()
    : "";

  const actionItems = useMemo<SpotlightItem[]>(() => {
    const managementLockReason = manageable ? undefined : texts.module.managementLocked;
    // Ad now, clip, and shoutout are the same immediate actions Stream
    // Manager offers -- each hidden when its module is disabled, and
    // disabled with the module's own reason when the stream isn't live, no
    // role check invented on top (their endpoints run for any member).
    const adNow = moduleImmediateActionAvailability("ads", modules, streamState);
    const clip = moduleImmediateActionAvailability("clips", modules, streamState);
    const shoutout = moduleImmediateActionAvailability("raid", modules, streamState);
    const items: SpotlightItem[] = [];
    if (adNow.offered) {
      items.push({
        id: "action:ad-now",
        label: texts.streamManager.runAd("60"),
        group: texts.spotlight.groupActions,
        keywords: ["ad", "werbung", "commercial"],
        disabled: adNow.disabledReason !== null,
        ...(adNow.disabledReason === null ? {} : { disabledReason: adNow.disabledReason }),
        icon: "ad",
        onTrigger: () => { void startCommercial(channelId, 60); },
      });
    }
    items.push(
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
    );
    if (clip.offered) {
      items.push({
        id: "action:clip",
        label: texts.streamManager.createClip,
        group: texts.spotlight.groupActions,
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
        description: texts.spotlight.shoutoutHint,
        group: texts.spotlight.groupActions,
        keywords: [SHOUTOUT_KEYWORD],
        icon: "shoutout",
        disabled: shoutout.disabledReason !== null || shoutoutLogin.length === 0,
        disabledReason: shoutout.disabledReason ?? texts.spotlight.shoutoutMissingLogin,
        onTrigger: () => { void sendManualShoutout(channelId, shoutoutLogin); },
      });
    }
    return items;
  }, [texts, manageable, adsEnabled, channelId, shoutoutLogin, streamState, modules]);

  const items = [...actionItems, ...pageItems, ...moduleItems, ...commandItems, ...variableItems];

  return (
    <Spotlight
      items={items}
      emptyMessage={texts.spotlight.empty}
      placeholder={texts.spotlight.placeholder}
      query={query}
      onQueryChange={setQuery}
      onOpen={loadResultData}
      closeOnUnmount
    />
  );
};

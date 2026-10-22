import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { TextCommand } from "../modules/text_commands/contracts";
import { readLastCounterVariable } from "../modules/text_commands/panel/counter-selection";
import { textCommandQuickActionTexts } from "../modules/text_commands/panel/quick-action-locale";
import { streamMarkerActionTexts } from "../modules/channel_events/panel/quick-action-locale";
import { loadTextCommands } from "../modules/text_commands/panel/service";
import type { Timer } from "../modules/timers/contracts";
import { loadUpcomingTimers } from "../modules/timers/panel/service";
import { timersQuickActionTexts } from "../modules/timers/panel/quick-action-locale";
import { canManage, hasRequiredChannelRole, type ChannelRole } from "../contracts/values";
import type { PanelChannelControls, PanelModuleState } from "../panel-contract";
import { PanelApiError, createClip, fetchStreamMarkerAvailability, fetchChannelVariables, sendManualShoutout, setChannelControl, startCommercial, type PanelChannelVariable } from "./api";
import { dispatchDashboardAuthenticationRequired } from "./data/events";
import { queryKeys } from "./data/keys";
import { evaluateImmediateActionAvailability } from "./immediate-action-availability";
import { apiErrorText, channelVariablesTexts, dashboardLanguage, dashboardTexts, immediateActionUnavailableReasonText } from "./locale";
import { moduleDescription, moduleName, moduleWorkspaceTexts } from "./module-labels";
import { moduleDependencyLockReason } from "./module-dependencies";
import { ModuleIcon, NavigationIcon } from "./module-panels";
import { dashboardNavigationGroups } from "./nav-pages";
import { dashboardRoutePath, dashboardRouteRequiresBot, type DashboardRoute } from "./router";
import { readRecentTargets, rememberRecentTarget, RECENT_TARGET_LIMIT } from "./command-palette-recents";
import { FormDialog, notify, Select, CommandPalette, type CommandPaletteItem } from "./ui";
import { dismissToast } from "./ui/toast-store";

const SHOUTOUT_KEYWORD = "shoutout";
const streamMarkerGrantHref = (channelId: string): string =>
  `/auth/channels/${encodeURIComponent(channelId)}/broadcaster-scopes/broadcast`;

const botBlocksRoute = (route: DashboardRoute, botSignedIn: boolean | undefined): boolean =>
  botSignedIn === false && dashboardRouteRequiresBot(route);

/**
 * Presence and availability for a module action, from the same declarations
 * as the live cockpit so the command palette cannot offer a disabled action.
 */
const moduleImmediateActionAvailability = (
  moduleId: string,
  actionId: string,
  modules: readonly Pick<PanelModuleState, "id" | "enabled">[],
  streamState: "online" | "offline" | null | undefined,
  role: ChannelRole | null,
  conditionReason: string | null = null,
): { offered: boolean; disabledReason: string | null } => {
  const module = MODULES.find((entry) => entry.id === moduleId);
  const action = module?.actions?.find((entry) => entry.id === actionId);
  const state = modules.find((entry) => entry.id === moduleId);
  if (action === undefined || state === undefined || role === null || (!state.enabled && !action.conditions.includes("moduleEnabled"))) {
    return { offered: false, disabledReason: null };
  }
  if (!hasRequiredChannelRole(role, action.requiredRole)) {
    return {
      offered: true,
      disabledReason: action.requiredRole === "manager" ? dashboardTexts().streamManager.managerOnly : dashboardTexts().streamManager.operatorOnly,
    };
  }
  const availability = evaluateImmediateActionAvailability(action.conditions, streamState, state.enabled);
  return {
    offered: true,
    disabledReason: availability.reason === null
      ? conditionReason
      : immediateActionUnavailableReasonText(availability.reason),
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
  botConnected?: boolean | null;
  streamState?: "online" | "offline" | null | undefined;
  channelControls?: PanelChannelControls;
  onRefreshChannelState?: () => Promise<void>;
  onToggleModule: (channelId: string, moduleId: string, enabled: boolean) => Promise<void>;
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

interface ChannelCommandData<T> {
  channelId: string | null;
  value: T;
  loaded: boolean;
  failed: boolean;
  openCycle: number;
}

interface CounterPickerState {
  channelId: string;
  variableName: string | null;
}

interface TimerPickerState {
  channelId: string;
  timerId: string | null;
}

const timersWithPlannedOccurrence = (timers: readonly Timer[]): Timer[] => timers.filter((timer) =>
  timer.enabled && timer.nextRunAt !== null && Number.isFinite(Date.parse(timer.nextRunAt)));

const formatTimerNextRun = (at: string, language: "de" | "en"): string =>
  new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(at));

interface MarkerActionScope {
  channelId: string | null;
  controller: AbortController;
  toastIds: Set<number>;
}

interface MarkerActionScopeStore {
  getSnapshot: () => MarkerActionScope | null;
  subscribe: (listener: () => void) => () => void;
  set: (scope: MarkerActionScope) => void;
}

const createMarkerActionScopeStore = (): MarkerActionScopeStore => {
  let currentScope: MarkerActionScope | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => currentScope,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (scope) => {
      if (currentScope === scope) return;
      currentScope = scope;
      for (const listener of listeners) listener();
    },
  };
};

/** Cmd/Ctrl+K finds navigation, text commands, variables, and channel actions. */
export const ChannelCommandPalette = ({ open, onOpenChange, channelId, ownRole, viewerUserId = null, route, isPlatformAdmin = false, botSignedIn, botConnected, streamState, channelControls, onRefreshChannelState, onToggleModule, modules, onNavigate, onOpenCommand, onOpenVariable }: ChannelCommandPaletteProperties): ReactElement => {
  const texts = dashboardTexts();
  const markerActionScopeStore = useMemo(() => createMarkerActionScopeStore(), []);
  const markerActionScope = useSyncExternalStore(markerActionScopeStore.subscribe, markerActionScopeStore.getSnapshot, markerActionScopeStore.getSnapshot);
  useLayoutEffect(() => {
    const scope = { channelId, controller: new AbortController(), toastIds: new Set<number>() };
    markerActionScopeStore.set(scope);
    return () => {
      scope.controller.abort();
      for (const toastId of scope.toastIds) dismissToast(toastId);
    };
  }, [channelId, markerActionScopeStore]);
  const manageable = ownRole !== null && canManage(ownRole);
  const markerAction = MODULES.find((module) => module.id === "channel_events")?.actions?.find((action) => action.id === "set-stream-marker");
  const markerModuleEnabled = modules.some((module) => module.id === "channel_events" && module.enabled);
  const [commandState, setCommandState] = useState<{ channelId: string | null; value: TextCommand[] }>({ channelId, value: [] });
  const [paletteSession, setPaletteSession] = useState({ open, cycle: 0 });
  if (paletteSession.open !== open) {
    setPaletteSession({ open, cycle: paletteSession.cycle + (open ? 1 : 0) });
  }
  const openCycle = paletteSession.open === open
    ? paletteSession.cycle
    : paletteSession.cycle + (open ? 1 : 0);
  const timersModuleEnabled = modules.find((candidate) => candidate.id === "timers")?.enabled === true;
  const [variableState, setVariableState] = useState<ChannelCommandData<readonly PanelChannelVariable[]>>({ channelId, value: [], loaded: false, failed: false, openCycle: 0 });
  const [timerState, setTimerState] = useState<ChannelCommandData<readonly Timer[]>>({ channelId, value: [], loaded: false, failed: false, openCycle: 0 });
  const [markerScopeState, setMarkerScopeState] = useState<ChannelCommandData<boolean>>({ channelId, value: false, loaded: false, failed: false, openCycle: 0 });
  const [counterPicker, setCounterPicker] = useState<CounterPickerState | null>(null);
  const [timerPicker, setTimerPicker] = useState<TimerPickerState | null>(null);
  const [query, setQuery] = useState("");
  const commands = useMemo(() => commandState.channelId === channelId ? commandState.value : [], [channelId, commandState]);
  const variablesMatchOpenCycle = variableState.channelId === channelId && variableState.openCycle === openCycle;
  const variables = useMemo(() => variablesMatchOpenCycle ? variableState.value : [], [variableState.value, variablesMatchOpenCycle]);
  const variablesLoaded = variablesMatchOpenCycle && variableState.loaded;
  const variablesFailed = variablesMatchOpenCycle && variableState.failed;
  const markerScopeMatchesOpenCycle = markerScopeState.channelId === channelId && markerScopeState.openCycle === openCycle;
  const markerScopeLoaded = markerScopeMatchesOpenCycle && markerScopeState.loaded;
  const markerScopeFailed = markerScopeMatchesOpenCycle && markerScopeState.failed;
  const markerScopeAvailable = markerScopeLoaded && !markerScopeFailed && markerScopeState.value;
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

  // Load only while open. Scope every response to the request's channel and
  // abort variable requests when the palette closes or switches channels.
  useEffect(() => {
    if (!open || channelId === null) return;
    let active = true;
    const controller = new AbortController();
    void loadTextCommands(channelId).then((value) => {
      if (active) setCommandState({ channelId, value });
    }).catch(() => {
      if (active) setCommandState({ channelId, value: [] });
    });
    void fetchChannelVariables(channelId, controller.signal).then(({ variables: value }) => {
      if (active) setVariableState({ channelId, value, loaded: true, failed: false, openCycle });
    }).catch(() => {
      if (active) setVariableState({ channelId, value: [], loaded: true, failed: true, openCycle });
    });
    if (timersModuleEnabled) {
      void loadUpcomingTimers(channelId, controller.signal).then((value) => {
        if (active) setTimerState({ channelId, value, loaded: true, failed: false, openCycle });
      }).catch(() => {
        if (active) setTimerState({ channelId, value: [], loaded: true, failed: true, openCycle });
      });
    }
    if (markerModuleEnabled && markerAction !== undefined && streamState === "online" &&
        ownRole !== null && hasRequiredChannelRole(ownRole, markerAction.requiredRole)) {
      void fetchStreamMarkerAvailability(channelId, controller.signal).then((availability) => {
        if (active) setMarkerScopeState({ channelId, value: availability.manageScopeAvailable, loaded: true, failed: false, openCycle });
      }).catch(() => {
        if (active) setMarkerScopeState({ channelId, value: false, loaded: true, failed: true, openCycle });
      });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [channelId, markerAction, markerModuleEnabled, open, openCycle, ownRole, streamState, timersModuleEnabled]);

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
  const toggleChannelControl = useCallback(async (kind: "mute" | "pause"): Promise<void> => {
    if (channelId === null) return;
    const control = channelControls?.[kind];
    const configured = control?.active === true || control?.pending === true;
    const labels = dashboardTexts().channelControls;
    try {
      await setChannelControl(channelId, kind, configured ? null : "unlimited");
    } catch (error: unknown) {
      notify({ tone: "error", message: error instanceof PanelApiError ? apiErrorText(error.code, labels.failure) : labels.failure });
      if (error instanceof PanelApiError && error.status === 401) dispatchDashboardAuthenticationRequired();
      return;
    }
    try {
      if (onRefreshChannelState !== undefined) await onRefreshChannelState();
      else await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.channels(), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channel(channelId, "overview"), exact: true }),
      ]);
    } catch {
      notify({ tone: "error", message: labels.refreshFailure });
    }
  }, [channelControls, channelId, onRefreshChannelState, queryClient]);
  const toggleAds = useCallback(async (enabled: boolean): Promise<void> => {
    if (channelId === null || moduleDependencyLockReason("ads", enabled, modules) !== null) return;
    await onToggleModule(channelId, "ads", enabled);
  }, [channelId, modules, onToggleModule]);
  const quickActions = MODULES.find((module) => module.id === "text_commands")?.actions ?? [];
  const timerQuickActions = MODULES.find((module) => module.id === "timers")?.actions ?? [];
  const counterAction = quickActions.find((action) => action.id === "counter-plus-one");
  const testMessageAction = quickActions.find((action) => action.id === "send-test-message");
  const timerAction = timerQuickActions.find((action) => action.id === "skip-next-timer-message");
  const language = dashboardLanguage();
  const pickerState = counterPicker?.channelId === channelId ? counterPicker : null;
  const timerPickerState = timerPicker?.channelId === channelId ? timerPicker : null;
  const numericVariables = variables.filter((variable) => Number.isFinite(variable.value));
  const timerStateMatchesOpenCycle = timerState.channelId === channelId && timerState.openCycle === openCycle;
  const plannedTimers = useMemo(
    () => timerStateMatchesOpenCycle ? timersWithPlannedOccurrence(timerState.value) : [],
    [timerState.value, timerStateMatchesOpenCycle],
  );
  const timersLoaded = timerStateMatchesOpenCycle && timerState.loaded;
  const timersFailed = timerStateMatchesOpenCycle && timerState.failed;
  const counterReason = !variablesLoaded
    ? texts.streamManager.actionLoading
    : variablesFailed
      ? textCommandQuickActionTexts.counter.loadFailed[language]
      : numericVariables.length > 0
        ? null
        : textCommandQuickActionTexts.counter.noVariables[language];
  const counterAvailability = moduleImmediateActionAvailability("text_commands", "counter-plus-one", modules, streamState, ownRole, counterReason);
  const counterActionAvailable = counterAvailability.offered && counterAvailability.disabledReason === null;
  const timerReason = !timersLoaded
    ? texts.streamManager.actionLoading
    : timersFailed
      ? timersQuickActionTexts.loadFailed[language]
      : plannedTimers.length > 0
        ? null
        : timersQuickActionTexts.noPlanned[language];
  const timerAvailability = moduleImmediateActionAvailability("timers", "skip-next-timer-message", modules, streamState, ownRole, timerReason);
  const timerActionAvailable = timerAvailability.offered && timerAvailability.disabledReason === null;
  const runCounterAction = useCallback((variableName: string): void => {
    if (channelId === null || counterAction === undefined || !counterActionAvailable ||
        !numericVariables.some((variable) => variable.name === variableName)) return;
    const formData = new FormData();
    formData.set("variableName", variableName);
    void counterAction.execute({ channelId, language, formData }).then((result) => {
      notify({ tone: result?.tone ?? "success", message: result?.message?.[language] ?? texts.streamManager.actionSucceeded(counterAction.name[language]) });
    }).catch(() => {
      notify({ tone: "error", message: counterAction.errorMessage?.[language] ?? texts.streamManager.actionFailed });
    });
  }, [channelId, counterAction, counterActionAvailable, language, numericVariables, texts]);
  const pickerSelectionIsValid = pickerState?.variableName !== null && pickerState?.variableName !== undefined &&
    counterActionAvailable && numericVariables.some((variable) => variable.name === pickerState.variableName);
  const timerPickerSelectionIsValid = timerPickerState?.timerId !== null && timerPickerState?.timerId !== undefined &&
    timerActionAvailable && plannedTimers.some((timer) => timer.id === timerPickerState.timerId);
  const runTimerAction = useCallback((timerId: string): void => {
    if (channelId === null || timerAction === undefined || !timerActionAvailable || !plannedTimers.some((timer) => timer.id === timerId)) return;
    const formData = new FormData();
    formData.set("timerId", timerId);
    void timerAction.execute({ channelId, language, formData }).then((result) => {
      notify({ tone: result?.tone ?? "success", message: result?.message?.[language] ?? texts.streamManager.actionSucceeded(timerAction.name[language]) });
    }).catch(() => {
      notify({ tone: "error", message: timerAction.errorMessage?.[language] ?? texts.streamManager.actionFailed });
    });
  }, [channelId, language, plannedTimers, texts, timerAction, timerActionAvailable]);
  const markerReason = !markerScopeLoaded
    ? texts.streamManager.actionLoading
    : markerScopeFailed
      ? streamMarkerActionTexts.scopeCheckFailed[language]
      : markerScopeAvailable
        ? null
        : viewerUserId === channelId
          ? streamMarkerActionTexts.scopeMissing[language]
          : streamMarkerActionTexts.scopeOwnerOnly[language];
  const marker = moduleImmediateActionAvailability("channel_events", "set-stream-marker", modules, streamState, ownRole, markerReason);
  const triggerStreamMarker = useCallback((): void => {
    const scope = markerActionScope;
    if (channelId === null || markerAction === undefined || marker.disabledReason !== null || scope === null || scope.channelId !== channelId) return;
    void markerAction.execute({ channelId, viewerUserId, language, formData: new FormData() }).then((result) => {
      if (scope.controller.signal.aborted) return;
      const resultLink = result?.link;
      const toastId = notify({
        tone: result?.tone ?? "success",
        message: result?.message?.[language] ?? texts.streamManager.actionSucceeded(markerAction.name[language]),
        scope: channelId,
        ...(resultLink === undefined ? {} : {
          action: {
            label: resultLink.label[language],
            onClick: () => { window.location.assign(resultLink.href); },
          },
        }),
      });
      scope.toastIds.add(toastId);
    }).catch(() => {
      if (scope.controller.signal.aborted) return;
      const toastId = notify({ tone: "error", message: markerAction.errorMessage?.[language] ?? texts.streamManager.actionFailed });
      scope.toastIds.add(toastId);
    });
  }, [channelId, language, marker.disabledReason, markerAction, markerActionScope, texts, viewerUserId]);
  const actionItems = useMemo<CommandPaletteItem[]>(() => {
    if (channelId === null) return [];
    const managementLockReason = manageable ? undefined : texts.module.managementLocked;
    const adsOffDependencyReason = moduleDependencyLockReason("ads", false, modules);
    const adsOnDependencyReason = moduleDependencyLockReason("ads", true, modules);
    const adsOffLockReason = adsOffDependencyReason ?? managementLockReason;
    const adsOnLockReason = adsOnDependencyReason ?? managementLockReason;
    // The quick actions share their module declarations with the live cockpit.
    // Each command uses the declared role and stream-state requirements.
    const adNow = moduleImmediateActionAvailability("ads", "start-commercial", modules, streamState, ownRole);
    const clip = moduleImmediateActionAvailability("clips", "create-clip", modules, streamState, ownRole);
    const shoutout = moduleImmediateActionAvailability("raid", "send-shoutout", modules, streamState, ownRole);
    const testMessageReason = botConnected === true
      ? null
      : textCommandQuickActionTexts.testMessage.botNotConnected[language];
    const testMessage = moduleImmediateActionAvailability("text_commands", "send-test-message", modules, streamState, ownRole, testMessageReason);
    const items: CommandPaletteItem[] = [];
    const channelControlLabels = texts.channelControls;
    for (const kind of ["mute", "pause"] as const) {
      const control = channelControls?.[kind];
      const configured = control?.active === true || control?.pending === true;
      const isMute = kind === "mute";
      const actionLabel = isMute
        ? configured ? channelControlLabels.muteDisable : channelControlLabels.muteEnable
        : configured ? channelControlLabels.pauseDisable : channelControlLabels.pauseEnable;
      const stateLabel = control?.pending === true
        ? channelControlLabels.pendingUntilStreamStart
        : configured
          ? isMute ? channelControlLabels.muteActive : channelControlLabels.pauseActive
          : channelControlLabels.inactive;
      items.push({
        id: `action:channel-${kind}`,
        label: actionLabel,
        ...(configured ? {} : { description: channelControlLabels.durationUnlimitedDescription }),
        group: texts.commandPalette.groupActions,
        keywords: isMute
          ? ["mute", "unmute", "stumm", "stummschalten"]
          : ["pause", "resume", "paused", "automatische aktionen", "fortsetzen"],
        stateLabel,
        icon: isMute ? (configured ? "volume-off" : "volume-3") : (configured ? "player-play" : "player-pause"),
        onTrigger: () => { void toggleChannelControl(kind); },
      });
    }
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
        disabled: !manageable || adsOffDependencyReason !== null || !adsEnabled,
        ...(adsOffLockReason === undefined ? {} : { disabledReason: adsOffLockReason }),
        icon: <ModuleIcon moduleId="ads" className="command-palette-module-icon" />,
        onTrigger: () => { void toggleAds(false); },
      },
      {
        id: "action:ads-on",
        label: texts.commandPalette.adOn,
        group: texts.commandPalette.groupActions,
        keywords: ["ads on", "werbung an"],
        disabled: !manageable || adsOnDependencyReason !== null || adsEnabled,
        ...(adsOnLockReason === undefined ? {} : { disabledReason: adsOnLockReason }),
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
    if (counterAvailability.offered && counterAction !== undefined) {
      items.push({
        id: "action:counter-plus-one",
        label: counterAction.name[language],
        group: texts.commandPalette.groupActions,
        keywords: [...textCommandQuickActionTexts.counter.paletteKeywords],
        icon: counterAction.icon,
        disabled: counterAvailability.disabledReason !== null,
        ...(counterAvailability.disabledReason === null ? {} : { inlineReason: counterAvailability.disabledReason }),
        onTrigger: () => {
          if (!counterActionAvailable) return;
          const savedName = readLastCounterVariable(channelId);
          const selectedName = numericVariables.find((variable) => variable.name === savedName)?.name;
          if (selectedName !== undefined) runCounterAction(selectedName);
          else setCounterPicker({ channelId, variableName: numericVariables[0]?.name ?? null });
        },
      });
    }
    if (testMessage.offered && testMessageAction !== undefined) {
      items.push({
        id: "action:send-test-message",
        label: testMessageAction.name[language],
        group: texts.commandPalette.groupActions,
        keywords: ["test message", "testnachricht", "chat"],
        icon: testMessageAction.icon,
        disabled: testMessage.disabledReason !== null,
        ...(testMessage.disabledReason === null ? {} : { disabledReason: testMessage.disabledReason }),
        onTrigger: () => {
          if (testMessage.disabledReason !== null) return;
          void testMessageAction.execute({ channelId, language, formData: new FormData() }).then((result) => {
            notify({ tone: result?.tone ?? "success", message: result?.message?.[language] ?? texts.streamManager.actionSucceeded(testMessageAction.name[language]) });
          }).catch(() => {
            notify({ tone: "error", message: testMessageAction.errorMessage?.[language] ?? texts.streamManager.actionFailed });
          });
        },
      });
    }
    if (timerAvailability.offered && timerAction !== undefined) {
      items.push({
        id: "action:skip-next-timer-message",
        label: timerAction.name[language],
        group: texts.commandPalette.groupActions,
        keywords: [...timersQuickActionTexts.paletteKeywords],
        icon: timerAction.icon,
        disabled: timerAvailability.disabledReason !== null,
        ...(timerAvailability.disabledReason === null ? {} : { inlineReason: timerAvailability.disabledReason }),
        onTrigger: () => {
          if (!timerActionAvailable) return;
          setTimerPicker({ channelId, timerId: null });
        },
      });
    }
    if (marker.offered && markerAction !== undefined) {
      items.push({
        id: "action:set-stream-marker",
        label: markerAction.name[language],
        group: texts.commandPalette.groupActions,
        keywords: ["stream marker", "marker", "stream-markierung", "marker setzen"],
        icon: markerAction.icon,
        disabled: marker.disabledReason !== null,
        ...(marker.disabledReason === null ? {} : { disabledReason: marker.disabledReason }),
        onTrigger: triggerStreamMarker,
      });
      if (markerScopeLoaded && !markerScopeFailed && !markerScopeAvailable && marker.disabledReason === markerReason &&
          viewerUserId === channelId && ownRole !== null && hasRequiredChannelRole(ownRole, markerAction.requiredRole)) {
        items.push({
          id: "action:stream-marker-grant",
          label: streamMarkerActionTexts.scopeGrant[language],
          group: texts.commandPalette.groupActions,
          keywords: ["stream marker", "broadcast permission", "broadcaster berechtigung", "grant scope"],
          icon: "external",
          onTrigger: () => { window.location.assign(streamMarkerGrantHref(channelId)); },
        });
      }
    }
    return items;
  }, [texts, manageable, adsEnabled, channelId, viewerUserId, channelControls, ownRole, shoutoutLogin, streamState, modules, toggleAds, toggleChannelControl, botConnected, counterAction, counterAvailability, counterActionAvailable, numericVariables, language, runCounterAction, testMessageAction, timerAction, timerActionAvailable, timerAvailability, marker, markerAction, markerReason, markerScopeAvailable, markerScopeFailed, markerScopeLoaded, triggerStreamMarker]);

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

  return <>
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
    />
    <FormDialog
      opened={pickerState !== null}
      title={textCommandQuickActionTexts.counter.chooseCounterTitle[language]}
      description={textCommandQuickActionTexts.counter.chooseCounterDescription[language]}
      confirmLabel={texts.streamManager.actionRun}
      cancelLabel={texts.streamManager.actionCancel}
      confirmDisabled={!pickerSelectionIsValid}
      onCancel={() => { setCounterPicker(null); }}
      onConfirm={() => {
        if (pickerState === null || pickerState.variableName === null || !pickerSelectionIsValid) return;
        runCounterAction(pickerState.variableName);
        setCounterPicker(null);
      }}
    >
      <Select
        label={textCommandQuickActionTexts.counter.variableLabel[language]}
        name="variableName"
        value={pickerState?.variableName ?? null}
        onChange={(variableName) => {
          if (pickerState === null) return;
          setCounterPicker({ ...pickerState, variableName });
        }}
        options={numericVariables.map((variable) => ({
          value: variable.name,
          label: variable.name,
          description: String(variable.value),
        }))}
        placeholder={textCommandQuickActionTexts.counter.selectVariable[language]}
        disabled={numericVariables.length === 0}
        required
      />
    </FormDialog>
    <FormDialog
      opened={timerPickerState !== null}
      title={timersQuickActionTexts.name[language]}
      description={timersQuickActionTexts.chooseTimerHint[language]}
      confirmLabel={texts.streamManager.actionRun}
      cancelLabel={texts.streamManager.actionCancel}
      confirmDisabled={!timerPickerSelectionIsValid}
      onCancel={() => { setTimerPicker(null); }}
      onConfirm={() => {
        if (timerPickerState?.timerId === null || timerPickerState?.timerId === undefined || !timerPickerSelectionIsValid) return;
        runTimerAction(timerPickerState.timerId);
        setTimerPicker(null);
      }}
    >
      <Select
        label={timersQuickActionTexts.timerLabel[language]}
        name="timerId"
        value={timerPickerState?.timerId ?? null}
        onChange={(timerId) => {
          if (timerPickerState === null) return;
          setTimerPicker({ ...timerPickerState, timerId });
        }}
        options={plannedTimers.map((timer) => ({
          value: timer.id,
          label: timer.name.trim() || timer.id,
          description: timer.nextRunAt === null ? "" : formatTimerNextRun(timer.nextRunAt, language),
        }))}
        placeholder={timersQuickActionTexts.chooseTimer[language]}
        hint={timersQuickActionTexts.chooseTimerHint[language]}
        dropdownBelowField
        disabled={!timerActionAvailable || plannedTimers.length === 0}
        required
      />
    </FormDialog>
  </>;
};

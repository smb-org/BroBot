import { Fragment, StrictMode, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type {
  PanelAuditFilters,
  PanelBotPermissions,
  PanelBotStatus,
  PanelBroadcasterPermissions,
  PanelChannelOverview,
  PanelChannelsResponse,
  PanelChannelControl,
  PanelChannelControls,
  PanelChannelState,
  PanelEventFilters,
  PanelEventSubSubscription,
  PanelModeratorStatus,
  PanelModuleState,
  PanelModulesResponse,
  PanelSystemResponse,
  PanelTokenStatus,
} from "../panel-contract";
import {
  fetchChannelOverview,
  fetchChannels,
  logout,
  PanelApiError,
  refreshModeratorStatus,
  setChannelControl,
  setChannelModuleEnabled,
} from "./api";
import { ModuleCount, ModuleHeading, ModuleIcon, ModulePage, ModuleTile, ModuleWorkspace, NavigationIcon, StateRow, type StateTone } from "./module-panels";
import { preloadModulePanel } from "./module-panel-loaders";
import { BroadcasterConsentAction } from "./channel-actions";
import { refreshAfterModuleToggle } from "./data/module-toggle";
import { mergeChannelRefreshData, mergeChannelsRefreshData, runModeratorRecheck } from "./data/channel-cache";
import { useMountedPageGuard } from "./data/page-generation";
import { useSystemQuery } from "./data/lists";
import { ChannelCommandPalette } from "./command-palette";
import { MembersPage } from "./members";
import { PlatformPage } from "./platform";
import { channelPanelTexts } from "./labels";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatTimestamp as formatTimestampBase, formatNumber, maintenanceReasonText } from "./locale";
import { CHANNEL_CONTROL_DURATIONS, canManage, type ChannelControlDuration, type ChannelRole } from "../contracts/values";
import { MODULES } from "../modules/registry";
import { eventSubName, moduleNavigationName, statusWord } from "./module-labels";
import { dashboardModeForRoute, dashboardRouteFocusKey, dashboardRoutePath, dashboardRouteRequiresBot, routeForDashboardMode, routeForSelectedChannel, replaceDashboardRoute, useDashboardRoute, type DashboardMode, type DashboardRoute } from "./router";
import { dashboardNavigationGroups, visibleModuleNavigationIds } from "./nav-pages";
import { BlockingState, Button, ChannelLocationMenu, ControlDurationDialog, EmptyCellValue, Icon, InspectorSection, ListDetail, LoadState as UiLoadState, LoadStateLines, notify, SettingsPage, Select as UiSelect, Shell, Sidebar, StatusLed, SubInspector, UiProvider, useInspectorSelection, type SidebarEntry, type SidebarGroup, type StatusLedState } from "./ui";
import { readPalette, writePalette, type Palette } from "./ui/palette";
import { EventsPage } from "./events/EventsPage";
import { emptyEventFilter, eventFilterIsActive } from "./events/model";
import { AuditPage } from "./audit/AuditPage";
import { ChannelVariablesPage } from "./ChannelVariablesPage";
import { ChannelDefaultsEditor } from "./ChannelDefaultsEditor";
import { ChannelLocationPage } from "./ChannelLocationPage";
import { LiveCockpit } from "./LiveCockpit";
import { OverlaysPage } from "./OverlaysPage";
import { OverlayEditorPage } from "./OverlayEditorPage";
import { emptyAuditFilter, auditFilterIsActive } from "./audit/model";
import { useRealtimePanelMessages } from "./realtime";
import { useDashboardRealtimeStatus } from "./data/realtime";
import { botPermissionsAreMissing, broadcasterPermissionsAreMissing, moderatorIsMissing, parseDashboardDate, tokenHealth } from "./channel-health";
import { loadingState, type LoadState } from "./load-state";
import { queryKeys } from "./data/keys";
import { dashboardAuthenticationRequiredEvent, dispatchDashboardAuthenticationRequired } from "./data/events";
import { DashboardDataProvider } from "./data/provider";

writePalette(readPalette());

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const statusLabel = (status: PanelBotStatus["status"]): string => {
  const texts = dashboardTexts();
  if (status === "connected") return texts.status.connected;
  if (status === "revoked") return texts.status.revoked;
  return texts.status.error;
};

const subscriptionTone = (status: PanelEventSubSubscription["status"], reason: string | null): StateTone =>
  reason === "pending_adoption" || reason === "moderator_required" ? "neutral"
    : status === "enabled" ? "healthy" : status === "missing" || status === "pending" ? "warning" : "error";

const subscriptionStatusLabel = (status: PanelEventSubSubscription["status"], reason: string | null): string => {
  const reasonText = maintenanceReasonText(reason);
  if ((reason === "pending_adoption" || reason === "moderator_required") && reasonText !== null) return reasonText;
  const texts = dashboardTexts();
  if (status === "enabled") return texts.status.active;
  if (status === "missing") return texts.status.missing;
  if (status === "pending") return texts.status.pending;
  if (status === "revoked") return texts.status.revoked;
  return texts.status.error;
};

const channelBotConsentMissing = (channel: PanelChannelState): boolean =>
  channel.channelBotConsent === "missing";

const channelStatus = (channel: PanelChannelState, loadedAt?: number, now = Date.now()): StateTone => {
  if (moderatorIsMissing(channel.moderator)) return "error";
  if (channel.chatSubscriptionNeeded === true &&
      (channel.chatSubscription?.status === "error" || channel.chatSubscription?.status === "revoked")) return "error";
  if (channel.lastError?.source === "eventsub") return "error";
  if (channel.bot?.status === "error" || channel.bot?.status === "revoked") return "error";
  if (botPermissionsAreMissing(channel.botPermissions)) return "warning";
  if (broadcasterPermissionsAreMissing(channel.broadcasterPermissions)) return "warning";
  if (channel.tokens.loginStatus === "error" || channel.tokens.loginStatus === "revoked") return "error";
  const tokenStatus = tokenHealth(channel.tokens, channel.bot, loadedAt, now);
  if (tokenStatus.tone === "error") return "error";
  if (channelBotConsentMissing(channel)) return "warning";
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription == null) return "warning";
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription?.status === "missing" &&
      channel.chatSubscription.reason !== "pending_adoption" && channel.chatSubscription.reason !== "moderator_required") return "warning";
  if (tokenStatus.tone === "neutral") return "neutral";
  if (tokenStatus.tone !== "healthy") return "warning";
  if (channel.bot?.status !== "connected" || channel.moderator?.isModerator !== true ||
      channel.tokens.loginStatus !== "connected" || channel.tokens.botExpiresAt === null ||
      channel.tokens.loginExpiresAt === null || channelBotConsentMissing(channel)) return "warning";
  return "healthy";
};

const statusText = (channel: PanelChannelState, loadedAt?: number, now = Date.now()): string => {
  const texts = dashboardTexts();
  if (moderatorIsMissing(channel.moderator)) return texts.status.moderatorRoleMissing;
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription?.status === "error") return texts.status.chatSubscriptionError;
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription?.status === "revoked") return texts.status.chatSubscriptionRevoked;
  if (channel.lastError?.source === "eventsub") return texts.errors.last;
  if (channel.bot?.status === "error") return texts.status.botError;
  if (channel.bot?.status === "revoked") return texts.status.botTokenRevoked;
  if (botPermissionsAreMissing(channel.botPermissions)) return texts.status.botPermissionsMissing(formatNumber(channel.botPermissions.missingScopes.length));
  if (broadcasterPermissionsAreMissing(channel.broadcasterPermissions)) return channelPanelTexts().fullConsentMissing;
  const tokenStatus = tokenHealth(channel.tokens, channel.bot, loadedAt, now);
  if (channelBotConsentMissing(channel) && tokenStatus.tone === "healthy") return texts.status.broadcasterConsentMissing;
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription == null) return texts.status.chatSubscriptionMissing;
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription?.status === "missing" &&
      channel.chatSubscription.reason !== "pending_adoption" && channel.chatSubscription.reason !== "moderator_required") return texts.status.chatSubscriptionMissing;
  if (tokenStatus.tone !== "healthy") return tokenStatus.label;
  if (channelStatus(channel, loadedAt, now) === "healthy") return texts.status.healthy;
  return texts.status.stateIncomplete;
};

const channelToneToStatusState = (tone: StateTone): StatusLedState =>
  tone === "healthy" ? "ok" : tone === "warning" ? "warn" : tone === "error" ? "error" : "off";

const broadcasterConnectionLabel = (status: PanelChannelState["broadcasterConnection"]): string =>
  status === "connected" ? dashboardTexts().status.connected : dashboardTexts().status.notConnected;

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return dashboardTexts().errors.sessionInvalid;
  const fallback = dashboardTexts().errors.dataLoadFailed;
  return error instanceof PanelApiError ? apiErrorText(error.code, fallback) : fallback;
};

const loadStateFromQuery = <T,>(query: UseQueryResult<T>): LoadState<T> => {
  const loadedAt = query.dataUpdatedAt > 0 ? query.dataUpdatedAt : undefined;
  if (query.data !== undefined) {
    return {
      status: query.status === "error" ? "error" : "success",
      data: query.data,
      error: query.status === "error" ? errorMessage(query.error) : null,
      ...(loadedAt === undefined ? {} : { loadedAt }),
    };
  }
  if (query.status === "pending") return loadingState();
  if (query.status === "error") {
    return {
      status: "error",
      data: null,
      error: errorMessage(query.error),
      ...(loadedAt === undefined ? {} : { loadedAt }),
    };
  }
  return {
    status: "loading",
    data: query.data,
    error: null,
    ...(loadedAt === undefined ? {} : { loadedAt }),
  };
};

const formatTimestamp = (value: string): string => formatTimestampBase(value);

interface PanelSidebarProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  platformAdmin: boolean;
  moduleStates: PanelModuleState[] | null;
  memberRole: ChannelRole | null;
  onEntryNavigate: () => void;
  onOpenCommandPalette: () => void;
  onNavigate: (route: DashboardRoute) => void;
}

/**
 * Setup navigation groups come from the same registry used by the command palette.
 */
const PanelSidebar = ({ route, channels, platformAdmin: platform, moduleStates, memberRole, onEntryNavigate, onOpenCommandPalette, onNavigate }: PanelSidebarProperties): ReactElement => {
  const texts = dashboardTexts();
  const navigationChannelId = route.kind === "channel" || route.kind === "module"
    ? route.channelId
    : channels[0]?.channelId ?? "";

  useEffect(() => {
    if (moduleStates === null || memberRole === null) return;
    const enabledModuleIds = [...visibleModuleNavigationIds(moduleStates, memberRole)];
    if (enabledModuleIds.length === 0) return;

    let cancelled = false;
    const preloadEnabledModules = (): void => {
      if (cancelled) return;
      for (const moduleId of enabledModuleIds) {
        void preloadModulePanel(moduleId).catch(() => undefined);
      }
    };
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback !== undefined) {
      const handle = idleWindow.requestIdleCallback(preloadEnabledModules, { timeout: 1_000 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const handle = window.setTimeout(preloadEnabledModules, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [memberRole, moduleStates]);

  const navigationGroups = dashboardNavigationGroups(
    { isPlatformAdmin: platform },
    navigationChannelId,
    texts,
    MODULES,
    moduleStates ?? [],
    memberRole,
    dashboardLanguage(),
    (moduleId) => moduleNavigationName(moduleId),
  );
  const groups: SidebarGroup[] = navigationGroups.flatMap(({ category, heading, entries }) => {
    const sidebarEntries = entries.filter((entry) => entry.area === "setup" && entry.sidebarVisible).map((entry): SidebarEntry => ({
      id: entry.id,
      ...(entry.pageId === undefined ? {} : { pageId: entry.pageId }),
      category,
      label: entry.label,
      icon: entry.iconKind === null
        ? entry.moduleId === undefined ? <span aria-hidden="true" className="sidebar-nav-icon" /> : <ModuleIcon moduleId={entry.moduleId} className="sidebar-nav-icon" />
        : <NavigationIcon kind={entry.iconKind} className="sidebar-nav-icon" />,
      href: dashboardRoutePath(entry.route),
      active: entry.pageId !== undefined
        ? dashboardRoutePath(entry.route) === dashboardRoutePath(route)
        : route.kind === "module" && route.moduleId === entry.moduleId,
      onNavigate: () => { onNavigate(entry.route); },
      ...(entry.moduleId === undefined ? {} : {
        onPreload: () => { void preloadModulePanel(entry.moduleId as string).catch(() => undefined); },
        led: { status: "ok" as const, word: statusWord(true) },
      }),
    }));
    return sidebarEntries.length === 0 ? [] : [{ id: category, category, heading, entries: sidebarEntries }];
  });

  return (
    <Sidebar
      groups={groups}
      onOpenCommandPalette={onOpenCommandPalette}
      onEntryNavigate={onEntryNavigate}
      setupHeading={texts.navigation.sidebarSetupHeading}
      setupDescription={texts.navigation.sidebarSetupDescription}
      paletteLabel={texts.navigation.sidebarSearch}
      paletteShortcut={navigator.userAgent.includes("Mac") ? "⌘ K" : "Ctrl K"}
    />
  );
};

interface DashboardHeaderProperties {
  route: DashboardRoute;
  mode: DashboardMode;
  channels: PanelChannelState[];
  activeChannel: PanelChannelState | undefined;
  loadedAt: number | undefined;
  palette: Palette;
  onPaletteChange: (palette: Palette) => void;
  onOpenCommandPalette: () => void;
  onSwitchMode: (mode: DashboardMode) => void;
  onNavigate: (route: DashboardRoute) => void;
  onLogout: () => void;
  loggingOut: boolean;
  onRefreshState: () => Promise<void>;
}

const CONTROL_OFF: PanelChannelControl = { active: false, until: null, mode: null };

const isControlDuration = (value: string): value is ChannelControlDuration =>
  (CHANNEL_CONTROL_DURATIONS as readonly string[]).includes(value);

const streamDuration = (startedAt: string | null | undefined, now: number): string | null => {
  if (startedAt == null) return null;
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  return `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, "0")}`;
};

type ChannelStreamVersion = Pick<PanelChannelState, "channelId" | "streamState" | "streamStartedAt" | "streamStateChangedAt" | "streamStateCheckedAt" | "controls">;

const streamVersionOf = (channel: ChannelStreamVersion): ChannelStreamVersion => ({
  channelId: channel.channelId,
  ...(channel.streamState === undefined ? {} : { streamState: channel.streamState }),
  ...(channel.streamStartedAt === undefined ? {} : { streamStartedAt: channel.streamStartedAt }),
  ...(channel.streamStateChangedAt === undefined ? {} : { streamStateChangedAt: channel.streamStateChangedAt }),
  ...(channel.streamStateCheckedAt === undefined ? {} : { streamStateCheckedAt: channel.streamStateCheckedAt }),
  ...(channel.controls === undefined ? {} : { controls: channel.controls }),
});

const mergeChannelStreamVersion = <T extends ChannelStreamVersion>(incoming: T, current: ChannelStreamVersion | undefined): T => {
  if (current === undefined) return incoming;
  const incomingChangedAt = incoming.streamStateChangedAt == null ? Number.NaN : Date.parse(incoming.streamStateChangedAt);
  const currentChangedAt = current.streamStateChangedAt == null ? Number.NaN : Date.parse(current.streamStateChangedAt);
  const incomingCheckedAt = incoming.streamStateCheckedAt == null ? Number.NaN : Date.parse(incoming.streamStateCheckedAt);
  const currentCheckedAt = current.streamStateCheckedAt == null ? Number.NaN : Date.parse(current.streamStateCheckedAt);
  const checkedAt = Number.isFinite(currentCheckedAt) &&
      (!Number.isFinite(incomingCheckedAt) || currentCheckedAt > incomingCheckedAt)
    ? current.streamStateCheckedAt
    : incoming.streamStateCheckedAt;
  const currentIsNewer = Number.isFinite(currentChangedAt) &&
      (!Number.isFinite(incomingChangedAt) || currentChangedAt > incomingChangedAt);
  const merged: ChannelStreamVersion = {
    ...incoming,
    ...(currentIsNewer ? {
      ...(current.streamState === undefined ? {} : { streamState: current.streamState }),
      ...(current.streamStartedAt === undefined ? {} : { streamStartedAt: current.streamStartedAt }),
      ...(current.streamStateChangedAt === undefined ? {} : { streamStateChangedAt: current.streamStateChangedAt }),
      ...(current.controls === undefined ? {} : { controls: current.controls }),
    } : {}),
    ...(incoming.controls === undefined && current.controls !== undefined ? { controls: current.controls } : {}),
    ...(checkedAt === undefined ? {} : { streamStateCheckedAt: checkedAt }),
  };
  return merged as T;
};

const mergeAndRememberChannelStreamVersion = <T extends ChannelStreamVersion>(
  incoming: T,
  latestByChannel: Map<string, ChannelStreamVersion>,
  current?: ChannelStreamVersion,
): T => {
  const withCurrent = mergeChannelStreamVersion(incoming, current);
  const merged = mergeChannelStreamVersion(withCurrent, latestByChannel.get(incoming.channelId));
  latestByChannel.set(incoming.channelId, streamVersionOf(merged));
  return merged;
};

const useSecondClock = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(id); };
  }, []);
  return now;
};

const ChannelControlExpiryWatcher = ({ controls, onRefresh }: {
  controls: PanelChannelControls | undefined;
  onRefresh: () => Promise<void>;
}): null => {
  const refreshedExpiryKey = useRef("");
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => {
    let timer: number | null = null;
    let retryTimer: number | null = null;
    const refreshExpiredControl = (expiryKey: string): void => {
      void onRefreshRef.current().then(() => {
        refreshedExpiryKey.current = expiryKey;
      }).catch(() => {
        retryTimer = window.setTimeout(() => { refreshExpiredControl(expiryKey); }, 30_000);
      });
    };
    const checkExpiry = (): void => {
      const now = Date.now();
      const mute = controls?.mute ?? CONTROL_OFF;
      const pause = controls?.pause ?? CONTROL_OFF;
      const staleExpiryKey = [mute, pause]
        .filter((control) => control.active && control.mode === "timed" && control.until !== null && Date.parse(control.until) <= now)
        .map((control) => control.until)
        .join("|");
      if (staleExpiryKey.length === 0) refreshedExpiryKey.current = "";
      else if (refreshedExpiryKey.current !== staleExpiryKey) {
        refreshExpiredControl(staleExpiryKey);
      }
      const nextExpiry = [mute, pause]
        .filter((control) => control.active && control.mode === "timed" && control.until !== null)
        .map((control) => Date.parse(control.until ?? ""))
        .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now)
        .sort((left, right) => left - right)[0];
      if (nextExpiry !== undefined) timer = window.setTimeout(checkExpiry, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextExpiry - now)));
    };
    checkExpiry();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [controls]);
  return null;
};

const ChannelControlStatus = ({ control, kind, compact = false }: {
  control: PanelChannelControl;
  kind: "mute" | "pause";
  compact?: boolean;
}): ReactElement => {
  const texts = dashboardTexts();
  const labels = texts.channelControls;
  const now = useSecondClock();
  const configured = control.active || control.pending === true;
  let label: string | null = null;
  if (control.pending === true) label = labels.pendingUntilStreamStart;
  else if (control.active && control.mode === "timed" && control.until !== null) {
    const remaining = Math.ceil((Date.parse(control.until) - now) / 60_000);
    label = remaining <= 0 ? texts.status.refreshing
      : kind === "mute" ? labels.muteRemaining(String(remaining)) : labels.pauseRemaining(String(remaining));
  } else if (control.active && control.mode === "until_stream_end") {
    label = `${kind === "mute" ? labels.muteActive : labels.pauseActive} · ${labels.untilStreamEnd}`;
  } else if (control.active) label = kind === "mute" ? labels.muteActive : labels.pauseActive;
  else if (compact) label = labels.inactive;
  const timed = control.active && control.mode === "timed" && control.until !== null && Date.parse(control.until) > now;
  if (compact) return <span className="dashboard-header__account-control-state" title={label ?? labels.inactive}>{label}</span>;
  return <span className="dashboard-header__control-state-slot">
    {configured && label !== null ? <span className="dashboard-header__control-state" title={label}>{timed ? <Icon name="clock-hour-4" size={16} /> : null}<span>{label}</span></span> : null}
  </span>;
};

const ChannelControlActions = ({ channelId, controls, onRefresh, children }: {
  channelId: string | undefined;
  controls: PanelChannelControls | undefined;
  onRefresh: () => Promise<void>;
  children: (slots: { desktopControls: ReactNode; accountMenuItems: ReactNode }) => ReactNode;
}): ReactElement => {
  const texts = dashboardTexts();
  const labels = texts.channelControls;
  const [dialogControl, setDialogControl] = useState<"mute" | "pause" | null>(null);
  const [duration, setDuration] = useState<ChannelControlDuration>("unlimited");
  const [busy, setBusy] = useState<"mute" | "pause" | null>(null);
  const mute = controls?.mute ?? CONTROL_OFF;
  const pause = controls?.pause ?? CONTROL_OFF;
  const muteConfigured = mute.active || mute.pending === true;
  const pauseConfigured = pause.active || pause.pending === true;
  const activeChannelControls = controls ?? { mute: CONTROL_OFF, pause: CONTROL_OFF };

  const apply = async (kind: "mute" | "pause", next: ChannelControlDuration | null): Promise<void> => {
    if (busy !== null || channelId === undefined) return;
    setBusy(kind);
    try {
      await setChannelControl(channelId, kind, next);
      setDialogControl(null);
    } catch (requestError: unknown) {
      notify({
        tone: "error",
        message: requestError instanceof PanelApiError
          ? apiErrorText(requestError.code, labels.failure)
          : labels.failure,
      });
      setBusy(null);
      return;
    }
    try {
      await onRefresh();
    } catch {
      notify({ tone: "error", message: labels.refreshFailure });
    } finally {
      setBusy(null);
    }
  };

  const durationOptions = CHANNEL_CONTROL_DURATIONS.map((choice) => ({
    value: choice,
    label: choice === "15m" ? labels.duration15m
      : choice === "1h" ? labels.duration1h
        : choice === "until_stream_end" ? labels.durationStream
          : labels.durationUnlimited,
    description: choice === "15m" ? labels.duration15mDescription
      : choice === "1h" ? labels.duration1hDescription
        : choice === "until_stream_end" ? labels.durationStreamDescription
          : labels.durationUnlimitedDescription,
  }));

  const desktopControls = channelId === undefined ? null : (
    <div className="dashboard-header__controls" aria-label={texts.navigation.channel}>
      <div className="dashboard-header__control-buttons">
        <Button
          icon={muteConfigured ? "volume-off" : "volume-3"}
          iconOnly
          ariaLabel={muteConfigured ? labels.muteDisable : labels.muteEnable}
          title={muteConfigured ? labels.muteDisable : labels.muteEnable}
          disabled={busy !== null}
          onClick={() => { if (muteConfigured) void apply("mute", null); else setDialogControl("mute"); }}
        />
        <ChannelControlStatus control={mute} kind="mute" />
        <Button
          icon={pauseConfigured ? "player-play" : "player-pause"}
          iconOnly
          ariaLabel={pauseConfigured ? labels.pauseDisable : labels.pauseEnable}
          title={pauseConfigured ? labels.pauseDisable : labels.pauseEnable}
          disabled={busy !== null}
          onClick={() => { if (pauseConfigured) void apply("pause", null); else setDialogControl("pause"); }}
        />
        <ChannelControlStatus control={pause} kind="pause" />
      </div>
    </div>
  );
  const accountMenuItems = channelId === undefined ? null : (
    <>
      <div className="dashboard-header__account-menu-heading">{labels.controlsHeading}</div>
      <button className="dashboard-header__account-control" onClick={() => { if (muteConfigured) void apply("mute", null); else setDialogControl("mute"); }} role="menuitem" type="button">
        <span>{muteConfigured ? labels.muteDisable : labels.muteEnable}</span>
        <ChannelControlStatus compact control={mute} kind="mute" />
      </button>
      <button className="dashboard-header__account-control" onClick={() => { if (pauseConfigured) void apply("pause", null); else setDialogControl("pause"); }} role="menuitem" type="button">
        <span>{pauseConfigured ? labels.pauseDisable : labels.pauseEnable}</span>
        <ChannelControlStatus compact control={pause} kind="pause" />
      </button>
    </>
  );

  return (
    <>
      {children({ desktopControls, accountMenuItems })}
      <ChannelControlExpiryWatcher controls={activeChannelControls} onRefresh={onRefresh} />
      <ControlDurationDialog
        opened={dialogControl !== null}
        title={labels.durationTitle(dialogControl === "mute" ? labels.muteName : labels.pauseName)}
        description={labels.durationDescription(dialogControl === "mute" ? labels.muteName : labels.pauseName)}
        durationLabel={labels.durationLabel}
        durationHint={labels.durationHint}
        value={duration}
        options={durationOptions}
        confirmLabel={labels.enable}
        cancelLabel={labels.cancel}
        pending={busy !== null}
        onChange={(value) => { if (isControlDuration(value)) setDuration(value); }}
        onConfirm={() => { if (dialogControl !== null) void apply(dialogControl, duration); }}
        onCancel={() => { if (busy === null) setDialogControl(null); }}
      />
    </>
  );
};

/** The fixed dashboard topbar owns channel, mode, palette, and account controls. */
const DashboardConnectionClock = ({ channel, loadedAt }: {
  channel: PanelChannelState;
  loadedAt?: number;
}): ReactElement => {
  const texts = dashboardTexts();
  const now = useSecondClock();
  const tone = channelStatus(channel, loadedAt, now);
  const label = tone === "healthy" ? texts.header.connectionRunning : statusText(channel, loadedAt, now);
  return <StatusLed state={channelToneToStatusState(tone)} label={label} />;
};

const DashboardStreamClock = ({ channel }: { channel: PanelChannelState }): ReactElement => {
  const texts = dashboardTexts();
  const now = useSecondClock();
  const streamState = channel.streamState;
  const streamLabel = streamState === "online"
    ? texts.header.streamLive(streamDuration(channel.streamStartedAt, now))
    : streamState === "offline" ? texts.header.streamOffline : texts.header.streamUnknown;
  return <span aria-label={streamLabel} className="dashboard-header__stream" data-state={streamState === "online" ? "live" : streamState === "offline" ? "offline" : "unknown"}>
    <Icon name={streamState === "online" ? "broadcast" : "broadcast-off"} size={20} />
    <span>{streamLabel}</span>
    {channel.streamStateCheckedAt === undefined || channel.streamStateCheckedAt === null ||
        !Number.isFinite(Date.parse(channel.streamStateCheckedAt)) ? null : (
      <DataAge since={Date.parse(channel.streamStateCheckedAt)} format={texts.header.streamChecked} className="dashboard-header__stream-age" />
    )}
  </span>;
};

const DashboardHeader = ({ route, mode, channels, activeChannel, loadedAt, palette, onPaletteChange, onOpenCommandPalette, onSwitchMode, onNavigate, onLogout, loggingOut, onRefreshState }: DashboardHeaderProperties): ReactElement => {
  const texts = dashboardTexts();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!accountOpen) return;
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (event.target instanceof Node && !accountMenuRef.current?.contains(event.target)) setAccountOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setAccountOpen(false); };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [accountOpen]);
  return (
    <div className="dashboard-header">
      <div className="dashboard-header__start">
      <a aria-current={dashboardModeForRoute(route) === "live" ? "page" : undefined} className="brand-mark dashboard-header__brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate({ kind: "overview" }); }}><span className="brand-mark__dot" /><span className="brand-mark__word">BroBot</span></a>
      {activeChannel === undefined ? null : (
      <div className="dashboard-header__channel">
        <div className="dashboard-header__channel-select">
          <span aria-hidden="true" className="dashboard-header__channel-avatar">{activeChannel.login.slice(0, 1).toUpperCase()}</span>
          <UiSelect
              compact
              value={activeChannel.channelId}
              onChange={(channelId) => { if (channelId !== null) onNavigate(routeForSelectedChannel(route, channelId)); }}
              options={channels.map((channel) => ({ value: channel.channelId, label: `${channel.displayName} — ${channel.channelId}`, selectedLabel: channel.displayName }))}
              ariaLabel={`${activeChannel.displayName} — ${texts.navigation.selectChannel}`}
              id="dashboard-channel-select"
            />
        </div>
        {activeChannel.location == null ? null : <ChannelLocationMenu location={activeChannel.location} messages={texts.header.locationMenu} />}
        </div>
      )}
      </div>
      <div aria-label={texts.navigation.setup} className="dashboard-header__mode" role="group">
        <button aria-label={texts.navigation.live} aria-pressed={mode === "live"} onClick={() => { onSwitchMode("live"); }} type="button"><Icon name="broadcast" size={16} /><span className="dashboard-header__mode-label">{texts.navigation.live}</span></button>
        <button aria-label={texts.navigation.setup} aria-pressed={mode === "setup"} onClick={() => { onSwitchMode("setup"); }} type="button"><Icon name="tabSettings" size={16} /><span className="dashboard-header__mode-label">{texts.navigation.setup}</span></button>
      </div>
      <ChannelControlActions channelId={activeChannel?.channelId} controls={activeChannel?.controls} onRefresh={onRefreshState}>
        {({ desktopControls, accountMenuItems }) => (
          <div className="dashboard-header__end">
            <div className="dashboard-header__status">
              {activeChannel === undefined ? null : <DashboardStreamClock channel={activeChannel} />}
              {activeChannel === undefined ? null : <DashboardConnectionClock channel={activeChannel} {...(loadedAt === undefined ? {} : { loadedAt })} />}
              {loadedAt === undefined ? null : <DataAge since={loadedAt} />}
            </div>
            {desktopControls}
            <button aria-label={texts.commandPalette.placeholder} className="dashboard-header__palette-trigger" onClick={onOpenCommandPalette} type="button">
              <Icon name="search" size={16} /><span>{texts.commandPalette.placeholder}</span><kbd>{navigator.userAgent.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>
            </button>
            <div className="dashboard-header__account-wrap" ref={accountMenuRef}>
              <button aria-expanded={accountOpen} aria-haspopup="menu" aria-label={texts.navigation.accountMenu} className="dashboard-header__account-trigger" onClick={() => { setAccountOpen((open) => !open); }} type="button">
                <span aria-hidden="true" className="dashboard-header__account-avatar">B</span><span className="dashboard-header__account-name">{texts.navigation.accountMenu}</span><span aria-hidden="true">⌄</span>
              </button>
              {accountOpen ? (
                <div aria-label={texts.navigation.accountMenu} className="dashboard-header__account-menu" role="menu">
                  <div className="dashboard-header__account-menu-heading">{texts.navigation.appearance}</div>
                  <button aria-checked={palette === "nachtschicht"} onClick={() => { onPaletteChange("nachtschicht"); setAccountOpen(false); }} role="menuitemradio" type="button">
                    <span>{texts.navigation.appearanceNightShift}</span>{palette === "nachtschicht" ? <span aria-hidden="true">✓</span> : null}
                  </button>
                  <button aria-checked={palette === "indigo-nacht"} onClick={() => { onPaletteChange("indigo-nacht"); setAccountOpen(false); }} role="menuitemradio" type="button">
                    <span>{texts.navigation.appearanceIndigoNight}</span>{palette === "indigo-nacht" ? <span aria-hidden="true">✓</span> : null}
                  </button>
                  {accountMenuItems}
                  <button className="dashboard-header__account-signout" disabled={loggingOut} onClick={() => { setAccountOpen(false); onLogout(); }} role="menuitem" type="button">
                    {loggingOut ? texts.navigation.signingOut : texts.navigation.signOut}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </ChannelControlActions>
    </div>
  );
};

const OverviewPage = ({ channelState, onNavigate }: { channelState: LoadState<PanelChannelState[]>; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
  const texts = dashboardTexts();
  const channels = channelState.data ?? [];
  const status = channelState.data !== null
    ? channels.length === 0 ? "empty" : "success"
    : channelState.status === "error" ? "error" : "loading";
  return (
    <>
      <ModuleHeading kind="overview" title={texts.navigation.overview} subtitle={channels.length === 1 ? texts.overview.oneChannelAvailable : <ModuleCount count={channels.length} label={texts.overview.channelsAvailableShort} />} />
      <UiLoadState
        variant="panel-360"
        status={status}
        loading={<LoadStateLines rows={3} height={132} />}
        empty={<section className="empty-state"><h2>{texts.overview.noChannelAvailable}</h2><p>{texts.overview.noMembership}</p></section>}
        error={<LoadStateLines rows={3} height={132} />}
      >
        <div className="module-grid">
          {channels.map((channel) => (
            <ModuleTile
              key={channel.channelId}
              channelId={channel.channelId}
              moduleId={channel.channelId}
              enabled={channelStatus(channel, channelState.loadedAt) === "healthy"}
              name={channel.displayName}
              ledStatus={channelToneToStatusState(channelStatus(channel, channelState.loadedAt))}
              ledLabel={statusText(channel, channelState.loadedAt)}
              route={{ kind: "channel", channelId: channel.channelId, section: "overview" }}
              icon={<NavigationIcon kind="channel" className="module-glyph" />}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </UiLoadState>
    </>
  );
};

/**
 * The channel page's only bright action. It sits in the title row and
 * not in the moderator row, because that row doesn't appear at all in a
 * healthy state — the recheck must still be reachable at all times.
 */
const relativeTime = (since: number, now: number): string => {
  const s = Math.max(0, Math.round((now - since) / 1000));
  const texts = dashboardTexts();
  if (s < 60) return texts.time.secondsAgo(s);
  const m = Math.round(s / 60);
  if (m < 60) return texts.time.minutesAgo(m);
  return texts.time.hoursAgo(Math.round(m / 60));
};

/**
 * Proves liveness without asserting a status. Deliberately neutral and
 * never in status color.
 */
const DataAge = ({ since, format, className }: {
  since: number;
  format?: (relativeTime: string) => string;
  className?: string;
}): ReactElement => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, []);
  const age = relativeTime(since, now);
  return <span className={`data-age${className === undefined ? "" : ` ${className}`}`}>{format === undefined ? dashboardTexts().time.updated(age) : format(age)}</span>;
};

interface StatusEntry {
  key: string;
  tone: StateTone;
  node: ReactElement;
}

const botRow = (bot: PanelBotStatus | null): StatusEntry => {
  const texts = dashboardTexts();
  if (bot === null) return { key: "bot", tone: "neutral", node: <StateRow label={texts.statusCard.botAccount} tone="neutral" word={texts.status.notSetUp} detail={texts.bot.noSavedStatus} /> };
  const tone: StateTone = bot.status === "connected" ? "healthy" : "error";
  return { key: "bot", tone, node: <StateRow label={texts.statusCard.botAccount} tone={tone} word={statusLabel(bot.status)} detail={maintenanceReasonText(bot.reason) ?? texts.bot.lastUpdated(formatTimestamp(bot.updatedAt))} /> };
};

const broadcasterRow = (status: PanelChannelState["broadcasterConnection"]): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = status === "connected" ? "healthy" : "neutral";
  return { key: "broadcaster", tone, node: <StateRow label={texts.statusCard.broadcasterOauth} tone={tone} word={broadcasterConnectionLabel(status)} detail={status === "connected" ? texts.bot.optionalModules : texts.bot.normalOperation} /> };
};

const chatRow = (status: PanelChannelState["chatSubscription"] | undefined, needed = false): StatusEntry => {
  const texts = dashboardTexts();
  const current = status ?? null;
  if (!needed) {
    return { key: "chat-subscription", tone: "neutral", node: <StateRow label={texts.statusCard.chatSubscription} tone="neutral" word={texts.status.chatSubscriptionNotNeeded} /> };
  }
  const reasonText = maintenanceReasonText(current?.reason);
  const neutralReason = current?.reason === "pending_adoption" || current?.reason === "moderator_required";
  const tone: StateTone = current === null || current.status === "missing"
    ? neutralReason ? "neutral" : "warning"
    : current.status === "enabled" ? "healthy" : "error";
  const word = neutralReason ? reasonText ?? texts.status.notChecked
    : current === null || current.status === "missing" ? texts.status.missing
      : current.status === "enabled" ? texts.status.active
        : current.status === "revoked" ? texts.status.revoked : texts.status.error;
  return { key: "chat-subscription", tone, node: <StateRow label={texts.statusCard.chatSubscription} tone={tone} word={word} detail={neutralReason ? undefined : reasonText ?? (current === null ? texts.status.chatSubscriptionMissing : undefined)} /> };
};

const botPermissionsRow = (permissions: PanelBotPermissions | null | undefined): StatusEntry | null => {
  const texts = dashboardTexts();
  if (permissions === undefined) return null;
  if (permissions === null) {
    return {
      key: "bot-permissions",
      tone: "neutral",
      node: <StateRow label={texts.statusCard.botPermissions} tone="neutral" word={texts.status.notChecked} detail={texts.bot.noSavedStatus} />,
    };
  }
  const missing = permissions.missingScopes.length;
  const tone: StateTone = missing === 0 ? "healthy" : "warning";
  return {
    key: "bot-permissions",
    tone,
    node: <StateRow
      label={texts.statusCard.botPermissions}
      tone={tone}
      word={missing === 0 ? texts.status.healthy : texts.status.botPermissionsMissing(formatNumber(missing))}
      detail={missing === 0 ? texts.bot.botPermissionsComplete : texts.bot.botPermissionsOperator}
    />,
  };
};

const broadcasterPermissionsRow = (permissions: PanelBroadcasterPermissions | null | undefined, login?: string, canRequest = false): StatusEntry | null => {
  const texts = channelPanelTexts();
  if (!broadcasterPermissionsAreMissing(permissions)) return null;
  return {
    key: "broadcaster-permissions",
    tone: "warning",
    node: <StateRow
      label={texts.fullConsent}
      tone="warning"
      word={texts.fullConsentMissing}
      action={login === undefined ? undefined : <BroadcasterConsentAction login={login} needed canRequest={canRequest} />}
    />,
  };
};

const channelBotConsentRow = (
  channelId: string,
  consent: PanelChannelState["channelBotConsent"],
  viewerUserId: string | null,
): StatusEntry | null => {
  if (consent !== "missing") return null;
  const texts = dashboardTexts();
  const reasonId = `channel-bot-consent-reason-${channelId}`;
  const requestConsent = viewerUserId === channelId;
  const action = requestConsent
    ? <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/channel-bot`}>{texts.statusCard.requestChannelBotConsent}</a>
    : <div className="header-action">
      <Button size="compact" variant="neutral" disabled describedBy={reasonId}>{texts.statusCard.requestChannelBotConsent}</Button>
      <div className="header-action__reason-slot"><span className="lock-reason" id={reasonId}>{texts.statusCard.channelBotConsentLocked}</span></div>
    </div>;
  return {
    key: "channel-bot-consent",
    tone: "warning",
    node: <StateRow
      label={texts.statusCard.chatConsent}
      tone="warning"
      word={texts.status.broadcasterConsentMissing}
      detail={texts.statusCard.channelBotConsentMissing}
      action={action}
    />,
  };
};

const tokenRow = (tokens: PanelTokenStatus, bot: PanelBotStatus | null, loadedAt?: number): StatusEntry => {
  const texts = dashboardTexts();
  const token = tokenHealth(tokens, bot, loadedAt);
  return { key: "token", tone: token.tone, node: <StateRow label={texts.statusCard.tokenStatus} tone={token.tone} word={token.label} detail={maintenanceReasonText(tokens.loginReason) ?? undefined} /> };
};

const BotPermissionsInspector = ({ permissions }: { permissions: PanelBotPermissions | null | undefined }): ReactElement | null => {
  const texts = dashboardTexts();
  if (!botPermissionsAreMissing(permissions)) return null;
  return (
    <section className="content-section" aria-label={texts.system.missingBotPermissions}>
      <div className="section-heading"><h2>{texts.system.missingBotPermissions}</h2><span className="mono muted">{formatNumber(permissions.missingScopes.length)}</span></div>
      <h4>{texts.system.missingScopes}</h4>
      <ul className="scope-list">{permissions.missingScopes.map((scope) => <li className="mono" key={scope}>{scope}</li>)}</ul>
    </section>
  );
};

const BroadcasterPermissionsInspector = ({ permissions }: { permissions: PanelBroadcasterPermissions | null | undefined }): ReactElement | null => {
  const texts = channelPanelTexts();
  if (!broadcasterPermissionsAreMissing(permissions)) return null;
  return (
    <section className="content-section" aria-label={texts.missingBroadcasterPermissions}>
      <div className="section-heading"><h2>{texts.missingBroadcasterPermissions}</h2><span className="mono muted">{formatNumber(permissions.missingScopes.length)}</span></div>
      <h4>{texts.missingScopes}</h4>
      <ul className="scope-list">{permissions.missingScopes.map((scope) => <li className="mono" key={scope}>{scope}</li>)}</ul>
    </section>
  );
};

const subscriptionKey = (subscription: PanelEventSubSubscription): string =>
  `${subscription.subscriptionType}\u0000${subscription.variant}\u0000${subscription.version}`;

const subscriptionDisplayName = (subscription: PanelEventSubSubscription): string =>
  eventSubName(subscription.subscriptionType, subscription.variant);

const SubscriptionsSection = ({ subscriptions }: { subscriptions: PanelEventSubSubscription[] }): ReactElement => {
  const texts = dashboardTexts();
  const emptyValue = "—";
  const { selectedKey, select, rowRef, close } = useInspectorSelection<string>();
  const selected = subscriptions.find((subscription) => subscriptionKey(subscription) === selectedKey) ?? null;
  const list = (
    <section className="content-section" aria-label={texts.system.subscriptions}>
      <div className="section-heading"><h2>{texts.system.subscriptions}</h2><span className="muted number">{formatNumber(subscriptions.length)}</span></div>
      {subscriptions.length === 0 ? <p className="empty-state">{texts.system.noSubscriptions}</p> : (
        <div className="table-wrap">
          <table className="table subscriptions-table">
            <thead><tr><th scope="col">{texts.system.subscription}</th><th scope="col">{texts.system.state}</th><th scope="col">{texts.system.reason}</th></tr></thead>
            <tbody>{subscriptions.map((subscription) => {
              const key = subscriptionKey(subscription);
              const name = subscriptionDisplayName(subscription);
              const unknown = name === subscription.subscriptionType;
              const tone = subscriptionTone(subscription.status, subscription.reason);
              return <tr
                key={key}
                ref={rowRef(key)}
                tabIndex={0}
                aria-selected={selectedKey === key}
                onClick={() => { select(key); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(key); } }}
              >
                <th scope="row"><span className={unknown ? "mono" : undefined}>{name}</span></th>
                <td><StatusLed state={channelToneToStatusState(tone)} label={subscriptionStatusLabel(subscription.status, subscription.reason)} /></td>
                <td>{maintenanceReasonText(subscription.reason) ?? <EmptyCellValue />}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
  const inspector = selected === null ? null : (
    <SubInspector ariaLabel={texts.system.subscriptionDetails} title={subscriptionDisplayName(selected)} identifier={selected.subscriptionId ?? emptyValue} closeLabel={dashboardCommonTexts().close} onClose={close}>
      <InspectorSection title={texts.system.subscription}>
        <dl className="properties">
          <div><dt>{texts.system.subscriptionRawType}</dt><dd className="mono">{selected.subscriptionType}</dd></div>
          <div><dt>{texts.system.subscriptionVersion}</dt><dd className="mono">{selected.version}</dd></div>
          <div><dt>{texts.system.subscriptionId}</dt><dd className="mono">{selected.subscriptionId ?? emptyValue}</dd></div>
          <div><dt>{texts.system.subscriptionUpdated}</dt><dd className="mono">{formatTimestamp(selected.updatedAt)}</dd></div>
          <div><dt>{texts.system.twitchMessage}</dt><dd>{selected.message ?? emptyValue}</dd></div>
          <div><dt>{texts.system.httpStatus}</dt><dd className="mono">{selected.statusCode === null ? emptyValue : String(selected.statusCode)}</dd></div>
        </dl>
      </InspectorSection>
    </SubInspector>
  );
  return (
    <ListDetail list={list} inspector={inspector} onCloseInspector={close} />
  );
};

interface ChannelOverviewRouteProperties {
  overview: PanelChannelOverview;
  modules: PanelModuleState[];
  modulesLoaded: boolean;
  onNavigate: (route: DashboardRoute) => void;
}

const ChannelOverviewRoute = ({ overview, modules, modulesLoaded, onNavigate }: ChannelOverviewRouteProperties): ReactElement =>
  <LiveCockpit overview={overview} modules={modules} modulesLoaded={modulesLoaded} onNavigate={onNavigate} />;

interface SystemPageProperties {
  channelId: string;
  login: string;
  role: ChannelRole;
  channelBotConsent: PanelChannelState["channelBotConsent"];
  viewerUserId: string | null;
  moderator: PanelModeratorStatus | null;
  system: PanelSystemResponse | undefined;
  error: string | null;
  loadedAt: number | undefined;
  onRetry: () => void;
  onModeratorRecheck: (isCurrentPage: () => boolean) => Promise<void>;
}

const SystemPage = ({ channelId, login, role, channelBotConsent, viewerUserId, moderator, system, error, loadedAt, onRetry, onModeratorRecheck }: SystemPageProperties): ReactElement => {
  const texts = dashboardTexts();
  const [saveTarget, setSaveTarget] = useState<HTMLDivElement | null>(null);
  const saveTargetRef = useCallback((element: HTMLDivElement | null): void => { setSaveTarget(element); }, []);
  const [recheckingModerator, setRecheckingModerator] = useState(false);
  const isCurrentPage = useMountedPageGuard();
  const canRecheckModerator = canManage(role);
  const moderatorReasonId = `moderator-recheck-reason-${channelId}`;
  const moderatorTone: StateTone = moderator === null ? "neutral" : moderator.isModerator ? "healthy" : "error";
  const moderatorWord = moderator === null ? texts.status.notChecked : moderator.isModerator ? texts.status.healthy : texts.status.moderatorRoleMissing;
  const moderatorDetail = moderator === null
    ? texts.moderation.noCheckForChannel
    : texts.moderation.lastCheck(formatTimestamp(moderator.checkedAt));
  const moderatorAction = <div className="header-action">
    <Button
      size="compact"
      variant="neutral"
      disabled={!canRecheckModerator || recheckingModerator}
      {...(!canRecheckModerator ? { describedBy: moderatorReasonId } : {})}
      onClick={() => {
        setRecheckingModerator(true);
        void onModeratorRecheck(isCurrentPage)
          .catch(() => { if (isCurrentPage()) notify({ tone: "error", message: texts.errors.changeFailed }); })
          .finally(() => { if (isCurrentPage()) setRecheckingModerator(false); });
      }}
    >{recheckingModerator ? texts.moderation.checkRunning : texts.moderation.checkModeratorStatus}</Button>
    <div className="header-action__reason-slot">{!canRecheckModerator ? <span className="lock-reason" id={moderatorReasonId}>{texts.moderation.checkLocked}</span> : null}</div>
  </div>;
  const moderatorStatusRow: StatusEntry = {
    key: "moderator-status",
    tone: moderatorTone,
    node: <StateRow label={texts.statusCard.moderatorStatus} tone={moderatorTone} word={moderatorWord} detail={moderatorDetail} action={moderatorAction} />,
  };
  return (
    <SettingsPage
      kind="system"
      title={texts.system.title}
      subtitle={texts.system.readOnly}
      saveTargetRef={saveTargetRef}
      columns={[
        <ChannelDefaultsEditor key="channel-defaults" channelId={channelId} role={role} saveTarget={saveTarget} />,
        <div key="system-status" className="system-page__status">
          <UiLoadState
            variant="status-row"
            status={system !== undefined && error !== null ? "error" : "success"}
            loading={null}
            empty={null}
            error={null}
            {...(system !== undefined && error !== null ? { queryError: { title: texts.errors.dataLoadFailed, message: error, onRetry } } : {})}
          >{null}</UiLoadState>
          <UiLoadState
            variant="panel-720"
            status={system !== undefined ? "success" : error !== null ? "error" : "loading"}
            loading={<LoadStateLines rows={8} height={58} />}
            empty={<LoadStateLines rows={8} height={58} />}
            error={<p role="alert">{error ?? texts.system.loadState}</p>}
            queryError={{ title: texts.errors.dataLoadFailed, message: error ?? texts.system.loadState, onRetry }}
          >
            {system === undefined ? null : <>
              <div className="state-list">{[broadcasterRow(system.broadcasterConnection), chatRow(system.chatSubscription, system.chatSubscriptionNeeded === true), botRow(system.bot), botPermissionsRow(system.botPermissions), channelBotConsentRow(channelId, channelBotConsent, viewerUserId), broadcasterPermissionsRow(system.broadcasterPermissions, login, role === "broadcaster"), moderatorStatusRow, tokenRow(system.tokens, system.bot, loadedAt)].filter((entry): entry is StatusEntry => entry !== null).map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
              <BotPermissionsInspector permissions={system.botPermissions} />
              <BroadcasterPermissionsInspector permissions={system.broadcasterPermissions} />
              <SubscriptionsSection subscriptions={system.subscriptions ?? []} />
              <SystemProperties system={system} />
            </>}
          </UiLoadState>
        </div>,
      ]}
    />
  );
};

const SystemProperties = ({ system }: { system: PanelSystemResponse }): ReactElement => {
  const texts = dashboardTexts();
  const emptyValue = "—";
  const loginStatus = system.tokens.loginStatus === null ? emptyValue : statusLabel(system.tokens.loginStatus);
  return (
    <section className="content-section properties-section" aria-label={texts.system.properties}>
      <div className="section-heading"><h2>{texts.system.properties}</h2></div>
      <dl className="properties">
        <div><dt>{texts.system.botReason}</dt><dd>{maintenanceReasonText(system.bot?.reason) ?? emptyValue}</dd></div>
        <div><dt>{texts.system.botUpdated}</dt><dd className="mono">{system.bot === null ? emptyValue : formatTimestamp(system.bot.updatedAt)}</dd></div>
        <div><dt>{texts.system.chatSubscriptionId}</dt><dd className="mono">{system.chatSubscription?.subscriptionId ?? emptyValue}</dd></div>
        <div><dt>{texts.system.chatSubscriptionReason}</dt><dd>{maintenanceReasonText(system.chatSubscription?.reason) ?? emptyValue}</dd></div>
        <div><dt>{texts.system.chatSubscriptionUpdated}</dt><dd className="mono">{system.chatSubscription == null ? emptyValue : formatTimestamp(system.chatSubscription.updatedAt)}</dd></div>
        <div><dt>{texts.system.loginStatus}</dt><dd>{loginStatus}</dd></div>
        <div><dt>{texts.system.loginReason}</dt><dd>{maintenanceReasonText(system.tokens.loginReason) ?? emptyValue}</dd></div>
        <div><dt>{texts.system.loginValidUntil}</dt><dd className="mono">{system.tokens.loginExpiresAt === null ? emptyValue : formatTimestamp(system.tokens.loginExpiresAt)}</dd></div>
        <div><dt>{texts.system.botValidUntil}</dt><dd className="mono">{system.tokens.botExpiresAt === null ? emptyValue : formatTimestamp(system.tokens.botExpiresAt)}</dd></div>
      </dl>
    </section>
  );
};

export const DashboardApp = (): ReactElement => {
  useEffect(() => {
    document.documentElement.lang = dashboardLanguage();
  }, []);

  const [route, navigate] = useDashboardRoute();
  const [palette, setPalette] = useState<Palette>(() => readPalette());
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const realtimeChannelId = route.kind === "channel" || route.kind === "module" ? route.channelId : null;
  const realtimeStatus = useDashboardRealtimeStatus(realtimeChannelId ?? "");
  const offlineRefetchInterval = realtimeStatus === "connected" ? false : 180_000;
  const routeRef = useRef(route);
  useLayoutEffect(() => { routeRef.current = route; }, [route]);
  const queryClient = useQueryClient();
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const requestLogin = useCallback((): void => { setAuthenticationRequired(true); }, []);
  useEffect(() => {
    window.addEventListener(dashboardAuthenticationRequiredEvent, requestLogin);
    return () => window.removeEventListener(dashboardAuthenticationRequiredEvent, requestLogin);
  }, [requestLogin]);
  const latestStreamByChannel = useRef(new Map<string, ChannelStreamVersion>());
  const channelsQuery = useQuery<PanelChannelsResponse>({
    queryKey: queryKeys.channels(),
    refetchOnWindowFocus: false,
    structuralSharing: mergeChannelsRefreshData,
    queryFn: async ({ signal }) => {
      const response = await fetchChannels(signal);
      return {
        ...response,
        channels: response.channels.map((channel) =>
          mergeAndRememberChannelStreamVersion(channel, latestStreamByChannel.current),
        ),
      };
    },
    refetchInterval: offlineRefetchInterval,
    enabled: !authenticationRequired,
  });
  const channelsResponse = channelsQuery.data;
  const channels: LoadState<PanelChannelState[]> = {
    ...loadStateFromQuery(channelsQuery),
    data: channelsResponse?.channels ?? null,
  };
  const selectedChannel = (route.kind !== "channel" && route.kind !== "module") || channels.data === null
    ? null
    : channels.data.find((channel) => channel.channelId === route.channelId) ?? null;
  const realtimeEnabled = realtimeChannelId !== null && selectedChannel !== null &&
    !authenticationRequired && !loggingOut;
  const viewerUserId = channelsResponse?.viewerUserId ?? null;
  const isPlatform = channelsResponse?.platformAdmin ?? false;
  const viewerIsBot = channelsResponse?.viewerIsBot ?? false;
  const botLogin = channelsResponse?.botLogin ?? null;
  // The installation's single bot identity, independent of which channels
  // this viewer can see -- present even with zero released channels (#159).
  const installationBot = channelsResponse?.bot ?? null;
  const overviewChannelId = route.kind === "channel" || route.kind === "module" ? route.channelId : null;
  const overviewQuery = useQuery<PanelChannelOverview>({
    queryKey: queryKeys.channel(overviewChannelId ?? "", "overview"),
    refetchOnWindowFocus: false,
    structuralSharing: mergeChannelRefreshData,
    queryFn: async ({ signal }) => {
      if (overviewChannelId === null) throw new Error("An overview query needs a channel ID.");
      const response = await fetchChannelOverview(overviewChannelId, signal);
      return mergeAndRememberChannelStreamVersion(response, latestStreamByChannel.current);
    },
    refetchInterval: overviewChannelId === null ? false : offlineRefetchInterval,
    enabled: !authenticationRequired && overviewChannelId !== null &&
      (route.kind === "module" || (route.kind === "channel" && route.section === "overview")),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === overviewChannelId ? previousData : undefined,
  });
  const overview = loadStateFromQuery(overviewQuery);
  useRealtimePanelMessages(realtimeChannelId, realtimeEnabled);
  const systemChannelId = route.kind === "channel" && route.section === "system" ? route.channelId : null;
  const systemQuery = useSystemQuery(
    systemChannelId ?? "",
    !authenticationRequired && systemChannelId !== null,
    systemChannelId === null ? false : offlineRefetchInterval,
  );
  const [, setFreshnessTick] = useState(0);
  const routeKey = dashboardRoutePath(route);
  const [headerModuleBusyKeys, setHeaderModuleBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const headerModuleBusyKeysRef = useRef<ReadonlySet<string>>(new Set());
  const headerModuleBusy = route.kind === "module" && headerModuleBusyKeys.has(`${route.channelId}:${route.moduleId}`);
  // The command palette sets this before navigating so a module can preselect
  // can pre-select something on mount (e.g. a text command by name). Not
  // part of the route/URL -- see the deep-link discussion in that commit.
  const [pendingModuleSelection, setPendingModuleSelection] = useState<{ channelId: string; moduleId: string; value: string } | null>(null);
  // The same deep-link pattern lets the command palette jump straight to a channel
  // variable's inspector (#208) instead of just opening the variables page.
  const [pendingVariableSelection, setPendingVariableSelection] = useState<{ channelId: string; name: string } | null>(null);
  const notifiedLoadErrors = useRef(new Map<string, string>());
  const reportLoadError = useCallback((key: string, message: string | null): void => {
    if (message === null) {
      notifiedLoadErrors.current.delete(key);
      return;
    }
    if (notifiedLoadErrors.current.get(key) === message) return;
    notifiedLoadErrors.current.set(key, message);
    notify({ tone: "error", message });
  }, []);

  useEffect(() => { reportLoadError("channels", channels.error); }, [channels.error, reportLoadError]);
  useEffect(() => {
    reportLoadError("overview", route.kind === "channel" || route.kind === "module" ? overview.error : null);
  }, [overview.error, reportLoadError, route]);
  useEffect(() => {
    reportLoadError("system", systemChannelId !== null && systemQuery.isError ? errorMessage(systemQuery.error) : null);
  }, [reportLoadError, systemChannelId, systemQuery.error, systemQuery.isError]);
  const reloadChannels = useCallback(async (): Promise<void> => {
    const filter = { queryKey: queryKeys.channels(), exact: true } as const;
    await queryClient.cancelQueries(filter);
    await queryClient.invalidateQueries(filter, { throwOnError: true });
  }, [queryClient]);

  const clearProtectedState = (): void => {
    setAuthenticationRequired(true);
    queryClient.clear();
    navigate({ kind: "overview" });
  };

  useEffect(() => {
    if (route.kind === "platform" && channels.status === "success" && !isPlatform) {
      navigate({ kind: "overview" });
    }
  }, [channels.status, isPlatform, navigate, route.kind]);

  useEffect(() => {
    if (route.kind !== "overview" || channels.status !== "success" || channels.data?.length !== 1) return;
    const channel = channels.data[0];
    if (channel === undefined) return;
    replaceDashboardRoute({ kind: "channel", channelId: channel.channelId, section: "overview" });
  }, [channels.data, channels.status, route.kind]);

  const reloadModules = useCallback(async (): Promise<void> => {
    if (route.kind !== "channel" && route.kind !== "module") return;
    if (selectedChannel?.modules !== undefined) {
      await reloadChannels();
      return;
    }
    const filter = { queryKey: queryKeys.channel(route.channelId, "modules"), exact: true } as const;
    await queryClient.cancelQueries(filter);
    await queryClient.invalidateQueries(filter, { throwOnError: true });
  }, [queryClient, reloadChannels, route, selectedChannel]);

  const reloadAfterModuleToggle = async (channelId: string): Promise<void> => refreshAfterModuleToggle(queryClient, channelId);

  const toggleModuleEnabled = async (channelId: string, moduleId: string, enabled: boolean): Promise<void> => {
    const targetKey = `${channelId}:${moduleId}`;
    if (headerModuleBusyKeysRef.current.has(targetKey)) return;
    const channel = channels.data?.find((candidate) => candidate.channelId === channelId)
      ?? (selectedChannel?.channelId === channelId ? selectedChannel : null);
    const moduleState = channel?.modules?.find((candidate) => candidate.id === moduleId)
      ?? (selectedChannel?.channelId === channelId ? modules.data?.modules.find((candidate) => candidate.id === moduleId) : undefined);
    const module = MODULES.find((candidate) => candidate.id === moduleId);
    if (channel === null || !canManage(channel.role) || moduleState === undefined || moduleState.mandatory === true || module?.mandatory === true) return;

    const busyKeys = new Set(headerModuleBusyKeysRef.current);
    busyKeys.add(targetKey);
    headerModuleBusyKeysRef.current = busyKeys;
    setHeaderModuleBusyKeys(busyKeys);
    try {
      await setChannelModuleEnabled(channelId, moduleId, enabled);
      await reloadAfterModuleToggle(channelId);
    } catch (error) {
      notify({ tone: "error", message: error instanceof PanelApiError
        ? apiErrorText(error.code, dashboardTexts().errors.changeFailed)
        : dashboardTexts().errors.changeFailed });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      const nextBusyKeys = new Set(headerModuleBusyKeysRef.current);
      nextBusyKeys.delete(targetKey);
      headerModuleBusyKeysRef.current = nextBusyKeys;
      setHeaderModuleBusyKeys(nextBusyKeys);
    }
  };

  const recheckModerator = useCallback((channelId: string, isCurrentPage: () => boolean): Promise<void> => {
    return runModeratorRecheck(queryClient, channelId, isCurrentPage, refreshModeratorStatus);
  }, [queryClient]);

  const reloadOverview = useCallback(async (): Promise<void> => {
    if (route.kind !== "module" && !(route.kind === "channel" && route.section === "overview")) return;
    const filter = { queryKey: queryKeys.channel(route.channelId, "overview"), exact: true } as const;
    await queryClient.cancelQueries(filter);
    await queryClient.invalidateQueries(filter, { throwOnError: true });
  }, [queryClient, route]);
  const refreshChannelState = useCallback(async (): Promise<void> => {
    const refreshFallbackModules = selectedChannel?.modules === undefined ? reloadModules() : Promise.resolve();
    const refreshSystem = systemChannelId === null ? Promise.resolve() : (async () => {
      const filter = { queryKey: queryKeys.channel(systemChannelId, "system"), exact: true } as const;
      await queryClient.cancelQueries(filter);
      await queryClient.invalidateQueries(filter, { throwOnError: true });
    })();
    await Promise.all([
      reloadChannels(),
      reloadOverview(),
      refreshSystem,
      refreshFallbackModules,
    ]);
  }, [queryClient, reloadChannels, reloadModules, reloadOverview, selectedChannel?.modules, systemChannelId]);
  const refreshChannelStateRef = useRef(refreshChannelState);
  useLayoutEffect(() => { refreshChannelStateRef.current = refreshChannelState; }, [refreshChannelState]);

  const routeUsesOverview = route.kind === "module" || (route.kind === "channel" && route.section === "overview");
  // Keep the freshest token snapshot per channel. The channels query covers all
  // channels; only a currently refreshed overview or System view may supersede
  // its selected channel. Inactive route snapshots never schedule refreshes.
  const tokenSnapshots = new Map<string, { tokens: PanelTokenStatus; loadedAt: number }>();
  const rememberTokenSnapshot = (channelId: string, tokens: PanelTokenStatus, loadedAt: number): void => {
    const current = tokenSnapshots.get(channelId);
    if (current === undefined || loadedAt >= current.loadedAt) tokenSnapshots.set(channelId, { tokens, loadedAt });
  };
  if (channels.loadedAt !== undefined) {
    for (const channel of channels.data ?? []) rememberTokenSnapshot(channel.channelId, channel.tokens, channels.loadedAt);
  }
  if (routeUsesOverview && overview.data?.channelId === route.channelId && overview.loadedAt !== undefined) {
    rememberTokenSnapshot(overview.data.channelId, overview.data.tokens, overview.loadedAt);
  }
  if (route.kind === "channel" && route.section === "system" && route.channelId === systemChannelId &&
      systemQuery.data !== undefined && systemQuery.dataUpdatedAt > 0) {
    rememberTokenSnapshot(route.channelId, systemQuery.data.tokens, systemQuery.dataUpdatedAt);
  }
  const expiryCandidates = [...tokenSnapshots].flatMap(([channelId, snapshot]) =>
    [snapshot.tokens.botExpiresAt, snapshot.tokens.loginExpiresAt].flatMap((value) => {
      const expiresAt = parseDashboardDate(value);
      return expiresAt !== null && expiresAt > snapshot.loadedAt
        ? [{ expiresAt, loadedAt: snapshot.loadedAt, channelId }]
        : [];
    }));
  expiryCandidates.sort((left, right) => left.expiresAt - right.expiresAt);
  const nextExpiry = expiryCandidates[0];
  const expiryRefreshKey = nextExpiry === undefined ? "" : `${nextExpiry.channelId}:${String(nextExpiry.loadedAt)}:${String(nextExpiry.expiresAt)}`;
  const expiryAt = nextExpiry?.expiresAt ?? null;
  const expiryRefreshRef = useRef("");
  useEffect(() => {
    if (expiryAt === null) {
      expiryRefreshRef.current = "";
      return;
    }
    let timer: number | null = null;
    const refreshWhenExpired = (): void => {
      const remaining = expiryAt - Date.now();
      if (remaining > 0) {
        timer = window.setTimeout(refreshWhenExpired, Math.min(remaining, MAX_TIMER_DELAY_MS));
        return;
      }
      if (expiryRefreshRef.current === expiryRefreshKey) return;
      void refreshChannelStateRef.current().then(() => {
        expiryRefreshRef.current = expiryRefreshKey;
        setFreshnessTick((current) => current + 1);
      }).catch(() => {
        timer = window.setTimeout(refreshWhenExpired, 30_000);
      });
    };
    timer = window.setTimeout(refreshWhenExpired, Math.min(Math.max(0, expiryAt - Date.now()), MAX_TIMER_DELAY_MS));
    return () => { if (timer !== null) window.clearTimeout(timer); };
  }, [expiryAt, expiryRefreshKey]);

  const toggleHeaderModule = async (): Promise<void> => {
    if (route.kind !== "module") return;
    const targetModuleId = route.moduleId;
    const state = (selectedChannel?.modules ?? modules.data?.modules ?? []).find((module) => module.id === targetModuleId);
    if (state === undefined) return;
    await toggleModuleEnabled(route.channelId, targetModuleId, !state.enabled);
  };

  const selectedChannelIdForModules = selectedChannel?.channelId ?? null;
  const selectedModulesForChannel = selectedChannel?.modules;
  const paletteChannel = route.kind === "channel" || route.kind === "module"
    ? selectedChannel
    : channels.data?.[0] ?? null;
  const paletteChannelIdRef = useRef(paletteChannel?.channelId ?? null);
  useEffect(() => {
    const nextChannelId = paletteChannel?.channelId ?? null;
    if (paletteChannelIdRef.current !== null && nextChannelId !== null && paletteChannelIdRef.current !== nextChannelId) {
      setCommandPaletteOpen(false);
    }
    paletteChannelIdRef.current = nextChannelId;
  }, [paletteChannel?.channelId]);

  // Current workers include module state in GET /api/channels. Keep a
  // compatibility fallback for an older worker response that omits it.
  // Current page loads therefore need one request, including the sidebar.
  const modulesChannelId = (route.kind === "channel" || route.kind === "module") &&
    selectedChannelIdForModules === route.channelId && selectedModulesForChannel === undefined
    ? route.channelId
    : null;
  const modulesQuery = useQuery<PanelModulesResponse>({
    queryKey: queryKeys.channel(modulesChannelId ?? "", "modules"),
    enabled: !authenticationRequired && modulesChannelId !== null,
    refetchOnWindowFocus: false,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === modulesChannelId ? previousData : undefined,
  });
  const modules: LoadState<PanelModulesResponse> = selectedModulesForChannel === undefined
    ? loadStateFromQuery(modulesQuery)
    : {
      status: "success",
      data: { modules: selectedModulesForChannel },
      error: null,
      ...(channels.loadedAt === undefined ? {} : { loadedAt: channels.loadedAt }),
    };

  const overviewForHeader = routeUsesOverview && overview.data !== null && selectedChannel !== null &&
    overview.data.channelId === selectedChannel.channelId
    ? overview.data
    : null;
  const activeHeaderChannel = overviewForHeader ?? selectedChannel ?? undefined;
  const activeHeaderLoadedAt = overviewForHeader === null ? channels.loadedAt : overview.loadedAt;
  const paletteModules = paletteChannel?.modules ?? (
    (route.kind === "channel" || route.kind === "module") && paletteChannel?.channelId === route.channelId
      ? modules.data?.modules ?? []
      : []
  );
  const paletteStreamState = overviewForHeader !== null && overviewForHeader.channelId === paletteChannel?.channelId
    ? overviewForHeader.streamState
    : paletteChannel?.streamState;
  // Same source as the account menu: the fresh overview wins over the cached channel list.
  const paletteControls = overviewForHeader !== null && overviewForHeader.channelId === paletteChannel?.channelId
    ? overviewForHeader.controls
    : paletteChannel?.controls;
  const dashboardMode = dashboardModeForRoute(route);
  const selectPalette = (nextPalette: Palette): void => {
    setPalette(nextPalette);
    writePalette(nextPalette);
  };
  const switchMode = (mode: DashboardMode): void => {
    const channelId = activeHeaderChannel?.channelId ?? channels.data?.[0]?.channelId ?? null;
    navigate(routeForDashboardMode(route, mode, channelId, isPlatform));
  };

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
      clearProtectedState();
    } catch (error) {
      // 401 means: the session is actually gone, the protected state
      // may be cleared. 403 only means the CSRF token didn't match —
      // the worker hasn't revoked anything in that case. Clearing state here would report
      // a sign-out that never happened; after a reload the
      // user is signed in again.
      if (error instanceof PanelApiError && error.status === 401) {
        clearProtectedState();
        return;
      }
      notify({ tone: "error", message: errorMessage(error) });
    } finally {
      setLoggingOut(false);
    }
  };

  const handleBotAccountSwitch = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
      window.location.href = "/auth/login?switch=1&returnTo=%2F";
    } catch (error) {
      if (error instanceof PanelApiError && error.status === 401) {
        window.location.href = "/auth/login?switch=1&returnTo=%2F";
        return;
      }
      notify({ tone: "error", message: errorMessage(error) });
    } finally {
      setLoggingOut(false);
    }
  };

  const updateEventFilters = (filters: PanelEventFilters): void => {
    if (route.kind !== "channel" || route.section !== "events") return;
    const nextRoute: DashboardRoute = {
      kind: "channel",
      channelId: route.channelId,
      section: "events",
      ...(eventFilterIsActive(filters) ? { filters } : {}),
    };
    navigate(nextRoute);
  };
  const eventFilters = route.kind === "channel" && route.section === "events" ? route.filters ?? emptyEventFilter : emptyEventFilter;

  const updateAuditFilters = (filters: PanelAuditFilters): void => {
    if (route.kind !== "channel" || route.section !== "audit") return;
    const nextRoute: DashboardRoute = {
      kind: "channel",
      channelId: route.channelId,
      section: "audit",
      ...(auditFilterIsActive(filters) ? { auditFilters: filters } : {}),
    };
    navigate(nextRoute);
  };
  const auditFilters = route.kind === "channel" && route.section === "audit" ? route.auditFilters ?? emptyAuditFilter : emptyAuditFilter;

  if (authenticationRequired) {
    const texts = dashboardTexts();
    return (
      <UiProvider>
        <main className="auth-screen"><div className="auth-card"><h1>{texts.signIn.required}</h1><p>{texts.signIn.explanation}</p><a className="button" href="/auth/login">{texts.signIn.signInWithTwitch}</a></div></main>
      </UiProvider>
    );
  }

  const sidebarModuleStates = route.kind === "channel" || route.kind === "module"
    ? selectedChannel?.modules ?? modules.data?.modules ?? null
    : null;

  const botSignedIn = installationBot?.status === "connected";
  const isChannelOrModuleRoute = route.kind === "channel" || route.kind === "module";
  // Installation-wide, so it applies wherever page content depends on the
  // bot -- including the overview, the first page everyone lands on (a
  // fresh installation with zero released channels has nowhere else to
  // say it). The system page (bot status + sign-in live there) and the
  // platform page (releases channels) must stay reachable, or the block
  // would also lock the only places that fix it. Overlays and channel
  // variables also remain reachable because their APIs do not depend on the bot.
  const botBlockingApplies = dashboardRouteRequiresBot(route);
  const showBotBlocking = botBlockingApplies && channels.status === "success" && !botSignedIn;
  // Per-user/channel authorization, not an outage -- loses to the bot state
  // above: installation-wide beats per-viewer, and without the bot nothing
  // works on any channel regardless of whether this one is released.
  const showChannelNotReleased = !showBotBlocking && isChannelOrModuleRoute && selectedChannel === null && channels.status === "success";
  const overviewMatchesRoute = isChannelOrModuleRoute &&
    overview.data !== null && overview.data.channelId === route.channelId;
  const overviewModulesLoaded = selectedChannel?.modules !== undefined || overview.data?.modules !== undefined ||
    modules.data !== null || modules.status === "error";
  const overviewPageStatus = overviewMatchesRoute && overviewModulesLoaded
    ? "success"
    : overview.status === "error" ? "error" : "loading";

  return (
    <UiProvider>
        <Shell
          header={(context) => <DashboardHeader route={route} mode={dashboardMode} channels={channels.data ?? []} activeChannel={activeHeaderChannel} loadedAt={activeHeaderLoadedAt} palette={palette} onPaletteChange={selectPalette} onOpenCommandPalette={context.openCommandPalette} onSwitchMode={switchMode} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} onRefreshState={refreshChannelState} />}
          navbar={(context) => <PanelSidebar route={route} channels={channels.data ?? []} platformAdmin={isPlatform} moduleStates={sidebarModuleStates} memberRole={selectedChannel?.role ?? null} onEntryNavigate={context.closeMobileNav} onOpenCommandPalette={context.openCommandPalette} onNavigate={navigate} />}
          navLabel={dashboardTexts().navigation.mainNavigation}
          openSidebarLabel={dashboardTexts().navigation.openSidebar}
          closeSidebarLabel={dashboardTexts().navigation.closeSidebar}
          mode={dashboardMode}
          commandPaletteOpen={commandPaletteOpen}
          onCommandPaletteOpenChange={setCommandPaletteOpen}
          focusKey={dashboardRouteFocusKey(route)}
        >
          <div className="main-content">
        {!showBotBlocking && route.kind === "overview" ? <OverviewPage channelState={channels} onNavigate={navigate} /> : null}
        {route.kind === "platform" && isPlatform ? <PlatformPage onAuthenticationRequired={requestLogin} /> : null}
        {!showBotBlocking && isChannelOrModuleRoute && selectedChannel === null && channels.status !== "success" ? (
          <UiLoadState
            variant="panel-720"
            status={channels.status === "error" ? "error" : "loading"}
            loading={<LoadStateLines rows={8} height={58} />}
            empty={<LoadStateLines rows={8} height={58} />}
            error={<LoadStateLines rows={8} height={58} />}
          >{null}</UiLoadState>
        ) : null}
        {showChannelNotReleased ? <BlockingState
          tone="neutral"
          title={dashboardTexts().blocking.channelTitle}
          description={dashboardTexts().blocking.channelDescription}
          {...(isPlatform
            ? { action: { label: dashboardTexts().blocking.channelAction, onClick: () => { navigate({ kind: "platform" }); } } }
            : { contact: dashboardTexts().blocking.channelContact })}
        /> : null}
        {showBotBlocking ? <BlockingState
          tone="error"
          title={dashboardTexts().blocking.botTitle}
          description={viewerIsBot
            ? dashboardTexts().blocking.botDescriptionBot
            : isPlatform
              ? dashboardTexts().blocking.botDescriptionAdmin(botLogin ?? "")
              : dashboardTexts().blocking.botDescriptionViewer}
          {...(viewerIsBot
            ? { action: { label: dashboardTexts().blocking.botAction, onClick: () => { window.location.href = "/auth/bot/login"; } } }
            : isPlatform
              ? { action: { label: loggingOut ? dashboardTexts().blocking.botSwitching : dashboardTexts().blocking.botSwitchAction, onClick: () => { void handleBotAccountSwitch(); } } }
              : { contact: dashboardTexts().blocking.botContact })}
        /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "overview" && selectedChannel !== null ? <UiLoadState
          variant="panel-960"
          status={overviewPageStatus}
          loading={<LoadStateLines rows={12} height={58} />}
          empty={<LoadStateLines rows={12} height={58} />}
          error={<LoadStateLines rows={12} height={58} />}
        >{overviewMatchesRoute && overview.data !== null && overviewModulesLoaded ? <ChannelOverviewRoute
          key={routeKey}
          overview={overview.data}
          modules={selectedChannel.modules ?? overview.data.modules ?? modules.data?.modules ?? []}
          modulesLoaded={overviewModulesLoaded}
          onNavigate={navigate}
        /> : null}</UiLoadState> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "location-weather" && selectedChannel !== null
          ? <ChannelLocationPage key={route.channelId} channelId={route.channelId} role={selectedChannel.role} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "members" && selectedChannel !== null ? <MembersPage key={route.channelId} channelId={route.channelId} ownRole={selectedChannel.role} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "variables" && selectedChannel !== null ? <ChannelVariablesPage key={route.channelId} channelId={route.channelId} canManage={canManage(selectedChannel.role)} onOpenCommand={(name) => { setPendingModuleSelection({ channelId: route.channelId, moduleId: "text_commands", value: name }); navigate({ kind: "module", channelId: route.channelId, moduleId: "text_commands" }); }} onOpenOverlay={(overlayId, initialVariable, initialOverlayName) => { navigate({ kind: "channel", channelId: route.channelId, section: "overlays", editorOverlayId: overlayId, ...(initialVariable === undefined ? {} : { initialVariable }), ...(overlayId === "new" && initialOverlayName !== undefined ? { initialOverlayName } : {}) }); }} onInitialSelectionConsumed={(name) => { setPendingVariableSelection((pending) => pending?.channelId === route.channelId && pending.name === name ? null : pending); }} {...(pendingVariableSelection?.channelId === route.channelId ? { initialSelection: pendingVariableSelection.name } : {})} /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "overlays" && selectedChannel !== null
          ? route.editorOverlayId === undefined
            ? <OverlaysPage key={dashboardRoutePath(route)} channelId={route.channelId} canManage={canManage(selectedChannel.role)} onOpenEditor={(overlayId) => { navigate({ kind: "channel", channelId: route.channelId, section: "overlays", editorOverlayId: overlayId }); }} {...(route.overlayId === undefined ? {} : { initialSelection: route.overlayId })} />
            : <OverlayEditorPage key={dashboardRoutePath(route)} channelId={route.channelId} overlayId={route.editorOverlayId} canManage={canManage(selectedChannel.role)} language={selectedChannel.language} {...(route.initialVariable === undefined ? {} : { initialVariable: route.initialVariable })} {...(route.initialOverlayName === undefined ? {} : { initialOverlayName: route.initialOverlayName })} onBack={() => { navigate({ kind: "channel", channelId: route.channelId, section: "overlays" }); }} onOverlayCreated={(overlayId) => {
              const path = dashboardRoutePath({ kind: "channel", channelId: route.channelId, section: "overlays", editorOverlayId: overlayId });
              window.history.replaceState(window.history.state, "", path);
            }} />
          : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "modules" && selectedChannel !== null ? <ModuleWorkspace channelId={route.channelId} ownRole={selectedChannel.role} modules={selectedChannel.modules ?? modules.data?.modules ?? []} loading={modules.status === "loading"} error={modules.error} onNavigate={navigate} onChanged={() => reloadAfterModuleToggle(route.channelId)} /> : null}
        {route.kind === "module" ? <div className="module-route-layout">
          <Suspense fallback={<div className="module-view-fallback" aria-hidden="true"><LoadStateLines rows={3} height={58} /></div>}>
            {!showChannelNotReleased && !showBotBlocking && selectedChannel !== null ? <UiLoadState
              variant="panel-720"
              reserveHeight="calc(100dvh - var(--app-shell-header-height) - var(--dashboard-main-gutters))"
              status={overviewPageStatus}
              loading={<LoadStateLines rows={8} height={58} />}
              empty={<LoadStateLines rows={8} height={58} />}
              error={<LoadStateLines rows={8} height={58} />}
            >{overviewMatchesRoute && overview.data !== null ? <ModulePage channelId={route.channelId} moduleId={route.moduleId} ownRole={selectedChannel.role} modules={selectedChannel.modules ?? modules.data?.modules ?? overview.data.modules ?? []} activeModules={overview.data.activeModules} streamSessionIdentity={JSON.stringify([overview.data.streamState ?? null, overview.data.streamStartedAt ?? null, overview.data.streamStateChangedAt ?? null])} loading={overview.status === "loading" || modules.status === "loading"} error={overview.error ?? modules.error} busy={headerModuleBusy} botIsModerator={overview.data.moderator?.isModerator ?? null} onNavigate={navigate} onToggle={() => { void toggleHeaderModule(); }} suspendPanelUntilReady {...(pendingModuleSelection?.channelId === route.channelId && pendingModuleSelection.moduleId === route.moduleId ? { initialSelection: pendingModuleSelection.value } : {})} /> : null}</UiLoadState> : null}
          </Suspense>
        </div> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "system" && selectedChannel !== null ? <SystemPage
          key={route.channelId}
          channelId={route.channelId}
          login={selectedChannel.login}
          role={selectedChannel.role}
          channelBotConsent={selectedChannel.channelBotConsent}
          viewerUserId={viewerUserId}
          moderator={selectedChannel.moderator}
          system={systemQuery.data}
          error={systemQuery.isError ? errorMessage(systemQuery.error) : null}
          loadedAt={systemQuery.dataUpdatedAt > 0 ? systemQuery.dataUpdatedAt : undefined}
          onRetry={() => { void systemQuery.refetch(); }}
          onModeratorRecheck={(isCurrentPage) => recheckModerator(route.channelId, isCurrentPage)}
        /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "audit" && selectedChannel !== null ? <AuditPage key={route.channelId} channelId={route.channelId} filters={auditFilters} onFiltersChange={updateAuditFilters} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "events" && selectedChannel !== null ? <EventsPage key={route.channelId} channelId={route.channelId} filters={eventFilters} moduleOptions={selectedChannel.modules ?? modules.data?.modules ?? []} onFiltersChange={updateEventFilters} /> : null}
        <ChannelCommandPalette
          key={`command-palette-${paletteChannel?.channelId ?? "none"}`}
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          channelId={paletteChannel?.channelId ?? null}
          ownRole={paletteChannel?.role ?? null}
          viewerUserId={viewerUserId}
          route={route}
          isPlatformAdmin={isPlatform}
          {...(channels.status === "success" ? { botSignedIn } : {})}
          streamState={paletteStreamState}
          {...(paletteControls === undefined ? {} : { channelControls: paletteControls })}
          onRefreshChannelState={refreshChannelState}
          onToggleModule={toggleModuleEnabled}
          modules={paletteModules}
          onNavigate={navigate}
          onOpenCommand={(name) => {
            if (paletteChannel !== null) setPendingModuleSelection({ channelId: paletteChannel.channelId, moduleId: "text_commands", value: name });
          }}
          onOpenVariable={(channelId, name) => { setPendingVariableSelection({ channelId, name }); }}
        />
          </div>
        </Shell>
    </UiProvider>
  );
};

const DashboardRoot = (): ReactElement => (
  <DashboardDataProvider onAuthenticationRequired={dispatchDashboardAuthenticationRequired}>
    <DashboardApp />
  </DashboardDataProvider>
);

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <DashboardRoot />
    </StrictMode>,
  );
}

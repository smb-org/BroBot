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
  PanelLastError,
  PanelModeratorStatus,
  PanelModuleState,
  PanelModulesResponse,
  PanelSystemResponse,
  PanelTokenStatus,
} from "../panel-contract";
import {
  fetchChannelOverview,
  fetchChannelSettings,
  fetchChannels,
  logout,
  PanelApiError,
  refreshModeratorStatus,
  setChannelControl,
  saveChannelTimeZone,
  setChannelModuleEnabled,
  type PanelChannelSettings,
} from "./api";
import { Led, ModuleCount, ModuleHeading, ModuleIcon, ModulePage, ModuleTile, ModuleWorkspace, NavigationIcon, StateRow, type LedStatus, type StateTone } from "./module-panels";
import { preloadModulePanel } from "./module-panel-loaders";
import { BroadcasterConsentAction, ChannelNotices, ImmediateActions, ModeratorCheckAction, WarningsAndErrorsFeed } from "./stream-manager";
import { refreshAfterModuleToggle } from "./data/module-toggle";
import { useSystemQuery } from "./data/lists";
import { ChannelSpotlight } from "./spotlight";
import { MembersPage } from "./members";
import { PlatformPage } from "./platform";
import { channelPanelTexts, roleLabel } from "./labels";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatTimestamp as formatTimestampBase, formatNumber, maintenanceReasonText } from "./locale";
import { CHANNEL_CONTROL_DURATIONS, canManage, type ChannelControlDuration, type ChannelRole } from "../contracts/values";
import { MODULES } from "../modules/registry";
import { eventSubName, moduleName, statusWord } from "./module-labels";
import { dashboardRoutePath, dashboardRouteRequiresBot, replaceDashboardRoute, useDashboardRoute, type DashboardRoute } from "./router";
import { dashboardNavEntries, enabledModuleNavigationGroups, moduleCategoryHeading, navPageGroupHeading, visibleModuleNavigationIds } from "./nav-pages";
import { truncateTo200Chars } from "../text";
import { BlockingState, Button, ChannelLocationMenu, ControlDurationDialog, EmptyCellValue, Icon, InspectorSection, ListDetail, LoadState as UiLoadState, notify, Select as UiSelect, Shell, Sidebar, Skeleton, SubInspector, UiProvider, useInspectorSelection, type SidebarEntry, type SidebarGroup } from "./ui";
import { EventsPage } from "./events/EventsPage";
import { emptyEventFilter, eventFilterIsActive } from "./events/model";
import { AuditPage } from "./audit/AuditPage";
import { ChannelVariablesPage } from "./ChannelVariablesPage";
import { OverlaysPage } from "./OverlaysPage";
import { OverlayEditorPage } from "./OverlayEditorPage";
import { emptyAuditFilter, auditFilterIsActive } from "./audit/model";
import { useRealtimePanelMessages } from "./realtime";
import { useDashboardRealtimeStatus } from "./data/realtime";
import { channelSettingsTexts } from "./channel-settings-locale";
import { ChannelTimeZoneField } from "./ChannelTimeZoneField";
import { ChannelLocationField } from "./ChannelLocationField";
import { botPermissionsAreMissing, broadcasterPermissionsAreMissing, moderatorIsMissing, parseDashboardDate, tokenHealth } from "./channel-health";
import { loadingState, type LoadState } from "./load-state";
import { queryKeys } from "./data/keys";
import { dashboardAuthenticationRequiredEvent, dispatchDashboardAuthenticationRequired } from "./data/events";
import { DashboardDataProvider } from "./data/provider";
import "./styles.css";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ModeratorCheckState {
  status: "idle" | "loading" | "error";
  error: string | null;
  nextAllowedAt: string | null;
}

const idleModeratorCheck = (): ModeratorCheckState => ({
  status: "idle",
  error: null,
  nextAllowedAt: null,
});

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

const channelToneToLedStatus = (tone: StateTone): LedStatus =>
  tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off";

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

const nextAllowedAtFromError = (error: unknown): string | null => {
  if (!(error instanceof PanelApiError) || error.details === null || typeof error.details !== "object" || Array.isArray(error.details)) return null;
  const nextAllowedAt = (error.details as Record<string, unknown>).nextAllowedAt;
  return typeof nextAllowedAt === "string" ? nextAllowedAt : null;
};

const moderatorLastError = (moderator: PanelModeratorStatus): PanelLastError | null =>
  moderator.reason === null
    ? null
    : { source: "moderator", reason: moderator.reason, at: moderator.checkedAt };

const mergeModeratorStatus = <T extends { moderator: PanelModeratorStatus | null; lastError: PanelLastError | null }>(
  current: T,
  moderator: PanelModeratorStatus,
): T => ({
  ...current,
  moderator,
  lastError: current.lastError?.source === "moderator" ? moderatorLastError(moderator) : current.lastError,
});

const mergeChannelSettings = (
  current: PanelChannelSettings | undefined,
  incoming: PanelChannelSettings,
): PanelChannelSettings => ({
  timeZone: current !== undefined && current.revision > incoming.revision ? current.timeZone : incoming.timeZone,
  revision: Math.max(current?.revision ?? -1, incoming.revision),
  location: current !== undefined && current.locationRevision > incoming.locationRevision ? current.location : incoming.location,
  locationRevision: Math.max(current?.locationRevision ?? -1, incoming.locationRevision),
});

const formatTimestamp = (value: string): string => formatTimestampBase(value);

interface PanelSidebarProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  platformAdmin: boolean;
  moduleStates: PanelModuleState[] | null;
  memberRole: ChannelRole | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onEntryNavigate: () => void;
  onNavigate: (route: DashboardRoute) => void;
}

/**
 * "Seitenleiste" (docs/input/DESIGN-neu.md): four groups, built from the
 * seam's `Sidebar`. Replaces `Rail` and the breadcrumb switchers.
 */
const PanelSidebar = ({ route, channels, platformAdmin: platform, moduleStates, memberRole, collapsed, onToggleCollapsed, onEntryNavigate, onNavigate }: PanelSidebarProperties): ReactElement => {
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

  const pages = dashboardNavEntries({ isPlatformAdmin: platform }, navigationChannelId, texts);
  const pageEntry = (page: (typeof pages)[number]): SidebarEntry => {
    const entryRoute = page.route;
    return {
      id: page.id,
      pageId: page.id,
      label: page.label,
      icon: <NavigationIcon kind={page.iconKind} className="sidebar-nav-icon" />,
      href: dashboardRoutePath(entryRoute),
      active: dashboardRoutePath(entryRoute) === dashboardRoutePath(route),
      onNavigate: () => { onNavigate(entryRoute); },
    };
  };
  const platformPage = pages.find((page) => page.group === "platform");

  const sidebarPageOrder = ["overview", "overlays", "audit", "system", "members", "variables", "events", "modules"];
  const sidebarChannelPages = sidebarPageOrder.flatMap((id) => {
    const page = pages.find((candidate) => candidate.id === id);
    if (page === undefined) return [];
    const entry = pageEntry(page);
    return [id === "modules" ? { ...entry, label: texts.navigation.manageModules } : entry];
  });
  const channelGroup: SidebarGroup = {
    id: "channel",
    heading: navPageGroupHeading("channel", texts),
    entries: sidebarChannelPages,
  };

  const moduleGroups: SidebarGroup[] = enabledModuleNavigationGroups(
    MODULES,
    moduleStates ?? [],
    memberRole,
    navigationChannelId,
    dashboardLanguage(),
    (moduleId) => moduleName(moduleId),
  ).map(({ category, entries }) => ({
    id: `modules-${category}`,
    heading: moduleCategoryHeading(category, texts),
    nestedEntries: true,
    entries: entries.map((entry): SidebarEntry => ({
      id: entry.id,
      label: entry.label,
      icon: entry.iconKind === null
        ? <ModuleIcon moduleId={entry.moduleId} className="sidebar-nav-icon" />
        : <NavigationIcon kind={entry.iconKind} className="sidebar-nav-icon" />,
      href: dashboardRoutePath(entry.route),
      active: route.kind === "module" && route.moduleId === entry.moduleId,
      onNavigate: () => { onNavigate(entry.route); },
      onPreload: () => { void preloadModulePanel(entry.moduleId).catch(() => undefined); },
      led: { status: "green" as const, word: statusWord(true) },
    })),
  }));
  const platformGroup: SidebarGroup | undefined = platformPage === undefined ? undefined : {
    id: "platform",
    heading: navPageGroupHeading("platform", texts),
    entries: [pageEntry(platformPage)],
  };

  return (
    <Sidebar
      groups={[channelGroup, ...moduleGroups, ...(platformGroup === undefined ? [] : [platformGroup])]}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      onEntryNavigate={onEntryNavigate}
      collapseLabel={texts.navigation.collapseSidebar}
      expandLabel={texts.navigation.expandSidebar}
      spotlightLabel={texts.spotlight.placeholder}
    />
  );
};

interface DashboardHeaderProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  activeChannel: PanelChannelState | undefined;
  loadedAt: number | undefined;
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

const ChannelControlStatus = ({ control, kind }: {
  control: PanelChannelControl;
  kind: "mute" | "pause";
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
  const timed = control.active && control.mode === "timed" && control.until !== null && Date.parse(control.until) > now;
  return <span className="dashboard-header__control-state-slot">
    {configured && label !== null ? <span className="dashboard-header__control-state" title={label}>{timed ? <Icon name="clock-hour-4" size={16} /> : null}<span>{label}</span></span> : null}
  </span>;
};

const ChannelControlActions = ({ channelId, controls, onRefresh }: {
  channelId: string;
  controls: PanelChannelControls | undefined;
  onRefresh: () => Promise<void>;
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
    if (busy !== null) return;
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

  return (
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
    </div>
  );
};

/**
 * "Kopfleiste" (docs/input/DESIGN-neu.md): brand, channel `Select` up to
 * 280px with the Twitch id, connection LED, life-sign, and sign-out.
 *
 * The channel `Select`'s options carry the Twitch id as plain text next to
 * the name rather than in a monospace secondary line: `ui/Select` only
 * renders a flat label per option, and extending it for a two-line,
 * icon-plus-LED option render is a separate, larger seam change.
 * ponytail: functional parity (the id stays visible and searchable), not
 * pixel parity. Upgrade path: a richer `SelectOption` shape in `ui/Select`
 * if the plain label stops being legible enough.
 */
const DashboardConnectionClock = ({ channel, loadedAt }: {
  channel: PanelChannelState;
  loadedAt?: number;
}): ReactElement => {
  const texts = dashboardTexts();
  const now = useSecondClock();
  const tone = channelStatus(channel, loadedAt, now);
  const label = tone === "healthy" ? texts.header.connectionRunning : statusText(channel, loadedAt, now);
  const status = tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off";
  return <span className="led" data-status={status}><span className="led__dot" aria-hidden="true" /><span>{label}</span></span>;
};

const DashboardStreamClock = ({ channel }: { channel: PanelChannelState }): ReactElement => {
  const texts = dashboardTexts();
  const now = useSecondClock();
  const streamState = channel.streamState;
  const streamLabel = streamState === "online"
    ? texts.header.streamLive(streamDuration(channel.streamStartedAt, now))
    : streamState === "offline" ? texts.header.streamOffline : texts.header.streamUnknown;
  return <span className="dashboard-header__stream" data-state={streamState === "online" ? "live" : streamState === "offline" ? "offline" : "unknown"}>
    <Icon name={streamState === "online" ? "broadcast" : "broadcast-off"} size={20} />
    <span>{streamLabel}</span>
    {channel.streamStateCheckedAt === undefined || channel.streamStateCheckedAt === null ||
        !Number.isFinite(Date.parse(channel.streamStateCheckedAt)) ? null : (
      <DataAge since={Date.parse(channel.streamStateCheckedAt)} format={texts.header.streamChecked} className="dashboard-header__stream-age" />
    )}
  </span>;
};

const DashboardHeader = ({ route, channels, activeChannel, loadedAt, onNavigate, onLogout, loggingOut, onRefreshState }: DashboardHeaderProperties): ReactElement => {
  const texts = dashboardTexts();
  return (
    <div className="dashboard-header">
      <a className="brand-mark dashboard-header__brand" href="/" aria-current={route.kind === "overview" ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate({ kind: "overview" }); }}><span className="brand-mark__dot" /><span className="brand-mark__word">BroBot</span></a>
      {activeChannel === undefined ? null : (
      <div className="dashboard-header__channel">
        <div className="dashboard-header__channel-select"><UiSelect
            compact
            value={activeChannel.channelId}
            onChange={(channelId) => { if (channelId !== null) onNavigate({ kind: "channel", channelId, section: "overview" }); }}
            options={channels.map((channel) => ({ value: channel.channelId, label: `${channel.displayName} — ${channel.channelId}` }))}
            ariaLabel={texts.navigation.selectChannel}
            id="dashboard-channel-select"
          /></div>
        {activeChannel.location == null ? null : <ChannelLocationMenu location={activeChannel.location} messages={texts.header.locationMenu} />}
        </div>
      )}
      <div className="dashboard-header__status">
        {activeChannel === undefined ? null : <DashboardStreamClock channel={activeChannel} />}
        {activeChannel === undefined ? null : <DashboardConnectionClock channel={activeChannel} {...(loadedAt === undefined ? {} : { loadedAt })} />}
        {loadedAt === undefined ? null : <DataAge since={loadedAt} />}
      </div>
      {activeChannel === undefined ? null : <ChannelControlActions channelId={activeChannel.channelId} controls={activeChannel.controls} onRefresh={onRefreshState} />}
      <button className="button button--quiet dashboard-header__logout" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? texts.navigation.signingOut : texts.navigation.signOut}</button>
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
        loading={<Skeleton rows={3} height={132} />}
        empty={<section className="empty-state"><h2>{texts.overview.noChannelAvailable}</h2><p>{texts.overview.noMembership}</p></section>}
        error={<Skeleton rows={3} height={132} />}
      >
        <div className="module-grid">
          {channels.map((channel) => (
            <ModuleTile
              key={channel.channelId}
              channelId={channel.channelId}
              moduleId={channel.channelId}
              enabled={channelStatus(channel, channelState.loadedAt) === "healthy"}
              name={channel.displayName}
              ledStatus={channelToneToLedStatus(channelStatus(channel, channelState.loadedAt))}
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

const ChannelBotConsentAction = ({ channelId, needed, canRequest }: {
  channelId: string;
  needed: boolean;
  canRequest: boolean;
}): ReactElement | null => {
  if (!needed) return null;
  const texts = dashboardTexts();
  return (
    <div className="header-action">
      {canRequest ? <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/channel-bot`}>{texts.moderation.requestBroadcasterConsent}</a> : <button className="button" type="button" disabled>{texts.moderation.requestBroadcasterConsent}</button>}
      <div className="header-action__reason-slot">{!canRequest ? <span className="lock-reason">{texts.moderation.broadcasterReauthorize}</span> : null}</div>
    </div>
  );
};

const toneRank: Record<StateTone, number> = { error: 0, warning: 1, neutral: 2, healthy: 3 };

interface StatusEntry {
  key: string;
  tone: StateTone;
  node: ReactElement;
}

const sortBySeverity = (entries: StatusEntry[]): StatusEntry[] =>
  [...entries].sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);

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
      label={texts.fullConsentMissing}
      tone="warning"
      word={texts.fullConsentMissing}
      detail={texts.fullConsentLocked}
      action={login === undefined ? undefined : <BroadcasterConsentAction login={login} needed canRequest={canRequest} />}
    />,
  };
};

const tokenRow = (tokens: PanelTokenStatus, bot: PanelBotStatus | null, loadedAt?: number): StatusEntry => {
  const texts = dashboardTexts();
  const token = tokenHealth(tokens, bot, loadedAt);
  return { key: "token", tone: token.tone, node: <StateRow label={texts.statusCard.tokenStatus} tone={token.tone} word={token.label} detail={maintenanceReasonText(tokens.loginReason) ?? undefined} /> };
};

const channelBotConsentRow = (status: PanelChannelState["channelBotConsent"], channelId: string, canRequest: boolean): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = status === "missing" ? "warning" : "healthy";
  return { key: "channel-bot-consent", tone, node: <StateRow
    label={texts.statusCard.chatConsent}
    tone={tone}
    word={status === "missing" ? texts.statusCard.broadcasterConsentMissing : texts.status.present}
    detail={status === "missing" ? texts.statusCard.chatBotRequired : undefined}
    action={status === "missing" ? <ChannelBotConsentAction channelId={channelId} needed canRequest={canRequest} /> : undefined}
  /> };
};

const moderatorRow = (moderator: PanelModeratorStatus | null, overview: PanelChannelOverview, check: ModeratorCheckState, onCheck: () => void): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = moderator === null ? "neutral" : moderatorIsMissing(moderator) ? "error" : "healthy";
  const word = moderator === null ? texts.status.notChecked : moderator.isModerator ? texts.status.moderator : texts.status.moderatorRoleMissing;
  const detail = moderator === null
    ? texts.moderation.noCheckForChannel
    : maintenanceReasonText(moderator.reason) ?? texts.moderation.lastCheck(formatTimestamp(moderator.checkedAt));
  return { key: "moderator", tone, node: <StateRow
    label={texts.statusCard.moderatorStatus}
    tone={tone}
    word={word}
    detail={detail}
    action={<ModeratorCheckAction canCheck={canManage(overview.role)} checking={check.status === "loading"} checkError={check.error} nextAllowedAt={check.nextAllowedAt} urgent={moderator === null || !moderator.isModerator} onCheck={onCheck} />}
  /> };
};

const lastErrorRow = (error: PanelLastError | null): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = error === null ? "healthy" : "error";
  if (error === null) {
    return { key: "error", tone, node: <StateRow label={texts.errors.last} tone={tone} word={texts.status.healthy} detail={texts.errors.noCause} /> };
  }
  const aboName = error.source === "eventsub" && error.subscriptionType !== undefined
    ? eventSubName(error.subscriptionType, error.subscriptionVariant ?? "")
    : null;
  const reasonText = maintenanceReasonText(error.reason) ?? error.reason;
  const reason = aboName === null ? reasonText : `${aboName}: ${reasonText}`;
  const detail = [
    reason,
    error.message === null || error.message === undefined ? null : truncateTo200Chars(error.message),
    error.status === null || error.status === undefined ? null : `HTTP ${String(error.status)}`,
    formatTimestamp(error.at),
  ].filter((part): part is string => part !== null).join(" · ");
  return { key: "fehler", tone, node: <StateRow label={texts.errors.last} tone={tone} word={texts.status.error} detail={detail} /> };
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
                <td><Led status={channelToneToLedStatus(tone)} label={subscriptionStatusLabel(subscription.status, subscription.reason)} /></td>
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

interface ChannelOverviewPageProperties {
  overview: PanelChannelOverview;
  loadedAt?: number | undefined;
  moderatorCheck: ModeratorCheckState;
  onCheckModeratorStatus: () => void;
  onNavigate: (route: DashboardRoute) => void;
  /** Stream Manager: every module, switchable without a page change. */
  modules: PanelModuleState[];
  modulesLoaded: boolean;
  onLocationChanged: (channelId: string, location: NonNullable<PanelChannelOverview["location"]> | null) => void;
}

const ChannelStateChecks = ({ entries, children }: { entries: StatusEntry[]; children?: ReactNode }): ReactElement => {
  const texts = dashboardTexts();
  const allHealthy = entries.length > 0 && entries.every((entry) => entry.tone === "healthy");
  const problemCount = entries.filter((entry) => entry.tone !== "healthy").length;
  const summaryTone: LedStatus = allHealthy
    ? "green"
    : entries.some((entry) => entry.tone === "error") ? "red" : "amber";
  const summary = allHealthy
    ? texts.streamManager.checksHealthy(formatNumber(entries.length))
    : texts.streamManager.checksNeedAttention(formatNumber(problemCount), formatNumber(entries.length));

  return (
    <details className="channel-state-checks" open={!allHealthy}>
      <summary className="channel-state-checks__summary">
        <Led status={summaryTone} label={summary} />
      </summary>
      <div className="state-list">{entries.map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
      {children}
    </details>
  );
};

const ChannelOverviewPage = ({ overview, loadedAt, moderatorCheck, onCheckModeratorStatus, onNavigate, modules, modulesLoaded, onLocationChanged }: ChannelOverviewPageProperties): ReactElement => {
  const settingsTexts = channelSettingsTexts(dashboardLanguage());
  const queryClient = useQueryClient();
  const settingsQueryKey = queryKeys.channel(overview.channelId, "settings");
  const channelSettingsQuery = useQuery<PanelChannelSettings>({
    queryKey: settingsQueryKey,
    queryFn: async ({ signal }) => {
      const fetched = await fetchChannelSettings(overview.channelId, signal);
      return mergeChannelSettings(queryClient.getQueryData<PanelChannelSettings>(settingsQueryKey), fetched);
    },
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === overview.channelId ? previousData : undefined,
  });
  const channelSettings = channelSettingsQuery.data ?? null;
  const [timeZoneDraftState, setTimeZoneDraftState] = useState<{ channelId: string; revision: number; value: string } | null>(null);
  const timeZoneDraft = channelSettings === null
    ? ""
    : timeZoneDraftState?.channelId === overview.channelId && timeZoneDraftState.revision === channelSettings.revision
      ? timeZoneDraftState.value
      : channelSettings.timeZone;
  const [settingsBusy, setSettingsBusy] = useState(false);
  const commitSettingsUpdate = async (update: Partial<PanelChannelSettings>): Promise<void> => {
    await queryClient.cancelQueries({ queryKey: settingsQueryKey, exact: true });
    queryClient.setQueryData<PanelChannelSettings>(settingsQueryKey, (current) => current === undefined
      ? current
      : mergeChannelSettings(current, { ...current, ...update }));
  };
  useEffect(() => {
    if (channelSettingsQuery.error !== null) notify({ tone: "error", message: settingsTexts.loadError });
  }, [channelSettingsQuery.error, settingsTexts.loadError]);
  const changeTimeZoneDraft = (value: string): void => {
    if (channelSettings === null) return;
    setTimeZoneDraftState({ channelId: overview.channelId, revision: channelSettings.revision, value });
  };
  const saveTimeZone = async (): Promise<void> => {
    if (channelSettings === null || timeZoneDraft.trim().length === 0 || !canManage(overview.role)) {
      notify({ tone: "error", message: settingsTexts.invalid });
      return;
    }
    setSettingsBusy(true);
    try {
      const saved = await saveChannelTimeZone(overview.channelId, channelSettings.revision, timeZoneDraft.trim());
      await commitSettingsUpdate({ timeZone: saved.timeZone, revision: saved.revision });
      setTimeZoneDraftState({ channelId: overview.channelId, revision: saved.revision, value: saved.timeZone });
    } catch {
      notify({ tone: "error", message: settingsTexts.saveError });
    } finally {
      setSettingsBusy(false);
    }
  };
  const saveSuggestedTimeZone = async (timeZone: string): Promise<void> => {
    if (channelSettings === null) throw new Error("Channel settings are still loading.");
    setSettingsBusy(true);
    try {
      const saved = await saveChannelTimeZone(overview.channelId, channelSettings.revision, timeZone);
      await commitSettingsUpdate({ timeZone: saved.timeZone, revision: saved.revision });
      setTimeZoneDraftState({ channelId: overview.channelId, revision: saved.revision, value: saved.timeZone });
    } finally {
      setSettingsBusy(false);
    }
  };
  const locationSaved = async (location: PanelChannelSettings["location"], revision: number): Promise<void> => {
    await commitSettingsUpdate({ location, locationRevision: revision });
    onLocationChanged(overview.channelId, location);
  };
  const entries = sortBySeverity([
    broadcasterRow(overview.broadcasterConnection),
    channelBotConsentRow(overview.channelBotConsent, overview.channelId, overview.role === "broadcaster"),
    chatRow(overview.chatSubscription, overview.chatSubscriptionNeeded === true),
    moderatorRow(overview.moderator, overview, moderatorCheck, onCheckModeratorStatus),
    botRow(overview.bot),
    botPermissionsRow(overview.botPermissions),
    broadcasterPermissionsRow(overview.broadcasterPermissions, overview.login, overview.role === "broadcaster"),
    tokenRow(overview.tokens, overview.bot, loadedAt),
    lastErrorRow(overview.lastError),
  ].filter((entry): entry is StatusEntry => entry !== null));

  return (
    <>
      <ChannelNotices
        channel={overview}
        modules={modules}
        modulesLoaded={modulesLoaded}
        {...(loadedAt === undefined ? {} : { loadedAt })}
        moderatorCheck={moderatorCheck}
        onCheckModeratorStatus={onCheckModeratorStatus}
        onNavigate={onNavigate}
      />
      <ModuleHeading
        kind="channel"
        title={overview.displayName}
        subtitle={roleLabel(overview.role)}
      />
      <section className="content-section channel-overview-settings" aria-label={settingsTexts.section}>
        <div className="section-heading"><h2>{settingsTexts.section}</h2></div>
        <div className="form-actions">
          <ChannelTimeZoneField
            label={settingsTexts.timeZone}
            hint={settingsTexts.timeZoneHint}
            value={timeZoneDraft}
            onChange={changeTimeZoneDraft}
            disabled={settingsBusy || channelSettings === null}
            canEdit={canManage(overview.role)}
          />
          {canManage(overview.role)
            ? <Button disabled={settingsBusy || channelSettings === null || timeZoneDraft === channelSettings.timeZone || timeZoneDraft.trim().length === 0} onClick={() => { void saveTimeZone(); }}>{settingsTexts.save}</Button>
            : <p className="muted">{settingsTexts.readOnly}</p>}
        </div>
        <ChannelLocationField
          channelId={overview.channelId}
          language={dashboardLanguage()}
          value={channelSettings?.location ?? null}
          revision={channelSettings?.locationRevision ?? 0}
          onSaved={locationSaved}
          channelTimeZone={channelSettings?.timeZone ?? ""}
          onSaveChannelTimeZone={saveSuggestedTimeZone}
          canEdit={canManage(overview.role)}
          disabled={settingsBusy || channelSettings === null}
        />
      </section>
      <ImmediateActions channelId={overview.channelId} streamState={overview.streamState} canManage={canManage(overview.role)} modules={modules} modulesLoaded={modulesLoaded} />
      <WarningsAndErrorsFeed channelId={overview.channelId} onNavigate={onNavigate} />
      <ChannelStateChecks entries={entries}>
        <BotPermissionsInspector permissions={overview.botPermissions} />
        <BroadcasterPermissionsInspector permissions={overview.broadcasterPermissions} />
      </ChannelStateChecks>
    </>
  );
};

interface ChannelOverviewRouteProperties {
  routeKey: string;
  overview: PanelChannelOverview;
  loadedAt?: number | undefined;
  onNavigate: (route: DashboardRoute) => void;
  modules: PanelModuleState[];
  modulesLoaded: boolean;
  channelsLoadedAt: number;
  onAuthenticationRequired: () => void;
  onLocationChanged: (channelId: string, location: NonNullable<PanelChannelOverview["location"]> | null) => void;
}

const ChannelOverviewRoute = ({ routeKey, overview, loadedAt, onNavigate, modules, modulesLoaded, channelsLoadedAt, onAuthenticationRequired, onLocationChanged }: ChannelOverviewRouteProperties): ReactElement => {
  const queryClient = useQueryClient();
  const [moderatorCheck, setModeratorCheck] = useState<ModeratorCheckState>(idleModeratorCheck);
  const generationRef = useRef(0);
  useLayoutEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [routeKey]);

  const handleModeratorStatusCheck = async (): Promise<void> => {
    const channelId = overview.channelId;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "overview" });
    const generation = generationRef.current;
    setModeratorCheck({ status: "loading", error: null, nextAllowedAt: null });
    try {
      const response = await refreshModeratorStatus(channelId);
      if (generationRef.current !== generation || window.location.pathname !== routePath) return;
      queryClient.setQueryData<PanelChannelOverview>(queryKeys.channel(channelId, "overview"), (current) =>
        current?.channelId !== channelId ? current : mergeModeratorStatus(current, response.moderator),
      { ...(loadedAt === undefined ? {} : { updatedAt: loadedAt }) });
      queryClient.setQueryData<PanelChannelsResponse>(queryKeys.channels(), (current) => current === undefined ? current : {
        ...current,
        channels: current.channels.map((channel) => channel.channelId !== channelId ? channel : mergeModeratorStatus(channel, response.moderator)),
      }, { updatedAt: channelsLoadedAt });
      setModeratorCheck({ status: "idle", error: null, nextAllowedAt: response.nextAllowedAt });
    } catch (error: unknown) {
      if (generationRef.current !== generation || window.location.pathname !== routePath) return;
      setModeratorCheck({ status: "error", error: errorMessage(error), nextAllowedAt: nextAllowedAtFromError(error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    }
  };

  return <ChannelOverviewPage
    overview={overview}
    loadedAt={loadedAt}
    moderatorCheck={moderatorCheck}
    onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }}
    onNavigate={onNavigate}
    modules={modules}
    modulesLoaded={modulesLoaded}
    onLocationChanged={onLocationChanged}
  />;
};

interface SystemPageProperties {
  system: PanelSystemResponse | undefined;
  error: string | null;
  loadedAt: number | undefined;
  onRetry: () => void;
}

const SystemPage = ({ system, error, loadedAt, onRetry }: SystemPageProperties): ReactElement => {
  const texts = dashboardTexts();
  return (
    <>
      <ModuleHeading kind="system" title={texts.system.title} subtitle={texts.system.readOnly} />
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
        loading={<Skeleton rows={8} height={58} />}
        empty={<Skeleton rows={8} height={58} />}
        error={<p role="alert">{error ?? texts.system.loadState}</p>}
        queryError={{ title: texts.errors.dataLoadFailed, message: error ?? texts.system.loadState, onRetry }}
      >
        {system === undefined ? null : <>
          <div className="state-list">{[broadcasterRow(system.broadcasterConnection), chatRow(system.chatSubscription, system.chatSubscriptionNeeded === true), botRow(system.bot), botPermissionsRow(system.botPermissions), broadcasterPermissionsRow(system.broadcasterPermissions), tokenRow(system.tokens, system.bot, loadedAt)].filter((entry): entry is StatusEntry => entry !== null).map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
          <BotPermissionsInspector permissions={system.botPermissions} />
          <BroadcasterPermissionsInspector permissions={system.broadcasterPermissions} />
          <SubscriptionsSection subscriptions={system.subscriptions ?? []} />
          <SystemProperties system={system} />
        </>}
      </UiLoadState>
    </>
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
  const headerModuleBusy = route.kind === "module" && headerModuleBusyKeys.has(`${route.channelId}:${route.moduleId}`);
  // Spotlight (#164): set right before navigating to a module so its panel
  // can pre-select something on mount (e.g. a text command by name). Not
  // part of the route/URL -- see the deep-link discussion in that commit.
  const [pendingModuleSelection, setPendingModuleSelection] = useState<{ channelId: string; moduleId: string; value: string } | null>(null);
  // Same deep-link pattern, for Spotlight jumping straight to a channel
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
    const targetKey = `${route.channelId}:${targetModuleId}`;
    const state = (selectedChannel?.modules ?? modules.data?.modules ?? []).find((module) => module.id === targetModuleId);
    if (state === undefined || state.mandatory === true || targetModuleId === "channel_events" ||
        (selectedChannel !== null && !canManage(selectedChannel.role)) || headerModuleBusyKeys.has(targetKey)) return;
    setHeaderModuleBusyKeys((current) => new Set(current).add(targetKey));
    try {
      await setChannelModuleEnabled(route.channelId, targetModuleId, !state.enabled);
      await reloadAfterModuleToggle(route.channelId);
    } catch (error) {
      notify({ tone: "error", message: error instanceof PanelApiError
        ? apiErrorText(error.code, dashboardTexts().errors.changeFailed)
        : dashboardTexts().errors.changeFailed });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      setHeaderModuleBusyKeys((current) => {
        if (!current.has(targetKey)) return current;
        const next = new Set(current);
        next.delete(targetKey);
        return next;
      });
    }
  };

  const selectedChannelIdForModules = selectedChannel?.channelId ?? null;
  const selectedModulesForChannel = selectedChannel?.modules;
  const spotlightChannel = route.kind === "channel" || route.kind === "module"
    ? selectedChannel
    : channels.data?.[0] ?? null;

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
  const spotlightModules = spotlightChannel?.modules ?? (
    (route.kind === "channel" || route.kind === "module") && spotlightChannel?.channelId === route.channelId
      ? modules.data?.modules ?? []
      : []
  );
  const spotlightStreamState = overviewForHeader !== null && overviewForHeader.channelId === spotlightChannel?.channelId
    ? overviewForHeader.streamState
    : spotlightChannel?.streamState;

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
          header={<DashboardHeader route={route} channels={channels.data ?? []} activeChannel={activeHeaderChannel} loadedAt={activeHeaderLoadedAt} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} onRefreshState={refreshChannelState} />}
          navbar={(context) => <PanelSidebar route={route} channels={channels.data ?? []} platformAdmin={isPlatform} moduleStates={sidebarModuleStates} memberRole={selectedChannel?.role ?? null} collapsed={context.collapsed} onToggleCollapsed={context.onToggleCollapsed} onEntryNavigate={context.closeMobileNav} onNavigate={navigate} />}
          navLabel={dashboardTexts().navigation.mainNavigation}
          openSidebarLabel={dashboardTexts().navigation.openSidebar}
          closeSidebarLabel={dashboardTexts().navigation.closeSidebar}
        >
          <div className="main-content">
        {!showBotBlocking && route.kind === "overview" ? <OverviewPage channelState={channels} onNavigate={navigate} /> : null}
        {route.kind === "platform" && isPlatform ? <PlatformPage onAuthenticationRequired={requestLogin} /> : null}
        {!showBotBlocking && isChannelOrModuleRoute && selectedChannel === null && channels.status !== "success" ? (
          <UiLoadState
            variant="panel-720"
            status={channels.status === "error" ? "error" : "loading"}
            loading={<Skeleton rows={8} height={58} />}
            empty={<Skeleton rows={8} height={58} />}
            error={<Skeleton rows={8} height={58} />}
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
          loading={<Skeleton rows={12} height={58} />}
          empty={<Skeleton rows={12} height={58} />}
          error={<Skeleton rows={12} height={58} />}
        >{overviewMatchesRoute && overview.data !== null && overviewModulesLoaded ? <ChannelOverviewRoute
          key={routeKey}
          routeKey={routeKey}
          overview={overview.data}
          loadedAt={overview.loadedAt}
          onNavigate={navigate}
          modules={selectedChannel.modules ?? overview.data.modules ?? modules.data?.modules ?? []}
          modulesLoaded={overviewModulesLoaded}
          channelsLoadedAt={channelsQuery.dataUpdatedAt}
          onAuthenticationRequired={clearProtectedState}
          onLocationChanged={(channelId, location) => {
            queryClient.setQueryData<PanelChannelsResponse>(queryKeys.channels(), (current) => current === undefined ? current : {
              ...current,
              channels: current.channels.map((channel) => channel.channelId === channelId ? { ...channel, location } : channel),
            }, { updatedAt: channelsQuery.dataUpdatedAt });
            queryClient.setQueryData<PanelChannelOverview>(queryKeys.channel(channelId, "overview"), (current) =>
              current?.channelId !== channelId ? current : { ...current, location },
            { updatedAt: overviewQuery.dataUpdatedAt });
          }}
        /> : null}</UiLoadState> : null}
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
          <Suspense fallback={<div className="module-view-fallback" aria-hidden="true"><Skeleton rows={3} height={58} /></div>}>
            {!showChannelNotReleased && !showBotBlocking && selectedChannel !== null ? <UiLoadState
              variant="panel-720"
              status={overviewPageStatus}
              loading={<Skeleton rows={8} height={58} />}
              empty={<Skeleton rows={8} height={58} />}
              error={<Skeleton rows={8} height={58} />}
            >{overviewMatchesRoute && overview.data !== null ? <ModulePage channelId={route.channelId} moduleId={route.moduleId} ownRole={selectedChannel.role} modules={selectedChannel.modules ?? modules.data?.modules ?? overview.data.modules ?? []} activeModules={overview.data.activeModules} loading={overview.status === "loading" || modules.status === "loading"} error={overview.error ?? modules.error} busy={headerModuleBusy} botIsModerator={overview.data.moderator?.isModerator ?? null} onNavigate={navigate} onToggle={() => { void toggleHeaderModule(); }} suspendPanelUntilReady {...(pendingModuleSelection?.channelId === route.channelId && pendingModuleSelection.moduleId === route.moduleId ? { initialSelection: pendingModuleSelection.value } : {})} /> : null}</UiLoadState> : null}
          </Suspense>
        </div> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "system" && selectedChannel !== null ? <SystemPage
          key={route.channelId}
          system={systemQuery.data}
          error={systemQuery.isError ? errorMessage(systemQuery.error) : null}
          loadedAt={systemQuery.dataUpdatedAt > 0 ? systemQuery.dataUpdatedAt : undefined}
          onRetry={() => { void systemQuery.refetch(); }}
        /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "audit" && selectedChannel !== null ? <AuditPage key={route.channelId} channelId={route.channelId} filters={auditFilters} onFiltersChange={updateAuditFilters} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "events" && selectedChannel !== null ? <EventsPage key={route.channelId} channelId={route.channelId} filters={eventFilters} moduleOptions={selectedChannel.modules ?? modules.data?.modules ?? []} onFiltersChange={updateEventFilters} /> : null}
        <ChannelSpotlight
          key={`spotlight-${spotlightChannel?.channelId ?? "none"}`}
          channelId={spotlightChannel?.channelId ?? null}
          ownRole={spotlightChannel?.role ?? null}
          viewerUserId={viewerUserId}
          route={route}
          isPlatformAdmin={isPlatform}
          {...(channels.status === "success" ? { botSignedIn } : {})}
          streamState={spotlightStreamState}
          modules={spotlightModules}
          onNavigate={navigate}
          onOpenCommand={(name) => {
            if (spotlightChannel !== null) setPendingModuleSelection({ channelId: spotlightChannel.channelId, moduleId: "text_commands", value: name });
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

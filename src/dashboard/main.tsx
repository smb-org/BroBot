import { Fragment, StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  PanelAuditFilters,
  PanelAuditResponse,
  PanelBotPermissions,
  PanelBotStatus,
  PanelBroadcasterPermissions,
  PanelChannelOverview,
  PanelChannelControl,
  PanelChannelControls,
  PanelChannelState,
  PanelEventEntry,
  PanelEventFilters,
  PanelEventsResponse,
  PanelEventSubSubscription,
  PanelLastError,
  PanelMembersResponse,
  PanelModeratorStatus,
  PanelModuleState,
  PanelModulesResponse,
  PanelSystemResponse,
  PanelTokenStatus,
} from "../panel-contract";
import {
  BOT_MAINTENANCE_INTERVAL_MS,
  BOT_MAINTENANCE_STALE_AFTER_MS,
} from "../maintenance-policy";
import {
  fetchAuditLog,
  fetchChannelOverview,
  fetchChannels,
  fetchEvents,
  fetchMembers,
  fetchModules,
  fetchSystemOverview,
  logout,
  PanelApiError,
  refreshModeratorStatus,
  setChannelControl,
  setChannelModuleEnabled,
} from "./api";
import { Led, ModuleCount, ModuleHeading, ModuleIcon, ModulePage, ModuleTile, ModuleToggleList, ModuleWorkspace, NavigationIcon, StateRow, type LedStatus, type StateTone } from "./module-panels";
import { ImmediateActions, WarningsAndErrorsFeed } from "./stream-manager";
import { ChannelSpotlight } from "./spotlight";
import { MembersPage } from "./members";
import { PlatformPage } from "./platform";
import { channelPanelTexts, roleLabel } from "./labels";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatTimestamp as formatTimestampBase, formatNumber, maintenanceReasonText } from "./locale";
import { CHANNEL_CONTROL_DURATIONS, canManage, type ChannelControlDuration } from "../contracts/values";
import { eventSubName, moduleName, statusWord } from "./module-labels";
import { dashboardRoutePath, dashboardRouteRequiresBot, replaceDashboardRoute, useDashboardRoute, type DashboardRoute } from "./router";
import { navPageActive, navPageById, navPageGroupHeading, visibleNavPages } from "./nav-pages";
import { truncateTo200Chars } from "../text";
import { BlockingState, Button, ControlDurationDialog, Icon, Select as UiSelect, Shell, Sidebar, SubInspector, UiProvider, useInspectorSelection, type SidebarEntry, type SidebarGroup, type SidebarModulesGroup } from "./ui";
import { EventsPage } from "./events/EventsPage";
import { chronological, emptyEventFilter, eventFilterIsActive } from "./events/model";
import { AuditPage } from "./audit/AuditPage";
import { ChannelVariablesPage } from "./ChannelVariablesPage";
import { OverlaysPage } from "./OverlaysPage";
import { emptyAuditFilter, auditFilterIsActive } from "./audit/model";
import { useRealtimePanelMessages } from "./realtime";
import { idleState, loadedState, loadingState, type LoadState, type LoadStateSetter } from "./load-state";
import "./styles.css";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ModeratorCheckState {
  status: "idle" | "loading" | "error";
  error: string | null;
  nextAllowedAt: string | null;
}

interface MembersRequestState {
  controller: AbortController | null;
  generation: number;
}

interface EventsRequestState {
  controller: AbortController | null;
  generation: number;
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

const parseDate = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

type TokenView = {
  tone: "healthy" | "warning" | "error" | "neutral";
  label: string;
};

/**
 * A token that's routinely about to expire is not a problem — the cron
 * renews it on its next run. It's only a problem once the renewal fails to happen.
 *
 * That's why remaining lifetime alone is not a sufficient threshold: with four-hour
 * Twitch tokens and an hourly cron, every token regularly spends up to an hour
 * inside the renewal window without anything being broken. It's only overdue
 * once a maintenance run has already taken place since the point at which the
 * cron should have renewed it, and the token is still inside the window anyway.
 */
const renewalOverdue = (
  expiresAt: number,
  lastMaintenanceAt: number,
  now: number,
): boolean => expiresAt <= now + BOT_MAINTENANCE_INTERVAL_MS &&
  lastMaintenanceAt >= expiresAt - BOT_MAINTENANCE_INTERVAL_MS;

const tokenView = (tokens: PanelTokenStatus, bot: PanelBotStatus | null, loadedAt?: number, now = Date.now()): TokenView => {
  const texts = dashboardTexts();
  if (bot?.status === "error" || bot?.status === "revoked") {
    return { tone: "error", label: statusLabel(bot.status) };
  }
  if (tokens.loginStatus === "error" || tokens.loginStatus === "revoked") {
    return { tone: "error", label: statusLabel(tokens.loginStatus) };
  }
  if (tokens.loginStatus === null) return { tone: "neutral", label: texts.status.loginIdentityMissing };
  const botExpiresAt = parseDate(tokens.botExpiresAt);
  const loginExpiresAt = parseDate(tokens.loginExpiresAt);
  if (botExpiresAt === null || loginExpiresAt === null) return { tone: "neutral", label: texts.status.notChecked };
  const expiredAtLoad = loadedAt !== undefined && (botExpiresAt <= loadedAt || loginExpiresAt <= loadedAt);
  if (expiredAtLoad) return { tone: "error", label: texts.status.expired };
  if (botExpiresAt <= now || loginExpiresAt <= now) return { tone: "neutral", label: texts.status.refreshing };
  if (bot?.status !== "connected") return { tone: "neutral", label: texts.status.notChecked };
  const lastMaintenanceAt = parseDate(bot.updatedAt);
  if (lastMaintenanceAt === null || lastMaintenanceAt <= now - BOT_MAINTENANCE_STALE_AFTER_MS) {
    return { tone: "warning", label: texts.status.maintenanceOverdue };
  }
  if (renewalOverdue(botExpiresAt, lastMaintenanceAt, now) ||
      renewalOverdue(loginExpiresAt, lastMaintenanceAt, now)) {
    return { tone: "warning", label: texts.status.renewalOverdue };
  }
  return { tone: "healthy", label: texts.status.valid };
};

const channelBotConsentMissing = (channel: PanelChannelState): boolean =>
  channel.channelBotConsent === "missing";

const broadcasterConsentMissing = (permissions: PanelBroadcasterPermissions | null | undefined): permissions is PanelBroadcasterPermissions =>
  permissions !== null && permissions !== undefined && permissions.missingScopes.length > 0;

const channelStatus = (channel: PanelChannelState, loadedAt?: number, now = Date.now()): StateTone => {
  if (channel.moderator?.isModerator === false) return "error";
  if (channel.chatSubscriptionNeeded === true &&
      (channel.chatSubscription?.status === "error" || channel.chatSubscription?.status === "revoked")) return "error";
  if (channel.lastError?.source === "eventsub") return "error";
  if (channel.bot?.status === "error" || channel.bot?.status === "revoked") return "error";
  if (channel.botPermissions?.missingScopes.length) return "warning";
  if (broadcasterConsentMissing(channel.broadcasterPermissions)) return "warning";
  if (channel.tokens.loginStatus === "error" || channel.tokens.loginStatus === "revoked") return "error";
  const tokenStatus = tokenView(channel.tokens, channel.bot, loadedAt, now);
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
  if (channel.moderator?.isModerator === false) return texts.status.moderatorRoleMissing;
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription?.status === "error") return texts.status.chatSubscriptionError;
  if (channel.chatSubscriptionNeeded === true && channel.chatSubscription?.status === "revoked") return texts.status.chatSubscriptionRevoked;
  if (channel.lastError?.source === "eventsub") return texts.errors.last;
  if (channel.bot?.status === "error") return texts.status.botError;
  if (channel.bot?.status === "revoked") return texts.status.botTokenRevoked;
  if (channel.botPermissions?.missingScopes.length) return texts.status.botPermissionsMissing(formatNumber(channel.botPermissions.missingScopes.length));
  if (broadcasterConsentMissing(channel.broadcasterPermissions)) return channelPanelTexts().fullConsentMissing;
  const tokenStatus = tokenView(channel.tokens, channel.bot, loadedAt, now);
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

const formatTimestamp = (value: string): string => formatTimestampBase(value);

const ErrorPanel = ({ message }: { message: string }): ReactElement => (
  <section className="error-panel" data-status="error" role="alert">
    <strong>{dashboardTexts().errors.title}</strong>
    <p>{message}</p>
  </section>
);

interface PanelSidebarProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  platformAdmin: boolean;
  moduleStates: PanelModuleState[] | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onEntryNavigate: () => void;
  onNavigate: (route: DashboardRoute) => void;
}

/**
 * "Seitenleiste" (docs/input/DESIGN-neu.md): four groups, built from the
 * seam's `Sidebar`. Replaces `Rail` and the breadcrumb switchers.
 */
const PanelSidebar = ({ route, channels, platformAdmin: platform, moduleStates, collapsed, onToggleCollapsed, onEntryNavigate, onNavigate }: PanelSidebarProperties): ReactElement => {
  const texts = dashboardTexts();
  const navigationChannelId = route.kind === "channel" || route.kind === "module"
    ? route.channelId
    : channels[0]?.channelId ?? "";

  // Built from `NAV_PAGES` (#208), the same list Spotlight indexes -- a page
  // added there shows up in both places instead of drifting the way
  // Spotlight did (it only knew modules/commands/members).
  const pages = visibleNavPages({ isPlatformAdmin: platform });
  const pageEntry = (page: (typeof pages)[number]): SidebarEntry => {
    const entryRoute = page.route(navigationChannelId);
    return {
      id: page.id,
      pageId: page.id,
      label: page.label(texts),
      icon: <NavigationIcon kind={page.iconKind} className="sidebar-nav-icon" />,
      href: dashboardRoutePath(entryRoute),
      active: navPageActive(page, route),
      onNavigate: () => { onNavigate(entryRoute); },
    };
  };
  const platformPage = pages.find((page) => page.group === "platform");

  const operationGroup: SidebarGroup = {
    id: "operation",
    heading: navPageGroupHeading("operation", texts),
    entries: pages.filter((page) => page.group === "operation").map(pageEntry),
  };
  const channelGroup: SidebarGroup = {
    id: "channel",
    heading: navPageGroupHeading("channel", texts),
    entries: pages.filter((page) => page.group === "channel").map(pageEntry),
  };

  // "jedes aktive Modul als Eintrag" -- only modules that are actually on
  // (enabled, and not held back by a missing broadcaster scope) appear
  // here; everything else lives in the module list only.
  const activeModuleEntries: SidebarEntry[] = (moduleStates ?? [])
    .filter((module) => module.enabled && (module.missingBroadcasterScopes?.length ?? 0) === 0)
    .map((module) => {
      const moduleRoute: DashboardRoute = { kind: "module", channelId: navigationChannelId, moduleId: module.id };
      return {
        id: module.id,
        label: moduleName(module.id),
        icon: <ModuleIcon moduleId={module.id} className="sidebar-nav-icon" />,
        href: dashboardRoutePath(moduleRoute),
        active: route.kind === "module" && route.moduleId === module.id,
        onNavigate: () => { onNavigate(moduleRoute); },
        led: { status: "green" as const, word: statusWord(true) },
      };
    });
  const modulesGroup: SidebarModulesGroup = {
    heading: navPageGroupHeading("modules", texts),
    entry: pageEntry(navPageById("modules")),
    entries: activeModuleEntries,
  };

  const platformGroup: SidebarGroup | undefined = platformPage === undefined ? undefined : {
    id: "platform",
    heading: navPageGroupHeading("platform", texts),
    entries: [pageEntry(platformPage)],
  };

  return (
    <Sidebar
      groups={[operationGroup, channelGroup]}
      modules={modulesGroup}
      platform={platformGroup}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      onEntryNavigate={onEntryNavigate}
      collapseLabel={texts.navigation.collapseSidebar}
      expandLabel={texts.navigation.expandSidebar}
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

const ChannelControlActions = ({ channelId, controls, now, onRefresh }: {
  channelId: string;
  controls: PanelChannelControls | undefined;
  now: number;
  onRefresh: () => Promise<void>;
}): ReactElement => {
  const texts = dashboardTexts();
  const labels = texts.channelControls;
  const [dialogControl, setDialogControl] = useState<"mute" | "pause" | null>(null);
  const [duration, setDuration] = useState<ChannelControlDuration>("unlimited");
  const [busy, setBusy] = useState<"mute" | "pause" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef(onRefresh);
  useEffect(() => { refreshRef.current = onRefresh; }, [onRefresh]);
  const mute = controls?.mute ?? CONTROL_OFF;
  const pause = controls?.pause ?? CONTROL_OFF;
  const muteConfigured = mute.active || mute.pending === true;
  const pauseConfigured = pause.active || pause.pending === true;
  const staleExpiryKey = [mute, pause]
    .filter((control) => control.active && control.mode === "timed" && control.until !== null && Date.parse(control.until) <= now)
    .map((control) => control.until)
    .join("|");
  const refreshedExpiryKey = useRef("");

  useEffect(() => {
    if (staleExpiryKey.length === 0) {
      refreshedExpiryKey.current = "";
      return;
    }
    if (refreshedExpiryKey.current === staleExpiryKey) return;
    refreshedExpiryKey.current = staleExpiryKey;
    void refreshRef.current();
  }, [staleExpiryKey]);

  const apply = async (kind: "mute" | "pause", next: ChannelControlDuration | null): Promise<void> => {
    if (busy !== null) return;
    setBusy(kind);
    setError(null);
    try {
      await setChannelControl(channelId, kind, next);
      setDialogControl(null);
      await onRefresh();
    } catch (requestError: unknown) {
      setError(requestError instanceof PanelApiError
        ? apiErrorText(requestError.code, labels.failure)
        : labels.failure);
    } finally {
      setBusy(null);
    }
  };

  const activeText = (control: typeof mute, kind: "mute" | "pause"): string | null => {
    if (control.pending === true) return labels.pendingUntilStreamStart;
    if (!control.active) return null;
    if (control.mode === "timed" && control.until !== null) {
      const remaining = Math.ceil((Date.parse(control.until) - now) / 60_000);
      if (remaining <= 0) return texts.status.refreshing;
      return kind === "mute" ? labels.muteRemaining(String(remaining)) : labels.pauseRemaining(String(remaining));
    }
    if (control.mode === "until_stream_end") return `${kind === "mute" ? labels.muteActive : labels.pauseActive} · ${labels.untilStreamEnd}`;
    return kind === "mute" ? labels.muteActive : labels.pauseActive;
  };

  const timedIndicator = (control: typeof mute, kind: "mute" | "pause"): ReactElement | null => {
    if (!control.active || control.mode !== "timed" || control.until === null || Date.parse(control.until) <= now) return null;
    return <span className="dashboard-header__control-state"><Icon name="clock-hour-4" size={16} />{activeText(control, kind)}</span>;
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
          onClick={() => { if (muteConfigured) void apply("mute", null); else { setDialogControl("mute"); setError(null); } }}
        />
        {timedIndicator(mute, "mute")}
        {!muteConfigured || mute.mode === "timed" ? null : <span className="dashboard-header__control-state">{activeText(mute, "mute")}</span>}
        <Button
          icon={pauseConfigured ? "player-play" : "player-pause"}
          iconOnly
          ariaLabel={pauseConfigured ? labels.pauseDisable : labels.pauseEnable}
          title={pauseConfigured ? labels.pauseDisable : labels.pauseEnable}
          disabled={busy !== null}
          onClick={() => { if (pauseConfigured) void apply("pause", null); else { setDialogControl("pause"); setError(null); } }}
        />
        {timedIndicator(pause, "pause")}
        {!pauseConfigured || pause.mode === "timed" ? null : <span className="dashboard-header__control-state">{activeText(pause, "pause")}</span>}
      </div>
      {error === null ? null : <span className="dashboard-header__control-error" role="alert">{error}</span>}
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
const DashboardHeader = ({ route, channels, activeChannel, loadedAt, onNavigate, onLogout, loggingOut, onRefreshState }: DashboardHeaderProperties): ReactElement => {
  const texts = dashboardTexts();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(id); };
  }, []);
  const tone = activeChannel === undefined ? "neutral" : channelStatus(activeChannel, loadedAt, now);
  const connectionLabel = activeChannel === undefined
    ? null
    : tone === "healthy" ? texts.header.connectionRunning : statusText(activeChannel, loadedAt, now);
  const connectionLed = connectionLabel === null ? null : <span className="led" data-status={tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off"}><span className="led__dot" aria-hidden="true" /><span>{connectionLabel}</span></span>;
  const streamState = activeChannel?.streamState;
  const streamLabel = streamState === "online"
    ? texts.header.streamLive(streamDuration(activeChannel?.streamStartedAt, now))
    : streamState === "offline" ? texts.header.streamOffline : texts.header.streamUnknown;
  return (
    <div className="dashboard-header">
      <a className="brand-mark dashboard-header__brand" href="/" aria-current={route.kind === "overview" ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate({ kind: "overview" }); }}><span className="brand-mark__dot" /><span className="brand-mark__word">BroBot</span></a>
      {activeChannel === undefined ? null : (
        <div className="dashboard-header__channel">
          <UiSelect
            value={activeChannel.channelId}
            onChange={(channelId) => { if (channelId !== null) onNavigate({ kind: "channel", channelId, section: "overview" }); }}
            options={channels.map((channel) => ({ value: channel.channelId, label: `${channel.displayName} — ${channel.channelId}` }))}
            ariaLabel={texts.navigation.selectChannel}
            id="dashboard-channel-select"
          />
        </div>
      )}
      <div className="dashboard-header__status">
        {activeChannel === undefined ? null : <span className="dashboard-header__stream" data-state={streamState === "online" ? "live" : streamState === "offline" ? "offline" : "unknown"}>
          <Icon name={streamState === "online" ? "broadcast" : "broadcast-off"} size={20} />
          <span>{streamLabel}</span>
          {activeChannel.streamStateCheckedAt === undefined || activeChannel.streamStateCheckedAt === null ||
              !Number.isFinite(Date.parse(activeChannel.streamStateCheckedAt)) ? null : (
            <DataAge since={Date.parse(activeChannel.streamStateCheckedAt)} format={texts.header.streamChecked} className="dashboard-header__stream-age" />
          )}
        </span>}
        {connectionLed}
        {loadedAt === undefined ? null : <DataAge since={loadedAt} />}
      </div>
      {activeChannel === undefined ? null : <ChannelControlActions channelId={activeChannel.channelId} controls={activeChannel.controls} now={now} onRefresh={onRefreshState} />}
      <button className="button button--quiet dashboard-header__logout" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? texts.navigation.signingOut : texts.navigation.signOut}</button>
    </div>
  );
};

const OverviewPage = ({ channels, loadedAt, onNavigate }: { channels: PanelChannelState[]; loadedAt?: number | undefined; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
  const texts = dashboardTexts();
  return (
    <>
      <ModuleHeading kind="overview" title={texts.navigation.overview} subtitle={channels.length === 1 ? texts.overview.oneChannelAvailable : <ModuleCount count={channels.length} label={texts.overview.channelsAvailableShort} />} />
      {channels.length === 0 ? (
        <section className="empty-state"><h2>{texts.overview.noChannelAvailable}</h2><p>{texts.overview.noMembership}</p></section>
      ) : (
        <div className="module-grid">
          {channels.map((channel) => (
            <ModuleTile
              key={channel.channelId}
              channelId={channel.channelId}
              moduleId={channel.channelId}
              enabled={channelStatus(channel, loadedAt) === "healthy"}
              name={channel.displayName}
              ledStatus={channelToneToLedStatus(channelStatus(channel, loadedAt))}
              ledLabel={statusText(channel, loadedAt)}
              route={{ kind: "channel", channelId: channel.channelId, section: "overview" }}
              icon={<NavigationIcon kind="channel" className="module-glyph" />}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
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

const ModeratorCheckAction = ({ canCheck, checking, checkError, nextAllowedAt, urgent, onCheck }: {
  canCheck: boolean; checking: boolean; checkError: string | null;
  nextAllowedAt: string | null; urgent: boolean; onCheck: () => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const [now, setNow] = useState(() => Date.now());
  const nextAllowedAtMs = nextAllowedAt === null ? null : Date.parse(nextAllowedAt);
  useEffect(() => {
    if (nextAllowedAtMs === null || !Number.isFinite(nextAllowedAtMs)) return;
    const timeoutId = window.setTimeout(() => { setNow(Date.now()); }, Math.max(0, nextAllowedAtMs - Date.now()));
    return () => { window.clearTimeout(timeoutId); };
  }, [nextAllowedAtMs]);
  const cooldownActive = nextAllowedAtMs !== null && Number.isFinite(nextAllowedAtMs) && nextAllowedAtMs > now;
  return (
    <div className="header-action">
      <button className={urgent ? "button button--primary" : "button"} type="button" onClick={onCheck} disabled={!canCheck || checking || cooldownActive} aria-busy={checking}>
        {checking ? texts.moderation.checkRunning : texts.moderation.checkModeratorStatus}
      </button>
      {nextAllowedAt === null ? null : <p className="muted moderator-check-time">{texts.moderation.nextCheckFrom(formatTimestamp(nextAllowedAt))}</p>}
      {!canCheck ? <span className="lock-reason">{texts.moderation.checkLocked}</span> : null}
      {checkError === null ? null : <p className="form-error" role="alert">{checkError}</p>}
    </div>
  );
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
      {!canRequest ? <span className="lock-reason">{texts.moderation.broadcasterReauthorize}</span> : null}
    </div>
  );
};

const BroadcasterConsentAction = ({ login, needed, canRequest }: {
  login: string;
  needed: boolean;
  canRequest: boolean;
}): ReactElement | null => {
  if (!needed) return null;
  const texts = channelPanelTexts();
  return (
    <div className="header-action">
      {canRequest ? <a className="button button--primary" href={`/auth/login?channel=${encodeURIComponent(login)}`}>{texts.requestFullConsent}</a> : <button className="button" type="button" disabled>{texts.requestFullConsent}</button>}
      {!canRequest ? <span className="lock-reason">{texts.fullConsentLocked}</span> : null}
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
  if (!broadcasterConsentMissing(permissions)) return null;
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
  const token = tokenView(tokens, bot, loadedAt);
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
  const tone: StateTone = moderator === null ? "neutral" : moderator.isModerator ? "healthy" : "error";
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
  if (permissions === null || permissions === undefined || permissions.missingScopes.length === 0) return null;
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
  if (!broadcasterConsentMissing(permissions)) return null;
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
  return (
    <section className={`content-section inspector-section${selected === null ? "" : " inspector-section--open"}`} aria-label={texts.system.subscriptions}>
      <div className="inspector-section__list">
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
                  <td>{maintenanceReasonText(subscription.reason) ?? emptyValue}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </div>
      {selected === null ? null : <SubInspector ariaLabel={texts.system.subscriptionDetails} title={subscriptionDisplayName(selected)} identifier={selected.subscriptionId ?? emptyValue} closeLabel={dashboardCommonTexts().close} onClose={close}>
        <dl className="properties">
          <div><dt>{texts.system.subscriptionRawType}</dt><dd className="mono">{selected.subscriptionType}</dd></div>
          <div><dt>{texts.system.subscriptionVersion}</dt><dd className="mono">{selected.version}</dd></div>
          <div><dt>{texts.system.subscriptionId}</dt><dd className="mono">{selected.subscriptionId ?? emptyValue}</dd></div>
          <div><dt>{texts.system.subscriptionUpdated}</dt><dd className="mono">{formatTimestamp(selected.updatedAt)}</dd></div>
          <div><dt>{texts.system.twitchMessage}</dt><dd>{selected.message ?? emptyValue}</dd></div>
          <div><dt>{texts.system.httpStatus}</dt><dd className="mono">{selected.statusCode === null ? emptyValue : String(selected.statusCode)}</dd></div>
        </dl>
      </SubInspector>}
    </section>
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
  onModulesChanged: () => Promise<void>;
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

const ChannelOverviewPage = ({ overview, loadedAt, moderatorCheck, onCheckModeratorStatus, onNavigate, modules, onModulesChanged }: ChannelOverviewPageProperties): ReactElement => {
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
      <ModuleHeading
        kind="channel"
        title={overview.displayName}
        subtitle={roleLabel(overview.role)}
      />
      <ImmediateActions channelId={overview.channelId} streamState={overview.streamState} modules={modules} />
      <WarningsAndErrorsFeed channelId={overview.channelId} onNavigate={onNavigate} />
      <section className="content-section" aria-label={dashboardTexts().navigation.module}>
        <div className="section-heading"><h2>{dashboardTexts().navigation.module}</h2><span className="muted number">{formatNumber(overview.activeModules.length)}</span></div>
        <ModuleToggleList channelId={overview.channelId} ownRole={overview.role} modules={modules} onNavigate={onNavigate} onChanged={onModulesChanged} />
      </section>
      <ChannelStateChecks entries={entries}>
        <BotPermissionsInspector permissions={overview.botPermissions} />
        <BroadcasterPermissionsInspector permissions={overview.broadcasterPermissions} />
      </ChannelStateChecks>
    </>
  );
};

interface SystemPageProperties {
  system: PanelSystemResponse | null;
  systemState: LoadState<PanelSystemResponse>;
}

const SystemPage = ({ system, systemState }: SystemPageProperties): ReactElement => {
  const texts = dashboardTexts();
  return (
    <>
      <ModuleHeading kind="system" title={texts.system.title} subtitle={texts.system.readOnly} />
      {system === null && systemState.status === "loading" ? <p className="loading-line">{texts.system.loadState}</p> : null}
      {systemState.error !== null ? <ErrorPanel message={systemState.error} /> : null}
      {system === null ? null : <>
        <div className="state-list">{[broadcasterRow(system.broadcasterConnection), chatRow(system.chatSubscription, system.chatSubscriptionNeeded === true), botRow(system.bot), botPermissionsRow(system.botPermissions), broadcasterPermissionsRow(system.broadcasterPermissions), tokenRow(system.tokens, system.bot, systemState.loadedAt)].filter((entry): entry is StatusEntry => entry !== null).map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
        <BotPermissionsInspector permissions={system.botPermissions} />
        <BroadcasterPermissionsInspector permissions={system.broadcasterPermissions} />
        <SubscriptionsSection subscriptions={system.subscriptions ?? []} />
        <SystemProperties system={system} />
      </>}
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

const mergeEventEntries = (
  current: readonly PanelEventEntry[],
  incoming: readonly PanelEventEntry[],
): PanelEventEntry[] => {
  const byId = new Map<string, PanelEventEntry>();
  for (const entry of current) byId.set(entry.eventId, entry);
  for (const entry of incoming) byId.set(entry.eventId, entry);
  return Array.from(byId.values()).sort((left, right) => chronological(right, left));
};

export const DashboardApp = (): ReactElement => {
  useEffect(() => {
    document.documentElement.lang = dashboardLanguage();
  }, []);

  const [route, navigate] = useDashboardRoute();
  const routeRef = useRef(route);
  routeRef.current = route;
  const realtimeChannelId = route.kind === "channel" || route.kind === "module" ? route.channelId : null;
  const routeHasOwnRealtimeFeed = route.kind === "channel" &&
    (route.section === "overview" || route.section === "events" || route.section === "variables");
  useRealtimePanelMessages(realtimeChannelId, realtimeChannelId !== null && !routeHasOwnRealtimeFeed);
  const [channels, setChannels] = useState<LoadState<PanelChannelState[]>>(() => idleState());
  const latestStreamByChannel = useRef(new Map<string, ChannelStreamVersion>());
  const [, setFreshnessTick] = useState(0);
  const [isPlatform, setIsPlatform] = useState(false);
  const [viewerIsBot, setViewerIsBot] = useState(false);
  const [botLogin, setBotLogin] = useState<string | null>(null);
  // The installation's single bot identity, independent of which channels
  // this viewer can see -- present even with zero released channels (#159).
  const [installationBot, setInstallationBot] = useState<PanelBotStatus | null>(null);
  const [overview, setOverview] = useState<LoadState<PanelChannelOverview>>(() => idleState());
  const [overviewRoutePath, setOverviewRoutePath] = useState<string | null>(null);
  const [moderatorCheck, setModeratorCheck] = useState<ModeratorCheckState>(() => idleModeratorCheck());
  const [system, setSystem] = useState<LoadState<PanelSystemResponse>>(() => idleState());
  const [members, setMembers] = useState<LoadState<PanelMembersResponse>>(() => idleState());
  const [modules, setModules] = useState<LoadState<PanelModulesResponse>>(() => idleState());
  const [audit, setAudit] = useState<LoadState<PanelAuditResponse>>(() => idleState());
  const [events, setEvents] = useState<LoadState<PanelEventsResponse>>(() => idleState());
  const [systemChannelId, setSystemChannelId] = useState<string | null>(null);
  const [auditChannelId, setAuditChannelId] = useState<string | null>(null);
  const [eventsChannelId, setEventsChannelId] = useState<string | null>(null);
  const [loadingNextAuditPage, setLoadingNextAuditPage] = useState(false);
  const auditPageController = useRef<AbortController | null>(null);
  const [loadingNextEventsPage, setLoadingNextEventsPage] = useState(false);
  const eventsRequest = useRef<EventsRequestState>({ controller: null, generation: 0 });
  const [loadingNextMembersPage, setLoadingNextMembersPage] = useState(false);
  const membersRequest = useRef<MembersRequestState>({ controller: null, generation: 0 });
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [headerModuleBusy, setHeaderModuleBusy] = useState(false);
  // Guards `reloadModules` against out-of-order responses: two reloads can
  // be in flight together (a toggle's own reload racing a Stream Manager
  // poll), and without this an older response can overwrite a newer one.
  const modulesRequestGeneration = useRef(0);
  const channelsRequestGeneration = useRef(0);
  // Same guard for `reloadOverview`: a control edit's own refresh can resolve
  // before a reload that started earlier (e.g. on reconnect). Controls don't
  // touch streamStateChangedAt, so the changedAt-based merge alone can't tell
  // the two apart -- only the later-started request may ever apply its
  // response (latest-started wins).
  const overviewRequestGeneration = useRef(0);
  // Spotlight (#164): set right before navigating to a module so its panel
  // can pre-select something on mount (e.g. a text command by name). Not
  // part of the route/URL -- see the deep-link discussion in that commit.
  const [pendingModuleSelection, setPendingModuleSelection] = useState<string | null>(null);
  // Same deep-link pattern, for Spotlight jumping straight to a channel
  // variable's inspector (#208) instead of just opening the variables page.
  const [pendingVariableSelection, setPendingVariableSelection] = useState<{ channelId: string; name: string } | null>(null);
  const requestLogin = useCallback((): void => { setAuthenticationRequired(true); }, []);

  useEffect(() => {
    const handleRealtimeMessage = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return;
      const message = detail as Record<string, unknown>;
      if (message.type !== "stream.state.changed" || typeof message.channelId !== "string" ||
          typeof message.payload !== "object" || message.payload === null || Array.isArray(message.payload)) return;
      const payload = message.payload as Record<string, unknown>;
      if ((payload.state !== "online" && payload.state !== "offline") ||
          (payload.startedAt !== null && typeof payload.startedAt !== "string") ||
          typeof payload.changedAt !== "string" || !Number.isFinite(Date.parse(payload.changedAt)) ||
          (payload.checkedAt !== undefined && (typeof payload.checkedAt !== "string" || !Number.isFinite(Date.parse(payload.checkedAt))))) return;
      const { channelId } = message;
      const streamVersion = mergeAndRememberChannelStreamVersion({
        channelId,
        streamState: payload.state,
        streamStartedAt: payload.startedAt,
        streamStateChangedAt: payload.changedAt,
        streamStateCheckedAt: typeof payload.checkedAt === "string" ? payload.checkedAt : payload.changedAt,
        ...(payload.controls === undefined ? {} : { controls: payload.controls as PanelChannelControls }),
      }, latestStreamByChannel.current);
      setChannels((current) => current.data === null || !current.data.some((channel) => channel.channelId === channelId) ? current : {
        ...current,
        data: current.data.map((channel) => channel.channelId !== channelId ? channel : {
          ...channel,
          ...mergeChannelStreamVersion({ ...channel, ...streamVersion }, channel),
        }),
      });
      setOverview((current) => current.data?.channelId !== channelId ? current : {
        ...current,
        data: {
          ...current.data,
          ...mergeChannelStreamVersion({ ...current.data, ...streamVersion }, current.data),
        },
      });
    };
    window.addEventListener("brobot:realtime", handleRealtimeMessage);
    return () => window.removeEventListener("brobot:realtime", handleRealtimeMessage);
  }, []);

  const reloadChannels = useCallback(async (): Promise<void> => {
    const generation = channelsRequestGeneration.current + 1;
    channelsRequestGeneration.current = generation;
    setChannels((current) => loadingState(current));
    try {
      const response = await fetchChannels();
      if (channelsRequestGeneration.current !== generation) return;
      const orderedChannels = response.channels.map((channel) =>
        mergeAndRememberChannelStreamVersion(channel, latestStreamByChannel.current),
      );
      setChannels(loadedState(orderedChannels));
      setIsPlatform(response.platformAdmin);
      setViewerIsBot(response.viewerIsBot);
      setBotLogin(response.botLogin ?? null);
      setInstallationBot(response.bot);
      setAuthenticationRequired(false);
    } catch (error: unknown) {
      if (channelsRequestGeneration.current !== generation) return;
      setChannels((current) => current.loadedAt === undefined
        ? { status: "error", data: null, error: errorMessage(error) }
        : { status: "error", data: current.data, error: errorMessage(error), loadedAt: current.loadedAt });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    }
  }, []);

  const startMembersRequest = useCallback((): { controller: AbortController; generation: number } => {
    membersRequest.current.controller?.abort();
    const request = {
      controller: new AbortController(),
      generation: membersRequest.current.generation + 1,
    };
    membersRequest.current = request;
    return request;
  }, []);

  const isCurrentMembersRequest = useCallback((generation: number): boolean => membersRequest.current.generation === generation, []);

  const finishMembersRequest = useCallback((generation: number): void => {
    if (isCurrentMembersRequest(generation)) membersRequest.current.controller = null;
  }, [isCurrentMembersRequest]);

  const cancelMembersRequest = useCallback((): void => {
    membersRequest.current.controller?.abort();
    membersRequest.current = { controller: null, generation: membersRequest.current.generation + 1 };
  }, []);

  const startEventsRequest = useCallback((): { controller: AbortController; generation: number } => {
    eventsRequest.current.controller?.abort();
    const request = {
      controller: new AbortController(),
      generation: eventsRequest.current.generation + 1,
    };
    eventsRequest.current = request;
    return request;
  }, []);

  const isCurrentEventsRequest = useCallback((generation: number): boolean => eventsRequest.current.generation === generation, []);

  const finishEventsRequest = useCallback((generation: number): void => {
    if (isCurrentEventsRequest(generation)) eventsRequest.current.controller = null;
  }, [isCurrentEventsRequest]);

  const cancelEventsRequest = useCallback((): void => {
    eventsRequest.current.controller?.abort();
    eventsRequest.current = { controller: null, generation: eventsRequest.current.generation + 1 };
  }, []);

  const reloadFirstEventsPage = useCallback(async (channelId: string, filters: PanelEventFilters): Promise<void> => {
    const routePath = dashboardRoutePath({
      kind: "channel",
      channelId,
      section: "events",
      ...(eventFilterIsActive(filters) ? { filters } : {}),
    });
    const request = startEventsRequest();
    setEvents((current) => loadingState(current));
    try {
      const response = await fetchEvents(channelId, null, request.controller.signal, filters);
      if (!isCurrentEventsRequest(request.generation) || request.controller.signal.aborted || window.location.pathname + window.location.search !== routePath) return;
      setEvents((current) => loadedState({
        entries: mergeEventEntries(current.data?.entries ?? [], response.entries),
        nextCursor: current.data === null ? response.nextCursor : current.data.nextCursor,
      }));
      setEventsChannelId(channelId);
    } catch (error) {
      if (!isCurrentEventsRequest(request.generation) || request.controller.signal.aborted || window.location.pathname + window.location.search !== routePath || (error instanceof DOMException && error.name === "AbortError")) return;
      setEvents((current) => ({ ...current, status: "error", error: errorMessage(error) }));
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      finishEventsRequest(request.generation);
    }
  }, [finishEventsRequest, isCurrentEventsRequest, startEventsRequest]);

  const clearProtectedState = (): void => {
    auditPageController.current?.abort();
    auditPageController.current = null;
    cancelEventsRequest();
    cancelMembersRequest();
    setChannels({ status: "success", data: [], error: null });
    setIsPlatform(false);
    setViewerIsBot(false);
    setBotLogin(null);
    setInstallationBot(null);
    setOverview(idleState());
    setOverviewRoutePath(null);
    setModeratorCheck(idleModeratorCheck());
    setSystem(idleState());
    setMembers(idleState());
    setModules(idleState());
    setAudit(idleState());
    setEvents(idleState());
    setSystemChannelId(null);
    setAuditChannelId(null);
    setEventsChannelId(null);
    setLoadingNextAuditPage(false);
    setLoadingNextEventsPage(false);
    setLoadingNextMembersPage(false);
    setAuthenticationRequired(true);
    navigate({ kind: "overview" });
  };

  useEffect(() => {
    void reloadChannels();
    return () => { channelsRequestGeneration.current += 1; };
  }, [reloadChannels]);

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
  }, [channels, route.kind]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    auditPageController.current?.abort();
    auditPageController.current = null;
    setLoadingNextAuditPage(false);
    cancelEventsRequest();
    setLoadingNextEventsPage(false);
    cancelMembersRequest();
    setLoadingNextMembersPage(false);
    setOverview(loadingState());
    setOverviewRoutePath(null);
    setModeratorCheck(idleModeratorCheck());
    setSystem(idleState());
    setModules(idleState());
    setAudit(idleState());
    setEvents(idleState());
    setSystemChannelId(null);
    setAuditChannelId(null);
    setEventsChannelId(null);
    const cleanup = (): void => {
      cancelled = true;
      controller.abort();
      auditPageController.current?.abort();
      auditPageController.current = null;
      cancelEventsRequest();
      cancelMembersRequest();
      setLoadingNextMembersPage(false);
    };
    if (route.kind !== "channel" && route.kind !== "module") return cleanup;
    const expectedOverviewPath = dashboardRoutePath(route);

    const load = async (): Promise<void> => {
      if (route.kind === "channel" && route.section === "modules") return;
      // The module page shows the same channel header as the overview and
      // therefore needs the same data.
      if (route.kind === "module" || route.section === "overview") {
        // Same generation guard `reloadOverview` uses: a control edit's own
        // reload can resolve before this initial fetch does, and without
        // this the initial response would overwrite the edit on arrival.
        const overviewGeneration = overviewRequestGeneration.current + 1;
        overviewRequestGeneration.current = overviewGeneration;
        try {
          const response = await fetchChannelOverview(route.channelId, controller.signal);
          if (!cancelled && overviewRequestGeneration.current === overviewGeneration) {
            const orderedResponse = mergeAndRememberChannelStreamVersion(response, latestStreamByChannel.current);
            setOverview((current) => loadedState(mergeChannelStreamVersion(
              orderedResponse,
              current.data?.channelId === route.channelId ? current.data : undefined,
            )));
            setOverviewRoutePath(expectedOverviewPath);
          }
        } catch (error) {
          if (!cancelled && overviewRequestGeneration.current === overviewGeneration && !(error instanceof DOMException && error.name === "AbortError")) {
            setOverview({ status: "error", data: null, error: errorMessage(error) });
            if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
          }
        }
        return;
      }
      if (route.section === "members") {
        const routePath = dashboardRoutePath({ kind: "channel", channelId: route.channelId, section: "members" });
        const request = startMembersRequest();
        setMembers(loadingState());
        try {
          const response = await fetchMembers(route.channelId, null, request.controller.signal);
          if (!cancelled && isCurrentMembersRequest(request.generation) && !request.controller.signal.aborted && window.location.pathname === routePath) {
            setMembers(loadedState(response));
          }
        } catch (error) {
          if (!cancelled && isCurrentMembersRequest(request.generation) && !request.controller.signal.aborted && window.location.pathname === routePath && !(error instanceof DOMException && error.name === "AbortError")) {
            setMembers({ status: "error", data: null, error: errorMessage(error) });
            if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
          }
        } finally {
          finishMembersRequest(request.generation);
        }
        return;
      }
      if (route.section === "modules") {
        return;
      }
      if (route.section === "events") {
        setEvents(loadingState());
        setEventsChannelId(route.channelId);
        const request = startEventsRequest();
        const filters = route.filters ?? emptyEventFilter;
        try {
          const response = await fetchEvents(route.channelId, null, request.controller.signal, filters);
          if (!cancelled && isCurrentEventsRequest(request.generation) && !request.controller.signal.aborted) {
            setEvents(loadedState(response));
            setEventsChannelId(route.channelId);
          }
        } catch (error) {
          if (!cancelled && isCurrentEventsRequest(request.generation) && !request.controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
            setEvents({ status: "error", data: null, error: errorMessage(error) });
            if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
          }
        } finally {
          finishEventsRequest(request.generation);
        }
        return;
      }
      setOverview(idleState());
      if (route.section === "audit") {
        setAudit(loadingState());
        setAuditChannelId(route.channelId);
        try {
          const response = await fetchAuditLog(route.channelId, null, controller.signal, route.auditFilters ?? emptyAuditFilter);
          if (!cancelled && !controller.signal.aborted) {
            setAudit(loadedState(response));
            setAuditChannelId(route.channelId);
          }
        } catch (error) {
          if (!cancelled && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
            setAudit({ status: "error", data: null, error: errorMessage(error) });
            if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
          }
        }
        return;
      }

      if (route.section !== "system") return;
      setSystem(loadingState());
      setSystemChannelId(route.channelId);
      try {
        const response = await fetchSystemOverview(route.channelId, controller.signal);
        if (!cancelled && !controller.signal.aborted) {
          setSystem(loadedState(response));
          setSystemChannelId(route.channelId);
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
          setSystem({ status: "error", data: null, error: errorMessage(error) });
          if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
        }
      }
    };
    void load();
    return cleanup;
  }, [cancelEventsRequest, cancelMembersRequest, finishEventsRequest, finishMembersRequest, isCurrentEventsRequest, isCurrentMembersRequest, route, startEventsRequest, startMembersRequest]);

  const handleModeratorStatusCheck = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "overview") return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "overview" });
    setModeratorCheck({ status: "loading", error: null, nextAllowedAt: null });
    try {
      const response = await refreshModeratorStatus(channelId);
      if (window.location.pathname !== routePath) return;
      setOverview((current) => {
        if (current.data === null || current.data.channelId !== channelId) return current;
        return {
          status: "success",
          data: mergeModeratorStatus(current.data, response.moderator),
          error: null,
          ...(current.loadedAt === undefined ? {} : { loadedAt: current.loadedAt }),
        };
      });
      setChannels((current) => current.data === null ? current : {
        ...current,
        data: current.data.map((channel) => channel.channelId !== channelId ? channel : mergeModeratorStatus(channel, response.moderator)),
      });
      setModeratorCheck({ status: "idle", error: null, nextAllowedAt: response.nextAllowedAt });
    } catch (error: unknown) {
      if (window.location.pathname !== routePath) return;
      setModeratorCheck({ status: "error", error: errorMessage(error), nextAllowedAt: nextAllowedAtFromError(error) });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    }
  };

  const reloadMembers = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "members") return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "members" });
    setLoadingNextMembersPage(false);
    const request = startMembersRequest();
    setMembers((current) => loadingState(current));
    try {
      const response = await fetchMembers(channelId, null, request.controller.signal);
      if (!isCurrentMembersRequest(request.generation) || request.controller.signal.aborted || window.location.pathname !== routePath) return;
      setMembers(loadedState(response));
    } catch (error) {
      if (!isCurrentMembersRequest(request.generation) || request.controller.signal.aborted || window.location.pathname !== routePath) return;
      setMembers((current) => current.loadedAt === undefined
        ? { status: "error", data: null, error: errorMessage(error) }
        : { status: "error", data: null, error: errorMessage(error), loadedAt: current.loadedAt });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      finishMembersRequest(request.generation);
    }
  };

  const reloadData = async <T,>(
    routePath: string,
    setState: LoadStateSetter<T>,
    fetchData: () => Promise<T>,
    preserveDataOnError: boolean,
    afterLoad?: () => void,
    /** Lets a superseded call discard its own response instead of overwriting a newer one. */
    isCurrent: () => boolean = () => true,
    mergeResponse?: (response: T, current: T | null) => T,
  ): Promise<void> => {
    setState((current) => loadingState(current));
    try {
      const response = await fetchData();
      if (!isCurrent() || window.location.pathname !== routePath) return;
      setState((current) => loadedState(mergeResponse?.(response, current.data) ?? response));
      afterLoad?.();
    } catch (error) {
      if (!isCurrent() || window.location.pathname !== routePath) return;
      setState((current) => current.loadedAt === undefined
        ? { status: "error", data: null, error: errorMessage(error) }
        : { status: "error", data: preserveDataOnError ? current.data : null, error: errorMessage(error), loadedAt: current.loadedAt });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    }
  };

  const reloadModules = async (): Promise<void> => {
    if (route.kind !== "channel" && route.kind !== "module") return;
    if (selectedChannel?.modules !== undefined) {
      await reloadChannels();
      return;
    }
    const channelId = route.channelId;
    const routePath = dashboardRoutePath(route);
    const generation = modulesRequestGeneration.current + 1;
    modulesRequestGeneration.current = generation;
    await reloadData(
      routePath,
      setModules,
      () => fetchModules(channelId),
      false,
      undefined,
      () => modulesRequestGeneration.current === generation,
    );
  };

  const reloadOverview = async (): Promise<void> => {
    if (route.kind !== "module" && !(route.kind === "channel" && route.section === "overview")) return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath(route);
    const generation = overviewRequestGeneration.current + 1;
    overviewRequestGeneration.current = generation;
    await reloadData(
      routePath,
      setOverview,
      () => fetchChannelOverview(channelId),
      true,
      () => setOverviewRoutePath(routePath),
      () => overviewRequestGeneration.current === generation,
      (response, current) => mergeAndRememberChannelStreamVersion(
        response,
        latestStreamByChannel.current,
        current?.channelId === channelId ? current : undefined,
      ),
    );
  };
  const reloadOverviewRef = useRef(reloadOverview);
  reloadOverviewRef.current = reloadOverview;
  useEffect(() => {
    const reconcileOnSocketConnect = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return;
      const channelId = Reflect.get(detail, "channelId") as unknown;
      const currentRoute = routeRef.current;
      if (typeof channelId === "string" &&
          (currentRoute.kind === "channel" || currentRoute.kind === "module") &&
          currentRoute.channelId === channelId) void reloadOverviewRef.current();
    };
    window.addEventListener("brobot:realtime-connected", reconcileOnSocketConnect);
    return () => window.removeEventListener("brobot:realtime-connected", reconcileOnSocketConnect);
  }, []);

  const reloadSystem = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "system") return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath(route);
    await reloadData(routePath, setSystem, () => fetchSystemOverview(channelId), true, () => setSystemChannelId(channelId));
  };

  const refreshChannelState = async (): Promise<void> => {
    await Promise.all([
      reloadChannels(),
      reloadOverview(),
      reloadSystem(),
    ]);
  };
  const refreshChannelStateRef = useRef(refreshChannelState);
  refreshChannelStateRef.current = refreshChannelState;
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === "visible") void refreshChannelStateRef.current();
    };
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 3 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(interval);
    };
  }, []);

  const expiryCandidates = [
    ...(channels.data ?? []).flatMap((channel) => [channel.tokens.botExpiresAt, channel.tokens.loginExpiresAt]
      .flatMap((value) => {
        const expiresAt = parseDate(value);
        return channels.loadedAt !== undefined && expiresAt !== null && expiresAt > channels.loadedAt
          ? [{ expiresAt, loadedAt: channels.loadedAt, channelId: channel.channelId }]
          : [];
      })),
    ...(overview.data === null ? [] : [overview.data.tokens.botExpiresAt, overview.data.tokens.loginExpiresAt]
      .flatMap((value) => {
        const expiresAt = parseDate(value);
        return overview.loadedAt !== undefined && expiresAt !== null && expiresAt > overview.loadedAt
          ? [{ expiresAt, loadedAt: overview.loadedAt, channelId: overview.data?.channelId ?? "" }]
          : [];
      })),
    ...(system.data === null ? [] : [system.data.tokens.botExpiresAt, system.data.tokens.loginExpiresAt]
      .flatMap((value) => {
        const expiresAt = parseDate(value);
        return system.loadedAt !== undefined && expiresAt !== null && expiresAt > system.loadedAt
          ? [{ expiresAt, loadedAt: system.loadedAt, channelId: systemChannelId ?? "" }]
          : [];
      })),
  ];
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
      expiryRefreshRef.current = expiryRefreshKey;
      setFreshnessTick((current) => current + 1);
      void refreshChannelStateRef.current();
    };
    timer = window.setTimeout(refreshWhenExpired, Math.min(Math.max(0, expiryAt - Date.now()), MAX_TIMER_DELAY_MS));
    return () => { if (timer !== null) window.clearTimeout(timer); };
  }, [expiryAt, expiryRefreshKey]);

  const toggleHeaderModule = async (): Promise<void> => {
    if (route.kind !== "module") return;
    const targetModuleId = route.moduleId;
    const state = (selectedChannel?.modules ?? modules.data?.modules ?? []).find((module) => module.id === targetModuleId);
    if (state === undefined || state.mandatory === true || targetModuleId === "channel_events" ||
        (selectedChannel !== null && !canManage(selectedChannel.role)) || headerModuleBusy) return;
    setHeaderModuleBusy(true);
    try {
      await setChannelModuleEnabled(route.channelId, targetModuleId, !state.enabled);
      await reloadModules();
      await reloadOverview();
    } catch (error) {
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      setHeaderModuleBusy(false);
    }
  };

  const loadNextMembersPage = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "members" || loadingNextMembersPage ||
        members.status === "loading" || members.data?.nextCursor === null || members.data?.nextCursor === undefined) return;
    const channelId = route.channelId;
    const cursor = members.data.nextCursor;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "members" });
    const request = startMembersRequest();
    setLoadingNextMembersPage(true);
    try {
      const nextPage = await fetchMembers(channelId, cursor, request.controller.signal);
      if (!isCurrentMembersRequest(request.generation) || request.controller.signal.aborted || window.location.pathname !== routePath) return;
      setMembers((current) => {
        if (current.data === null || current.data.nextCursor !== cursor) return current;
        return {
          status: "success",
          data: {
            members: [...current.data.members, ...nextPage.members],
            nextCursor: nextPage.nextCursor,
            // The count applies to the whole channel; the most recent response wins.
            broadcasterCount: nextPage.broadcasterCount,
            viewerUserId: nextPage.viewerUserId,
          },
          error: null,
          loadedAt: Date.now(),
        };
      });
    } catch (error) {
      if (!isCurrentMembersRequest(request.generation) || request.controller.signal.aborted || window.location.pathname !== routePath) return;
      setMembers((current) => ({ ...current, status: "error", error: errorMessage(error) }));
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      finishMembersRequest(request.generation);
      setLoadingNextMembersPage(false);
    }
  };

  const selectedChannel = useMemo(() => {
    if ((route.kind !== "channel" && route.kind !== "module") || channels.data === null) return null;
    return channels.data.find((channel) => channel.channelId === route.channelId) ?? null;
  }, [channels.data, route]);

  // Current workers include module state in GET /api/channels. Keep a
  // compatibility fallback for an older worker response that omits it.
  // Current page loads therefore need one request, including the sidebar.
  useEffect(() => {
    if ((route.kind !== "channel" && route.kind !== "module") || selectedChannel === null) {
      setModules(idleState());
      return;
    }
    if (selectedChannel.modules !== undefined) {
      setModules(loadedState({ modules: selectedChannel.modules }));
      return;
    }
    const controller = new AbortController();
    const routePath = dashboardRoutePath(route);
    setModules(loadingState());
    void fetchModules(route.channelId, controller.signal).then((response) => {
      if (!controller.signal.aborted && window.location.pathname + window.location.search === routePath) {
        setModules(loadedState(response));
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setModules({ status: "error", data: null, error: errorMessage(error) });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    });
    return () => controller.abort();
  }, [route, selectedChannel]);

  const overviewForHeader = overview.data !== null && selectedChannel !== null &&
    overview.data.channelId === selectedChannel.channelId &&
    overviewRoutePath === dashboardRoutePath(route)
    ? overview.data
    : null;
  const activeHeaderChannel = overviewForHeader ?? selectedChannel ?? undefined;
  const activeHeaderLoadedAt = overviewForHeader === null ? channels.loadedAt : overview.loadedAt;

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
      setChannels((current) => ({ ...current, error: errorMessage(error), status: "error" }));
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
      setChannels((current) => ({ ...current, error: errorMessage(error), status: "error" }));
    } finally {
      setLoggingOut(false);
    }
  };

  const loadNextAuditPage = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "audit" || loadingNextAuditPage ||
        audit.data?.nextCursor === null || audit.data?.nextCursor === undefined) return;
    const channelId = route.channelId;
    const cursor = audit.data.nextCursor;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "audit" });
    const controller = new AbortController();
    auditPageController.current = controller;
    setLoadingNextAuditPage(true);
    try {
      const nextPage = await fetchAuditLog(channelId, cursor, controller.signal, route.auditFilters ?? emptyAuditFilter);
      if (window.location.pathname !== routePath) return;
      setAudit((current) => {
        if (current.data === null || current.data.nextCursor !== cursor) return current;
        return {
          status: "success",
          data: { entries: [...current.data.entries, ...nextPage.entries], nextCursor: nextPage.nextCursor },
          error: null,
          ...(current.loadedAt === undefined ? {} : { loadedAt: current.loadedAt }),
        };
      });
    } catch (error) {
      if (controller.signal.aborted || window.location.pathname !== routePath) return;
      setAudit((current) => ({ ...current, status: "error", error: errorMessage(error) }));
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      if (auditPageController.current === controller) {
        auditPageController.current = null;
        setLoadingNextAuditPage(false);
      }
    }
  };

  const loadNextEventsPage = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "events" || loadingNextEventsPage ||
        eventsRequest.current.controller !== null || events.data?.nextCursor === null || events.data?.nextCursor === undefined) return;
    const channelId = route.channelId;
    const cursor = events.data.nextCursor;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "events" });
    const request = startEventsRequest();
    setLoadingNextEventsPage(true);
    try {
      const nextPage = await fetchEvents(channelId, cursor, request.controller.signal, route.filters ?? emptyEventFilter);
      if (!isCurrentEventsRequest(request.generation) || request.controller.signal.aborted || window.location.pathname !== routePath) return;
      setEvents((current) => {
        if (current.data === null || current.data.nextCursor !== cursor) return current;
        return {
          status: "success",
          data: { entries: [...current.data.entries, ...nextPage.entries], nextCursor: nextPage.nextCursor },
          error: null,
          ...(current.loadedAt === undefined ? {} : { loadedAt: current.loadedAt }),
        };
      });
    } catch (error) {
      if (!isCurrentEventsRequest(request.generation) || request.controller.signal.aborted || window.location.pathname !== routePath) return;
      setEvents((current) => ({ ...current, status: "error", error: errorMessage(error) }));
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      if (isCurrentEventsRequest(request.generation)) {
        finishEventsRequest(request.generation);
        setLoadingNextEventsPage(false);
      }
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
    return <UiProvider><main className="auth-screen"><div className="auth-card"><h1>{texts.signIn.required}</h1><p>{texts.signIn.explanation}</p><a className="button" href="/auth/login">{texts.signIn.signInWithTwitch}</a></div></main></UiProvider>;
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

  return (
    <UiProvider>
      <Shell
        header={<DashboardHeader route={route} channels={channels.data ?? []} activeChannel={activeHeaderChannel} loadedAt={activeHeaderLoadedAt} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} onRefreshState={refreshChannelState} />}
        navbar={(context) => <PanelSidebar route={route} channels={channels.data ?? []} platformAdmin={isPlatform} moduleStates={sidebarModuleStates} collapsed={context.collapsed} onToggleCollapsed={context.onToggleCollapsed} onEntryNavigate={context.closeMobileNav} onNavigate={navigate} />}
        navLabel={dashboardTexts().navigation.mainNavigation}
        openSidebarLabel={dashboardTexts().navigation.openSidebar}
        closeSidebarLabel={dashboardTexts().navigation.closeSidebar}
      >
        <div className="main-content">
        {channels.status === "loading" ? <p className="loading-line">{dashboardTexts().signIn.checkChannelAccess}</p> : null}
        {channels.error !== null ? <ErrorPanel message={channels.error} /> : null}
        {!showBotBlocking && route.kind === "overview" && channels.data !== null ? <OverviewPage channels={channels.data} loadedAt={channels.loadedAt} onNavigate={navigate} /> : null}
        {route.kind === "platform" && isPlatform ? <PlatformPage onAuthenticationRequired={requestLogin} /> : null}
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
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "overview" && overview.status === "loading" ? <p className="loading-line">{dashboardTexts().overview.loadState}</p> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "overview" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "overview" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} loadedAt={overview.loadedAt} moderatorCheck={moderatorCheck} onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }} onNavigate={navigate} modules={selectedChannel?.modules ?? overview.data.modules ?? modules.data?.modules ?? []} onModulesChanged={reloadModules} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "members" && selectedChannel !== null && (members.data !== null || members.status !== "idle") ? <MembersPage key={route.channelId} channelId={route.channelId} ownRole={selectedChannel.role} ownUserId={members.data?.viewerUserId ?? ""} members={members.data?.members ?? []} broadcasterCount={members.data?.broadcasterCount ?? 0} nextCursor={members.data?.nextCursor ?? null} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "variables" && selectedChannel !== null ? <ChannelVariablesPage key={route.channelId} channelId={route.channelId} canManage={canManage(selectedChannel.role)} onOpenCommand={(name) => { setPendingModuleSelection(name); navigate({ kind: "module", channelId: route.channelId, moduleId: "text_commands" }); }} onOpenOverlay={(overlayId) => { navigate({ kind: "channel", channelId: route.channelId, section: "overlays", overlayId }); }} onInitialSelectionConsumed={(name) => { setPendingVariableSelection((pending) => pending?.channelId === route.channelId && pending.name === name ? null : pending); }} {...(pendingVariableSelection?.channelId === route.channelId ? { initialSelection: pendingVariableSelection.name } : {})} /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "overlays" && selectedChannel !== null ? <OverlaysPage key={dashboardRoutePath(route)} channelId={route.channelId} canManage={canManage(selectedChannel.role)} {...(route.overlayId === undefined ? {} : { initialSelection: route.overlayId })} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "modules" && selectedChannel !== null ? <ModuleWorkspace key={dashboardRoutePath(route)} channelId={route.channelId} ownRole={selectedChannel.role} modules={selectedChannel.modules ?? modules.data?.modules ?? []} loading={modules.status === "loading"} error={modules.error} onNavigate={navigate} onChanged={reloadModules} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "module" && overview.status === "loading" ? <p className="loading-line">{dashboardTexts().overview.loadState}</p> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "module" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "module" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId && selectedChannel !== null ? <ModulePage key={dashboardRoutePath(route)} channelId={route.channelId} moduleId={route.moduleId} ownRole={selectedChannel.role} modules={selectedChannel.modules ?? modules.data?.modules ?? overview.data.modules ?? []} activeModules={overview.data.activeModules} loading={overview.status === "loading" || modules.status === "loading"} error={overview.error ?? modules.error} busy={headerModuleBusy} botIsModerator={overview.data.moderator?.isModerator ?? null} onNavigate={navigate} onToggle={() => { void toggleHeaderModule(); }} {...(pendingModuleSelection === null ? {} : { initialSelection: pendingModuleSelection })} /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "system" && system.status !== "idle" ? <SystemPage key={route.channelId} system={systemChannelId === route.channelId ? system.data : null} systemState={system} /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "audit" && audit.status !== "idle" ? <AuditPage key={route.channelId} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} filters={auditFilters} onFiltersChange={updateAuditFilters} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "events" && eventsChannelId === route.channelId && events.status !== "idle" ? <EventsPage key={route.channelId} channelId={route.channelId} eventsState={events} filters={eventFilters} moduleOptions={selectedChannel?.modules ?? modules.data?.modules ?? []} onFiltersChange={updateEventFilters} onRefreshFirstPage={reloadFirstEventsPage} onNextPage={() => { void loadNextEventsPage(); }} loadingNextPage={loadingNextEventsPage} /> : null}
        {(route.kind === "channel" || route.kind === "module") && selectedChannel !== null ? <ChannelSpotlight key={`spotlight-${route.channelId}`} channelId={route.channelId} ownRole={selectedChannel.role} isPlatformAdmin={isPlatform} {...(channels.status === "success" ? { botSignedIn } : {})} streamState={overviewForHeader === null ? selectedChannel.streamState : overviewForHeader.streamState} modules={selectedChannel.modules ?? modules.data?.modules ?? []} onNavigate={navigate} onOpenCommand={setPendingModuleSelection} onOpenVariable={(channelId, name) => { setPendingVariableSelection({ channelId, name }); }} /> : null}
        </div>
      </Shell>
    </UiProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <DashboardApp />
    </StrictMode>,
  );
}

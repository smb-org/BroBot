import { Fragment, StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import type {
  PanelAuditEntry,
  PanelAuditResponse,
  PanelBotPermissions,
  PanelBotStatus,
  PanelBroadcasterPermissions,
  PanelChannelOverview,
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
  setChannelModuleEnabled,
} from "./api";
import { Led, ModuleCount, ModuleHeading, ModuleIcon, ModulePage, ModuleTile, ModuleWorkspace, NavigationIcon, StateRow, type LedStatus, type StateTone } from "./module-panels";
import { MembersPage } from "./members";
import { PlatformPage } from "./platform";
import { platformTexts, channelPanelTexts, roleLabel } from "./labels";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatTimestamp as formatTimestampBase, formatNumber } from "./locale";
import { eventSubName, moduleName, statusWord } from "./module-labels";
import { dashboardRoutePath, useDashboardRoute, type DashboardRoute } from "./router";
import { truncateTo200Chars } from "../text";
import { BlockingState, ListDetail, Select as UiSelect, Shell, Sidebar, SubInspector, Switch as UiSwitch, UiProvider, useInspectorSelection, type SidebarEntry, type SidebarGroup, type SidebarModulesGroup } from "./ui";
import { EventsPage } from "./events/EventsPage";
import { chronological, emptyEventFilter, eventFilterIsActive } from "./events/model";
import { idleState, loadedState, loadingState, type LoadState, type LoadStateSetter } from "./load-state";
import "./styles.css";

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

const subscriptionTone = (status: PanelEventSubSubscription["status"]): StateTone =>
  status === "enabled" ? "healthy" : status === "missing" || status === "pending" ? "warning" : "error";

const subscriptionStatusLabel = (status: PanelEventSubSubscription["status"]): string => {
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

const tokenView = (tokens: PanelTokenStatus, bot: PanelBotStatus | null): TokenView => {
  const texts = dashboardTexts();
  if (bot?.status === "error" || bot?.status === "revoked") {
    return { tone: "error", label: statusLabel(bot.status) };
  }
  if (tokens.loginStatus === "error" || tokens.loginStatus === "revoked") {
    return { tone: "error", label: statusLabel(tokens.loginStatus) };
  }
  if (tokens.loginStatus === null) return { tone: "neutral", label: texts.status.loginIdentityMissing };
  const now = Date.now();
  const botExpiresAt = parseDate(tokens.botExpiresAt);
  const loginExpiresAt = parseDate(tokens.loginExpiresAt);
  if (botExpiresAt === null || loginExpiresAt === null) return { tone: "neutral", label: texts.status.notChecked };
  if (botExpiresAt <= now || loginExpiresAt <= now) return { tone: "error", label: texts.status.expired };
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

const channelStatus = (channel: PanelChannelState): "healthy" | "warning" | "error" => {
  if (channel.moderator?.isModerator === false) return "error";
  if (channel.chatSubscription?.status === "error" || channel.chatSubscription?.status === "revoked") return "error";
  if (channel.lastError?.source === "eventsub") return "error";
  if (channel.bot?.status === "error" || channel.bot?.status === "revoked") return "error";
  if (channel.botPermissions?.missingScopes.length) return "warning";
  if (broadcasterConsentMissing(channel.broadcasterPermissions)) return "warning";
  if (channel.tokens.loginStatus === "error" || channel.tokens.loginStatus === "revoked") return "error";
  const tokenStatus = tokenView(channel.tokens, channel.bot);
  if (tokenStatus.tone === "error") return "error";
  if (channelBotConsentMissing(channel)) return "warning";
  if (channel.chatSubscription == null) return "warning";
  if (channel.chatSubscription.status === "missing") return "warning";
  if (tokenStatus.tone !== "healthy") return "warning";
  if (channel.bot?.status !== "connected" || channel.moderator?.isModerator !== true ||
      channel.tokens.loginStatus !== "connected" || channel.tokens.botExpiresAt === null ||
      channel.tokens.loginExpiresAt === null || channelBotConsentMissing(channel)) return "warning";
  return "healthy";
};

const statusText = (channel: PanelChannelState): string => {
  const texts = dashboardTexts();
  if (channel.moderator?.isModerator === false) return texts.status.moderatorRoleMissing;
  if (channel.chatSubscription?.status === "error") return texts.status.chatSubscriptionError;
  if (channel.chatSubscription?.status === "revoked") return texts.status.chatSubscriptionRevoked;
  if (channel.lastError?.source === "eventsub") return texts.errors.last;
  if (channel.bot?.status === "error") return texts.status.botError;
  if (channel.bot?.status === "revoked") return texts.status.botTokenRevoked;
  if (channel.botPermissions?.missingScopes.length) return texts.status.botPermissionsMissing(formatNumber(channel.botPermissions.missingScopes.length));
  if (broadcasterConsentMissing(channel.broadcasterPermissions)) return channelPanelTexts().fullConsentMissing;
  const tokenStatus = tokenView(channel.tokens, channel.bot);
  if (channelBotConsentMissing(channel) && tokenStatus.tone === "healthy") return texts.status.broadcasterConsentMissing;
  if (channel.chatSubscription == null && !channelBotConsentMissing(channel)) return texts.status.chatSubscriptionMissing;
  if (channel.chatSubscription?.status === "missing") return texts.status.chatSubscriptionMissing;
  if (tokenStatus.tone !== "healthy") return tokenStatus.label;
  if (channelStatus(channel) === "healthy") return texts.status.healthy;
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

type PageLoadedAt = Record<"overview" | "system" | "members" | "modules" | "events", number | undefined>;

const loadedAtForRoute = (route: DashboardRoute, loadedAt: PageLoadedAt): number | undefined => {
  if (route.kind === "overview") return undefined;
  if (route.kind === "platform") return undefined;
  if (route.kind === "module") return loadedAt.modules;
  return loadedAt[route.section];
};

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
  const platformTextsValues = platformTexts();
  const navigationChannelId = route.kind === "channel" || route.kind === "module"
    ? route.channelId
    : channels[0]?.channelId ?? "";

  const sectionEntry = (section: "overview" | "system" | "members" | "events", label: string, iconKind: string): SidebarEntry => {
    const entryRoute: DashboardRoute = { kind: "channel", channelId: navigationChannelId, section };
    return {
      id: section,
      label,
      icon: <NavigationIcon kind={iconKind} className="sidebar-nav-icon" />,
      href: dashboardRoutePath(entryRoute),
      active: route.kind === "channel" && route.section === section,
      onNavigate: () => { onNavigate(entryRoute); },
    };
  };

  const operationGroup: SidebarGroup = {
    id: "operation",
    heading: texts.navigation.operationSection,
    entries: [sectionEntry("events", texts.navigation.events, "events")],
  };
  const channelGroup: SidebarGroup = {
    id: "channel",
    heading: texts.navigation.channel,
    entries: [
      sectionEntry("overview", texts.navigation.channel, "channel"),
      sectionEntry("system", texts.navigation.system, "system"),
      sectionEntry("members", texts.navigation.members, "members"),
    ],
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
  const allModulesRoute: DashboardRoute = { kind: "channel", channelId: navigationChannelId, section: "modules" };
  const modulesGroup: SidebarModulesGroup = {
    heading: texts.navigation.module,
    icon: <NavigationIcon kind="modules" className="sidebar-nav-icon" />,
    label: texts.navigation.module,
    active: route.kind === "module" || (route.kind === "channel" && route.section === "modules"),
    entries: activeModuleEntries,
    allEntry: {
      id: "all-modules",
      label: texts.module.moduleOverview,
      icon: <NavigationIcon kind="modules" className="sidebar-nav-icon" />,
      href: dashboardRoutePath(allModulesRoute),
      active: route.kind === "channel" && route.section === "modules",
      onNavigate: () => { onNavigate(allModulesRoute); },
    },
  };

  const platformGroup: SidebarGroup | undefined = platform ? {
    id: "platform",
    heading: platformTextsValues.navigation,
    entries: [{
      id: "platform",
      label: platformTextsValues.navigation,
      icon: <NavigationIcon kind="members" className="sidebar-nav-icon" />,
      href: dashboardRoutePath({ kind: "platform" }),
      active: route.kind === "platform",
      onNavigate: () => { onNavigate({ kind: "platform" }); },
    }],
  } : undefined;

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
  headerModule: { id: string; enabled: boolean } | undefined;
  headerModuleBusy: boolean;
  onToggleHeaderModule: () => void;
  onNavigate: (route: DashboardRoute) => void;
  onLogout: () => void;
  loggingOut: boolean;
}

/**
 * "Kopfleiste" (docs/input/DESIGN-neu.md): brand, channel `Select` up to
 * 280px with the Twitch id, connection LED, life-sign, and (on a module
 * page) the module's main switch -- `ui/Switch`, the same component the
 * future module list row uses. Sign-out closes it out.
 *
 * The channel `Select`'s options carry the Twitch id as plain text next to
 * the name rather than in a monospace secondary line: `ui/Select` only
 * renders a flat label per option, and extending it for a two-line,
 * icon-plus-LED option render is a separate, larger seam change.
 * ponytail: functional parity (the id stays visible and searchable), not
 * pixel parity. Upgrade path: a richer `SelectOption` shape in `ui/Select`
 * if the plain label stops being legible enough.
 */
const DashboardHeader = ({ route, channels, activeChannel, loadedAt, headerModule, headerModuleBusy, onToggleHeaderModule, onNavigate, onLogout, loggingOut }: DashboardHeaderProperties): ReactElement => {
  const texts = dashboardTexts();
  const tone = activeChannel === undefined ? "neutral" : channelStatus(activeChannel);
  const connectionLabel = activeChannel === undefined
    ? null
    : tone === "healthy" ? texts.header.connectionRunning : statusText(activeChannel);
  const connectionLed = connectionLabel === null ? null : <span className="led" data-status={tone === "healthy" ? "green" : tone === "warning" ? "amber" : "red"}><span className="led__dot" aria-hidden="true" /><span>{connectionLabel}</span></span>;
  const headerModuleLabel = headerModule === undefined ? null : `${moduleName(headerModule.id)} · ${statusWord(headerModule.enabled)}`;
  const managementLocked = activeChannel?.role === "operator";
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
        {connectionLed}
        {loadedAt === undefined ? null : <Datenalter seit={loadedAt} />}
      </div>
      {headerModule === undefined || headerModuleLabel === null ? null : (
        <div className="dashboard-header__switch">
          <UiSwitch
            label={headerModuleLabel}
            checked={headerModule.enabled}
            onChange={onToggleHeaderModule}
            pending={headerModuleBusy}
            {...(managementLocked ? { lockedReason: texts.module.managementLocked } : {})}
          />
        </div>
      )}
      <button className="button button--quiet dashboard-header__logout" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? texts.navigation.signingOut : texts.navigation.signOut}</button>
    </div>
  );
};

const OverviewPage = ({ channels, onNavigate }: { channels: PanelChannelState[]; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
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
              enabled={channelStatus(channel) === "healthy"}
              name={channel.displayName}
              ledStatus={channelToneToLedStatus(channelStatus(channel))}
              ledLabel={statusText(channel)}
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
const relativeZeit = (seit: number, jetzt: number): string => {
  const s = Math.max(0, Math.round((jetzt - seit) / 1000));
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
const Datenalter = ({ seit }: { seit: number }): ReactElement => {
  const [jetzt, setJetzt] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { setJetzt(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, []);
  return <span className="datenalter">{dashboardTexts().time.updated(relativeZeit(seit, jetzt))}</span>;
};

const ModeratorCheckAction = ({ canCheck, checking, checkError, nextAllowedAt, dringend, onCheck }: {
  canCheck: boolean; checking: boolean; checkError: string | null;
  nextAllowedAt: string | null; dringend: boolean; onCheck: () => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const [jetzt, setJetzt] = useState(() => Date.now());
  const nextAllowedAtMs = nextAllowedAt === null ? null : Date.parse(nextAllowedAt);
  useEffect(() => {
    if (nextAllowedAtMs === null || !Number.isFinite(nextAllowedAtMs)) return;
    const timeoutId = window.setTimeout(() => { setJetzt(Date.now()); }, Math.max(0, nextAllowedAtMs - Date.now()));
    return () => { window.clearTimeout(timeoutId); };
  }, [nextAllowedAtMs]);
  const cooldownActive = nextAllowedAtMs !== null && Number.isFinite(nextAllowedAtMs) && nextAllowedAtMs > jetzt;
  return (
    <div className="header-action">
      <button className={dringend ? "button button--primary" : "button"} type="button" onClick={onCheck} disabled={!canCheck || checking || cooldownActive} aria-busy={checking}>
        {checking ? texts.moderation.checkRunning : texts.moderation.checkModeratorStatus}
      </button>
      {nextAllowedAt === null ? null : <p className="muted moderator-check-time">{texts.moderation.nextCheckFrom(formatTimestamp(nextAllowedAt))}</p>}
      {!canCheck ? <span className="sperrgrund">{texts.moderation.checkLocked}</span> : null}
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
      {!canRequest ? <span className="sperrgrund">{texts.moderation.broadcasterReauthorize}</span> : null}
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
      {!canRequest ? <span className="sperrgrund">{texts.fullConsentLocked}</span> : null}
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
  return { key: "bot", tone, node: <StateRow label={texts.statusCard.botAccount} tone={tone} word={statusLabel(bot.status)} detail={bot.reason ?? texts.bot.lastUpdated(formatTimestamp(bot.updatedAt))} /> };
};

const broadcasterRow = (status: PanelChannelState["broadcasterConnection"]): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = status === "connected" ? "healthy" : "neutral";
  return { key: "broadcaster", tone, node: <StateRow label={texts.statusCard.broadcasterOauth} tone={tone} word={broadcasterConnectionLabel(status)} detail={status === "connected" ? texts.bot.optionalModules : texts.bot.normalOperation} /> };
};

const chatRow = (status: PanelChannelState["chatSubscription"] | undefined, expected = false): StatusEntry => {
  const texts = dashboardTexts();
  const current = status ?? null;
  const tone: StateTone = current === null ? expected ? "warning" : "neutral" : current.status === "enabled" ? "healthy" : current.status === "missing" ? "warning" : "error";
  const word = current === null ? expected ? texts.status.missing : texts.status.notChecked : current.status === "enabled" ? texts.status.active : current.status === "missing" ? texts.status.missing : current.status === "revoked" ? texts.status.revoked : texts.status.error;
  return { key: "chat-subscription", tone, node: <StateRow label={texts.statusCard.chatSubscription} tone={tone} word={word} detail={current?.reason ?? (current === null && expected ? texts.status.chatSubscriptionMissing : undefined)} /> };
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

const broadcasterPermissionsRow = (permissions: PanelBroadcasterPermissions | null | undefined): StatusEntry | null => {
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
    />,
  };
};

const tokenRow = (tokens: PanelTokenStatus, bot: PanelBotStatus | null): StatusEntry => {
  const texts = dashboardTexts();
  const token = tokenView(tokens, bot);
  return { key: "token", tone: token.tone, node: <StateRow label={texts.statusCard.tokenStatus} tone={token.tone} word={token.label} detail={tokens.loginReason ?? undefined} /> };
};

const channelBotConsentRow = (status: PanelChannelState["channelBotConsent"]): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = status === "missing" ? "warning" : "healthy";
  return { key: "channel-bot-consent", tone, node: <StateRow label={texts.statusCard.chatConsent} tone={tone} word={status === "missing" ? texts.statusCard.broadcasterConsentMissing : texts.status.present} detail={status === "missing" ? texts.statusCard.chatBotRequired : undefined} /> };
};

const moderatorRow = (moderator: PanelModeratorStatus | null): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = moderator === null ? "neutral" : moderator.isModerator ? "healthy" : "error";
  const word = moderator === null ? texts.status.notChecked : moderator.isModerator ? texts.status.moderator : texts.status.moderatorRoleMissing;
  const detail = moderator === null
    ? texts.moderation.noCheckForChannel
    : moderator.reason ?? texts.moderation.lastCheck(formatTimestamp(moderator.checkedAt));
  return { key: "moderator", tone, node: <StateRow label={texts.statusCard.moderatorStatus} tone={tone} word={word} detail={detail} /> };
};

const lastErrorRow = (error: PanelLastError | null): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = error === null ? "healthy" : "error";
  if (error === null) {
    return { key: "fehler", tone, node: <StateRow label={texts.errors.last} tone={tone} word={texts.status.healthy} detail={texts.errors.noCause} /> };
  }
  const aboName = error.source === "eventsub" && error.subscriptionType !== undefined
    ? eventSubName(error.subscriptionType, error.subscriptionVariant ?? "")
    : null;
  const reason = aboName === null ? error.reason : `${aboName}: ${error.reason}`;
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
      <ul className="scope-liste">{permissions.missingScopes.map((scope) => <li className="mono" key={scope}>{scope}</li>)}</ul>
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
      <ul className="scope-liste">{permissions.missingScopes.map((scope) => <li className="mono" key={scope}>{scope}</li>)}</ul>
    </section>
  );
};

const subscriptionKey = (subscription: PanelEventSubSubscription): string =>
  `${subscription.subscriptionType}\u0000${subscription.variant}\u0000${subscription.version}`;

const subscriptionDisplayName = (subscription: PanelEventSubSubscription): string =>
  eventSubName(subscription.subscriptionType, subscription.variant);

const SubscriptionsSection = ({ subscriptions }: { subscriptions: PanelEventSubSubscription[] }): ReactElement => {
  const texts = dashboardTexts();
  const leer = "—";
  const { selectedKey, select, rowRef, close } = useInspectorSelection<string>();
  const selected = subscriptions.find((subscription) => subscriptionKey(subscription) === selectedKey) ?? null;
  return (
    <section className={`content-section inspektor-bereich${selected === null ? "" : " inspektor-bereich--offen"}`} aria-label={texts.system.subscriptions}>
      <div className="inspektor-bereich__liste">
        <div className="section-heading"><h2>{texts.system.subscriptions}</h2><span className="muted zahl">{formatNumber(subscriptions.length)}</span></div>
        {subscriptions.length === 0 ? <p className="empty-state">{texts.system.noSubscriptions}</p> : (
          <div className="tabelle-wrap">
            <table className="tabelle abonnements-tabelle">
              <thead><tr><th scope="col">{texts.system.subscription}</th><th scope="col">{texts.system.state}</th><th scope="col">{texts.system.reason}</th></tr></thead>
              <tbody>{subscriptions.map((subscription) => {
                const key = subscriptionKey(subscription);
                const name = subscriptionDisplayName(subscription);
                const unknown = name === subscription.subscriptionType;
                const tone = subscriptionTone(subscription.status);
                return <tr
                  key={key}
                  ref={rowRef(key)}
                  tabIndex={0}
                  aria-selected={selectedKey === key}
                  onClick={() => { select(key); }}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(key); } }}
                >
                  <th scope="row"><span className={unknown ? "mono" : undefined}>{name}</span></th>
                  <td><Led status={channelToneToLedStatus(tone)} label={subscriptionStatusLabel(subscription.status)} /></td>
                  <td>{subscription.reason ?? leer}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </div>
      {selected === null ? null : <SubInspector ariaLabel={texts.system.subscriptionDetails} title={subscriptionDisplayName(selected)} identifier={selected.subscriptionId ?? leer} closeLabel={dashboardCommonTexts().close} onClose={close}>
        <dl className="properties">
          <div><dt>{texts.system.subscriptionRawType}</dt><dd className="mono">{selected.subscriptionType}</dd></div>
          <div><dt>{texts.system.subscriptionVersion}</dt><dd className="mono">{selected.version}</dd></div>
          <div><dt>{texts.system.subscriptionId}</dt><dd className="mono">{selected.subscriptionId ?? leer}</dd></div>
          <div><dt>{texts.system.subscriptionUpdated}</dt><dd className="mono">{formatTimestamp(selected.updatedAt)}</dd></div>
          <div><dt>{texts.system.twitchMessage}</dt><dd>{selected.message ?? leer}</dd></div>
          <div><dt>{texts.system.httpStatus}</dt><dd className="mono">{selected.statusCode === null ? leer : String(selected.statusCode)}</dd></div>
        </dl>
      </SubInspector>}
    </section>
  );
};

interface ChannelOverviewPageProperties {
  overview: PanelChannelOverview;
  moderatorCheck: ModeratorCheckState;
  onCheckModeratorStatus: () => void;
  onNavigate: (route: DashboardRoute) => void;
}

const ChannelOverviewPage = ({ overview, moderatorCheck, onCheckModeratorStatus, onNavigate }: ChannelOverviewPageProperties): ReactElement => {
  const entries = sortBySeverity([
    broadcasterRow(overview.broadcasterConnection),
    channelBotConsentRow(overview.channelBotConsent),
    chatRow(overview.chatSubscription, overview.channelBotConsent === "granted"),
    moderatorRow(overview.moderator),
    botRow(overview.bot),
    botPermissionsRow(overview.botPermissions),
    broadcasterPermissionsRow(overview.broadcasterPermissions),
    tokenRow(overview.tokens, overview.bot),
    lastErrorRow(overview.lastError),
  ].filter((entry): entry is StatusEntry => entry !== null));

  return (
    <>
      <ModuleHeading
        kind="channel"
        title={overview.displayName}
        subtitle={roleLabel(overview.role)}
        actions={<><ModeratorCheckAction canCheck={overview.role !== "operator"} checking={moderatorCheck.status === "loading"} checkError={moderatorCheck.error} nextAllowedAt={moderatorCheck.nextAllowedAt} dringend={overview.moderator === null || !overview.moderator.isModerator} onCheck={onCheckModeratorStatus} /><ChannelBotConsentAction channelId={overview.channelId} needed={overview.channelBotConsent === "missing"} canRequest={overview.role === "broadcaster"} /><BroadcasterConsentAction login={overview.login} needed={broadcasterConsentMissing(overview.broadcasterPermissions)} canRequest={overview.role === "broadcaster"} /></>}
      />
      <div className="zustand-liste">{entries.map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
      <BotPermissionsInspector permissions={overview.botPermissions} />
      <BroadcasterPermissionsInspector permissions={overview.broadcasterPermissions} />
      <section className="content-section"><div className="section-heading"><h2>{dashboardTexts().overview.activeModules}</h2><span className="muted zahl">{formatNumber(overview.activeModules.length)}</span></div>{overview.activeModules.length === 0 ? <p className="empty-state">{dashboardTexts().module.noneActive}</p> : <div className="module-grid">{overview.activeModules.map(({ moduleId }) => <ModuleTile key={moduleId} channelId={overview.channelId} moduleId={moduleId} enabled onNavigate={onNavigate} />)}</div>}</section>
    </>
  );
};

interface SystemPageProperties {
  system: PanelSystemResponse | null;
  systemState: LoadState<PanelSystemResponse>;
  auditState: LoadState<PanelAuditResponse>;
  onNextPage: () => void;
  loadingNextPage: boolean;
}

const SystemPage = ({ system, systemState, auditState, onNextPage, loadingNextPage }: SystemPageProperties): ReactElement => {
  const texts = dashboardTexts();
  const { selectedKey: selectedAuditId, select: selectAudit, rowRef: auditRowRef, close: closeAudit } = useInspectorSelection<string>();
  const selectedAudit = auditState.data?.entries.find((entry) => entry.auditId === selectedAuditId) ?? null;
  return (
    <>
      <ModuleHeading kind="system" title={texts.system.title} subtitle={texts.system.readOnly} />
      {system === null && systemState.status === "loading" ? <p className="loading-line">{texts.system.loadState}</p> : null}
      {systemState.error !== null ? <ErrorPanel message={systemState.error} /> : null}
      {system === null ? null : <>
        <div className="zustand-liste">{[broadcasterRow(system.broadcasterConnection), chatRow(system.chatSubscription), botRow(system.bot), botPermissionsRow(system.botPermissions), broadcasterPermissionsRow(system.broadcasterPermissions), tokenRow(system.tokens, system.bot)].filter((entry): entry is StatusEntry => entry !== null).map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
        <BotPermissionsInspector permissions={system.botPermissions} />
        <BroadcasterPermissionsInspector permissions={system.broadcasterPermissions} />
        <SubscriptionsSection subscriptions={system.subscriptions ?? []} />
        <SystemProperties system={system} />
      </>}
      <ListDetail
        onCloseInspector={closeAudit}
        list={
          <section className="content-section" aria-label={texts.system.auditLog}>
            <div className="section-heading"><h2>{texts.system.auditLog}</h2>{auditState.data === null ? null : <span className="muted"><span className="zahl">{formatNumber(auditState.data.entries.length)}</span> {texts.system.entries}</span>}</div>
            {auditState.status === "loading" && auditState.data === null ? <p className="loading-line">{texts.system.loadAudit}</p> : null}
            {auditState.error !== null ? <ErrorPanel message={auditState.error} /> : null}
            {auditState.data !== null && auditState.data.entries.length === 0 ? <p className="empty-state">{texts.system.noAuditEntries}</p> : null}
            {auditState.data !== null && auditState.data.entries.length > 0 ? <>
              <div className={auditState.status === "loading" ? "veraltet" : undefined}>
                <table className="tabelle audit-table">
                  <thead><tr><th scope="col">{texts.system.time}</th><th scope="col">{texts.system.action}</th><th scope="col">{texts.system.who}</th></tr></thead>
                  <tbody>{auditState.data.entries.map((entry) => <tr key={entry.auditId} ref={auditRowRef(entry.auditId)} tabIndex={0} aria-selected={selectedAuditId === entry.auditId} onClick={() => { selectAudit(entry.auditId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectAudit(entry.auditId); } }}><td className="mono">{formatTimestamp(entry.createdAt)}</td><th scope="row" className="mono">{entry.action}</th><td>{auditActorLabel(entry)}</td></tr>)}</tbody>
                </table>
              </div>
              {auditState.data.nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? texts.system.loadingOlderEntries : texts.system.olderEntries}</button>}
            </> : null}
          </section>
        }
        inspector={selectedAudit === null ? null : (
          <SubInspector ariaLabel={texts.system.changeData} title={selectedAudit.action} identifier={selectedAudit.auditId} closeLabel={dashboardCommonTexts().close} onClose={closeAudit}>
            <dl className="properties"><div><dt>{texts.system.who}</dt><dd className="mono">{selectedAudit.actorUserId}</dd></div></dl>
            <div className="inspector-columns"><div><h4>{texts.system.before}</h4><pre>{selectedAudit.before}</pre></div><div><h4>{texts.system.after}</h4><pre>{selectedAudit.after}</pre></div></div>
          </SubInspector>
        )}
      />
    </>
  );
};

const SystemProperties = ({ system }: { system: PanelSystemResponse }): ReactElement => {
  const texts = dashboardTexts();
  const leer = "—";
  const loginStatus = system.tokens.loginStatus === null ? leer : statusLabel(system.tokens.loginStatus);
  return (
    <section className="content-section properties-section" aria-label={texts.system.properties}>
      <div className="section-heading"><h2>{texts.system.properties}</h2></div>
      <dl className="properties">
        <div><dt>{texts.system.botReason}</dt><dd>{system.bot?.reason ?? leer}</dd></div>
        <div><dt>{texts.system.botUpdated}</dt><dd className="mono">{system.bot === null ? leer : formatTimestamp(system.bot.updatedAt)}</dd></div>
        <div><dt>{texts.system.chatSubscriptionId}</dt><dd className="mono">{system.chatSubscription?.subscriptionId ?? leer}</dd></div>
        <div><dt>{texts.system.chatSubscriptionReason}</dt><dd>{system.chatSubscription?.reason ?? leer}</dd></div>
        <div><dt>{texts.system.chatSubscriptionUpdated}</dt><dd className="mono">{system.chatSubscription == null ? leer : formatTimestamp(system.chatSubscription.updatedAt)}</dd></div>
        <div><dt>{texts.system.loginStatus}</dt><dd>{loginStatus}</dd></div>
        <div><dt>{texts.system.loginReason}</dt><dd>{system.tokens.loginReason ?? leer}</dd></div>
        <div><dt>{texts.system.loginValidUntil}</dt><dd className="mono">{system.tokens.loginExpiresAt === null ? leer : formatTimestamp(system.tokens.loginExpiresAt)}</dd></div>
        <div><dt>{texts.system.botValidUntil}</dt><dd className="mono">{system.tokens.botExpiresAt === null ? leer : formatTimestamp(system.tokens.botExpiresAt)}</dd></div>
      </dl>
    </section>
  );
};

const auditActorLabel = (entry: PanelAuditEntry): string =>
  entry.actorDisplayName ?? (entry.actorLogin == null ? entry.actorUserId : `@${entry.actorLogin}`);

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
  const [channels, setChannels] = useState<LoadState<PanelChannelState[]>>(() => idleState());
  const [isPlatform, setIsPlatform] = useState(false);
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
  const requestLogin = useCallback((): void => { setAuthenticationRequired(true); }, []);

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
    let cancelled = false;
    const load = async (): Promise<void> => {
      setChannels(loadingState());
      try {
        const response = await fetchChannels();
        if (!cancelled) {
          setChannels({ status: "success", data: response.channels, error: null });
          setIsPlatform(response.platformAdmin);
          setInstallationBot(response.bot);
          setAuthenticationRequired(false);
        }
      } catch (error) {
        if (!cancelled) {
          setChannels({ status: "error", data: null, error: errorMessage(error) });
          if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (route.kind === "platform" && channels.status === "success" && !isPlatform) {
      navigate({ kind: "overview" });
    }
  }, [channels.status, isPlatform, navigate, route.kind]);

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

    // The sidebar's Modules group lists the active modules on every
    // channel/module route, not only the ones that already fetch this for
    // their own page (the module detail page, the module list, the event
    // filters) -- one fetch here covers all of them; those keep their own
    // fetch removed below instead of doing it twice.
    const loadSidebarModules = async (): Promise<void> => {
      setModules(loadingState());
      try {
        const response = await fetchModules(route.channelId, controller.signal);
        if (!cancelled && !controller.signal.aborted) setModules(loadedState(response));
      } catch (error) {
        if (!cancelled && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
          setModules({ status: "error", data: null, error: errorMessage(error) });
          if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
        }
      }
    };
    void loadSidebarModules();

    const load = async (): Promise<void> => {
      // The module page shows the same channel header as the overview and
      // therefore needs the same data.
      if (route.kind === "module" || route.section === "overview") {
        try {
          const response = await fetchChannelOverview(route.channelId, controller.signal);
          if (!cancelled) {
            setOverview(loadedState(response));
            setOverviewRoutePath(expectedOverviewPath);
          }
        } catch (error) {
          if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
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
      setSystem(loadingState());
      setAudit(loadingState());
      setSystemChannelId(route.channelId);
      setAuditChannelId(route.channelId);
      const loadSystem = async (): Promise<void> => {
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
      const loadAudit = async (): Promise<void> => {
        try {
          const response = await fetchAuditLog(route.channelId, null, controller.signal);
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
      };
      void loadSystem();
      void loadAudit();
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

  const reloadData = async <T,>(routePath: string, setState: LoadStateSetter<T>, fetchData: () => Promise<T>, preserveDataOnError: boolean, afterLoad?: () => void): Promise<void> => {
    setState((current) => loadingState(current));
    try {
      const response = await fetchData();
      if (window.location.pathname !== routePath) return;
      setState(loadedState(response));
      afterLoad?.();
    } catch (error) {
      if (window.location.pathname !== routePath) return;
      setState((current) => current.loadedAt === undefined
        ? { status: "error", data: null, error: errorMessage(error) }
        : { status: "error", data: preserveDataOnError ? current.data : null, error: errorMessage(error), loadedAt: current.loadedAt });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    }
  };

  const reloadModules = async (): Promise<void> => {
    if (route.kind !== "module" && (route.kind !== "channel" || route.section !== "modules")) return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath(route);
    await reloadData(routePath, setModules, () => fetchModules(channelId), false);
  };

  const reloadOverview = async (): Promise<void> => {
    if (route.kind !== "module") return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath(route);
    await reloadData(routePath, setOverview, () => fetchChannelOverview(channelId), true, () => setOverviewRoutePath(routePath));
  };

  const toggleHeaderModule = async (): Promise<void> => {
    if (route.kind !== "module" || modules.data === null) return;
    const targetModuleId = route.moduleId;
    const state = modules.data.modules.find((module) => module.id === targetModuleId);
    if (state === undefined || selectedChannel?.role === "operator" || headerModuleBusy) return;
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

  const loadNextAuditPage = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "system" || loadingNextAuditPage ||
        audit.data?.nextCursor === null || audit.data?.nextCursor === undefined) return;
    const channelId = route.channelId;
    const cursor = audit.data.nextCursor;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "system" });
    const controller = new AbortController();
    auditPageController.current = controller;
    setLoadingNextAuditPage(true);
    try {
      const nextPage = await fetchAuditLog(channelId, cursor, controller.signal);
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

  if (authenticationRequired) {
    const texts = dashboardTexts();
    return <UiProvider><main className="auth-screen"><div className="auth-card"><h1>{texts.signIn.required}</h1><p>{texts.signIn.explanation}</p><a className="button" href="/auth/login">{texts.signIn.signInWithTwitch}</a></div></main></UiProvider>;
  }

  const sidebarModuleStates = route.kind === "channel" || route.kind === "module" ? modules.data?.modules ?? null : null;

  const botSignedIn = installationBot?.status === "connected";
  const isChannelOrModuleRoute = route.kind === "channel" || route.kind === "module";
  // Installation-wide, so it applies wherever page content depends on the
  // bot -- including the overview, the first page everyone lands on (a
  // fresh installation with zero released channels has nowhere else to
  // say it). The system page (bot status + sign-in live there) and the
  // platform page (releases channels) must stay reachable, or the block
  // would also lock the only places that fix it.
  const botBlockingApplies = route.kind === "overview" || route.kind === "module" || (route.kind === "channel" && route.section !== "system");
  const showBotBlocking = botBlockingApplies && channels.status === "success" && !botSignedIn;
  // Per-user/channel authorization, not an outage -- loses to the bot state
  // above: installation-wide beats per-viewer, and without the bot nothing
  // works on any channel regardless of whether this one is released.
  const showChannelNotReleased = !showBotBlocking && isChannelOrModuleRoute && selectedChannel === null && channels.status === "success";

  return (
    <UiProvider>
      <Shell
        header={<DashboardHeader route={route} channels={channels.data ?? []} activeChannel={selectedChannel ?? undefined} loadedAt={loadedAtForRoute(route, { overview: overview.loadedAt, system: system.loadedAt, members: members.loadedAt, modules: modules.loadedAt, events: events.loadedAt })} headerModule={route.kind === "module" ? modules.data?.modules.find((module) => module.id === route.moduleId) : undefined} headerModuleBusy={headerModuleBusy} onToggleHeaderModule={() => { void toggleHeaderModule(); }} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} />}
        navbar={(context) => <PanelSidebar route={route} channels={channels.data ?? []} platformAdmin={isPlatform} moduleStates={sidebarModuleStates} collapsed={context.collapsed} onToggleCollapsed={context.onToggleCollapsed} onEntryNavigate={context.closeMobileNav} onNavigate={navigate} />}
        navLabel={dashboardTexts().navigation.mainNavigation}
        openSidebarLabel={dashboardTexts().navigation.openSidebar}
        closeSidebarLabel={dashboardTexts().navigation.closeSidebar}
      >
        <div className="main-content">
        {channels.status === "loading" ? <p className="loading-line">{dashboardTexts().signIn.checkChannelAccess}</p> : null}
        {channels.error !== null ? <ErrorPanel message={channels.error} /> : null}
        {!showBotBlocking && route.kind === "overview" && channels.data !== null ? <OverviewPage channels={channels.data} onNavigate={navigate} /> : null}
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
          description={isPlatform ? dashboardTexts().blocking.botDescriptionAdmin : dashboardTexts().blocking.botDescriptionViewer}
          {...(isPlatform
            ? { action: { label: dashboardTexts().blocking.botAction, onClick: () => { window.location.href = "/auth/bot/login"; } } }
            : { contact: dashboardTexts().blocking.botContact })}
        /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "overview" && overview.status === "loading" ? <p className="loading-line">{dashboardTexts().overview.loadState}</p> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "overview" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "overview" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} moderatorCheck={moderatorCheck} onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }} onNavigate={navigate} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "members" && selectedChannel !== null && (members.data !== null || members.status !== "idle") ? <MembersPage key={route.channelId} channelId={route.channelId} ownRole={selectedChannel.role} ownUserId={members.data?.viewerUserId ?? ""} members={members.data?.members ?? []} broadcasterCount={members.data?.broadcasterCount ?? 0} nextCursor={members.data?.nextCursor ?? null} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "modules" && selectedChannel !== null ? <ModuleWorkspace key={dashboardRoutePath(route)} channelId={route.channelId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} loading={modules.status === "loading"} error={modules.error} onNavigate={navigate} onChanged={reloadModules} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "module" && overview.status === "loading" ? <p className="loading-line">{dashboardTexts().overview.loadState}</p> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "module" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "module" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId && selectedChannel !== null ? <ModulePage key={dashboardRoutePath(route)} channelId={route.channelId} moduleId={route.moduleId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} activeModules={overview.data.activeModules} loading={modules.status === "loading" || overview.status === "loading"} error={modules.error} busy={headerModuleBusy} onNavigate={navigate} onToggle={() => { void toggleHeaderModule(); }} /> : null}
        {!showChannelNotReleased && route.kind === "channel" && route.section === "system" && (system.status !== "idle" || audit.status !== "idle") ? <SystemPage key={route.channelId} system={systemChannelId === route.channelId ? system.data : null} systemState={system} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
        {!showChannelNotReleased && !showBotBlocking && route.kind === "channel" && route.section === "events" && eventsChannelId === route.channelId && events.status !== "idle" ? <EventsPage key={route.channelId} channelId={route.channelId} eventsState={events} filters={eventFilters} moduleOptions={modules.data?.modules ?? []} onFiltersChange={updateEventFilters} onRefreshFirstPage={reloadFirstEventsPage} onNextPage={() => { void loadNextEventsPage(); }} loadingNextPage={loadingNextEventsPage} /> : null}
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

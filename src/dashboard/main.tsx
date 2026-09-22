import { Fragment, StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
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
import { EVENT_TONES, type EventTone } from "../contracts/values";
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
import { SubInspector } from "./inspector";
import { useInspectorSelection } from "./inspector-selection";
import { MembersPage } from "./members";
import { PlatformPage } from "./platform";
import { platformTexts, channelPanelTexts, roleLabel } from "./labels";
import { dashboardCommonTexts, dashboardLanguage, dashboardTexts, eventText, eventToneEntries, formatTimestamp as formatTimestampBase, formatZahl, type EventCode, type EventDetail, type EventNumberKey } from "./locale";
import { disabledStatusWord, eventSubName, moduleName, statusWord } from "./module-labels";
import { useRealtimeEventFeed, type RealtimeFeedStatus } from "./realtime";
import { dashboardRoutePath, useDashboardRoute, type DashboardRoute } from "./router";
import { kuerzeAuf200Zeichen } from "../text";
import "./styles.css";

interface LoadState<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
  /** Wann diese Antwort eintraf. Traegt das Datenalter in der Anzeige. */
  loadedAt?: number;
}

type LoadStateSetter<T> = (value: LoadState<T> | ((current: LoadState<T>) => LoadState<T>)) => void;

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

const emptyEventFilter: PanelEventFilters = {
  origin: null,
  module: null,
  tone: null,
  person: null,
};

const PERSON_FILTER_DEBOUNCE_MS = 300;

const idleModeratorCheck = (): ModeratorCheckState => ({
  status: "idle",
  error: null,
  nextAllowedAt: null,
});

const idleState = <T,>(): LoadState<T> => ({ status: "idle", data: null, error: null });
const loadingState = <T,>(current?: LoadState<T>): LoadState<T> => {
  const next: LoadState<T> = { status: "loading", data: current?.data ?? null, error: null };
  if (current?.loadedAt !== undefined) next.loadedAt = current.loadedAt;
  return next;
};

const loadedState = <T,>(data: T): LoadState<T> => ({ status: "success", data, error: null, loadedAt: Date.now() });

const statusLabel = (status: PanelBotStatus["status"]): string => {
  const texts = dashboardTexts();
  if (status === "connected") return texts.status.verbunden;
  if (status === "revoked") return texts.status.widerrufen;
  return texts.status.fehler;
};

const subscriptionTone = (status: PanelEventSubSubscription["status"]): StateTone =>
  status === "enabled" ? "healthy" : status === "missing" || status === "pending" ? "warning" : "error";

const subscriptionStatusLabel = (status: PanelEventSubSubscription["status"]): string => {
  const texts = dashboardTexts();
  if (status === "enabled") return texts.status.aktiv;
  if (status === "missing") return texts.status.missing;
  if (status === "pending") return texts.status.ausstehend;
  if (status === "revoked") return texts.status.widerrufen;
  return texts.status.fehler;
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
 * Ein Token, das turnusmäßig bald abläuft, ist kein Problem — der Cron erneuert
 * es beim nächsten Lauf. Ein Problem ist erst, wenn die Erneuerung ausbleibt.
 *
 * Deshalb genügt die Restlaufzeit als Schwelle nicht: Bei vierstündigen Twitch-
 * Tokens und stündlichem Cron liegt jedes Token regelmäßig bis zu einer Stunde
 * im Erneuerungsfenster, ohne dass etwas kaputt wäre. Überfällig ist es erst,
 * wenn seit dem Zeitpunkt, ab dem der Cron hätte erneuern müssen, bereits ein
 * Wartungslauf stattgefunden hat und das Token trotzdem noch im Fenster steht.
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
  if (tokens.loginStatus === null) return { tone: "neutral", label: texts.status.loginIdentitaetFehlt };
  const now = Date.now();
  const botExpiresAt = parseDate(tokens.botExpiresAt);
  const loginExpiresAt = parseDate(tokens.loginExpiresAt);
  if (botExpiresAt === null || loginExpiresAt === null) return { tone: "neutral", label: texts.status.nichtGeprueft };
  if (botExpiresAt <= now || loginExpiresAt <= now) return { tone: "error", label: texts.status.abgelaufen };
  if (bot?.status !== "connected") return { tone: "neutral", label: texts.status.nichtGeprueft };
  const lastMaintenanceAt = parseDate(bot.updatedAt);
  if (lastMaintenanceAt === null || lastMaintenanceAt <= now - BOT_MAINTENANCE_STALE_AFTER_MS) {
    return { tone: "warning", label: texts.status.wartungUeberfaellig };
  }
  if (renewalOverdue(botExpiresAt, lastMaintenanceAt, now) ||
      renewalOverdue(loginExpiresAt, lastMaintenanceAt, now)) {
    return { tone: "warning", label: texts.status.erneuerungUeberfaellig };
  }
  return { tone: "healthy", label: texts.status.gueltig };
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
  if (channel.moderator?.isModerator === false) return texts.status.moderatorrolleFehlt;
  if (channel.chatSubscription?.status === "error") return texts.status.chatAboFehler;
  if (channel.chatSubscription?.status === "revoked") return texts.status.chatAboWiderrufen;
  if (channel.lastError?.source === "eventsub") return texts.fehler.letzter;
  if (channel.bot?.status === "error") return texts.status.botFehler;
  if (channel.bot?.status === "revoked") return texts.status.botTokenWiderrufen;
  if (channel.botPermissions?.missingScopes.length) return texts.status.botBerechtigungenFehlen(formatZahl(channel.botPermissions.missingScopes.length));
  if (broadcasterConsentMissing(channel.broadcasterPermissions)) return channelPanelTexts().fullConsentMissing;
  const tokenStatus = tokenView(channel.tokens, channel.bot);
  if (channelBotConsentMissing(channel) && tokenStatus.tone === "healthy") return texts.status.broadcasterConsentMissing;
  if (channel.chatSubscription == null && !channelBotConsentMissing(channel)) return texts.status.chatAboFehlt;
  if (channel.chatSubscription?.status === "missing") return texts.status.chatAboFehlt;
  if (tokenStatus.tone !== "healthy") return tokenStatus.label;
  if (channelStatus(channel) === "healthy") return texts.status.gesund;
  return texts.status.stateIncomplete;
};

const channelToneToLedStatus = (tone: StateTone): LedStatus =>
  tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off";

const broadcasterConnectionLabel = (status: PanelChannelState["broadcasterConnection"]): string =>
  status === "connected" ? dashboardTexts().status.verbunden : dashboardTexts().status.nichtVerbunden;

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return dashboardTexts().fehler.sessionInvalid;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return dashboardTexts().fehler.datenLaden;
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

interface LinkProperties {
  route: DashboardRoute;
  current: DashboardRoute;
  children: ReactNode;
  onNavigate: (route: DashboardRoute) => void;
  className?: string;
}

const RouteLink = ({ route, current, children, onNavigate, className = "nav-link" }: LinkProperties): ReactElement => {
  const isCurrent = (route.kind === "overview" && current.kind === "overview") ||
    (route.kind === "betreiber" && current.kind === "betreiber") ||
    (route.kind === "channel" && current.kind === "channel" &&
      route.channelId === current.channelId && route.section === current.section) ||
    (route.kind === "channel" && current.kind === "module" &&
      route.channelId === current.channelId && route.section === "modules");
  return (
    <a
      className={isCurrent ? `${className} ${className}--active` : className}
      href={dashboardRoutePath(route)}
      aria-current={isCurrent ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(route);
      }}
    >
      {children}
    </a>
  );
};

/**
 * Der Zustandspunkt in der Navigation zeigt ein Problem, bevor man klickt.
 * Der Text daneben ist fuer Hilfsmittel: Farbe informiert nie allein.
 */
const NavDot = ({ tone }: { tone: "healthy" | "warning" | "error" }): ReactElement | null =>
  tone === "healthy" ? null : (
    <span className="nav-dot" data-status={tone} role="img" aria-label={tone === "error" ? dashboardTexts().fehler.titel : dashboardTexts().fehler.warnung} />
  );

const formatTimestamp = (value: string): string => formatTimestampBase(value);

const ErrorPanel = ({ message }: { message: string }): ReactElement => (
  <section className="error-panel" data-status="error" role="alert">
    <strong>{dashboardTexts().fehler.titel}</strong>
    <p>{message}</p>
  </section>
);

interface SidebarProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  platformAdmin: boolean;
  onNavigate: (route: DashboardRoute) => void;
}

const Rail = ({ route, channels, platformAdmin: platform, onNavigate }: SidebarProperties): ReactElement => {
  const texts = dashboardTexts();
  const platformTextsValues = platformTexts();
  const activeChannel = route.kind === "channel" || route.kind === "module"
    ? channels.find((channel) => channel.channelId === route.channelId)
    : undefined;
  const navigationChannelId = route.kind === "channel" || route.kind === "module"
    ? route.channelId
    : channels[0]?.channelId ?? "";
  return (
    <aside className="rail">
      <nav className="primary-nav" aria-label={texts.navigation.hauptnavigation}>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "overview" }} current={route} onNavigate={onNavigate}>
          <span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="channel" /><span>{texts.navigation.channel}</span></span>
          {activeChannel === undefined ? null : <NavDot tone={channelStatus(activeChannel)} />}
        </RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "system" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="system" /><span>{texts.navigation.system}</span></span></RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "members" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="members" /><span>{texts.navigation.members}</span></span></RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "modules" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="modules" /><span>{texts.navigation.module}</span></span></RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "events" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="events" /><span>{texts.navigation.ereignisse}</span></span></RouteLink>
        {platform ? <RouteLink route={{ kind: "betreiber" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="members" /><span>{platformTextsValues.navigation}</span></span></RouteLink> : null}
      </nav>
    </aside>
  );
};

interface PanelTopbarProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  platformAdmin: boolean;
  activeChannel: PanelChannelState | undefined;
  moduleStates: PanelModuleState[] | null;
  loadedAt: number | undefined;
  headerModule: { id: string; enabled: boolean } | undefined;
  headerModuleBusy: boolean;
  onToggleHeaderModule: () => void;
  onNavigate: (route: DashboardRoute) => void;
  onLogout: () => void;
  loggingOut: boolean;
}

type PageLoadedAt = Record<"overview" | "system" | "members" | "modules" | "events", number | undefined>;

const loadedAtForRoute = (route: DashboardRoute, loadedAt: PageLoadedAt): number | undefined => {
  if (route.kind === "overview") return undefined;
  if (route.kind === "betreiber") return undefined;
  if (route.kind === "module") return loadedAt.modules;
  return loadedAt[route.section];
};

const focusableSelector = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

interface BreadcrumbSwitcherOption {
  id: string;
  name: string;
  icon: ReactNode;
  secondary?: string;
  status?: { status: LedStatus; label: string };
}

const BreadcrumbSwitcher = ({ kind, currentLabel, accessibleCurrentLabel = currentLabel, currentId, currentIcon, options, openable, buttonLabel, listLabel, listboxId, open, onOpenChange, onSelect }: {
  kind: "channel" | "module";
  currentLabel: string;
  accessibleCurrentLabel?: string;
  currentId: string;
  currentIcon?: ReactNode;
  options: BreadcrumbSwitcherOption[];
  openable: boolean;
  buttonLabel: string;
  listLabel: string;
  listboxId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
}): ReactElement => {
  const switcherRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === currentId));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (switcherRef.current?.contains(event.target as Node)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => { document.removeEventListener("mousedown", closeOnOutsideClick); };
  }, [onOpenChange, open]);

  const closeAndFocusButton = (): void => {
    onOpenChange(false);
    buttonRef.current?.focus();
  };

  const selectOption = (id: string): void => {
    closeAndFocusButton();
    onSelect(id);
  };

  const focusNextControl = (): void => {
    const button = buttonRef.current;
    if (button === null) return;
    const controls = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector));
    const index = controls.indexOf(button);
    controls[index + 1]?.focus();
  };

  const openList = (): void => {
    setActiveIndex(selectedIndex);
    onOpenChange(true);
  };

  if (!openable) {
    if (kind === "module") {
      return <span className="topbar__breadcrumb-current topbar__breadcrumb-module topbar__crumb-last" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true">{currentIcon}</span><span>{currentLabel}</span></span>;
    }
    return <span className="topbar__channel-segment topbar__channel-segment--static" data-channel-id={currentId}>{currentLabel}</span>;
  }

  return (
    <div className={`topbar__channel-switch${kind === "module" ? " topbar__breadcrumb-module" : ""}`} ref={switcherRef}>
      <button
        ref={buttonRef}
        className={kind === "module" ? "topbar__channel-button topbar__breadcrumb-link topbar__breadcrumb-module" : "topbar__channel-button"}
        type="button"
        aria-label={`${buttonLabel}: ${accessibleCurrentLabel}`}
        aria-current={kind === "module" ? "page" : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => { if (open) closeAndFocusButton(); else openList(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openList();
          }
        }}
      >
        {kind === "module" ? <span className="topbar__breadcrumb-icon" aria-hidden="true">{currentIcon}</span> : null}
        <span className="topbar__channel-segment">{currentLabel}</span>
        <svg className="topbar__breadcrumb-glyph topbar__channel-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open ? <div id={listboxId} className="topbar__channel-list" role="listbox" aria-label={listLabel}>
        {options.map((option, index) => {
          return <div
            key={option.id}
            ref={(element) => { optionRefs.current[index] = element; }}
            className="topbar__channel-option"
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => { selectOption(option.id); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex(Math.min(options.length - 1, activeIndex + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(Math.max(0, activeIndex - 1));
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(options.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectOption(options[activeIndex]?.id ?? option.id);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeAndFocusButton();
              } else if (event.key === "Tab") {
                event.preventDefault();
                onOpenChange(false);
                window.setTimeout(focusNextControl, 0);
              }
            }}
          >
            {option.icon}
            <span className="topbar__channel-option-copy">
              <span className="topbar__channel-option-name">{option.name}</span>
              {option.secondary === undefined ? null : <span className="topbar__channel-option-id mono">{option.secondary}</span>}
            </span>
            {option.status === undefined ? null : <Led status={option.status.status} label={option.status.label} />}
          </div>;
        })}
      </div> : null}
    </div>
  );
};

const ChannelSwitcher = ({ channels, activeChannel, open, onOpenChange, onNavigate }: {
  channels: PanelChannelState[];
  activeChannel: PanelChannelState | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement | null => {
  const texts = dashboardTexts();
  if (activeChannel === undefined) return null;
  return <BreadcrumbSwitcher
    kind="channel"
    currentLabel={activeChannel.displayName}
    currentId={activeChannel.channelId}
    options={channels.map((channel) => ({
      id: channel.channelId,
      name: channel.displayName,
      icon: <NavigationIcon className="topbar__channel-option-icon" kind="channel" />,
      secondary: channel.channelId,
      status: {
        status: channelToneToLedStatus(channelStatus(channel)),
        label: statusText(channel),
      },
    }))}
    openable={channels.length > 1}
    buttonLabel={texts.navigation.selectChannel}
    listLabel={texts.navigation.selectChannel}
    listboxId="channel-switcher-listbox"
    open={open}
    onOpenChange={onOpenChange}
    onSelect={(channelId) => { onNavigate({ kind: "channel", channelId, section: "overview" }); }}
  />;
};

const BreadcrumbAreaLink = ({ route, label, icon, onNavigate }: {
  route: DashboardRoute;
  label: string;
  icon: ReactNode;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => (
  <a
    className="topbar__breadcrumb-link topbar__breadcrumb-area"
    href={dashboardRoutePath(route)}
    onClick={(event) => { event.preventDefault(); onNavigate(route); }}
  >
    <span className="topbar__breadcrumb-icon" aria-hidden="true">{icon}</span>
    <span>{label}</span>
  </a>
);

const PanelTopbar = ({ route, channels, platformAdmin: platform, activeChannel, moduleStates, loadedAt, headerModule, headerModuleBusy, onToggleHeaderModule, onNavigate, onLogout, loggingOut }: PanelTopbarProperties): ReactElement => {
  const texts = dashboardTexts();
  const platformTextsValues = platformTexts();
  const [openSwitcher, setOpenSwitcher] = useState<"channel" | "module" | null>(null);
  const tone = activeChannel === undefined ? "neutral" : channelStatus(activeChannel);
  const connectionLabel = activeChannel === undefined
    ? null
    : tone === "healthy" ? texts.kopf.verbindungLaeuft : statusText(activeChannel);
  const headerModuleLabel = headerModule === undefined ? null : `${moduleName(headerModule.id)} · ${statusWord(headerModule.enabled)}`;
  const headerSwitch = headerModuleLabel === null ? null : <span className="topbar__module-switch-wrap"><button className="switch topbar__module-switch" type="button" role="switch" aria-label={headerModuleLabel} aria-checked={headerModule?.enabled} aria-busy={headerModuleBusy} disabled={activeChannel?.role === "operator" || headerModuleBusy} title={activeChannel?.role === "operator" ? texts.module.verwaltungGesperrt : undefined} onClick={onToggleHeaderModule}><span className="topbar__module-switch-label">{headerModuleLabel}</span><span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span></button>{activeChannel?.role === "operator" ? <span className="sperrgrund">{texts.module.verwaltungGesperrt}</span> : null}</span>;
  const connectionLed = connectionLabel === null ? null : <span className="led" data-status={tone === "healthy" ? "green" : tone === "warning" ? "amber" : "red"}><span className="led__dot" aria-hidden="true" /><span>{connectionLabel}</span></span>;
  const areaRoute = route.kind === "channel"
    ? { kind: "channel" as const, channelId: route.channelId, section: route.section }
    : route.kind === "module"
      ? { kind: "channel" as const, channelId: route.channelId, section: "modules" as const }
      : null;
  const areaLabel = areaRoute === null ? null : areaRoute.section === "overview" ? texts.navigation.channel
    : areaRoute.section === "system" ? texts.navigation.system
      : areaRoute.section === "members" ? texts.navigation.members
        : areaRoute.section === "modules" ? texts.navigation.module : texts.navigation.ereignisse;
  const moduleLabel = route.kind === "module" ? moduleName(route.moduleId) : null;
  const moduleBreadcrumbIcon = route.kind === "module" ? <ModuleIcon moduleId={route.moduleId} /> : null;
  const moduleOptions = moduleStates?.map((module): BreadcrumbSwitcherOption => {
    const missingScopes = module.missingBroadcasterScopes ?? [];
    const effectiveEnabled = module.enabled && missingScopes.length === 0;
    return {
      id: module.id,
      name: moduleName(module.id),
      icon: <ModuleIcon moduleId={module.id} className="topbar__channel-option-icon" />,
      status: {
        status: missingScopes.length > 0 ? "amber" : effectiveEnabled ? "green" : "off",
        label: missingScopes.length > 0 ? disabledStatusWord() : statusWord(effectiveEnabled),
      },
    };
  }) ?? [];
  const moduleArea = route.kind === "module" && areaRoute !== null && areaLabel !== null
    ? <BreadcrumbAreaLink route={areaRoute} label={areaLabel} icon={<NavigationIcon kind="modules" className="topbar__breadcrumb-glyph" />} onNavigate={onNavigate} />
    : null;
  const moduleSwitcher = route.kind === "module" && moduleStates !== null && moduleLabel !== null && moduleBreadcrumbIcon !== null
    ? <BreadcrumbSwitcher
        kind="module"
        currentLabel={moduleLabel}
        currentId={route.moduleId}
        currentIcon={moduleBreadcrumbIcon}
        options={moduleOptions}
        openable={moduleOptions.length > 1}
        buttonLabel={texts.navigation.selectModule}
        listLabel={texts.navigation.selectModule}
        listboxId="module-switcher-listbox"
        open={openSwitcher === "module"}
        onOpenChange={(open) => { setOpenSwitcher(open ? "module" : null); }}
        onSelect={(id) => { onNavigate({ kind: "module", channelId: route.channelId, moduleId: id }); }}
      />
    : null;
  return (
    <header className={`topbar${headerModuleLabel === null ? "" : " topbar--module-detail"}`}>
      <nav className={`topbar__breadcrumb${route.kind === "module" ? " topbar__breadcrumb--module" : ""}`} aria-label={texts.navigation.brotkrume}>
        <a className="brand-mark" href="/" aria-current={route.kind === "overview" ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate({ kind: "overview" }); }}><span className="brand-mark__dot" /><span className="brand-mark__word">BroBot</span></a>
        {activeChannel === undefined ? null : <><span className="topbar__breadcrumb-separator" aria-hidden="true">›</span><ChannelSwitcher channels={channels} activeChannel={activeChannel} open={openSwitcher === "channel"} onOpenChange={(open) => { setOpenSwitcher(open ? "channel" : null); }} onNavigate={onNavigate} /></>}
        {areaRoute === null || areaLabel === null ? null : <><span className="topbar__breadcrumb-separator topbar__breadcrumb-area-separator topbar__area-separator" aria-hidden="true">›</span>{route.kind === "module" ? moduleArea : <span className="topbar__breadcrumb-current topbar__breadcrumb-area" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true"><NavigationIcon kind={areaRoute.section === "overview" ? "channel" : areaRoute.section} className="topbar__breadcrumb-glyph" /></span><span>{areaLabel}</span></span>}</>}
        {route.kind === "betreiber" && platform ? <><span className="topbar__breadcrumb-separator topbar__breadcrumb-area-separator" aria-hidden="true">›</span><span className="topbar__breadcrumb-current topbar__breadcrumb-area" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true"><NavigationIcon kind="members" className="topbar__breadcrumb-glyph" /></span><span>{platformTextsValues.navigation}</span></span></> : null}
        {moduleLabel === null || moduleBreadcrumbIcon === null ? null : <><span className="topbar__breadcrumb-separator topbar__breadcrumb-module-separator topbar__crumb-area" aria-hidden="true">›</span>{moduleSwitcher ?? <span className="topbar__breadcrumb-current topbar__breadcrumb-module topbar__crumb-last" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true">{moduleBreadcrumbIcon}</span><span>{moduleLabel}</span></span>}</>}
      </nav>
      <span className="topbar__connection">{connectionLed}</span>
      {loadedAt === undefined ? null : <Datenalter seit={loadedAt} />}
      {headerSwitch}
      <button className="button button--quiet topbar__logout" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? texts.navigation.abmeldungLaeuft : texts.navigation.abmelden}</button>
    </header>
  );
};

const OverviewPage = ({ channels, onNavigate }: { channels: PanelChannelState[]; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
  const texts = dashboardTexts();
  return (
    <>
      <ModuleHeading kind="overview" title={texts.navigation.uebersicht} subtitle={channels.length === 1 ? texts.overview.einKanalFreigegeben : <ModuleCount count={channels.length} label={texts.overview.kanaeleFreigegebenKurz} />} />
      {channels.length === 0 ? (
        <section className="empty-state"><h2>{texts.overview.keinKanalFreigegeben}</h2><p>{texts.overview.keineMitgliedschaft}</p></section>
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
 * Die einzige helle Aktion der Kanalseite. Sie steht in der Titelzeile und
 * nicht in der Moderatorzeile, weil diese bei gesundem Zustand gar nicht
 * erscheint — die Nachpruefung muss trotzdem jederzeit erreichbar sein.
 */
const relativeZeit = (seit: number, jetzt: number): string => {
  const s = Math.max(0, Math.round((jetzt - seit) / 1000));
  const texts = dashboardTexts();
  if (s < 60) return texts.time.vorSekunden(s);
  const m = Math.round(s / 60);
  if (m < 60) return texts.time.vorMinuten(m);
  return texts.time.vorStunden(Math.round(m / 60));
};

/**
 * Beweist Leben, ohne einen Zustand zu behaupten. Steht bewusst neutral und
 * nie in Zustandsfarbe.
 */
const Datenalter = ({ seit }: { seit: number }): ReactElement => {
  const [jetzt, setJetzt] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => { setJetzt(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, []);
  return <span className="datenalter">{dashboardTexts().time.aktualisiert(relativeZeit(seit, jetzt))}</span>;
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
        {checking ? texts.moderation.checkRunning : texts.moderation.moderatorstatusPruefen}
      </button>
      {nextAllowedAt === null ? null : <p className="muted moderator-check-time">{texts.moderation.naechstePruefungAb(formatTimestamp(nextAllowedAt))}</p>}
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
      {canRequest ? <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/channel-bot`}>{texts.moderation.broadcasterZustimmungAnfordern}</a> : <button className="button" type="button" disabled>{texts.moderation.broadcasterZustimmungAnfordern}</button>}
      {!canRequest ? <span className="sperrgrund">{texts.moderation.broadcasterErneutAutorisieren}</span> : null}
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
  if (bot === null) return { key: "bot", tone: "neutral", node: <StateRow label={texts.statusKarte.botAccount} tone="neutral" wort={texts.status.nichtEingerichtet} detail={texts.bot.keinGespeicherterStatus} /> };
  const tone: StateTone = bot.status === "connected" ? "healthy" : "error";
  return { key: "bot", tone, node: <StateRow label={texts.statusKarte.botAccount} tone={tone} wort={statusLabel(bot.status)} detail={bot.reason ?? texts.bot.zuletztAktualisiert(formatTimestamp(bot.updatedAt))} /> };
};

const broadcasterRow = (status: PanelChannelState["broadcasterConnection"]): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = status === "connected" ? "healthy" : "neutral";
  return { key: "broadcaster", tone, node: <StateRow label={texts.statusKarte.broadcasterOauth} tone={tone} wort={broadcasterConnectionLabel(status)} detail={status === "connected" ? texts.bot.optionaleModule : texts.bot.normalerBetrieb} /> };
};

const chatRow = (status: PanelChannelState["chatSubscription"] | undefined, expected = false): StatusEntry => {
  const texts = dashboardTexts();
  const current = status ?? null;
  const tone: StateTone = current === null ? expected ? "warning" : "neutral" : current.status === "enabled" ? "healthy" : current.status === "missing" ? "warning" : "error";
  const wort = current === null ? expected ? texts.status.missing : texts.status.nichtGeprueft : current.status === "enabled" ? texts.status.aktiv : current.status === "missing" ? texts.status.missing : current.status === "revoked" ? texts.status.widerrufen : texts.status.fehler;
  return { key: "chat-subscription", tone, node: <StateRow label={texts.statusKarte.chatAbo} tone={tone} wort={wort} detail={current?.reason ?? (current === null && expected ? texts.status.chatAboFehlt : undefined)} /> };
};

const botPermissionsRow = (permissions: PanelBotPermissions | null | undefined): StatusEntry | null => {
  const texts = dashboardTexts();
  if (permissions === undefined) return null;
  if (permissions === null) {
    return {
      key: "bot-permissions",
      tone: "neutral",
      node: <StateRow label={texts.statusKarte.botBerechtigungen} tone="neutral" wort={texts.status.nichtGeprueft} detail={texts.bot.keinGespeicherterStatus} />,
    };
  }
  const missing = permissions.missingScopes.length;
  const tone: StateTone = missing === 0 ? "healthy" : "warning";
  return {
    key: "bot-permissions",
    tone,
    node: <StateRow
      label={texts.statusKarte.botBerechtigungen}
      tone={tone}
      wort={missing === 0 ? texts.status.gesund : texts.status.botBerechtigungenFehlen(formatZahl(missing))}
      detail={missing === 0 ? texts.bot.botBerechtigungenVollstaendig : texts.bot.botBerechtigungenBetreiber}
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
      wort={texts.fullConsentMissing}
      detail={texts.fullConsentLocked}
    />,
  };
};

const tokenRow = (tokens: PanelTokenStatus, bot: PanelBotStatus | null): StatusEntry => {
  const texts = dashboardTexts();
  const token = tokenView(tokens, bot);
  return { key: "token", tone: token.tone, node: <StateRow label={texts.statusKarte.tokenZustand} tone={token.tone} wort={token.label} detail={tokens.loginReason ?? undefined} /> };
};

const channelBotConsentRow = (status: PanelChannelState["channelBotConsent"]): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = status === "missing" ? "warning" : "healthy";
  return { key: "channel-bot-consent", tone, node: <StateRow label={texts.statusKarte.chatZustimmung} tone={tone} wort={status === "missing" ? texts.statusKarte.broadcasterConsentMissing : texts.status.vorhanden} detail={status === "missing" ? texts.statusKarte.chatBotNoetig : undefined} /> };
};

const moderatorRow = (moderator: PanelModeratorStatus | null): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = moderator === null ? "neutral" : moderator.isModerator ? "healthy" : "error";
  const wort = moderator === null ? texts.status.nichtGeprueft : moderator.isModerator ? texts.status.moderator : texts.status.moderatorrolleFehlt;
  const detail = moderator === null
    ? texts.moderation.fuerKanalKeinePruefung
    : moderator.reason ?? texts.moderation.letztePruefung(formatTimestamp(moderator.checkedAt));
  return { key: "moderator", tone, node: <StateRow label={texts.statusKarte.moderatorstatus} tone={tone} wort={wort} detail={detail} /> };
};

const lastErrorRow = (error: PanelLastError | null): StatusEntry => {
  const texts = dashboardTexts();
  const tone: StateTone = error === null ? "healthy" : "error";
  if (error === null) {
    return { key: "fehler", tone, node: <StateRow label={texts.fehler.letzter} tone={tone} wort={texts.status.gesund} detail={texts.fehler.keineUrsache} /> };
  }
  const aboName = error.source === "eventsub" && error.subscriptionType !== undefined
    ? eventSubName(error.subscriptionType, error.subscriptionVariant ?? "")
    : null;
  const reason = aboName === null ? error.reason : `${aboName}: ${error.reason}`;
  const detail = [
    reason,
    error.message === null || error.message === undefined ? null : kuerzeAuf200Zeichen(error.message),
    error.status === null || error.status === undefined ? null : `HTTP ${String(error.status)}`,
    formatTimestamp(error.at),
  ].filter((part): part is string => part !== null).join(" · ");
  return { key: "fehler", tone, node: <StateRow label={texts.fehler.letzter} tone={tone} wort={texts.status.fehler} detail={detail} /> };
};

const BotPermissionsInspector = ({ permissions }: { permissions: PanelBotPermissions | null | undefined }): ReactElement | null => {
  const texts = dashboardTexts();
  if (permissions === null || permissions === undefined || permissions.missingScopes.length === 0) return null;
  return (
    <section className="content-section" aria-label={texts.system.botBerechtigungenInspector}>
      <div className="section-heading"><h2>{texts.system.botBerechtigungenInspector}</h2><span className="mono muted">{formatZahl(permissions.missingScopes.length)}</span></div>
      <h4>{texts.system.fehlendeScopes}</h4>
      <ul className="scope-liste">{permissions.missingScopes.map((scope) => <li className="mono" key={scope}>{scope}</li>)}</ul>
    </section>
  );
};

const BroadcasterPermissionsInspector = ({ permissions }: { permissions: PanelBroadcasterPermissions | null | undefined }): ReactElement | null => {
  const texts = channelPanelTexts();
  if (!broadcasterConsentMissing(permissions)) return null;
  return (
    <section className="content-section" aria-label={texts.missingBroadcasterPermissions}>
      <div className="section-heading"><h2>{texts.missingBroadcasterPermissions}</h2><span className="mono muted">{formatZahl(permissions.missingScopes.length)}</span></div>
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
    <section className={`content-section inspektor-bereich${selected === null ? "" : " inspektor-bereich--offen"}`} aria-label={texts.system.abonnements}>
      <div className="inspektor-bereich__liste">
        <div className="section-heading"><h2>{texts.system.abonnements}</h2><span className="muted zahl">{formatZahl(subscriptions.length)}</span></div>
        {subscriptions.length === 0 ? <p className="empty-state">{texts.system.keineAbonnements}</p> : (
          <div className="tabelle-wrap">
            <table className="tabelle abonnements-tabelle">
              <thead><tr><th scope="col">{texts.system.abo}</th><th scope="col">{texts.system.state}</th><th scope="col">{texts.system.reason}</th></tr></thead>
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
      {selected === null ? null : <SubInspector ariaLabel={texts.system.aboInspector} title={subscriptionDisplayName(selected)} identifier={selected.subscriptionId ?? leer} closeLabel={dashboardCommonTexts().schliessen} onClose={close}>
        <dl className="eigenschaften">
          <div><dt>{texts.system.aboTyp}</dt><dd className="mono">{selected.subscriptionType}</dd></div>
          <div><dt>{texts.system.aboVersion}</dt><dd className="mono">{selected.version}</dd></div>
          <div><dt>{texts.system.aboId}</dt><dd className="mono">{selected.subscriptionId ?? leer}</dd></div>
          <div><dt>{texts.system.aboAktualisiert}</dt><dd className="mono">{formatTimestamp(selected.updatedAt)}</dd></div>
          <div><dt>{texts.system.twitchMeldung}</dt><dd>{selected.message ?? leer}</dd></div>
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
      <section className="content-section"><div className="section-heading"><h2>{dashboardTexts().overview.aktiveModule}</h2><span className="muted zahl">{formatZahl(overview.activeModules.length)}</span></div>{overview.activeModules.length === 0 ? <p className="empty-state">{dashboardTexts().module.keineAktiv}</p> : <div className="module-grid">{overview.activeModules.map(({ moduleId }) => <ModuleTile key={moduleId} channelId={overview.channelId} moduleId={moduleId} enabled onNavigate={onNavigate} />)}</div>}</section>
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
      <ModuleHeading kind="system" title={texts.system.titel} subtitle={texts.system.nurLesend} />
      {system === null && systemState.status === "loading" ? <p className="loading-line">{texts.system.loadState}</p> : null}
      {systemState.error !== null ? <ErrorPanel message={systemState.error} /> : null}
      {system === null ? null : <>
        <div className="zustand-liste">{[broadcasterRow(system.broadcasterConnection), chatRow(system.chatSubscription), botRow(system.bot), botPermissionsRow(system.botPermissions), broadcasterPermissionsRow(system.broadcasterPermissions), tokenRow(system.tokens, system.bot)].filter((entry): entry is StatusEntry => entry !== null).map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
        <BotPermissionsInspector permissions={system.botPermissions} />
        <BroadcasterPermissionsInspector permissions={system.broadcasterPermissions} />
        <SubscriptionsSection subscriptions={system.subscriptions ?? []} />
        <SystemProperties system={system} />
      </>}
      <section className={`content-section inspektor-bereich${selectedAudit === null ? "" : " inspektor-bereich--offen"}`}><div className="inspektor-bereich__liste">
        <div className="section-heading"><h2>{texts.system.auditLog}</h2>{auditState.data === null ? null : <span className="muted"><span className="zahl">{formatZahl(auditState.data.entries.length)}</span> {texts.system.eintraege}</span>}</div>
          {auditState.status === "loading" && auditState.data === null ? <p className="loading-line">{texts.system.loadAudit}</p> : null}
          {auditState.error !== null ? <ErrorPanel message={auditState.error} /> : null}
          {auditState.data !== null && auditState.data.entries.length === 0 ? <p className="empty-state">{texts.system.keineAuditEintraege}</p> : null}
          {auditState.data !== null && auditState.data.entries.length > 0 ? <>
            <div className={auditState.status === "loading" ? "veraltet" : undefined}>
              <table className="tabelle audit-tabelle">
                <thead><tr><th scope="col">{texts.system.time}</th><th scope="col">{texts.system.action}</th><th scope="col">{texts.system.wer}</th></tr></thead>
                <tbody>{auditState.data.entries.map((entry) => <tr key={entry.auditId} ref={auditRowRef(entry.auditId)} tabIndex={0} aria-selected={selectedAuditId === entry.auditId} onClick={() => { selectAudit(entry.auditId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectAudit(entry.auditId); } }}><td className="mono">{formatTimestamp(entry.createdAt)}</td><th scope="row" className="mono">{entry.action}</th><td>{auditActorLabel(entry)}</td></tr>)}</tbody>
              </table>
            </div>
            {auditState.data.nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? texts.system.aeltereEintraegeLaden : texts.system.aeltereEintraege}</button>}
          </> : null}
        </div>
        {selectedAudit === null ? null : <SubInspector ariaLabel={texts.system.aenderungsdaten} title={selectedAudit.action} identifier={selectedAudit.auditId} closeLabel={dashboardCommonTexts().schliessen} onClose={closeAudit}>
          <dl className="eigenschaften"><div><dt>{texts.system.wer}</dt><dd className="mono">{selectedAudit.actorUserId}</dd></div></dl>
          <div className="inspector-columns"><div><h4>{texts.system.vorher}</h4><pre>{selectedAudit.before}</pre></div><div><h4>{texts.system.nachher}</h4><pre>{selectedAudit.after}</pre></div></div>
        </SubInspector>}
      </section>
    </>
  );
};

const SystemProperties = ({ system }: { system: PanelSystemResponse }): ReactElement => {
  const texts = dashboardTexts();
  const leer = "—";
  const loginStatus = system.tokens.loginStatus === null ? leer : statusLabel(system.tokens.loginStatus);
  return (
    <section className="content-section properties-section" aria-label={texts.system.eigenschaften}>
      <div className="section-heading"><h2>{texts.system.eigenschaften}</h2></div>
      <dl className="eigenschaften">
        <div><dt>{texts.system.botGrund}</dt><dd>{system.bot?.reason ?? leer}</dd></div>
        <div><dt>{texts.system.botAktualisiert}</dt><dd className="mono">{system.bot === null ? leer : formatTimestamp(system.bot.updatedAt)}</dd></div>
        <div><dt>{texts.system.chatAboId}</dt><dd className="mono">{system.chatSubscription?.subscriptionId ?? leer}</dd></div>
        <div><dt>{texts.system.chatAboGrund}</dt><dd>{system.chatSubscription?.reason ?? leer}</dd></div>
        <div><dt>{texts.system.chatAboAktualisiert}</dt><dd className="mono">{system.chatSubscription == null ? leer : formatTimestamp(system.chatSubscription.updatedAt)}</dd></div>
        <div><dt>{texts.system.loginStatus}</dt><dd>{loginStatus}</dd></div>
        <div><dt>{texts.system.loginGrund}</dt><dd>{system.tokens.loginReason ?? leer}</dd></div>
        <div><dt>{texts.system.loginGueltigBis}</dt><dd className="mono">{system.tokens.loginExpiresAt === null ? leer : formatTimestamp(system.tokens.loginExpiresAt)}</dd></div>
        <div><dt>{texts.system.botGueltigBis}</dt><dd className="mono">{system.tokens.botExpiresAt === null ? leer : formatTimestamp(system.tokens.botExpiresAt)}</dd></div>
      </dl>
    </section>
  );
};

const eventMetadata = (code: string) =>
  Object.prototype.hasOwnProperty.call(eventToneEntries, code) ? eventToneEntries[code as EventCode] : null;

const eventTone = (code: string): EventTone | null =>
  eventMetadata(code)?.tone ?? null;

const eventToneRang = (tone: EventTone | null): number =>
  tone === "error" ? 3 : tone === "warning" ? 2 : tone === "info" ? 1 : 0;

const eventToneFromValue = (value: string): EventTone | null =>
  EVENT_TONES.includes(value as EventTone) ? value as EventTone : null;

interface EventGroup {
  key: string;
  entries: PanelEventEntry[];
  representative: PanelEventEntry;
}

const eventGroupKey = (entry: PanelEventEntry): string =>
  typeof entry.triggerId === "string" && entry.triggerId.length > 0
    ? `trigger:${entry.triggerId}`
    : `event:${entry.eventId}`;

const eventGroups = (entries: readonly PanelEventEntry[]): EventGroup[] => {
  const grouped = new Map<string, [PanelEventEntry, ...PanelEventEntry[]]>();
  for (const entry of entries) {
    const key = eventGroupKey(entry);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [entry]);
    else group.push(entry);
  }
  return Array.from(grouped, ([key, groupEntries]) => ({
    key,
    entries: groupEntries,
    representative: groupEntries.slice(1).reduce((current, candidate) => {
      const currentRank = eventToneRang(eventTone(current.code));
      const candidateRank = eventToneRang(eventTone(candidate.code));
      return candidateRank > currentRank ||
        (candidateRank === currentRank && candidate.createdAt < current.createdAt)
        ? candidate
        : current;
    }, groupEntries[0]),
  }));
};

const actorLabel = (entry: PanelEventEntry, texts: ReturnType<typeof dashboardTexts>): string =>
  entry.actorDisplayName ?? (entry.actorLogin == null
    ? entry.actorUserId == null ? texts.ereignisse.automatic : entry.actorUserId
    : `@${entry.actorLogin}`);

const actorCell = (entry: PanelEventEntry, texts: ReturnType<typeof dashboardTexts>): ReactNode =>
  entry.actorDisplayName ?? (entry.actorLogin == null
    ? entry.actorUserId == null ? texts.ereignisse.automatic : <span className="mono">{entry.actorUserId}</span>
    : `@${entry.actorLogin}`);

const auditActorLabel = (entry: PanelAuditEntry): string =>
  entry.actorDisplayName ?? (entry.actorLogin == null ? entry.actorUserId : `@${entry.actorLogin}`);

const moduleLabel = (entry: PanelEventEntry): string => moduleName(entry.moduleId);

const chronologisch = (left: PanelEventEntry, right: PanelEventEntry): number =>
  left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);

const mergeEventEntries = (
  current: readonly PanelEventEntry[],
  incoming: readonly PanelEventEntry[],
): PanelEventEntry[] => {
  const byId = new Map<string, PanelEventEntry>();
  for (const entry of current) byId.set(entry.eventId, entry);
  for (const entry of incoming) byId.set(entry.eventId, entry);
  return Array.from(byId.values()).sort((left, right) => chronologisch(right, left));
};

const eventDetail = (detail: string): EventDetail => {
  try {
    const parsed: unknown = JSON.parse(detail);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as EventDetail
      : {};
  } catch {
    return {};
  }
};

const eventChipNumber = (detail: EventDetail, key: EventNumberKey): string | null => {
  if (key === null) return null;
  const value = detail[key];
  if (key === "tier") {
    const tier = typeof value === "number" ? String(value) : value;
    if (typeof tier !== "string") return null;
    if (tier === "1000") return "T1";
    if (tier === "2000") return "T2";
    if (tier === "3000") return "T3";
    if (tier.toLowerCase() === "prime") return "Prime";
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return null;
  if (key === "count") return `${formatZahl(value)}x`;
  if (key === "duration" || key === "remainingSeconds") return `${formatZahl(value)} s`;
  return formatZahl(value);
};

const EventChipPair = ({ code, detail, texts: texts }: { code: string; detail: EventDetail; texts: ReturnType<typeof dashboardTexts> }): ReactElement => {
  const metadata = eventMetadata(code);
  if (metadata === null) {
    return <span className="event-chip-pair"><span className="event-chip" data-stufe="gezeichnet">{texts.ereignisse.unbekannt}</span></span>;
  }
  const number = eventChipNumber(detail, metadata.zahlSchluessel);
  return <span className="event-chip-pair">
    {number === null ? null : <span className="event-chip event-chip--number">{number}</span>}
    <span className="event-chip" data-familie={metadata.familie} data-stufe={metadata.tier} data-ton={metadata.tone}>{metadata.wort[dashboardLanguage()]}</span>
  </span>;
};

const formatEventDetail = (detail: string): string => {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
};

const eventFilterIsActive = (filters: PanelEventFilters): boolean =>
  filters.origin !== null || filters.module !== null || filters.tone !== null || filters.person !== null;

const EventFilterBar = ({
  filters,
  moduleOptions,
  onChange,
}: {
  filters: PanelEventFilters;
  moduleOptions: readonly PanelModuleState[];
  onChange: (filters: PanelEventFilters) => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const [personDraft, setPersonDraft] = useState(filters.person ?? "");
  // Der angewendete Filter ist die Quelle; der Entwurf zieht nach, wenn er sich
  // von aussen aendert (Zuruecksetzen, Navigation, zweiter Tab). Das geschieht
  // waehrend des Renders statt in einem Effect: ein Effect wuerde einen zweiten
  // Durchlauf mit veraltetem Wert zeigen, und React verbietet das Muster.
  const [zuletztAngewendet, setZuletztAngewendet] = useState(filters.person);
  if (zuletztAngewendet !== filters.person) {
    setZuletztAngewendet(filters.person);
    setPersonDraft(filters.person ?? "");
  }
  const commitPerson = useCallback((draft: string): void => {
    const value = draft.trim();
    onChange({ ...filters, person: value.length === 0 ? null : value });
  }, [filters, onChange]);
  useEffect(() => {
    if (personDraft.trim() === (filters.person ?? "")) return;
    const timeout = window.setTimeout(() => { commitPerson(personDraft); }, PERSON_FILTER_DEBOUNCE_MS);
    return () => { window.clearTimeout(timeout); };
  }, [commitPerson, filters.person, personDraft]);
  const activeFilter: string[] = [];
  if (filters.origin === "channel") activeFilter.push(texts.ereignisse.channelEvents);
  if (filters.origin === "module") activeFilter.push(texts.ereignisse.moduleDiagnostics);
  if (filters.module !== null) activeFilter.push(moduleName(filters.module));
  if (filters.tone !== null) activeFilter.push(filters.tone === "info" ? texts.ereignisse.info : filters.tone === "warning" ? texts.ereignisse.hinweis : texts.ereignisse.fehler);
  if (filters.person !== null) activeFilter.push(filters.person);
  return <div className="ereignis-filter" aria-label={texts.ereignisse.filter}>
    <div className="ereignis-filter__controls">
      <label>{texts.ereignisse.origin}<select aria-label={texts.ereignisse.origin} value={filters.origin ?? ""} onChange={(event) => { const value = event.target.value; onChange({ ...filters, origin: value === "channel" || value === "module" ? value : null }); }}>
        <option value="">{texts.ereignisse.alle}</option><option value="channel">{texts.ereignisse.channelEvents}</option><option value="module">{texts.ereignisse.moduleDiagnostics}</option>
      </select></label>
      <label>{texts.ereignisse.moduleFilter}<select aria-label={texts.ereignisse.moduleFilter} value={filters.module ?? ""} onChange={(event) => { const value = event.target.value; onChange({ ...filters, module: value.length === 0 ? null : value }); }}>
        <option value="">{texts.ereignisse.alle}</option>{moduleOptions.map((module) => <option key={module.id} value={module.id}>{moduleName(module.id)}</option>)}
      </select></label>
      <label>{texts.ereignisse.tone}<select aria-label={texts.ereignisse.tone} value={filters.tone ?? ""} onChange={(event) => { onChange({ ...filters, tone: eventToneFromValue(event.target.value) }); }}>
        <option value="">{texts.ereignisse.alle}</option><option value="info">{texts.ereignisse.info}</option><option value="warning">{texts.ereignisse.hinweis}</option><option value="error">{texts.ereignisse.fehler}</option>
      </select></label>
      <label>{texts.ereignisse.person}<input aria-label={texts.ereignisse.person} value={personDraft} onChange={(event) => { setPersonDraft(event.target.value); }} onKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); commitPerson(personDraft); }} /></label>
    </div>
    {activeFilter.length === 0 ? null : <div className="form-actions"><p className="muted" aria-live="polite">{texts.ereignisse.aktiveFilter} {activeFilter.join(" · ")}</p><button className="button button--quiet" type="button" onClick={() => { setPersonDraft(""); onChange(emptyEventFilter); }}>{texts.ereignisse.filterZuruecksetzen}</button></div>}
  </div>;
};

const EventFeedEnd = ({
  nextCursor,
  loadingNextPage,
  onNextPage,
}: {
  nextCursor: string | null;
  loadingNextPage: boolean;
  onNextPage: () => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const loadNextPage = useCallback((): void => {
    if (nextCursor !== null && !loadingNextPage) onNextPage();
  }, [loadingNextPage, nextCursor, onNextPage]);
  useEffect(() => {
    if (nextCursor === null) return;
    const onScroll = (): void => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1) loadNextPage();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    const end = feedEndRef.current;
    if (end !== null && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting) loadNextPage();
      });
      observer.observe(end);
      return () => { observer.disconnect(); window.removeEventListener("scroll", onScroll); };
    }
    return () => { window.removeEventListener("scroll", onScroll); };
  }, [loadNextPage, nextCursor]);
  return <div
    ref={feedEndRef}
    className="ereignis-feed__end"
    tabIndex={nextCursor === null ? -1 : 0}
    aria-label={nextCursor === null ? undefined : texts.ereignisse.nachladenAmEnde}
    onFocus={loadNextPage}
    onKeyDown={(event) => {
      if (event.key === "End" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        loadNextPage();
      }
    }}
  >
    {loadingNextPage ? <p className="loading-line" role="status">{texts.ereignisse.aeltereWerdenGeladen}</p> : nextCursor === null ? <p className="empty-state">{texts.ereignisse.feedEnde}</p> : <p className="muted">{texts.ereignisse.nachladenAmEnde}</p>}
  </div>;
};

const realtimeLedStatus = (status: RealtimeFeedStatus): LedStatus =>
  status === "connected" ? "green" : status === "renew" ? "red" : status === "offline" ? "off" : "amber";

const RealtimeFeedStatus = ({ status }: { status: RealtimeFeedStatus }): ReactElement => {
  const texts = dashboardTexts();
  const label = status === "connected"
    ? texts.ereignisse.realtimeVerbunden
    : status === "connecting"
      ? texts.ereignisse.realtimeVerbindet
      : status === "reconnecting"
        ? texts.ereignisse.realtimeWiederverbindung
        : status === "renew" ? texts.ereignisse.realtimeSitzungErneuern : texts.ereignisse.realtimeOffline;
  return <span className="realtime-status" aria-live="polite"><Led status={realtimeLedStatus(status)} label={label} />{status === "renew" ? <a className="profile-link" href="/auth/login">{texts.ereignisse.realtimeSitzungErneuern}</a> : null}</span>;
};

const EventsPage = ({
  channelId,
  eventsState,
  filters,
  moduleOptions,
  onFiltersChange,
  onRefreshFirstPage,
  onNextPage,
  loadingNextPage,
}: {
  channelId: string;
  eventsState: LoadState<PanelEventsResponse>;
  filters: PanelEventFilters;
  moduleOptions: readonly PanelModuleState[];
  onFiltersChange: (filters: PanelEventFilters) => void;
  onRefreshFirstPage: (channelId: string, filters: PanelEventFilters) => Promise<void>;
  onNextPage: () => void;
  loadingNextPage: boolean;
}): ReactElement => {
  const texts = dashboardTexts();
  const feedRef = useRef<HTMLDivElement | null>(null);
  const atBeginning = useCallback((): boolean => {
    const feed = feedRef.current;
    if (feed === null) return true;
    const feedStart = feed.getBoundingClientRect().top + window.scrollY;
    return window.scrollY <= feedStart + 8;
  }, []);
  const scrollToBeginning = useCallback((): void => {
    const feed = feedRef.current;
    if (feed === null) return;
    const feedStart = feed.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, feedStart), behavior: "auto" });
  }, []);
  const realtime = useRealtimeEventFeed({
    channelId,
    filters,
    atBeginning,
    refreshFirstPage: () => onRefreshFirstPage(channelId, filters),
    scrollToBeginning,
  });
  const { selectedKey: selectedGroupKey, select: selectGroup, rowRef: groupRowRef, close: closeGroup } = useInspectorSelection<string>();
  const groups = eventsState.data === null ? [] : eventGroups(eventsState.data.entries);
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? null;
  const selectedHistory = selectedGroup === null ? [] : [...selectedGroup.entries].sort(chronologisch);
  const eventEntries = eventsState.data?.entries ?? [];
  return (
    <>
      <ModuleHeading kind="events" title={texts.ereignisse.titel} subtitle={eventsState.data === null ? "" : <ModuleCount count={eventsState.data.entries.length} label={texts.ereignisse.count} />} />
      <section className={`content-section inspektor-bereich${selectedGroup === null ? "" : " inspektor-bereich--offen"}`}><div className="inspektor-bereich__liste">
        <div className="section-heading"><h2>{texts.ereignisse.protokoll}</h2><RealtimeFeedStatus status={realtime.status} /></div>
          <EventFilterBar filters={filters} moduleOptions={moduleOptions} onChange={onFiltersChange} />
          {realtime.pendingCount === 0 ? null : <button className="button realtime-feed__notice" type="button" onClick={realtime.jumpToBeginning} aria-live="polite">{texts.ereignisse.realtimeNeue(formatZahl(realtime.pendingCount))}</button>}
          {eventsState.status === "loading" && eventsState.data === null ? <p className="loading-line">{texts.ereignisse.load}</p> : null}
          {eventsState.error !== null ? <ErrorPanel message={eventsState.error} /> : null}
          {eventsState.data !== null && eventEntries.length === 0 ? <p className="empty-state">{eventFilterIsActive(filters) ? texts.ereignisse.keineTreffer : texts.ereignisse.keine}</p> : null}
          {eventsState.data !== null ? <>
            {eventEntries.length === 0 ? null : <div ref={feedRef} className="ereignis-feed">
              <div className={eventsState.status === "loading" ? "veraltet" : undefined}>
                <table className="tabelle ereignis-tabelle">
                  <thead><tr><th scope="col">{texts.ereignisse.time}</th><th scope="col">{texts.ereignisse.ereignis}</th><th scope="col">{texts.ereignisse.module}</th><th scope="col">{texts.ereignisse.wer}</th></tr></thead>
                  <tbody>{groups.map((group) => {
                    const entry = group.representative;
                    const eventLabel = eventText(entry.code, eventDetail(entry.detail));
                    return <tr key={group.key} ref={groupRowRef(group.key)} tabIndex={0} aria-selected={selectedGroupKey === group.key} onClick={() => { selectGroup(group.key); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectGroup(group.key); } }}><td className="mono" title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</td><td><span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texts={texts} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventLabel}</span></span></td><td className={moduleLabel(entry) === entry.moduleId ? "mono" : undefined}>{moduleLabel(entry)}</td><td>{actorCell(entry, texts)}</td></tr>;
                  })}</tbody>
                </table>
              </div>
            </div>}
            <EventFeedEnd nextCursor={eventsState.data.nextCursor} loadingNextPage={loadingNextPage} onNextPage={onNextPage} />
          </> : null}
        </div>
        {selectedGroup === null ? null : <SubInspector ariaLabel={texts.ereignisse.detail} title={texts.ereignisse.vorgang} identifier={selectedGroup.representative.triggerId || selectedGroup.representative.eventId} closeLabel={dashboardCommonTexts().schliessen} onClose={closeGroup}>
          <dl className="eigenschaften"><div><dt>{texts.ereignisse.timestamp}</dt><dd className="mono" title={selectedHistory[0]?.createdAt}>{selectedHistory[0] === undefined ? "" : formatTimestamp(selectedHistory[0].createdAt)}</dd></div><div><dt>{texts.ereignisse.module}</dt><dd>{Array.from(new Set(selectedHistory.map(moduleLabel))).join(", ")}</dd></div><div><dt>{texts.ereignisse.beteiligte}</dt><dd>{Array.from(new Set(selectedHistory.map((entry) => actorLabel(entry, texts)))).join(", ")}</dd></div></dl>
          <div className="inspector-section__heading"><h3>{texts.ereignisse.verlauf}</h3></div>
          <ol className="ereignis-verlauf">{selectedHistory.map((entry) => {
            return <li key={entry.eventId}><div className="ereignis-verlauf__heading"><span className="mono">{entry.code}</span><span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texts={texts} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventText(entry.code, eventDetail(entry.detail))}</span></span></div><pre className="event-detail-json">{formatEventDetail(entry.detail)}</pre></li>;
          })}</ol>
        </SubInspector>}
      </section>
    </>
  );
};

export const DashboardApp = (): ReactElement => {
  useEffect(() => {
    document.documentElement.lang = dashboardLanguage();
  }, []);

  const [route, navigate] = useDashboardRoute();
  const [channels, setChannels] = useState<LoadState<PanelChannelState[]>>(() => idleState());
  const [isPlatform, setIsPlatform] = useState(false);
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
    if (route.kind === "betreiber" && channels.status === "success" && !isPlatform) {
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

    const load = async (): Promise<void> => {
      // Die Modulseite zeigt denselben Kanalkopf wie die Uebersicht und
      // braucht deshalb dieselben Daten.
      if (route.kind === "module" || route.section === "overview") {
        if (route.kind === "module") setModules(loadingState());
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
        if (route.kind === "module") {
          try {
            const response = await fetchModules(route.channelId, controller.signal);
            if (!cancelled && !controller.signal.aborted) setModules(loadedState(response));
          } catch (error) {
            if (!cancelled && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
              setModules({ status: "error", data: null, error: errorMessage(error) });
              if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
            }
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
        return;
      }
      if (route.section === "events") {
        setEvents(loadingState());
        setEventsChannelId(route.channelId);
        setModules(loadingState());
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
        try {
          const response = await fetchModules(route.channelId, controller.signal);
          if (!cancelled && !controller.signal.aborted) setModules(loadedState(response));
        } catch (error) {
          if (!cancelled && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
            setModules({ status: "error", data: null, error: errorMessage(error) });
          }
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
            // Die Zahl gilt fuer den ganzen Kanal; die jeweils frischere Antwort zaehlt.
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
      // 401 heisst: die Session ist tatsaechlich weg, der geschuetzte Zustand
      // darf geraeumt werden. 403 heisst nur, dass das CSRF-Token nicht passte —
      // der Worker hat dann nichts widerrufen. Wer hier raeumt, meldet eine
      // Abmeldung, die gar nicht stattgefunden hat; nach einem Neuladen ist der
      // Nutzer wieder angemeldet.
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
    return <main className="auth-screen"><div className="auth-card"><h1>{texts.anmeldung.erforderlich}</h1><p>{texts.anmeldung.erklaerung}</p><a className="button" href="/auth/login">{texts.anmeldung.mitTwitchAnmelden}</a></div></main>;
  }

  return (
    <div className="app-shell">
      <PanelTopbar route={route} channels={channels.data ?? []} platformAdmin={isPlatform} activeChannel={selectedChannel ?? undefined} moduleStates={route.kind === "module" ? modules.data?.modules ?? null : null} loadedAt={loadedAtForRoute(route, { overview: overview.loadedAt, system: system.loadedAt, members: members.loadedAt, modules: modules.loadedAt, events: events.loadedAt })} headerModule={route.kind === "module" ? modules.data?.modules.find((module) => module.id === route.moduleId) : undefined} headerModuleBusy={headerModuleBusy} onToggleHeaderModule={() => { void toggleHeaderModule(); }} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} />
      <div className="app-body">
        <Rail route={route} channels={channels.data ?? []} platformAdmin={isPlatform} onNavigate={navigate} />
        <main className="main-content">
        {channels.status === "loading" ? <p className="loading-line">{dashboardTexts().anmeldung.checkChannelAccess}</p> : null}
        {channels.error !== null ? <ErrorPanel message={channels.error} /> : null}
        {route.kind === "overview" && channels.data !== null ? <OverviewPage channels={channels.data} onNavigate={navigate} /> : null}
        {route.kind === "betreiber" && isPlatform ? <PlatformPage onAuthenticationRequired={requestLogin} /> : null}
        {(route.kind === "channel" || route.kind === "module") && selectedChannel === null && channels.status === "success" ? <ErrorPanel message={dashboardTexts().fehler.channelNotReleased} /> : null}
        {route.kind === "channel" && route.section === "overview" && overview.status === "loading" ? <p className="loading-line">{dashboardTexts().overview.loadState}</p> : null}
        {route.kind === "channel" && route.section === "overview" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "channel" && route.section === "overview" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} moderatorCheck={moderatorCheck} onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }} onNavigate={navigate} /> : null}
        {route.kind === "channel" && route.section === "members" && selectedChannel !== null && (members.data !== null || members.status !== "idle") ? <MembersPage key={route.channelId} channelId={route.channelId} ownRole={selectedChannel.role} eigeneUserId={members.data?.viewerUserId ?? ""} members={members.data?.members ?? []} broadcasterCount={members.data?.broadcasterCount ?? 0} nextCursor={members.data?.nextCursor ?? null} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {route.kind === "channel" && route.section === "modules" && selectedChannel !== null ? <ModuleWorkspace key={dashboardRoutePath(route)} channelId={route.channelId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} loading={modules.status === "loading"} error={modules.error} onNavigate={navigate} /> : null}
        {route.kind === "module" && overview.status === "loading" ? <p className="loading-line">{dashboardTexts().overview.loadState}</p> : null}
        {route.kind === "module" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "module" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId && selectedChannel !== null ? <ModulePage key={dashboardRoutePath(route)} channelId={route.channelId} moduleId={route.moduleId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} activeModules={overview.data.activeModules} loading={modules.status === "loading" || overview.status === "loading"} error={modules.error} busy={headerModuleBusy} onNavigate={navigate} onToggle={() => { void toggleHeaderModule(); }} /> : null}
        {route.kind === "channel" && route.section === "system" && (system.status !== "idle" || audit.status !== "idle") ? <SystemPage key={route.channelId} system={systemChannelId === route.channelId ? system.data : null} systemState={system} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
        {route.kind === "channel" && route.section === "events" && eventsChannelId === route.channelId && events.status !== "idle" ? <EventsPage key={route.channelId} channelId={route.channelId} eventsState={events} filters={eventFilters} moduleOptions={modules.data?.modules ?? []} onFiltersChange={updateEventFilters} onRefreshFirstPage={reloadFirstEventsPage} onNextPage={() => { void loadNextEventsPage(); }} loadingNextPage={loadingNextEventsPage} /> : null}
        </main>
      </div>
    </div>
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

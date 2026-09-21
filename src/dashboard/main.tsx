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
import { Led, ModuleCount, ModuleHeading, ModuleIcon, ModulePage, ModuleTaste, ModuleWorkspace, NavigationIcon, ZustandZeile, type LedStatus, type ZustandsTon } from "./module-panels";
import { MembersPage } from "./members";
import { BetreiberSeite } from "./betreiber";
import { betreiberTexte, kanalPanelTexte, roleLabel } from "./labels";
import { dashboardLanguage, dashboardTexte, ereignisText, ereignisTon, formatZeitpunkt, formatZahl, type EreignisCode, type EreignisDetail, type EreignisZahlSchluessel } from "./locale";
import { disabledStatusWord, eventSubName, moduleName, statusWord } from "./module-labels";
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

const leereEreignisFilter: PanelEventFilters = {
  herkunft: null,
  modul: null,
  ton: null,
  person: null,
};

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
  const texte = dashboardTexte();
  if (status === "connected") return texte.status.verbunden;
  if (status === "revoked") return texte.status.widerrufen;
  return texte.status.fehler;
};

const subscriptionTone = (status: PanelEventSubSubscription["status"]): ZustandsTon =>
  status === "enabled" ? "healthy" : status === "missing" || status === "pending" ? "warning" : "error";

const subscriptionStatusLabel = (status: PanelEventSubSubscription["status"]): string => {
  const texte = dashboardTexte();
  if (status === "enabled") return texte.status.aktiv;
  if (status === "missing") return texte.status.fehlend;
  if (status === "pending") return texte.status.ausstehend;
  if (status === "revoked") return texte.status.widerrufen;
  return texte.status.fehler;
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
  const texte = dashboardTexte();
  if (bot?.status === "error" || bot?.status === "revoked") {
    return { tone: "error", label: statusLabel(bot.status) };
  }
  if (tokens.loginStatus === "error" || tokens.loginStatus === "revoked") {
    return { tone: "error", label: statusLabel(tokens.loginStatus) };
  }
  if (tokens.loginStatus === null) return { tone: "neutral", label: texte.status.loginIdentitaetFehlt };
  const now = Date.now();
  const botExpiresAt = parseDate(tokens.botExpiresAt);
  const loginExpiresAt = parseDate(tokens.loginExpiresAt);
  if (botExpiresAt === null || loginExpiresAt === null) return { tone: "neutral", label: texte.status.nichtGeprueft };
  if (botExpiresAt <= now || loginExpiresAt <= now) return { tone: "error", label: texte.status.abgelaufen };
  if (bot?.status !== "connected") return { tone: "neutral", label: texte.status.nichtGeprueft };
  const lastMaintenanceAt = parseDate(bot.updatedAt);
  if (lastMaintenanceAt === null || lastMaintenanceAt <= now - BOT_MAINTENANCE_STALE_AFTER_MS) {
    return { tone: "warning", label: texte.status.wartungUeberfaellig };
  }
  if (renewalOverdue(botExpiresAt, lastMaintenanceAt, now) ||
      renewalOverdue(loginExpiresAt, lastMaintenanceAt, now)) {
    return { tone: "warning", label: texte.status.erneuerungUeberfaellig };
  }
  return { tone: "healthy", label: texte.status.gueltig };
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
  const texte = dashboardTexte();
  if (channel.moderator?.isModerator === false) return texte.status.moderatorrolleFehlt;
  if (channel.chatSubscription?.status === "error") return texte.status.chatAboFehler;
  if (channel.chatSubscription?.status === "revoked") return texte.status.chatAboWiderrufen;
  if (channel.lastError?.source === "eventsub") return texte.fehler.letzter;
  if (channel.bot?.status === "error") return texte.status.botFehler;
  if (channel.bot?.status === "revoked") return texte.status.botTokenWiderrufen;
  if (channel.botPermissions?.missingScopes.length) return texte.status.botBerechtigungenFehlen(formatZahl(channel.botPermissions.missingScopes.length));
  if (broadcasterConsentMissing(channel.broadcasterPermissions)) return kanalPanelTexte().vollzustimmungFehlt;
  const tokenStatus = tokenView(channel.tokens, channel.bot);
  if (channelBotConsentMissing(channel) && tokenStatus.tone === "healthy") return texte.status.broadcasterZustimmungFehlt;
  if (channel.chatSubscription == null && !channelBotConsentMissing(channel)) return texte.status.chatAboFehlt;
  if (channel.chatSubscription?.status === "missing") return texte.status.chatAboFehlt;
  if (tokenStatus.tone !== "healthy") return tokenStatus.label;
  if (channelStatus(channel) === "healthy") return texte.status.gesund;
  return texte.status.zustandUnvollstaendig;
};

const channelToneToLedStatus = (tone: ZustandsTon): LedStatus =>
  tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off";

const broadcasterConnectionLabel = (status: PanelChannelState["broadcasterConnection"]): string =>
  status === "connected" ? dashboardTexte().status.verbunden : dashboardTexte().status.nichtVerbunden;

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return dashboardTexte().fehler.sitzungUngueltig;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return dashboardTexte().fehler.datenLaden;
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
    <span className="nav-dot" data-status={tone} role="img" aria-label={tone === "error" ? dashboardTexte().fehler.titel : dashboardTexte().fehler.warnung} />
  );

const formatTimestamp = (value: string): string => formatZeitpunkt(value);

const ErrorPanel = ({ message }: { message: string }): ReactElement => (
  <section className="error-panel" data-status="error" role="alert">
    <strong>{dashboardTexte().fehler.titel}</strong>
    <p>{message}</p>
  </section>
);

interface SidebarProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  betreiber: boolean;
  onNavigate: (route: DashboardRoute) => void;
}

const Rail = ({ route, channels, betreiber, onNavigate }: SidebarProperties): ReactElement => {
  const texte = dashboardTexte();
  const betreiberTexteWerte = betreiberTexte();
  const activeChannel = route.kind === "channel" || route.kind === "module"
    ? channels.find((channel) => channel.channelId === route.channelId)
    : undefined;
  const navigationChannelId = route.kind === "channel" || route.kind === "module"
    ? route.channelId
    : channels[0]?.channelId ?? "";
  return (
    <aside className="rail">
      <nav className="primary-nav" aria-label={texte.navigation.hauptnavigation}>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "overview" }} current={route} onNavigate={onNavigate}>
          <span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="channel" /><span>{texte.navigation.kanal}</span></span>
          {activeChannel === undefined ? null : <NavDot tone={channelStatus(activeChannel)} />}
        </RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "system" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="system" /><span>{texte.navigation.system}</span></span></RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "members" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="members" /><span>{texte.navigation.mitglieder}</span></span></RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "modules" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="modules" /><span>{texte.navigation.module}</span></span></RouteLink>
        <RouteLink route={{ kind: "channel", channelId: navigationChannelId, section: "events" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="events" /><span>{texte.navigation.ereignisse}</span></span></RouteLink>
        {betreiber ? <RouteLink route={{ kind: "betreiber" }} current={route} onNavigate={onNavigate}><span className="rail-link__content"><NavigationIcon className="rail-link__icon" kind="members" /><span>{betreiberTexteWerte.navigation}</span></span></RouteLink> : null}
      </nav>
    </aside>
  );
};

interface PanelTopbarProperties {
  route: DashboardRoute;
  channels: PanelChannelState[];
  betreiber: boolean;
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
const MODULE_OVERVIEW_OPTION_ID = "__module-overview__";

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
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (switcherRef.current?.contains(event.target as Node)) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => { document.removeEventListener("mousedown", closeOnOutsideClick); };
  }, [onOpenChange]);

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
      return <span className="topbar__breadcrumb-current topbar__breadcrumb-area"><span className="topbar__breadcrumb-icon" aria-hidden="true">{currentIcon}</span><span>{currentLabel}</span></span>;
    }
    return <span className="topbar__channel-segment topbar__channel-segment--static" data-channel-id={currentId}>{currentLabel}</span>;
  }

  return (
    <div className="topbar__channel-switch" ref={switcherRef}>
      <button
        ref={buttonRef}
        className={kind === "module" ? "topbar__channel-button topbar__breadcrumb-link topbar__breadcrumb-area" : "topbar__channel-button"}
        type="button"
        aria-label={`${buttonLabel}: ${accessibleCurrentLabel}`}
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
  const texte = dashboardTexte();
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
    buttonLabel={texte.navigation.kanalAuswaehlen}
    listLabel={texte.navigation.kanalAuswaehlen}
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

const PanelTopbar = ({ route, channels, betreiber, activeChannel, moduleStates, loadedAt, headerModule, headerModuleBusy, onToggleHeaderModule, onNavigate, onLogout, loggingOut }: PanelTopbarProperties): ReactElement => {
  const texte = dashboardTexte();
  const betreiberTexteWerte = betreiberTexte();
  const [openSwitcher, setOpenSwitcher] = useState<"channel" | "module" | null>(null);
  const tone = activeChannel === undefined ? "neutral" : channelStatus(activeChannel);
  const connectionLabel = activeChannel === undefined
    ? null
    : tone === "healthy" ? texte.kopf.verbindungLaeuft : statusText(activeChannel);
  const headerModuleLabel = headerModule === undefined ? null : `${moduleName(headerModule.id)} · ${statusWord(headerModule.enabled)}`;
  const headerSwitch = headerModuleLabel === null ? null : <span className="topbar__module-switch-wrap"><button className="switch topbar__module-switch" type="button" role="switch" aria-label={headerModuleLabel} aria-checked={headerModule?.enabled} aria-busy={headerModuleBusy} disabled={activeChannel?.role === "bediener" || headerModuleBusy} title={activeChannel?.role === "bediener" ? texte.module.verwaltungGesperrt : undefined} onClick={onToggleHeaderModule}><span className="topbar__module-switch-label">{headerModuleLabel}</span><span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span></button>{activeChannel?.role === "bediener" ? <span className="sperrgrund">{texte.module.verwaltungGesperrt}</span> : null}</span>;
  const connectionLed = connectionLabel === null ? null : <span className="led" data-status={tone === "healthy" ? "green" : tone === "warning" ? "amber" : "red"}><span className="led__dot" aria-hidden="true" /><span>{connectionLabel}</span></span>;
  const areaRoute = route.kind === "channel"
    ? { kind: "channel" as const, channelId: route.channelId, section: route.section }
    : route.kind === "module"
      ? { kind: "channel" as const, channelId: route.channelId, section: "modules" as const }
      : null;
  const areaLabel = areaRoute === null ? null : areaRoute.section === "overview" ? texte.navigation.kanal
    : areaRoute.section === "system" ? texte.navigation.system
      : areaRoute.section === "members" ? texte.navigation.mitglieder
        : areaRoute.section === "modules" ? texte.navigation.module : texte.navigation.ereignisse;
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
  const moduleArea = route.kind === "module" && moduleStates !== null
    ? <BreadcrumbSwitcher
        kind="module"
        currentLabel={texte.navigation.module}
        accessibleCurrentLabel={moduleLabel ?? texte.navigation.module}
        currentId={route.moduleId}
        currentIcon={<NavigationIcon kind="modules" className="topbar__breadcrumb-glyph" />}
        options={[...moduleOptions, {
          id: MODULE_OVERVIEW_OPTION_ID,
          name: texte.module.modulUebersicht,
          icon: <NavigationIcon kind="modules" className="topbar__channel-option-icon" />,
        }]}
        openable={moduleOptions.length > 1}
        buttonLabel={texte.navigation.modulAuswaehlen}
        listLabel={texte.navigation.modulAuswaehlen}
        listboxId="module-switcher-listbox"
        open={openSwitcher === "module"}
        onOpenChange={(open) => { setOpenSwitcher(open ? "module" : null); }}
        onSelect={(id) => {
          if (id === MODULE_OVERVIEW_OPTION_ID) {
            onNavigate({ kind: "channel", channelId: route.channelId, section: "modules" });
          } else {
            onNavigate({ kind: "module", channelId: route.channelId, moduleId: id });
          }
        }}
      />
    : route.kind === "module" && areaRoute !== null && areaLabel !== null
      ? <BreadcrumbAreaLink route={areaRoute} label={areaLabel} icon={<NavigationIcon kind="modules" className="topbar__breadcrumb-glyph" />} onNavigate={onNavigate} />
      : null;
  return (
    <header className={`topbar${headerModuleLabel === null ? "" : " topbar--module-detail"}`}>
      <nav className={`topbar__breadcrumb${route.kind === "module" ? " topbar__breadcrumb--module" : ""}`} aria-label={texte.navigation.brotkrume}>
        <a className="brand-mark" href="/" aria-current={route.kind === "overview" ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate({ kind: "overview" }); }}><span className="brand-mark__dot" /><span className="brand-mark__word">BroBot</span></a>
        {activeChannel === undefined ? null : <><span className="topbar__breadcrumb-separator" aria-hidden="true">›</span><ChannelSwitcher channels={channels} activeChannel={activeChannel} open={openSwitcher === "channel"} onOpenChange={(open) => { setOpenSwitcher(open ? "channel" : null); }} onNavigate={onNavigate} /></>}
        {areaRoute === null || areaLabel === null ? null : <><span className="topbar__breadcrumb-separator topbar__breadcrumb-area-separator topbar__area-separator" aria-hidden="true">›</span>{route.kind === "module" ? moduleArea : <span className="topbar__breadcrumb-current topbar__breadcrumb-area" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true"><NavigationIcon kind={areaRoute.section === "overview" ? "channel" : areaRoute.section} className="topbar__breadcrumb-glyph" /></span><span>{areaLabel}</span></span>}</>}
        {route.kind === "betreiber" && betreiber ? <><span className="topbar__breadcrumb-separator topbar__breadcrumb-area-separator" aria-hidden="true">›</span><span className="topbar__breadcrumb-current topbar__breadcrumb-area" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true"><NavigationIcon kind="members" className="topbar__breadcrumb-glyph" /></span><span>{betreiberTexteWerte.navigation}</span></span></> : null}
        {moduleLabel === null || moduleBreadcrumbIcon === null ? null : <><span className="topbar__breadcrumb-separator topbar__breadcrumb-module-separator topbar__crumb-area" aria-hidden="true">›</span><span className="topbar__breadcrumb-current topbar__breadcrumb-module topbar__crumb-last" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true">{moduleBreadcrumbIcon}</span><span>{moduleLabel}</span></span></>}
      </nav>
      <span className="topbar__connection">{connectionLed}</span>
      {loadedAt === undefined ? null : <Datenalter seit={loadedAt} />}
      {headerSwitch}
      <button className="button button--quiet topbar__logout" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? texte.navigation.abmeldungLaeuft : texte.navigation.abmelden}</button>
    </header>
  );
};

const OverviewPage = ({ channels, onNavigate }: { channels: PanelChannelState[]; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
  const texte = dashboardTexte();
  return (
    <>
      <ModuleHeading kind="overview" title={texte.navigation.uebersicht} subtitle={channels.length === 1 ? texte.overview.einKanalFreigegeben : <ModuleCount count={channels.length} label={texte.overview.kanaeleFreigegebenKurz} />} />
      {channels.length === 0 ? (
        <section className="empty-state"><h2>{texte.overview.keinKanalFreigegeben}</h2><p>{texte.overview.keineMitgliedschaft}</p></section>
      ) : (
        <div className="module-grid">
          {channels.map((channel) => (
            <ModuleTaste
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
  const texte = dashboardTexte();
  if (s < 60) return texte.zeit.vorSekunden(s);
  const m = Math.round(s / 60);
  if (m < 60) return texte.zeit.vorMinuten(m);
  return texte.zeit.vorStunden(Math.round(m / 60));
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
  return <span className="datenalter">{dashboardTexte().zeit.aktualisiert(relativeZeit(seit, jetzt))}</span>;
};

const ModeratorCheckAction = ({ canCheck, checking, checkError, nextAllowedAt, dringend, onCheck }: {
  canCheck: boolean; checking: boolean; checkError: string | null;
  nextAllowedAt: string | null; dringend: boolean; onCheck: () => void;
}): ReactElement => {
  const texte = dashboardTexte();
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
        {checking ? texte.moderation.pruefungLaeuft : texte.moderation.moderatorstatusPruefen}
      </button>
      {nextAllowedAt === null ? null : <p className="muted moderator-check-time">{texte.moderation.naechstePruefungAb(formatTimestamp(nextAllowedAt))}</p>}
      {!canCheck ? <span className="sperrgrund">{texte.moderation.pruefungGesperrt}</span> : null}
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
  const texte = dashboardTexte();
  return (
    <div className="header-action">
      {canRequest ? <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/channel-bot`}>{texte.moderation.broadcasterZustimmungAnfordern}</a> : <button className="button" type="button" disabled>{texte.moderation.broadcasterZustimmungAnfordern}</button>}
      {!canRequest ? <span className="sperrgrund">{texte.moderation.broadcasterErneutAutorisieren}</span> : null}
    </div>
  );
};

const BroadcasterConsentAction = ({ login, needed, canRequest }: {
  login: string;
  needed: boolean;
  canRequest: boolean;
}): ReactElement | null => {
  if (!needed) return null;
  const texte = kanalPanelTexte();
  return (
    <div className="header-action">
      {canRequest ? <a className="button button--primary" href={`/auth/login?kanal=${encodeURIComponent(login)}`}>{texte.vollzustimmungAnfordern}</a> : <button className="button" type="button" disabled>{texte.vollzustimmungAnfordern}</button>}
      {!canRequest ? <span className="sperrgrund">{texte.vollzustimmungGesperrt}</span> : null}
    </div>
  );
};

const toneRank: Record<ZustandsTon, number> = { error: 0, warning: 1, neutral: 2, healthy: 3 };

interface StatusEntry {
  key: string;
  tone: ZustandsTon;
  node: ReactElement;
}

const sortBySeverity = (entries: StatusEntry[]): StatusEntry[] =>
  [...entries].sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);

const botRow = (bot: PanelBotStatus | null): StatusEntry => {
  const texte = dashboardTexte();
  if (bot === null) return { key: "bot", tone: "neutral", node: <ZustandZeile label={texte.statusKarte.botAccount} tone="neutral" wort={texte.status.nichtEingerichtet} detail={texte.bot.keinGespeicherterStatus} /> };
  const tone: ZustandsTon = bot.status === "connected" ? "healthy" : "error";
  return { key: "bot", tone, node: <ZustandZeile label={texte.statusKarte.botAccount} tone={tone} wort={statusLabel(bot.status)} detail={bot.reason ?? texte.bot.zuletztAktualisiert(formatTimestamp(bot.updatedAt))} /> };
};

const broadcasterRow = (status: PanelChannelState["broadcasterConnection"]): StatusEntry => {
  const texte = dashboardTexte();
  const tone: ZustandsTon = status === "connected" ? "healthy" : "neutral";
  return { key: "broadcaster", tone, node: <ZustandZeile label={texte.statusKarte.broadcasterOauth} tone={tone} wort={broadcasterConnectionLabel(status)} detail={status === "connected" ? texte.bot.optionaleModule : texte.bot.normalerBetrieb} /> };
};

const chatRow = (status: PanelChannelState["chatSubscription"] | undefined, expected = false): StatusEntry => {
  const texte = dashboardTexte();
  const current = status ?? null;
  const tone: ZustandsTon = current === null ? expected ? "warning" : "neutral" : current.status === "enabled" ? "healthy" : current.status === "missing" ? "warning" : "error";
  const wort = current === null ? expected ? texte.status.fehlend : texte.status.nichtGeprueft : current.status === "enabled" ? texte.status.aktiv : current.status === "missing" ? texte.status.fehlend : current.status === "revoked" ? texte.status.widerrufen : texte.status.fehler;
  return { key: "chat-subscription", tone, node: <ZustandZeile label={texte.statusKarte.chatAbo} tone={tone} wort={wort} detail={current?.reason ?? (current === null && expected ? texte.status.chatAboFehlt : undefined)} /> };
};

const botPermissionsRow = (permissions: PanelBotPermissions | null | undefined): StatusEntry | null => {
  const texte = dashboardTexte();
  if (permissions === undefined) return null;
  if (permissions === null) {
    return {
      key: "bot-permissions",
      tone: "neutral",
      node: <ZustandZeile label={texte.statusKarte.botBerechtigungen} tone="neutral" wort={texte.status.nichtGeprueft} detail={texte.bot.keinGespeicherterStatus} />,
    };
  }
  const missing = permissions.missingScopes.length;
  const tone: ZustandsTon = missing === 0 ? "healthy" : "warning";
  return {
    key: "bot-permissions",
    tone,
    node: <ZustandZeile
      label={texte.statusKarte.botBerechtigungen}
      tone={tone}
      wort={missing === 0 ? texte.status.gesund : texte.status.botBerechtigungenFehlen(formatZahl(missing))}
      detail={missing === 0 ? texte.bot.botBerechtigungenVollstaendig : texte.bot.botBerechtigungenBetreiber}
    />,
  };
};

const broadcasterPermissionsRow = (permissions: PanelBroadcasterPermissions | null | undefined): StatusEntry | null => {
  const texte = kanalPanelTexte();
  if (!broadcasterConsentMissing(permissions)) return null;
  return {
    key: "broadcaster-permissions",
    tone: "warning",
    node: <ZustandZeile
      label={texte.vollzustimmungFehlt}
      tone="warning"
      wort={texte.vollzustimmungFehlt}
      detail={texte.vollzustimmungGesperrt}
    />,
  };
};

const tokenRow = (tokens: PanelTokenStatus, bot: PanelBotStatus | null): StatusEntry => {
  const texte = dashboardTexte();
  const token = tokenView(tokens, bot);
  return { key: "token", tone: token.tone, node: <ZustandZeile label={texte.statusKarte.tokenZustand} tone={token.tone} wort={token.label} detail={tokens.loginReason ?? undefined} /> };
};

const channelBotConsentRow = (status: PanelChannelState["channelBotConsent"]): StatusEntry => {
  const texte = dashboardTexte();
  const tone: ZustandsTon = status === "missing" ? "warning" : "healthy";
  return { key: "channel-bot-consent", tone, node: <ZustandZeile label={texte.statusKarte.chatZustimmung} tone={tone} wort={status === "missing" ? texte.statusKarte.broadcasterZustimmungFehlt : texte.status.vorhanden} detail={status === "missing" ? texte.statusKarte.chatBotNoetig : undefined} /> };
};

const moderatorRow = (moderator: PanelModeratorStatus | null): StatusEntry => {
  const texte = dashboardTexte();
  const tone: ZustandsTon = moderator === null ? "neutral" : moderator.isModerator ? "healthy" : "error";
  const wort = moderator === null ? texte.status.nichtGeprueft : moderator.isModerator ? texte.status.moderator : texte.status.moderatorrolleFehlt;
  const detail = moderator === null
    ? texte.moderation.fuerKanalKeinePruefung
    : moderator.reason ?? texte.moderation.letztePruefung(formatTimestamp(moderator.checkedAt));
  return { key: "moderator", tone, node: <ZustandZeile label={texte.statusKarte.moderatorstatus} tone={tone} wort={wort} detail={detail} /> };
};

const lastErrorRow = (error: PanelLastError | null): StatusEntry => {
  const texte = dashboardTexte();
  const tone: ZustandsTon = error === null ? "healthy" : "error";
  if (error === null) {
    return { key: "fehler", tone, node: <ZustandZeile label={texte.fehler.letzter} tone={tone} wort={texte.status.gesund} detail={texte.fehler.keineUrsache} /> };
  }
  const aboName = error.source === "eventsub" && error.subscriptionType !== undefined
    ? eventSubName(error.subscriptionType, error.subscriptionVariant ?? "")
    : null;
  const grund = aboName === null ? error.reason : `${aboName}: ${error.reason}`;
  const detail = [
    grund,
    error.message === null || error.message === undefined ? null : kuerzeAuf200Zeichen(error.message),
    error.status === null || error.status === undefined ? null : `HTTP ${String(error.status)}`,
    formatTimestamp(error.at),
  ].filter((part): part is string => part !== null).join(" · ");
  return { key: "fehler", tone, node: <ZustandZeile label={texte.fehler.letzter} tone={tone} wort={texte.status.fehler} detail={detail} /> };
};

const BotPermissionsInspector = ({ permissions }: { permissions: PanelBotPermissions | null | undefined }): ReactElement | null => {
  const texte = dashboardTexte();
  if (permissions === null || permissions === undefined || permissions.missingScopes.length === 0) return null;
  return (
    <section className="command-inspector sub-inspector" aria-label={texte.system.botBerechtigungenInspector}>
      <div className="inspector-section__heading"><h3>{texte.system.botBerechtigungenInspector}</h3><span className="mono muted">{formatZahl(permissions.missingScopes.length)}</span></div>
      <h4>{texte.system.fehlendeScopes}</h4>
      <ul className="scope-liste">{permissions.missingScopes.map((scope) => <li className="mono" key={scope}>{scope}</li>)}</ul>
    </section>
  );
};

const BroadcasterPermissionsInspector = ({ permissions }: { permissions: PanelBroadcasterPermissions | null | undefined }): ReactElement | null => {
  const texte = kanalPanelTexte();
  if (!broadcasterConsentMissing(permissions)) return null;
  return (
    <section className="command-inspector sub-inspector" aria-label={texte.fehlendeBroadcasterBerechtigungen}>
      <div className="inspector-section__heading"><h3>{texte.fehlendeBroadcasterBerechtigungen}</h3><span className="mono muted">{formatZahl(permissions.missingScopes.length)}</span></div>
      <h4>{texte.fehlendeScopes}</h4>
      <ul className="scope-liste">{permissions.missingScopes.map((scope) => <li className="mono" key={scope}>{scope}</li>)}</ul>
    </section>
  );
};

const subscriptionKey = (subscription: PanelEventSubSubscription): string =>
  `${subscription.subscriptionType}\u0000${subscription.variant}\u0000${subscription.version}`;

const subscriptionDisplayName = (subscription: PanelEventSubSubscription): string =>
  eventSubName(subscription.subscriptionType, subscription.variant);

const SubscriptionsSection = ({ subscriptions }: { subscriptions: PanelEventSubSubscription[] }): ReactElement => {
  const texte = dashboardTexte();
  const leer = "—";
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = subscriptions.find((subscription) => subscriptionKey(subscription) === selectedKey) ?? null;
  return (
    <section className="content-section" aria-label={texte.system.abonnements}>
      <div className="section-heading"><h2>{texte.system.abonnements}</h2><span className="muted zahl">{formatZahl(subscriptions.length)}</span></div>
      {subscriptions.length === 0 ? <p className="empty-state">{texte.system.keineAbonnements}</p> : <>
        <div className="tabelle-wrap">
          <table className="tabelle abonnements-tabelle">
            <thead><tr><th scope="col">{texte.system.abo}</th><th scope="col">{texte.system.zustand}</th><th scope="col">{texte.system.grund}</th></tr></thead>
            <tbody>{subscriptions.map((subscription) => {
              const key = subscriptionKey(subscription);
              const name = subscriptionDisplayName(subscription);
              const unknown = name === subscription.subscriptionType;
              const tone = subscriptionTone(subscription.status);
              return <tr
                key={key}
                tabIndex={0}
                aria-selected={selectedKey === key}
                onClick={() => { setSelectedKey(key); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(key); } }}
              >
                <th scope="row"><span className={unknown ? "mono" : undefined}>{name}</span></th>
                <td><Led status={channelToneToLedStatus(tone)} label={subscriptionStatusLabel(subscription.status)} /></td>
                <td>{subscription.reason ?? leer}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {selected === null ? null : <section className="command-inspector sub-inspector" aria-label={texte.system.aboInspector}>
          <div className="inspector-section__heading"><h3>{subscriptionDisplayName(selected)}</h3><span className="mono muted">{selected.subscriptionId ?? leer}</span></div>
          <dl className="eigenschaften">
            <div><dt>{texte.system.aboTyp}</dt><dd className="mono">{selected.subscriptionType}</dd></div>
            <div><dt>{texte.system.aboVersion}</dt><dd className="mono">{selected.version}</dd></div>
            <div><dt>{texte.system.aboId}</dt><dd className="mono">{selected.subscriptionId ?? leer}</dd></div>
            <div><dt>{texte.system.aboAktualisiert}</dt><dd className="mono">{formatTimestamp(selected.updatedAt)}</dd></div>
            <div><dt>{texte.system.twitchMeldung}</dt><dd>{selected.message ?? leer}</dd></div>
            <div><dt>{texte.system.httpStatus}</dt><dd className="mono">{selected.statusCode === null ? leer : String(selected.statusCode)}</dd></div>
          </dl>
        </section>}
      </>}
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
  const eintraege = sortBySeverity([
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
        actions={<><ModeratorCheckAction canCheck={overview.role !== "bediener"} checking={moderatorCheck.status === "loading"} checkError={moderatorCheck.error} nextAllowedAt={moderatorCheck.nextAllowedAt} dringend={overview.moderator === null || !overview.moderator.isModerator} onCheck={onCheckModeratorStatus} /><ChannelBotConsentAction channelId={overview.channelId} needed={overview.channelBotConsent === "missing"} canRequest={overview.role === "broadcaster"} /><BroadcasterConsentAction login={overview.login} needed={broadcasterConsentMissing(overview.broadcasterPermissions)} canRequest={overview.role === "broadcaster"} /></>}
      />
      <div className="zustand-liste">{eintraege.map((eintrag) => <Fragment key={eintrag.key}>{eintrag.node}</Fragment>)}</div>
      <BotPermissionsInspector permissions={overview.botPermissions} />
      <BroadcasterPermissionsInspector permissions={overview.broadcasterPermissions} />
      <section className="content-section"><div className="section-heading"><h2>{dashboardTexte().overview.aktiveModule}</h2><span className="muted zahl">{formatZahl(overview.activeModules.length)}</span></div>{overview.activeModules.length === 0 ? <p className="empty-state">{dashboardTexte().module.keineAktiv}</p> : <div className="module-grid">{overview.activeModules.map(({ moduleId }) => <ModuleTaste key={moduleId} channelId={overview.channelId} moduleId={moduleId} enabled onNavigate={onNavigate} />)}</div>}</section>
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
  const texte = dashboardTexte();
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);
  const auditWasLoading = useRef(auditState.status === "loading");
  useEffect(() => {
    if (auditState.status === "loading" && !auditWasLoading.current) setSelectedAuditId(null);
    auditWasLoading.current = auditState.status === "loading";
  }, [auditState.status]);
  const selectedAudit = auditState.data?.entries.find((entry) => entry.auditId === selectedAuditId) ?? null;
  return (
    <>
      <ModuleHeading kind="system" title={texte.system.titel} subtitle={texte.system.nurLesend} />
      {system === null && systemState.status === "loading" ? <p className="loading-line">{texte.system.zustandLaden}</p> : null}
      {systemState.error !== null ? <ErrorPanel message={systemState.error} /> : null}
      {system === null ? null : <>
        <div className="zustand-liste">{[broadcasterRow(system.broadcasterConnection), chatRow(system.chatSubscription), botRow(system.bot), botPermissionsRow(system.botPermissions), broadcasterPermissionsRow(system.broadcasterPermissions), tokenRow(system.tokens, system.bot)].filter((entry): entry is StatusEntry => entry !== null).map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
        <BotPermissionsInspector permissions={system.botPermissions} />
        <BroadcasterPermissionsInspector permissions={system.broadcasterPermissions} />
        <SubscriptionsSection subscriptions={system.subscriptions ?? []} />
        <SystemProperties system={system} />
      </>}
      <section className="content-section"><div className="section-heading"><h2>{texte.system.auditLog}</h2>{auditState.data === null ? null : <span className="muted"><span className="zahl">{formatZahl(auditState.data.entries.length)}</span> {texte.system.eintraege}</span>}</div>
        {auditState.status === "loading" && auditState.data === null ? <p className="loading-line">{texte.system.auditLaden}</p> : null}
        {auditState.error !== null ? <ErrorPanel message={auditState.error} /> : null}
        {auditState.data !== null && auditState.data.entries.length === 0 ? <p className="empty-state">{texte.system.keineAuditEintraege}</p> : null}
        {auditState.data !== null && auditState.data.entries.length > 0 ? <>
          <div className={auditState.status === "loading" ? "veraltet" : undefined}>
            <table className="tabelle audit-tabelle">
              <thead><tr><th scope="col">{texte.system.zeit}</th><th scope="col">{texte.system.aktion}</th><th scope="col">{texte.system.wer}</th></tr></thead>
              <tbody>{auditState.data.entries.map((entry) => <tr key={entry.auditId} tabIndex={0} aria-selected={selectedAuditId === entry.auditId} onClick={() => { setSelectedAuditId(entry.auditId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedAuditId(entry.auditId); } }}><td className="mono">{formatTimestamp(entry.createdAt)}</td><th scope="row" className="mono">{entry.action}</th><td>{auditActorLabel(entry)}</td></tr>)}</tbody>
            </table>
          </div>
          {selectedAudit === null ? null : <section className="command-inspector sub-inspector" aria-label={texte.system.aenderungsdaten}>
            <div className="inspector-section__heading"><h3>{selectedAudit.action}</h3><span className="mono muted">{selectedAudit.auditId}</span></div>
            <dl className="eigenschaften"><div><dt>{texte.system.wer}</dt><dd className="mono">{selectedAudit.actorUserId}</dd></div></dl>
            <div className="inspector-columns"><div><h4>{texte.system.vorher}</h4><pre>{selectedAudit.before}</pre></div><div><h4>{texte.system.nachher}</h4><pre>{selectedAudit.after}</pre></div></div>
          </section>}
          {auditState.data.nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? texte.system.aeltereEintraegeLaden : texte.system.aeltereEintraege}</button>}
        </> : null}
      </section>
    </>
  );
};

const SystemProperties = ({ system }: { system: PanelSystemResponse }): ReactElement => {
  const texte = dashboardTexte();
  const leer = "—";
  const loginStatus = system.tokens.loginStatus === null ? leer : statusLabel(system.tokens.loginStatus);
  return (
    <section className="content-section properties-section" aria-label={texte.system.eigenschaften}>
      <div className="section-heading"><h2>{texte.system.eigenschaften}</h2></div>
      <dl className="eigenschaften">
        <div><dt>{texte.system.botGrund}</dt><dd>{system.bot?.reason ?? leer}</dd></div>
        <div><dt>{texte.system.botAktualisiert}</dt><dd className="mono">{system.bot === null ? leer : formatTimestamp(system.bot.updatedAt)}</dd></div>
        <div><dt>{texte.system.chatAboId}</dt><dd className="mono">{system.chatSubscription?.subscriptionId ?? leer}</dd></div>
        <div><dt>{texte.system.chatAboGrund}</dt><dd>{system.chatSubscription?.reason ?? leer}</dd></div>
        <div><dt>{texte.system.chatAboAktualisiert}</dt><dd className="mono">{system.chatSubscription == null ? leer : formatTimestamp(system.chatSubscription.updatedAt)}</dd></div>
        <div><dt>{texte.system.loginStatus}</dt><dd>{loginStatus}</dd></div>
        <div><dt>{texte.system.loginGrund}</dt><dd>{system.tokens.loginReason ?? leer}</dd></div>
        <div><dt>{texte.system.loginGueltigBis}</dt><dd className="mono">{system.tokens.loginExpiresAt === null ? leer : formatTimestamp(system.tokens.loginExpiresAt)}</dd></div>
        <div><dt>{texte.system.botGueltigBis}</dt><dd className="mono">{system.tokens.botExpiresAt === null ? leer : formatTimestamp(system.tokens.botExpiresAt)}</dd></div>
      </dl>
    </section>
  );
};

const eventMetadata = (code: string) =>
  Object.prototype.hasOwnProperty.call(ereignisTon, code) ? ereignisTon[code as EreignisCode] : null;

const eventTone = (code: string): "info" | "hinweis" | "fehler" | null =>
  eventMetadata(code)?.ton ?? null;

const eventToneRang = (tone: "info" | "hinweis" | "fehler" | null): number =>
  tone === "fehler" ? 3 : tone === "hinweis" ? 2 : tone === "info" ? 1 : 0;

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

const actorLabel = (entry: PanelEventEntry, texte: ReturnType<typeof dashboardTexte>): string =>
  entry.actorDisplayName ?? (entry.actorLogin == null
    ? entry.actorUserId == null ? texte.ereignisse.automatisch : entry.actorUserId
    : `@${entry.actorLogin}`);

const actorCell = (entry: PanelEventEntry, texte: ReturnType<typeof dashboardTexte>): ReactNode =>
  entry.actorDisplayName ?? (entry.actorLogin == null
    ? entry.actorUserId == null ? texte.ereignisse.automatisch : <span className="mono">{entry.actorUserId}</span>
    : `@${entry.actorLogin}`);

const auditActorLabel = (entry: PanelAuditEntry): string =>
  entry.actorDisplayName ?? (entry.actorLogin == null ? entry.actorUserId : `@${entry.actorLogin}`);

const moduleLabel = (entry: PanelEventEntry): string => moduleName(entry.moduleId);

const chronologisch = (left: PanelEventEntry, right: PanelEventEntry): number =>
  left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);

const eventDetail = (detail: string): EreignisDetail => {
  try {
    const parsed: unknown = JSON.parse(detail);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as EreignisDetail
      : {};
  } catch {
    return {};
  }
};

const eventChipNumber = (detail: EreignisDetail, key: EreignisZahlSchluessel): string | null => {
  if (key === null) return null;
  const value = detail[key];
  if (key === "stufe") {
    const stufe = typeof value === "number" ? String(value) : value;
    if (typeof stufe !== "string") return null;
    if (stufe === "1000") return "T1";
    if (stufe === "2000") return "T2";
    if (stufe === "3000") return "T3";
    if (stufe.toLowerCase() === "prime") return "Prime";
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return null;
  if (key === "anzahl") return `${formatZahl(value)}x`;
  if (key === "dauer" || key === "restSekunden") return `${formatZahl(value)} s`;
  return formatZahl(value);
};

const EventChipPair = ({ code, detail, texte }: { code: string; detail: EreignisDetail; texte: ReturnType<typeof dashboardTexte> }): ReactElement => {
  const metadata = eventMetadata(code);
  if (metadata === null) {
    return <span className="event-chip-pair"><span className="event-chip" data-stufe="gezeichnet">{texte.ereignisse.unbekannt}</span></span>;
  }
  const number = eventChipNumber(detail, metadata.zahlSchluessel);
  return <span className="event-chip-pair">
    {number === null ? null : <span className="event-chip event-chip--number">{number}</span>}
    <span className="event-chip" data-familie={metadata.familie} data-stufe={metadata.stufe} data-ton={metadata.ton}>{metadata.wort[dashboardLanguage()]}</span>
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
  filters.herkunft !== null || filters.modul !== null || filters.ton !== null || filters.person !== null;

const EventFilterBar = ({
  filters,
  moduleOptions,
  onChange,
}: {
  filters: PanelEventFilters;
  moduleOptions: readonly PanelModuleState[];
  onChange: (filters: PanelEventFilters) => void;
}): ReactElement => {
  const texte = dashboardTexte();
  const aktiveFilter: string[] = [];
  if (filters.herkunft === "kanal") aktiveFilter.push(texte.ereignisse.kanalereignisse);
  if (filters.herkunft === "modul") aktiveFilter.push(texte.ereignisse.moduldiagnosen);
  if (filters.modul !== null) aktiveFilter.push(moduleName(filters.modul));
  if (filters.ton !== null) aktiveFilter.push(filters.ton === "info" ? texte.ereignisse.info : filters.ton === "hinweis" ? texte.ereignisse.hinweis : texte.ereignisse.fehler);
  if (filters.person !== null) aktiveFilter.push(filters.person);
  return <div className="ereignis-filter" aria-label={texte.ereignisse.filter}>
    <div className="ereignis-filter__controls">
      <label>{texte.ereignisse.herkunft}<select aria-label={texte.ereignisse.herkunft} value={filters.herkunft ?? ""} onChange={(event) => { const value = event.target.value; onChange({ ...filters, herkunft: value === "kanal" || value === "modul" ? value : null }); }}>
        <option value="">{texte.ereignisse.alle}</option><option value="kanal">{texte.ereignisse.kanalereignisse}</option><option value="modul">{texte.ereignisse.moduldiagnosen}</option>
      </select></label>
      <label>{texte.ereignisse.modulFilter}<select aria-label={texte.ereignisse.modulFilter} value={filters.modul ?? ""} onChange={(event) => { const value = event.target.value; onChange({ ...filters, modul: value.length === 0 ? null : value }); }}>
        <option value="">{texte.ereignisse.alle}</option>{moduleOptions.map((module) => <option key={module.id} value={module.id}>{moduleName(module.id)}</option>)}
      </select></label>
      <label>{texte.ereignisse.ton}<select aria-label={texte.ereignisse.ton} value={filters.ton ?? ""} onChange={(event) => { const value = event.target.value; onChange({ ...filters, ton: value === "info" || value === "hinweis" || value === "fehler" ? value : null }); }}>
        <option value="">{texte.ereignisse.alle}</option><option value="info">{texte.ereignisse.info}</option><option value="hinweis">{texte.ereignisse.hinweis}</option><option value="fehler">{texte.ereignisse.fehler}</option>
      </select></label>
      <label>{texte.ereignisse.person}<input aria-label={texte.ereignisse.person} value={filters.person ?? ""} onChange={(event) => { const value = event.target.value.trim(); onChange({ ...filters, person: value.length === 0 ? null : value }); }} /></label>
    </div>
    {aktiveFilter.length === 0 ? null : <div className="form-actions"><p className="muted" aria-live="polite">{texte.ereignisse.aktiveFilter} {aktiveFilter.join(" · ")}</p><button className="button button--quiet" type="button" onClick={() => { onChange(leereEreignisFilter); }}>{texte.ereignisse.filterZuruecksetzen}</button></div>}
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
  const texte = dashboardTexte();
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
    aria-label={nextCursor === null ? undefined : texte.ereignisse.nachladenAmEnde}
    onFocus={loadNextPage}
    onKeyDown={(event) => {
      if (event.key === "End" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        loadNextPage();
      }
    }}
  >
    {loadingNextPage ? <p className="loading-line" role="status">{texte.ereignisse.aeltereWerdenGeladen}</p> : nextCursor === null ? <p className="empty-state">{texte.ereignisse.feedEnde}</p> : <p className="muted">{texte.ereignisse.nachladenAmEnde}</p>}
  </div>;
};

const EventsPage = ({
  eventsState,
  filters,
  moduleOptions,
  onFiltersChange,
  onNextPage,
  loadingNextPage,
}: {
  eventsState: LoadState<PanelEventsResponse>;
  filters: PanelEventFilters;
  moduleOptions: readonly PanelModuleState[];
  onFiltersChange: (filters: PanelEventFilters) => void;
  onNextPage: () => void;
  loadingNextPage: boolean;
}): ReactElement => {
  const texte = dashboardTexte();
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const eventsWereLoading = useRef(eventsState.status === "loading");
  useEffect(() => {
    if (eventsState.status === "loading" && !eventsWereLoading.current) setSelectedGroupKey(null);
    eventsWereLoading.current = eventsState.status === "loading";
  }, [eventsState.status]);
  const groups = eventsState.data === null ? [] : eventGroups(eventsState.data.entries);
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? null;
  const selectedHistory = selectedGroup === null ? [] : [...selectedGroup.entries].sort(chronologisch);
  const eventEntries = eventsState.data?.entries ?? [];
  return (
    <>
      <ModuleHeading kind="events" title={texte.ereignisse.titel} subtitle={eventsState.data === null ? "" : <ModuleCount count={eventsState.data.entries.length} label={texte.ereignisse.anzahl} />} />
      <section className="content-section"><div className="section-heading"><h2>{texte.ereignisse.protokoll}</h2></div>
        <EventFilterBar filters={filters} moduleOptions={moduleOptions} onChange={onFiltersChange} />
        {eventsState.status === "loading" && eventsState.data === null ? <p className="loading-line">{texte.ereignisse.laden}</p> : null}
        {eventsState.error !== null ? <ErrorPanel message={eventsState.error} /> : null}
        {eventsState.data !== null && eventEntries.length === 0 ? <p className="empty-state">{eventFilterIsActive(filters) ? texte.ereignisse.keineTreffer : texte.ereignisse.keine}</p> : null}
        {eventsState.data !== null ? <>
          {eventEntries.length === 0 ? null : <>
            <div className={eventsState.status === "loading" ? "veraltet" : undefined}>
              <table className="tabelle ereignis-tabelle">
                <thead><tr><th scope="col">{texte.ereignisse.zeit}</th><th scope="col">{texte.ereignisse.ereignis}</th><th scope="col">{texte.ereignisse.modul}</th><th scope="col">{texte.ereignisse.wer}</th></tr></thead>
                <tbody>{groups.map((group) => {
                  const entry = group.representative;
                  const eventLabel = ereignisText(entry.code, eventDetail(entry.detail));
                  return <tr key={group.key} tabIndex={0} aria-selected={selectedGroupKey === group.key} onClick={() => { setSelectedGroupKey(group.key); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedGroupKey(group.key); } }}><td className="mono" title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</td><td><span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texte={texte} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{eventLabel}</span></span></td><td className={moduleLabel(entry) === entry.moduleId ? "mono" : undefined}>{moduleLabel(entry)}</td><td>{actorCell(entry, texte)}</td></tr>;
                })}</tbody>
              </table>
            </div>
            {selectedGroup === null ? null : <section className="command-inspector sub-inspector" aria-label={texte.ereignisse.detail}>
              <div className="inspector-section__heading"><h3>{texte.ereignisse.vorgang}</h3><span className="mono muted">{selectedGroup.representative.triggerId || selectedGroup.representative.eventId}</span></div>
              <dl className="eigenschaften"><div><dt>{texte.ereignisse.zeitstempel}</dt><dd className="mono" title={selectedHistory[0]?.createdAt}>{selectedHistory[0] === undefined ? "" : formatTimestamp(selectedHistory[0].createdAt)}</dd></div><div><dt>{texte.ereignisse.modul}</dt><dd>{Array.from(new Set(selectedHistory.map(moduleLabel))).join(", ")}</dd></div><div><dt>{texte.ereignisse.beteiligte}</dt><dd>{Array.from(new Set(selectedHistory.map((entry) => actorLabel(entry, texte)))).join(", ")}</dd></div></dl>
              <div className="inspector-section__heading"><h3>{texte.ereignisse.verlauf}</h3></div>
              <ol className="ereignis-verlauf">{selectedHistory.map((entry) => {
                return <li key={entry.eventId}><div className="ereignis-verlauf__heading"><span className="mono">{entry.code}</span><span className="event-label"><EventChipPair code={entry.code} detail={eventDetail(entry.detail)} texte={texte} /><span className={eventMetadata(entry.code) === null ? "mono" : undefined}>{ereignisText(entry.code, eventDetail(entry.detail))}</span></span></div><pre className="event-detail-json">{formatEventDetail(entry.detail)}</pre></li>;
              })}</ol>
            </section>}
          </>}
          <EventFeedEnd nextCursor={eventsState.data.nextCursor} loadingNextPage={loadingNextPage} onNextPage={onNextPage} />
        </> : null}
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
  const [istBetreiber, setIstBetreiber] = useState(false);
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
  const fordereAnmeldung = useCallback((): void => { setAuthenticationRequired(true); }, []);

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

  const clearProtectedState = (): void => {
    auditPageController.current?.abort();
    auditPageController.current = null;
    cancelEventsRequest();
    cancelMembersRequest();
    setChannels({ status: "success", data: [], error: null });
    setIstBetreiber(false);
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
          setIstBetreiber(response.betreiber);
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
    if (route.kind === "betreiber" && channels.status === "success" && !istBetreiber) {
      navigate({ kind: "overview" });
    }
  }, [channels.status, istBetreiber, navigate, route.kind]);

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
        const filters = route.filters ?? leereEreignisFilter;
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
    if (state === undefined || selectedChannel?.role === "bediener" || headerModuleBusy) return;
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
      const nextPage = await fetchEvents(channelId, cursor, request.controller.signal, route.filters ?? leereEreignisFilter);
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
  const eventFilters = route.kind === "channel" && route.section === "events" ? route.filters ?? leereEreignisFilter : leereEreignisFilter;

  if (authenticationRequired) {
    const texte = dashboardTexte();
    return <main className="auth-screen"><div className="auth-card"><h1>{texte.anmeldung.erforderlich}</h1><p>{texte.anmeldung.erklaerung}</p><a className="button" href="/auth/login">{texte.anmeldung.mitTwitchAnmelden}</a></div></main>;
  }

  return (
    <div className="app-shell">
      <PanelTopbar route={route} channels={channels.data ?? []} betreiber={istBetreiber} activeChannel={selectedChannel ?? undefined} moduleStates={route.kind === "module" ? modules.data?.modules ?? null : null} loadedAt={loadedAtForRoute(route, { overview: overview.loadedAt, system: system.loadedAt, members: members.loadedAt, modules: modules.loadedAt, events: events.loadedAt })} headerModule={route.kind === "module" ? modules.data?.modules.find((module) => module.id === route.moduleId) : undefined} headerModuleBusy={headerModuleBusy} onToggleHeaderModule={() => { void toggleHeaderModule(); }} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} />
      <div className="app-body">
        <Rail route={route} channels={channels.data ?? []} betreiber={istBetreiber} onNavigate={navigate} />
        <main className="main-content">
        {channels.status === "loading" ? <p className="loading-line">{dashboardTexte().anmeldung.kanalzugriffPruefen}</p> : null}
        {channels.error !== null ? <ErrorPanel message={channels.error} /> : null}
        {route.kind === "overview" && channels.data !== null ? <OverviewPage channels={channels.data} onNavigate={navigate} /> : null}
        {route.kind === "betreiber" && istBetreiber ? <BetreiberSeite beiAnmeldungErforderlich={fordereAnmeldung} /> : null}
        {(route.kind === "channel" || route.kind === "module") && selectedChannel === null && channels.status === "success" ? <ErrorPanel message={dashboardTexte().fehler.kanalNichtFreigegeben} /> : null}
        {route.kind === "channel" && route.section === "overview" && overview.status === "loading" ? <p className="loading-line">{dashboardTexte().overview.zustandLaden}</p> : null}
        {route.kind === "channel" && route.section === "overview" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "channel" && route.section === "overview" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} moderatorCheck={moderatorCheck} onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }} onNavigate={navigate} /> : null}
        {route.kind === "channel" && route.section === "members" && selectedChannel !== null && (members.data !== null || members.status !== "idle") ? <MembersPage key={route.channelId} channelId={route.channelId} ownRole={selectedChannel.role} eigeneUserId={members.data?.viewerUserId ?? ""} members={members.data?.members ?? []} broadcasterCount={members.data?.broadcasterCount ?? 0} nextCursor={members.data?.nextCursor ?? null} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {route.kind === "channel" && route.section === "modules" && selectedChannel !== null ? <ModuleWorkspace key={dashboardRoutePath(route)} channelId={route.channelId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} loading={modules.status === "loading"} error={modules.error} onNavigate={navigate} /> : null}
        {route.kind === "module" && overview.status === "loading" ? <p className="loading-line">{dashboardTexte().overview.zustandLaden}</p> : null}
        {route.kind === "module" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "module" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId && selectedChannel !== null ? <ModulePage key={dashboardRoutePath(route)} channelId={route.channelId} moduleId={route.moduleId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} activeModules={overview.data.activeModules} loading={modules.status === "loading" || overview.status === "loading"} error={modules.error} busy={headerModuleBusy} onNavigate={navigate} onToggle={() => { void toggleHeaderModule(); }} /> : null}
        {route.kind === "channel" && route.section === "system" && (system.status !== "idle" || audit.status !== "idle") ? <SystemPage key={route.channelId} system={systemChannelId === route.channelId ? system.data : null} systemState={system} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
        {route.kind === "channel" && route.section === "events" && eventsChannelId === route.channelId && events.status !== "idle" ? <EventsPage key={route.channelId} eventsState={events} filters={eventFilters} moduleOptions={modules.data?.modules ?? []} onFiltersChange={updateEventFilters} onNextPage={() => { void loadNextEventsPage(); }} loadingNextPage={loadingNextEventsPage} /> : null}
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

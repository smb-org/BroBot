import { Fragment, StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  PanelAuditResponse,
  PanelBotStatus,
  PanelChannelOverview,
  PanelChannelState,
  PanelEventEntry,
  PanelEventsResponse,
  PanelLastError,
  PanelMembersResponse,
  PanelModeratorStatus,
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
import { roleLabel } from "./labels";
import { dashboardLanguage, dashboardTexte, ereignisText, ereignisTon, formatZeitpunkt, formatZahl, type EreignisCode, type EreignisDetail } from "./locale";
import { moduleName, statusWord } from "./module-labels";
import { dashboardRoutePath, useDashboardRoute, type DashboardRoute } from "./router";
import "./styles.css";

interface LoadState<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
  /** Wann diese Antwort eintraf. Traegt das Datenalter in der Anzeige. */
  loadedAt?: number;
}

interface ModeratorCheckState {
  status: "idle" | "loading" | "error";
  error: string | null;
  nextAllowedAt: string | null;
}

interface MembersRequestState {
  controller: AbortController | null;
  generation: number;
}

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

const channelStatus = (channel: PanelChannelState): "healthy" | "warning" | "error" => {
  if (channel.moderator?.isModerator === false) return "error";
  if (channel.chatSubscription?.status === "error" || channel.chatSubscription?.status === "revoked") return "error";
  if (channel.lastError?.source === "eventsub") return "error";
  if (channel.bot?.status === "error" || channel.bot?.status === "revoked") return "error";
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
  onNavigate: (route: DashboardRoute) => void;
}

const Rail = ({ route, channels, onNavigate }: SidebarProperties): ReactElement => {
  const texte = dashboardTexte();
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
      </nav>
    </aside>
  );
};

interface PanelTopbarProperties {
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

type PageLoadedAt = Record<"overview" | "system" | "members" | "modules" | "events", number | undefined>;

const loadedAtForRoute = (route: DashboardRoute, loadedAt: PageLoadedAt): number | undefined => {
  if (route.kind === "overview") return undefined;
  if (route.kind === "module") return loadedAt.modules;
  return loadedAt[route.section];
};

const focusableSelector = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

const ChannelSwitcher = ({ channels, activeChannel, onNavigate }: {
  channels: PanelChannelState[];
  activeChannel: PanelChannelState | undefined;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement | null => {
  const texte = dashboardTexte();
  const switcherRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const selectedIndex = Math.max(0, channels.findIndex((channel) => channel.channelId === activeChannel?.channelId));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (switcherRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => { document.removeEventListener("mousedown", closeOnOutsideClick); };
  }, []);

  if (activeChannel === undefined) return null;

  const closeAndFocusButton = (): void => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const selectChannel = (channelId: string): void => {
    closeAndFocusButton();
    onNavigate({ kind: "channel", channelId, section: "overview" });
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
    setOpen(true);
  };

  if (channels.length === 1) {
    return <span className="topbar__channel-segment topbar__channel-segment--static" data-channel-id={activeChannel.channelId}>{activeChannel.displayName}</span>;
  }

  return (
    <div className="topbar__channel-switch" ref={switcherRef}>
      <button
        ref={buttonRef}
        className="topbar__channel-button"
        type="button"
        aria-label={`${texte.navigation.kanalAuswaehlen}: ${activeChannel.displayName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="channel-switcher-listbox"
        onClick={() => { if (open) closeAndFocusButton(); else openList(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openList();
          }
        }}
      >
        <span className="topbar__channel-segment">{activeChannel.displayName}</span>
        <span className="topbar__channel-chevron" aria-hidden="true">⌄</span>
      </button>
      {open ? <div id="channel-switcher-listbox" className="topbar__channel-list" role="listbox" aria-label={texte.navigation.kanalAuswaehlen}>
        {channels.map((channel, index) => {
          const tone = channelStatus(channel);
          return <div
            key={channel.channelId}
            ref={(element) => { optionRefs.current[index] = element; }}
            className="topbar__channel-option"
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => { selectChannel(channel.channelId); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex(Math.min(channels.length - 1, activeIndex + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(Math.max(0, activeIndex - 1));
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(channels.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectChannel(channels[activeIndex]?.channelId ?? channel.channelId);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeAndFocusButton();
              } else if (event.key === "Tab") {
                event.preventDefault();
                setOpen(false);
                window.setTimeout(focusNextControl, 0);
              }
            }}
          >
            <NavigationIcon className="topbar__channel-option-icon" kind="channel" />
            <span className="topbar__channel-option-copy">
              <span className="topbar__channel-option-name">{channel.displayName}</span>
              <span className="topbar__channel-option-id mono">{channel.channelId}</span>
            </span>
            <Led status={tone === "healthy" ? "green" : tone === "warning" ? "amber" : "red"} label={statusText(channel)} />
          </div>;
        })}
      </div> : null}
    </div>
  );
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

const PanelTopbar = ({ route, channels, activeChannel, loadedAt, headerModule, headerModuleBusy, onToggleHeaderModule, onNavigate, onLogout, loggingOut }: PanelTopbarProperties): ReactElement => {
  const texte = dashboardTexte();
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
  return (
    <header className={`topbar${headerModuleLabel === null ? "" : " topbar--module-detail"}`}>
      <nav className={`topbar__breadcrumb${route.kind === "module" ? " topbar__breadcrumb--module" : ""}`} aria-label={texte.navigation.brotkrume}>
        <a className="brand-mark" href="/" aria-current={route.kind === "overview" ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate({ kind: "overview" }); }}><span className="brand-mark__dot" /><span className="brand-mark__word">BroBot</span></a>
        {activeChannel === undefined ? null : <><span className="topbar__breadcrumb-separator" aria-hidden="true">›</span><ChannelSwitcher channels={channels} activeChannel={activeChannel} onNavigate={onNavigate} /></>}
        {areaRoute === null || areaLabel === null ? null : <><span className="topbar__breadcrumb-separator topbar__breadcrumb-area-separator topbar__area-separator" aria-hidden="true">›</span>{route.kind === "module" ? <BreadcrumbAreaLink route={areaRoute} label={areaLabel} icon={<NavigationIcon kind="modules" className="topbar__breadcrumb-glyph" />} onNavigate={onNavigate} /> : <span className="topbar__breadcrumb-current topbar__breadcrumb-area" aria-current="page"><span className="topbar__breadcrumb-icon" aria-hidden="true"><NavigationIcon kind={areaRoute.section === "overview" ? "channel" : areaRoute.section} className="topbar__breadcrumb-glyph" /></span><span>{areaLabel}</span></span>}</>}
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
  return { key: "fehler", tone, node: <ZustandZeile label={texte.fehler.letzter} tone={tone} wort={error === null ? texte.status.gesund : texte.status.fehler} detail={error === null ? texte.fehler.keineUrsache : `${error.reason} · ${formatTimestamp(error.at)}`} /> };
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
    tokenRow(overview.tokens, overview.bot),
    lastErrorRow(overview.lastError),
  ]);

  return (
    <>
      <ModuleHeading
        kind="channel"
        title={overview.displayName}
        subtitle={roleLabel(overview.role)}
        actions={<><ModeratorCheckAction canCheck={overview.role !== "bediener"} checking={moderatorCheck.status === "loading"} checkError={moderatorCheck.error} nextAllowedAt={moderatorCheck.nextAllowedAt} dringend={overview.moderator === null || !overview.moderator.isModerator} onCheck={onCheckModeratorStatus} /><ChannelBotConsentAction channelId={overview.channelId} needed={overview.channelBotConsent === "missing"} canRequest={overview.role === "broadcaster"} /></>}
      />
      <div className="zustand-liste">{eintraege.map((eintrag) => <Fragment key={eintrag.key}>{eintrag.node}</Fragment>)}</div>
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
        <div className="zustand-liste">{[broadcasterRow(system.broadcasterConnection), chatRow(system.chatSubscription), botRow(system.bot), tokenRow(system.tokens, system.bot)].map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}</div>
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
              <tbody>{auditState.data.entries.map((entry) => <tr key={entry.auditId} tabIndex={0} aria-selected={selectedAuditId === entry.auditId} onClick={() => { setSelectedAuditId(entry.auditId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedAuditId(entry.auditId); } }}><td className="mono">{formatTimestamp(entry.createdAt)}</td><th scope="row" className="mono">{entry.action}</th><td className="mono">{entry.actorUserId}</td></tr>)}</tbody>
            </table>
          </div>
          {selectedAudit === null ? null : <section className="command-inspector sub-inspector" aria-label={texte.system.aenderungsdaten}>
            <div className="inspector-section__heading"><h3>{selectedAudit.action}</h3><span className="mono muted">{selectedAudit.auditId}</span></div>
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

const eventTone = (code: string): "red" | "amber" | "green" | "off" | null =>
  Object.prototype.hasOwnProperty.call(ereignisTon, code) ? ereignisTon[code as EreignisCode] : null;

const eventToneRang = (tone: "red" | "amber" | "green" | "off" | null): number =>
  tone === "red" ? 3 : tone === "amber" ? 2 : tone === "green" ? 1 : 0;

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

const moduleLabel = (entry: PanelEventEntry): string => moduleName(entry.moduleId);

const eventWord = (tone: "red" | "amber" | "green" | "off" | null, texte: ReturnType<typeof dashboardTexte>): string =>
  tone === "red" ? texte.ereignisse.fehler : tone === "amber" ? texte.ereignisse.hinweis : tone === "green" ? texte.ereignisse.info : texte.ereignisse.unbekannt;

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

const formatEventDetail = (detail: string): string => {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
};

const EventsPage = ({ eventsState, onNextPage, loadingNextPage }: { eventsState: LoadState<PanelEventsResponse>; onNextPage: () => void; loadingNextPage: boolean }): ReactElement => {
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
  return (
    <>
      <ModuleHeading kind="events" title={texte.ereignisse.titel} subtitle={eventsState.data === null ? "" : <ModuleCount count={eventsState.data.entries.length} label={texte.ereignisse.anzahl} />} />
      <section className="content-section"><div className="section-heading"><h2>{texte.ereignisse.protokoll}</h2></div>
        {eventsState.status === "loading" && eventsState.data === null ? <p className="loading-line">{texte.ereignisse.laden}</p> : null}
        {eventsState.error !== null ? <ErrorPanel message={eventsState.error} /> : null}
        {eventsState.data !== null && eventsState.data.entries.length === 0 ? <p className="empty-state">{texte.ereignisse.keine}</p> : null}
        {eventsState.data !== null && eventsState.data.entries.length > 0 ? <>
          <div className={eventsState.status === "loading" ? "veraltet" : undefined}>
            <table className="tabelle ereignis-tabelle">
              <thead><tr><th scope="col">{texte.ereignisse.zeit}</th><th scope="col">{texte.ereignisse.ereignis}</th><th scope="col">{texte.ereignisse.modul}</th><th scope="col">{texte.ereignisse.wer}</th></tr></thead>
              <tbody>{groups.map((group) => {
                const entry = group.representative;
                const tone = eventTone(entry.code);
                const eventLabel = ereignisText(entry.code, eventDetail(entry.detail));
                return <tr key={group.key} tabIndex={0} aria-selected={selectedGroupKey === group.key} onClick={() => { setSelectedGroupKey(group.key); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedGroupKey(group.key); } }}><td className="mono">{formatTimestamp(entry.createdAt)}</td><td><span className="event-label"><Led status={tone ?? "off"} label={eventWord(tone, texte)} /><span className={tone === null ? "mono" : undefined}>{eventLabel}</span></span></td><td className={moduleLabel(entry) === entry.moduleId ? "mono" : undefined}>{moduleLabel(entry)}</td><td>{actorCell(entry, texte)}</td></tr>;
              })}</tbody>
            </table>
          </div>
          {selectedGroup === null ? null : <section className="command-inspector sub-inspector" aria-label={texte.ereignisse.detail}>
            <div className="inspector-section__heading"><h3>{texte.ereignisse.vorgang}</h3><span className="mono muted">{selectedGroup.representative.triggerId || selectedGroup.representative.eventId}</span></div>
            <dl className="eigenschaften"><div><dt>{texte.ereignisse.zeitstempel}</dt><dd className="mono" title={selectedHistory[0]?.createdAt}>{selectedHistory[0] === undefined ? "" : formatTimestamp(selectedHistory[0].createdAt)}</dd></div><div><dt>{texte.ereignisse.modul}</dt><dd>{Array.from(new Set(selectedHistory.map(moduleLabel))).join(", ")}</dd></div><div><dt>{texte.ereignisse.beteiligte}</dt><dd>{Array.from(new Set(selectedHistory.map((entry) => actorLabel(entry, texte)))).join(", ")}</dd></div></dl>
            <div className="inspector-section__heading"><h3>{texte.ereignisse.verlauf}</h3></div>
            <ol className="ereignis-verlauf">{selectedHistory.map((entry) => {
              const tone = eventTone(entry.code);
              return <li key={entry.eventId}><div className="ereignis-verlauf__heading"><span className="mono">{entry.code}</span><span className="event-label"><Led status={tone ?? "off"} label={eventWord(tone, texte)} /><span className={tone === null ? "mono" : undefined}>{ereignisText(entry.code, eventDetail(entry.detail))}</span></span></div><pre className="event-detail-json">{formatEventDetail(entry.detail)}</pre></li>;
            })}</ol>
          </section>}
          {eventsState.data.nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? texte.ereignisse.aeltereWerdenGeladen : texte.ereignisse.aeltereLaden}</button>}
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
  const eventsPageController = useRef<AbortController | null>(null);
  const [loadingNextMembersPage, setLoadingNextMembersPage] = useState(false);
  const membersRequest = useRef<MembersRequestState>({ controller: null, generation: 0 });
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [headerModuleBusy, setHeaderModuleBusy] = useState(false);

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

  const clearProtectedState = (): void => {
    auditPageController.current?.abort();
    auditPageController.current = null;
    eventsPageController.current?.abort();
    eventsPageController.current = null;
    cancelMembersRequest();
    setChannels({ status: "success", data: [], error: null });
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
    let cancelled = false;
    const controller = new AbortController();
    auditPageController.current?.abort();
    auditPageController.current = null;
    setLoadingNextAuditPage(false);
    eventsPageController.current?.abort();
    eventsPageController.current = null;
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
      eventsPageController.current?.abort();
      eventsPageController.current = null;
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
        try {
          const response = await fetchEvents(route.channelId, null, controller.signal);
          if (!cancelled && !controller.signal.aborted) {
            setEvents(loadedState(response));
            setEventsChannelId(route.channelId);
          }
        } catch (error) {
          if (!cancelled && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
            setEvents({ status: "error", data: null, error: errorMessage(error) });
            if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
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
  }, [cancelMembersRequest, finishMembersRequest, isCurrentMembersRequest, route, startMembersRequest]);

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

  const reloadModules = async (): Promise<void> => {
    if (route.kind !== "module" && (route.kind !== "channel" || route.section !== "modules")) return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath(route);
    setModules((current) => loadingState(current));
    try {
      const response = await fetchModules(channelId);
      if (window.location.pathname !== routePath) return;
      setModules(loadedState(response));
    } catch (error) {
      if (window.location.pathname !== routePath) return;
      setModules((current) => current.loadedAt === undefined
        ? { status: "error", data: null, error: errorMessage(error) }
        : { status: "error", data: null, error: errorMessage(error), loadedAt: current.loadedAt });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    }
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
        events.data?.nextCursor === null || events.data?.nextCursor === undefined) return;
    const channelId = route.channelId;
    const cursor = events.data.nextCursor;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "events" });
    const controller = new AbortController();
    eventsPageController.current = controller;
    setLoadingNextEventsPage(true);
    try {
      const nextPage = await fetchEvents(channelId, cursor, controller.signal);
      if (controller.signal.aborted || window.location.pathname !== routePath) return;
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
      if (controller.signal.aborted || window.location.pathname !== routePath) return;
      setEvents((current) => ({ ...current, status: "error", error: errorMessage(error) }));
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      if (eventsPageController.current === controller) {
        eventsPageController.current = null;
        setLoadingNextEventsPage(false);
      }
    }
  };

  if (authenticationRequired) {
    const texte = dashboardTexte();
    return <main className="auth-screen"><div className="auth-card"><h1>{texte.anmeldung.erforderlich}</h1><p>{texte.anmeldung.erklaerung}</p><a className="button" href="/auth/login">{texte.anmeldung.mitTwitchAnmelden}</a></div></main>;
  }

  return (
    <div className="app-shell">
      <PanelTopbar route={route} channels={channels.data ?? []} activeChannel={selectedChannel ?? undefined} loadedAt={loadedAtForRoute(route, { overview: overview.loadedAt, system: system.loadedAt, members: members.loadedAt, modules: modules.loadedAt, events: events.loadedAt })} headerModule={route.kind === "module" ? modules.data?.modules.find((module) => module.id === route.moduleId) : undefined} headerModuleBusy={headerModuleBusy} onToggleHeaderModule={() => { void toggleHeaderModule(); }} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} />
      <div className="app-body">
        <Rail route={route} channels={channels.data ?? []} onNavigate={navigate} />
        <main className="main-content">
        {channels.status === "loading" ? <p className="loading-line">{dashboardTexte().anmeldung.kanalzugriffPruefen}</p> : null}
        {channels.error !== null ? <ErrorPanel message={channels.error} /> : null}
        {route.kind === "overview" && channels.data !== null ? <OverviewPage channels={channels.data} onNavigate={navigate} /> : null}
        {(route.kind === "channel" || route.kind === "module") && selectedChannel === null && channels.status === "success" ? <ErrorPanel message={dashboardTexte().fehler.kanalNichtFreigegeben} /> : null}
        {route.kind === "channel" && route.section === "overview" && overview.status === "loading" ? <p className="loading-line">{dashboardTexte().overview.zustandLaden}</p> : null}
        {route.kind === "channel" && route.section === "overview" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "channel" && route.section === "overview" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} moderatorCheck={moderatorCheck} onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }} onNavigate={navigate} /> : null}
        {route.kind === "channel" && route.section === "members" && selectedChannel !== null && (members.data !== null || members.status !== "idle") ? <MembersPage key={route.channelId} channelId={route.channelId} ownRole={selectedChannel.role} eigeneUserId={members.data?.viewerUserId ?? ""} members={members.data?.members ?? []} broadcasterCount={members.data?.broadcasterCount ?? 0} nextCursor={members.data?.nextCursor ?? null} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {route.kind === "channel" && route.section === "modules" && selectedChannel !== null ? <ModuleWorkspace key={dashboardRoutePath(route)} channelId={route.channelId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} loading={modules.status === "loading"} error={modules.error} onNavigate={navigate} /> : null}
        {route.kind === "module" && overview.status === "loading" ? <p className="loading-line">{dashboardTexte().overview.zustandLaden}</p> : null}
        {route.kind === "module" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "module" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId && selectedChannel !== null ? <ModulePage key={dashboardRoutePath(route)} channelId={route.channelId} moduleId={route.moduleId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? overview.data.activeModules.map((module) => ({ id: module.moduleId, enabled: true, settings: module.settings }))} activeModules={overview.data.activeModules} loading={modules.status === "loading"} error={modules.error} busy={headerModuleBusy} onNavigate={navigate} onToggle={() => { void toggleHeaderModule(); }} /> : null}
        {route.kind === "channel" && route.section === "system" && (system.status !== "idle" || audit.status !== "idle") ? <SystemPage key={route.channelId} system={systemChannelId === route.channelId ? system.data : null} systemState={system} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
        {route.kind === "channel" && route.section === "events" && eventsChannelId === route.channelId && events.status !== "idle" ? <EventsPage key={route.channelId} eventsState={events} onNextPage={() => { void loadNextEventsPage(); }} loadingNextPage={loadingNextEventsPage} /> : null}
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

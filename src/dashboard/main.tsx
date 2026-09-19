import { Fragment, StrictMode, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  PanelAuditResponse,
  PanelBotStatus,
  PanelChannelOverview,
  PanelChannelState,
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
} from "./api";
import { ModuleNavigation, ModulePage } from "./module-panels";
import { MembersPage } from "./members";
import { ModulesPage } from "./modules";
import { roleLabel } from "./labels";
import { dashboardLanguage, dashboardTexte, formatZeitpunkt, formatZahl } from "./locale";
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

const idleModeratorCheck = (): ModeratorCheckState => ({
  status: "idle",
  error: null,
  nextAllowedAt: null,
});

const idleState = <T,>(): LoadState<T> => ({ status: "idle", data: null, error: null });
const loadingState = <T,>(): LoadState<T> => ({ status: "loading", data: null, error: null });

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
}

const RouteLink = ({ route, current, children, onNavigate }: LinkProperties): ReactElement => {
  const isCurrent = (route.kind === "overview" && current.kind === "overview") ||
    (route.kind === "channel" && current.kind === "channel" &&
      route.channelId === current.channelId && route.section === current.section) ||
    (route.kind === "channel" && current.kind === "module" &&
      route.channelId === current.channelId && route.section === "modules");
  return (
    <a
      className={isCurrent ? "nav-link nav-link--active" : "nav-link"}
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

interface StatusBadgeProperties {
  tone: "healthy" | "warning" | "error" | "neutral";
  children: string;
}

const StatusBadge = ({ tone, children }: StatusBadgeProperties): ReactElement => (
  <span className="status-badge" data-status={tone}>{children}</span>
);

/**
 * Der Zustandspunkt in der Navigation zeigt ein Problem, bevor man klickt.
 * Der Text daneben ist fuer Hilfsmittel: Farbe informiert nie allein.
 */
const NavDot = ({ tone }: { tone: "healthy" | "warning" | "error" }): ReactElement | null =>
  tone === "healthy" ? null : (
    <span className="nav-dot" data-status={tone} role="img" aria-label={tone === "error" ? dashboardTexte().fehler.titel : dashboardTexte().fehler.warnung} />
  );

const formatTimestamp = (value: string): string => formatZeitpunkt(value);

const tokenSummary = (tokens: PanelTokenStatus, bot: PanelBotStatus | null): string => {
  return tokenView(tokens, bot).label;
};

const ChannelStateCard = ({ channel }: { channel: PanelChannelState }): ReactElement => {
  const texte = dashboardTexte();
  return (
    <article className="channel-card" data-status={channelStatus(channel)}>
      <div className="channel-card__heading">
        <h2>{channel.displayName}</h2>
        <span className="muted mono">{channel.login}</span>
        <StatusBadge tone={channelStatus(channel)}>{statusText(channel)}</StatusBadge>
      </div>
      <dl className="compact-list">
        <div><dt>{texte.statusKarte.deineRolle}</dt><dd>{roleLabel(channel.role)}</dd></div>
        <div><dt>{texte.statusKarte.broadcasterOauth}</dt><dd>{broadcasterConnectionLabel(channel.broadcasterConnection)}</dd></div>
        <div><dt>{texte.statusKarte.chatZustimmung}</dt><dd>{channelBotConsentMissing(channel) ? texte.statusKarte.broadcasterZustimmungFehlt : texte.status.vorhanden}</dd></div>
        <div><dt>{texte.statusKarte.botAccount}</dt><dd>{channel.bot === null ? texte.status.nichtEingerichtet : statusLabel(channel.bot.status)}</dd></div>
        <div><dt>{texte.statusKarte.moderatorstatus}</dt><dd>{channel.moderator === null ? texte.status.nichtGeprueft : channel.moderator.isModerator ? texte.status.moderator : texte.status.fehlend}</dd></div>
        <div><dt>{texte.statusKarte.chatAbo}</dt><dd>{channel.chatSubscription == null ? channelBotConsentMissing(channel) ? texte.status.nichtErforderlich : texte.status.fehlend : channel.chatSubscription.status === "enabled" ? texte.status.aktiv : channel.chatSubscription.status === "missing" ? texte.status.fehlend : channel.chatSubscription.status === "revoked" ? texte.status.widerrufen : texte.status.fehler}</dd></div>
        <div><dt>{texte.statusKarte.tokenZustand}</dt><dd>{tokenSummary(channel.tokens, channel.bot)}</dd></div>
      </dl>
    </article>
  );
};

const StatusCard = ({ title, tone, value, detail, footer }: { title: string; tone: StatusBadgeProperties["tone"]; value: string; detail?: ReactElement | string | undefined; footer?: ReactElement | undefined }): ReactElement => (
  <article className="status-card" aria-label={title} data-status={tone}>
    <div className="status-card__heading">
      <strong>{title}</strong>
      <p>{value}</p>
      {detail === undefined ? null : <p className="status-card__detail">{detail}</p>}
    </div>
    <div className="status-card__action">{footer}</div>
  </article>
);

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
  onLogout: () => void;
  loggingOut: boolean;
}

const Sidebar = ({ route, channels, onNavigate, onLogout, loggingOut }: SidebarProperties): ReactElement => {
  const texte = dashboardTexte();
  const isChannelRoute = route.kind === "channel" || route.kind === "module";
  const selectedChannelId = isChannelRoute ? route.channelId : "";
  const activeChannel = isChannelRoute
    ? channels.find((channel) => channel.channelId === route.channelId)
    : undefined;
  return (
    <aside className="sidebar">
      <div className="brand-mark"><span className="brand-mark__dot" />BroBot</div>
      <nav className="primary-nav" aria-label={texte.navigation.hauptnavigation}>
        <RouteLink route={{ kind: "overview" }} current={route} onNavigate={onNavigate}>{texte.navigation.uebersicht}</RouteLink>
        {isChannelRoute ? (
          <>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "overview" }} current={route} onNavigate={onNavigate}>
              {texte.navigation.kanal}
              {activeChannel === undefined ? null : <NavDot tone={channelStatus(activeChannel)} />}
            </RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "system" }} current={route} onNavigate={onNavigate}>{texte.navigation.system}</RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "members" }} current={route} onNavigate={onNavigate}>{texte.navigation.mitglieder}</RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "modules" }} current={route} onNavigate={onNavigate}>{texte.navigation.module}</RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "events" }} current={route} onNavigate={onNavigate}>{texte.navigation.ereignisse}</RouteLink>
          </>
        ) : null}
      </nav>
      {channels.length > 1 ? (
        <label className="channel-picker">
          <span>{texte.navigation.kanal}</span>
          <select
            aria-label={texte.navigation.kanalAuswaehlen}
            value={selectedChannelId}
            onChange={(event) => onNavigate({ kind: "channel", channelId: event.target.value, section: "overview" })}
          >
            <option value="" disabled>{texte.navigation.bitteWaehlen}</option>
            {channels.map((channel) => <option key={channel.channelId} value={channel.channelId}>{channel.displayName}</option>)}
          </select>
        </label>
      ) : null}
      <div className="sidebar__footer">
        <a className="login-link" href="/auth/login">{channels.length === 0 ? texte.navigation.twitchAnmelden : texte.navigation.twitchKonto}</a>
        {channels.length > 0 ? <button className="button button--quiet" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? texte.navigation.abmeldungLaeuft : texte.navigation.abmelden}</button> : null}
      </div>
    </aside>
  );
};

const OverviewPage = ({ channels, onNavigate }: { channels: PanelChannelState[]; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
  const texte = dashboardTexte();
  return (
    <>
      <header className="page-heading">
        <h1>{texte.navigation.uebersicht}</h1>
        <p>{channels.length === 1 ? texte.overview.einKanalFreigegeben : texte.overview.kanaeleFreigegeben(formatZahl(channels.length))}</p>
      </header>
      {channels.length === 0 ? (
        <section className="empty-panel"><h2>{texte.overview.keinKanalFreigegeben}</h2><p>{texte.overview.keineMitgliedschaft}</p></section>
      ) : (
        <div className="channel-grid">
          {channels.map((channel) => (
            <a className="channel-card-link" href={dashboardRoutePath({ kind: "channel", channelId: channel.channelId, section: "overview" })} key={channel.channelId} onClick={(event) => { event.preventDefault(); onNavigate({ kind: "channel", channelId: channel.channelId, section: "overview" }); }}>
              <ChannelStateCard channel={channel} />
            </a>
          ))}
        </div>
      )}
    </>
  );
};

interface ModeratorCardProperties {
  moderator: PanelModeratorStatus | null;
}

const ModeratorCard = ({ moderator }: ModeratorCardProperties): ReactElement => {
  const texte = dashboardTexte();
  const tone = moderator === null ? "neutral" : moderator.isModerator ? "healthy" : "error";
  const value = moderator === null ? texte.status.nichtGeprueft : moderator.isModerator ? texte.status.moderator : texte.status.moderatorrolleFehlt;
  const detail = moderator === null
    ? texte.moderation.fuerKanalKeinePruefung
    : moderator.reason ?? undefined;
  const checkTime = moderator === null ? undefined : texte.moderation.letztePruefung(formatTimestamp(moderator.checkedAt));
  return <StatusCard title={dashboardTexte().statusKarte.moderatorstatus} tone={tone} value={value} detail={detail ?? checkTime} />;
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
  return <span className="datenalter mono">{dashboardTexte().zeit.aktualisiert(relativeZeit(seit, jetzt))}</span>;
};

const ModeratorCheckAction = ({ canCheck, checking, checkError, nextAllowedAt, checkedAt, dringend, onCheck }: {
  canCheck: boolean; checking: boolean; checkError: string | null;
  nextAllowedAt: string | null; checkedAt: string | null; dringend: boolean; onCheck: () => void;
}): ReactElement | null => {
  if (!canCheck) {
    return checkedAt === null ? null : <p className="muted moderator-check-time">{dashboardTexte().moderation.letztePruefung(formatTimestamp(checkedAt))}</p>;
  }
  const texte = dashboardTexte();
  return (
    <div className="page-heading__actions">
      {/* Gefuellt nur bei Anlass. Auf einer gesunden Seite ist die kraeftigste
          Flaeche keine Handlungsaufforderung, die niemand braucht. */}
      <button className={dringend ? "button button--primary" : "button"} type="button" onClick={onCheck} disabled={checking} aria-busy={checking}>
        {checking ? texte.moderation.pruefungLaeuft : texte.moderation.moderatorstatusPruefen}
      </button>
      {checkedAt === null ? null : <p className="muted moderator-check-time">{texte.moderation.letztePruefung(formatTimestamp(checkedAt))}</p>}
      {nextAllowedAt === null ? null : <p className="muted moderator-check-time">{texte.moderation.naechstePruefungAb(formatTimestamp(nextAllowedAt))}</p>}
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
  if (!canRequest) return <p className="muted moderator-check-time">{dashboardTexte().moderation.broadcasterErneutAutorisieren}</p>;
  return (
    <div className="page-heading__actions">
      <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/channel-bot`}>
        {dashboardTexte().moderation.broadcasterZustimmungAnfordern}
      </a>
    </div>
  );
};

const BotCard = ({ bot }: { bot: PanelBotStatus | null }): ReactElement => {
  const texte = dashboardTexte();
  if (bot === null) return <StatusCard title={texte.statusKarte.botAccount} tone="neutral" value={texte.status.nichtEingerichtet} detail={texte.bot.keinGespeicherterStatus} />;
  const tone = bot.status === "connected" ? "healthy" : "error";
  return <StatusCard title={texte.statusKarte.botAccount} tone={tone} value={statusLabel(bot.status)} detail={bot.reason ?? texte.bot.zuletztAktualisiert(formatTimestamp(bot.updatedAt))} />;
};

const TokenCard = ({ tokens, bot }: { tokens: PanelTokenStatus; bot: PanelBotStatus | null }): ReactElement => (
  <StatusCard title={dashboardTexte().statusKarte.tokenZustand} tone={tokenView(tokens, bot).tone} value={tokenSummary(tokens, bot)} detail={tokens.loginReason ?? undefined} />
);

const BroadcasterConnectionCard = ({ status }: { status: PanelChannelState["broadcasterConnection"] }): ReactElement => (
  <StatusCard
    title={dashboardTexte().statusKarte.broadcasterOauth}
    tone={status === "connected" ? "healthy" : "neutral"}
    value={broadcasterConnectionLabel(status)}
    detail={status === "connected" ? dashboardTexte().bot.optionaleModule : dashboardTexte().bot.normalerBetrieb}
  />
);

const ChannelBotConsentCard = ({ status }: { status: PanelChannelState["channelBotConsent"] }): ReactElement => (
  <StatusCard
    title={dashboardTexte().statusKarte.chatZustimmung}
    tone={status === "missing" ? "warning" : "healthy"}
    value={status === "missing" ? dashboardTexte().statusKarte.broadcasterZustimmungFehlt : dashboardTexte().status.vorhanden}
    detail={status === "missing" ? dashboardTexte().statusKarte.chatBotNoetig : undefined}
  />
);

const ChatSubscriptionCard = ({ status, expected = false }: { status: PanelChannelState["chatSubscription"] | undefined; expected?: boolean }): ReactElement => {
  const current = status ?? null;
  const tone = current === null ? expected ? "warning" : "neutral" : current.status === "enabled" ? "healthy" : current.status === "missing" ? "warning" : "error";
  const texte = dashboardTexte();
  const value = current === null ? expected ? texte.status.fehlend : texte.status.nichtGeprueft : current.status === "enabled" ? texte.status.aktiv : current.status === "missing" ? texte.status.fehlend : current.status === "revoked" ? texte.status.widerrufen : texte.status.fehler;
  return <StatusCard title={texte.statusKarte.chatAbo} tone={tone} value={value} detail={current?.reason ?? undefined} />;
};

/**
 * Rang der Dringlichkeit. Fehler zuerst, dann Warnung; gesunde Zeilen
 * erscheinen auf der Blickflaeche gar nicht.
 */
const toneRank: Record<StatusBadgeProperties["tone"], number> = {
  error: 0, warning: 1, neutral: 2, healthy: 3,
};

/** Die Meldungszeile eines Kanals samt ihrem Rang, damit sie sortierbar ist. */
interface StatusEntry {
  key: string;
  tone: StatusBadgeProperties["tone"];
  node: ReactElement;
}

const sortBySeverity = (entries: StatusEntry[]): StatusEntry[] =>
  [...entries]
    .filter((entry) => entry.tone !== "healthy")
    .sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);

const ErrorCard = ({ error }: { error: PanelLastError | null }): ReactElement =>
  error === null
    ? <StatusCard title={dashboardTexte().fehler.letzter} tone="neutral" value={dashboardTexte().fehler.keineUrsache} />
    : <StatusCard title={dashboardTexte().fehler.letzter} tone="error" value={error.reason} detail={`${error.source} · ${formatTimestamp(error.at)}`} />;

interface ChannelOverviewPageProperties {
  overview: PanelChannelOverview;
  geladenAm: number | undefined;
  moderatorCheck: ModeratorCheckState;
  onCheckModeratorStatus: () => void;
  onNavigate: (route: DashboardRoute) => void;
}

const ChannelOverviewPage = ({ overview, geladenAm, moderatorCheck, onCheckModeratorStatus, onNavigate }: ChannelOverviewPageProperties): ReactElement => {
  // Die Kanaluebersicht ist die Blickflaeche. Was in Ordnung ist, erscheint hier
  // nicht; laeuft alles, beginnt der Inhalt sofort. Die Werte stehen weiterhin
  // vollstaendig auf der Systemseite.
  const eintraege = sortBySeverity([
    {
      key: "broadcaster",
      tone: overview.broadcasterConnection === "connected" ? "healthy" : "neutral",
      node: <BroadcasterConnectionCard status={overview.broadcasterConnection} />,
    },
    {
      key: "channel-bot-consent",
      tone: overview.channelBotConsent === "missing" ? "warning" : "healthy",
      node: <ChannelBotConsentCard status={overview.channelBotConsent} />,
    },
    {
      key: "chat-subscription",
      tone: overview.chatSubscription == null ? overview.channelBotConsent === "granted" ? "warning" : "healthy" : overview.chatSubscription.status === "enabled" ? "healthy" : overview.chatSubscription.status === "missing" ? "warning" : "error",
      node: <ChatSubscriptionCard status={overview.chatSubscription} expected={overview.channelBotConsent === "granted"} />,
    },
    {
      key: "moderator",
      tone: overview.moderator === null ? "neutral" : overview.moderator.isModerator ? "healthy" : "error",
      node: <ModeratorCard moderator={overview.moderator} />,
    },
    {
      key: "bot",
      tone: overview.bot === null ? "neutral" : overview.bot.status === "connected" ? "healthy" : "error",
      node: <BotCard bot={overview.bot} />,
    },
    {
      key: "token",
      tone: tokenView(overview.tokens, overview.bot).tone,
      node: <TokenCard tokens={overview.tokens} bot={overview.bot} />,
    },
    {
      key: "fehler",
      tone: overview.lastError === null ? "healthy" : "error",
      node: <ErrorCard error={overview.lastError} />,
    },
  ]);

  return (
    <>
      <header className="page-heading">
        <h1>{overview.displayName}</h1><span className="muted">{roleLabel(overview.role)}</span>
        {geladenAm === undefined ? null : <Datenalter seit={geladenAm} />}
        <ModeratorCheckAction
          canCheck={overview.role !== "bediener"}
          checking={moderatorCheck.status === "loading"}
          checkError={moderatorCheck.error}
          nextAllowedAt={moderatorCheck.nextAllowedAt}
          checkedAt={overview.moderator?.checkedAt ?? null}
          dringend={overview.moderator === null || !overview.moderator.isModerator}
          onCheck={onCheckModeratorStatus}
        />
        <ChannelBotConsentAction
          channelId={overview.channelId}
          needed={overview.channelBotConsent === "missing"}
          canRequest={overview.role === "broadcaster"}
        />
      </header>
      {eintraege.length === 0 ? null : (
        <div className="status-grid">
          {eintraege.map((eintrag) => <Fragment key={eintrag.key}>{eintrag.node}</Fragment>)}
        </div>
      )}
      <section className="content-section"><div className="section-heading"><h2>{dashboardTexte().overview.aktiveModule}</h2><span className="muted zahl">{formatZahl(overview.activeModules.length)}</span></div><ModuleNavigation channelId={overview.channelId} activeModules={overview.activeModules} onNavigate={onNavigate} /></section>
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
  return (
  <>
    <header className="page-heading"><h1>{texte.system.titel}</h1></header>
    {system === null && systemState.status === "loading" ? <p className="loading-line">{texte.system.zustandLaden}</p> : null}
    {systemState.error !== null ? <ErrorPanel message={systemState.error} /> : null}
    {system === null ? null : <div className="status-grid"><BroadcasterConnectionCard status={system.broadcasterConnection} /><ChatSubscriptionCard status={system.chatSubscription} /><BotCard bot={system.bot} /><TokenCard tokens={system.tokens} bot={system.bot} /></div>}
    <section className="content-section"><div className="section-heading"><h2>{texte.system.auditLog}</h2>{auditState.data === null ? null : <span className="muted"><span className="zahl">{formatZahl(auditState.data.entries.length)}</span> {texte.system.eintraege}</span>}</div>
      {auditState.status === "loading" ? <p className="loading-line">{texte.system.auditLaden}</p> : null}
      {auditState.error !== null ? <ErrorPanel message={auditState.error} /> : null}
      {auditState.data !== null && auditState.data.entries.length === 0 ? <p className="muted">{texte.system.keineAuditEintraege}</p> : null}
      {auditState.data !== null && auditState.data.entries.length > 0 ? <>
        <div className="audit-list">{auditState.data.entries.map((entry) => <article className="audit-entry" key={entry.auditId}><div><strong>{entry.action}</strong><span>{entry.actorUserId} · {formatTimestamp(entry.createdAt)}</span></div><details><summary>{texte.system.aenderungsdaten}</summary><pre>{`${texte.system.vorher}: ${entry.before}\n${texte.system.nachher}: ${entry.after}`}</pre></details></article>)}</div>
        {auditState.data.nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? texte.system.aeltereEintraegeLaden : texte.system.aeltereEintraege}</button>}
      </> : null}
    </section>
  </>
  );
};

const EventsPage = ({ eventsState, onNextPage, loadingNextPage }: { eventsState: LoadState<PanelEventsResponse>; onNextPage: () => void; loadingNextPage: boolean }): ReactElement => {
  const texte = dashboardTexte();
  return (
  <>
    <header className="page-heading"><h1>{texte.ereignisse.titel}</h1></header>
    <section className="content-section"><div className="section-heading"><h2>{texte.ereignisse.protokoll}</h2>{eventsState.data === null ? null : <span className="muted"><span className="zahl">{formatZahl(eventsState.data.entries.length)}</span> {texte.system.eintraege}</span>}</div>
      {eventsState.status === "loading" ? <p className="loading-line">{texte.ereignisse.laden}</p> : null}
      {eventsState.error !== null ? <ErrorPanel message={eventsState.error} /> : null}
      {eventsState.data !== null && eventsState.data.entries.length === 0 ? <p className="muted">{texte.ereignisse.keine}</p> : null}
      {eventsState.data !== null && eventsState.data.entries.length > 0 ? <>
        <div className="event-list">{eventsState.data.entries.map((entry) => {
          const actor = entry.actorDisplayName ?? (entry.actorLogin == null
            ? entry.actorUserId ?? "Automatisch"
            : `@${entry.actorLogin}`);
          return <article className="event-entry" key={entry.eventId}><div className="event-entry__heading"><strong className="mono">{entry.code}</strong><span><span className="mono">{entry.moduleId}</span> · <span className="mono">{formatTimestamp(entry.createdAt)}</span> · <span className="mono">{actor}</span></span></div><details><summary>{texte.ereignisse.detail}</summary><pre>{entry.detail}</pre></details></article>;
        })}</div>
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
  const membersPageController = useRef<AbortController | null>(null);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const clearProtectedState = (): void => {
    auditPageController.current?.abort();
    auditPageController.current = null;
    eventsPageController.current?.abort();
    eventsPageController.current = null;
    membersPageController.current?.abort();
    membersPageController.current = null;
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
    membersPageController.current?.abort();
    membersPageController.current = null;
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
      membersPageController.current?.abort();
      membersPageController.current = null;
      setLoadingNextMembersPage(false);
    };
    if (route.kind !== "channel" && route.kind !== "module") return cleanup;
    const expectedOverviewPath = dashboardRoutePath(route);

    const load = async (): Promise<void> => {
      // Die Modulseite zeigt denselben Kanalkopf wie die Uebersicht und
      // braucht deshalb dieselben Daten.
      if (route.kind === "module" || route.section === "overview") {
        try {
          const response = await fetchChannelOverview(route.channelId, controller.signal);
          if (!cancelled) {
            setOverview({ status: "success", data: response, error: null, loadedAt: Date.now() });
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
        setMembers(loadingState());
        try {
          const response = await fetchMembers(route.channelId, null, controller.signal);
          if (!cancelled && !controller.signal.aborted) setMembers({ status: "success", data: response, error: null });
        } catch (error) {
          if (!cancelled && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
            setMembers({ status: "error", data: null, error: errorMessage(error) });
            if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
          }
        }
        return;
      }
      if (route.section === "modules") {
        setModules(loadingState());
        try {
          const response = await fetchModules(route.channelId, controller.signal);
          if (!cancelled && !controller.signal.aborted) setModules({ status: "success", data: response, error: null });
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
        try {
          const response = await fetchEvents(route.channelId, null, controller.signal);
          if (!cancelled && !controller.signal.aborted) {
            setEvents({ status: "success", data: response, error: null });
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
            setSystem({ status: "success", data: response, error: null });
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
            setAudit({ status: "success", data: response, error: null });
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
  }, [route]);

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
    membersPageController.current?.abort();
    const controller = new AbortController();
    membersPageController.current = controller;
    setMembers(loadingState());
    try {
      const response = await fetchMembers(channelId, null, controller.signal);
      if (controller.signal.aborted || window.location.pathname !== routePath) return;
      setMembers({ status: "success", data: response, error: null });
    } catch (error) {
      if (controller.signal.aborted || window.location.pathname !== routePath) return;
      setMembers({ status: "error", data: null, error: errorMessage(error) });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      if (membersPageController.current === controller) membersPageController.current = null;
    }
  };

  const reloadModules = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "modules") return;
    const channelId = route.channelId;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "modules" });
    setModules(loadingState());
    try {
      const response = await fetchModules(channelId);
      if (window.location.pathname !== routePath) return;
      setModules({ status: "success", data: response, error: null });
    } catch (error) {
      if (window.location.pathname !== routePath) return;
      setModules({ status: "error", data: null, error: errorMessage(error) });
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    }
  };

  const loadNextMembersPage = async (): Promise<void> => {
    if (route.kind !== "channel" || route.section !== "members" || loadingNextMembersPage ||
        members.data?.nextCursor === null || members.data?.nextCursor === undefined) return;
    const channelId = route.channelId;
    const cursor = members.data.nextCursor;
    const routePath = dashboardRoutePath({ kind: "channel", channelId, section: "members" });
    membersPageController.current?.abort();
    const controller = new AbortController();
    membersPageController.current = controller;
    setLoadingNextMembersPage(true);
    try {
      const nextPage = await fetchMembers(channelId, cursor, controller.signal);
      if (controller.signal.aborted || window.location.pathname !== routePath) return;
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
        };
      });
    } catch (error) {
      if (controller.signal.aborted || window.location.pathname !== routePath) return;
      setMembers((current) => ({ ...current, status: "error", error: errorMessage(error) }));
      if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
    } finally {
      if (membersPageController.current === controller) {
        membersPageController.current = null;
        setLoadingNextMembersPage(false);
      }
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
      <Sidebar route={route} channels={channels.data ?? []} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} />
      <main className="main-content">
        {channels.status === "loading" ? <p className="loading-line">{dashboardTexte().anmeldung.kanalzugriffPruefen}</p> : null}
        {channels.error !== null ? <ErrorPanel message={channels.error} /> : null}
        {route.kind === "overview" && channels.data !== null ? <OverviewPage channels={channels.data} onNavigate={navigate} /> : null}
        {(route.kind === "channel" || route.kind === "module") && selectedChannel === null && channels.status === "success" ? <ErrorPanel message={dashboardTexte().fehler.kanalNichtFreigegeben} /> : null}
        {route.kind === "channel" && route.section === "overview" && overview.status === "loading" ? <p className="loading-line">{dashboardTexte().overview.zustandLaden}</p> : null}
        {route.kind === "channel" && route.section === "overview" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "channel" && route.section === "overview" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} geladenAm={overview.loadedAt} moderatorCheck={moderatorCheck} onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }} onNavigate={navigate} /> : null}
        {route.kind === "channel" && route.section === "members" && members.status === "loading" ? <p className="loading-line">{dashboardTexte().anmeldung.mitgliederLaden}</p> : null}
        {route.kind === "channel" && route.section === "members" && members.error !== null ? <ErrorPanel message={members.error} /> : null}
        {route.kind === "channel" && route.section === "members" && members.data !== null && selectedChannel !== null ? <MembersPage channelId={route.channelId} ownRole={selectedChannel.role} eigeneUserId={members.data.viewerUserId} members={members.data.members} broadcasterCount={members.data.broadcasterCount} nextCursor={members.data.nextCursor} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {route.kind === "channel" && route.section === "modules" && selectedChannel !== null ? <ModulesPage channelId={route.channelId} ownRole={selectedChannel.role} modules={modules.data?.modules ?? []} loading={modules.status === "loading"} error={modules.error} onReload={reloadModules} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {route.kind === "module" && overview.status === "loading" ? <p className="loading-line">{dashboardTexte().overview.zustandLaden}</p> : null}
        {route.kind === "module" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "module" && overviewRoutePath === dashboardRoutePath(route) && overview.data !== null && overview.data.channelId === route.channelId && selectedChannel !== null ? <ModulePage channelId={route.channelId} moduleId={route.moduleId} activeModules={overview.data.activeModules} /> : null}
        {route.kind === "channel" && route.section === "system" && (system.status !== "idle" || audit.status !== "idle") ? <SystemPage system={systemChannelId === route.channelId ? system.data : null} systemState={system} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
        {route.kind === "channel" && route.section === "events" && events.status === "loading" ? <p className="loading-line">{dashboardTexte().ereignisse.laden}</p> : null}
        {route.kind === "channel" && route.section === "events" && events.error !== null ? <ErrorPanel message={events.error} /> : null}
        {route.kind === "channel" && route.section === "events" && events.data !== null && eventsChannelId === route.channelId ? <EventsPage eventsState={events} onNextPage={() => { void loadNextEventsPage(); }} loadingNextPage={loadingNextEventsPage} /> : null}
      </main>
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

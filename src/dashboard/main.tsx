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
  fetchSystemOverview,
  logout,
  PanelApiError,
  refreshModeratorStatus,
} from "./api";
import { ModulePanelMount } from "./module-panels";
import { MembersPage } from "./members";
import { roleLabel } from "./labels";
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
  if (status === "connected") return "Verbunden";
  if (status === "revoked") return "Widerrufen";
  return "Fehler";
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
  if (bot?.status === "error" || bot?.status === "revoked") {
    return { tone: "error", label: statusLabel(bot.status) };
  }
  if (tokens.loginStatus === "error" || tokens.loginStatus === "revoked") {
    return { tone: "error", label: statusLabel(tokens.loginStatus) };
  }
  if (tokens.loginStatus === null) return { tone: "neutral", label: "Login-Identität fehlt" };
  const now = Date.now();
  const botExpiresAt = parseDate(tokens.botExpiresAt);
  const loginExpiresAt = parseDate(tokens.loginExpiresAt);
  if (botExpiresAt === null || loginExpiresAt === null) return { tone: "neutral", label: "Nicht geprüft" };
  if (botExpiresAt <= now || loginExpiresAt <= now) return { tone: "error", label: "Abgelaufen" };
  if (bot?.status !== "connected") return { tone: "neutral", label: "Nicht geprüft" };
  const lastMaintenanceAt = parseDate(bot.updatedAt);
  if (lastMaintenanceAt === null || lastMaintenanceAt <= now - BOT_MAINTENANCE_STALE_AFTER_MS) {
    return { tone: "warning", label: "Wartung überfällig" };
  }
  if (renewalOverdue(botExpiresAt, lastMaintenanceAt, now) ||
      renewalOverdue(loginExpiresAt, lastMaintenanceAt, now)) {
    return { tone: "warning", label: "Erneuerung überfällig" };
  }
  return { tone: "healthy", label: "Gültig" };
};

const channelBotConsentMissing = (channel: PanelChannelState): boolean =>
  channel.channelBotConsent === "missing";

const channelStatus = (channel: PanelChannelState): "healthy" | "warning" | "error" => {
  if (channel.moderator?.isModerator === false) return "error";
  if (channel.bot?.status === "error" || channel.bot?.status === "revoked") return "error";
  if (channel.tokens.loginStatus === "error" || channel.tokens.loginStatus === "revoked") return "error";
  const tokenStatus = tokenView(channel.tokens, channel.bot);
  if (tokenStatus.tone === "error") return "error";
  if (channelBotConsentMissing(channel)) return "warning";
  if (tokenStatus.tone !== "healthy") return "warning";
  if (channel.bot?.status !== "connected" || channel.moderator?.isModerator !== true ||
      channel.tokens.loginStatus !== "connected" || channel.tokens.botExpiresAt === null ||
      channel.tokens.loginExpiresAt === null || channelBotConsentMissing(channel)) return "warning";
  return "healthy";
};

const statusText = (channel: PanelChannelState): string => {
  if (channel.moderator?.isModerator === false) return "Moderatorrolle fehlt";
  if (channel.bot?.status === "error") return "Bot-Fehler";
  if (channel.bot?.status === "revoked") return "Bot-Token widerrufen";
  const tokenStatus = tokenView(channel.tokens, channel.bot);
  if (channelBotConsentMissing(channel) && tokenStatus.tone === "healthy") return "Broadcaster-Zustimmung fehlt";
  if (tokenStatus.tone !== "healthy") return tokenStatus.label;
  if (channelStatus(channel) === "healthy") return "Gesund";
  return "Zustand unvollständig";
};

const broadcasterConnectionLabel = (status: PanelChannelState["broadcasterConnection"]): string =>
  status === "connected" ? "Verbunden" : "Nicht verbunden";

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return "Deine Sitzung ist nicht mehr gültig.";
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Die Daten konnten nicht geladen werden.";
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
  const isCurrent = route.kind === current.kind && route.kind === "overview"
    ? true
    : route.kind === "channel" && current.kind === "channel" &&
      route.channelId === current.channelId && route.section === current.section;
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
    <span className="nav-dot" data-status={tone} role="img" aria-label={tone === "error" ? "Fehler" : "Warnung"} />
  );

const formatTimestamp = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const tokenSummary = (tokens: PanelTokenStatus, bot: PanelBotStatus | null): string => {
  return tokenView(tokens, bot).label;
};

const ChannelStateCard = ({ channel }: { channel: PanelChannelState }): ReactElement => (
  <article className="channel-card" data-status={channelStatus(channel)}>
    <div className="channel-card__heading">
      <h2>{channel.displayName}</h2>
      <span className="muted mono">{channel.login}</span>
      <StatusBadge tone={channelStatus(channel)}>{statusText(channel)}</StatusBadge>
    </div>
    <dl className="compact-list">
      <div><dt>Deine Rolle</dt><dd>{roleLabel(channel.role)}</dd></div>
      <div><dt>Broadcaster-OAuth</dt><dd>{broadcasterConnectionLabel(channel.broadcasterConnection)}</dd></div>
      <div><dt>Chat-Zustimmung</dt><dd>{channelBotConsentMissing(channel) ? "Broadcaster-Zustimmung fehlt" : "Vorhanden"}</dd></div>
      <div><dt>Bot-Account</dt><dd>{channel.bot === null ? "Nicht eingerichtet" : statusLabel(channel.bot.status)}</dd></div>
      <div><dt>Moderatorstatus</dt><dd>{channel.moderator === null ? "Nicht geprüft" : channel.moderator.isModerator ? "Moderator" : "Fehlt"}</dd></div>
      <div><dt>Token</dt><dd>{tokenSummary(channel.tokens, channel.bot)}</dd></div>
    </dl>
  </article>
);

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
    <strong>Fehler</strong>
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
  const selectedChannelId = route.kind === "channel" ? route.channelId : "";
  const activeChannel = route.kind === "channel"
    ? channels.find((channel) => channel.channelId === route.channelId)
    : undefined;
  return (
    <aside className="sidebar">
      <div className="brand-mark"><span className="brand-mark__dot" />BroBot</div>
      <nav className="primary-nav" aria-label="Hauptnavigation">
        <RouteLink route={{ kind: "overview" }} current={route} onNavigate={onNavigate}>Übersicht</RouteLink>
        {route.kind === "channel" ? (
          <>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "overview" }} current={route} onNavigate={onNavigate}>
              Kanal
              {activeChannel === undefined ? null : <NavDot tone={channelStatus(activeChannel)} />}
            </RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "system" }} current={route} onNavigate={onNavigate}>System</RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "members" }} current={route} onNavigate={onNavigate}>Mitglieder</RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "events" }} current={route} onNavigate={onNavigate}>Ereignisse</RouteLink>
          </>
        ) : null}
      </nav>
      {channels.length > 1 ? (
        <label className="channel-picker">
          <span>Kanal</span>
          <select
            aria-label="Kanal auswählen"
            value={selectedChannelId}
            onChange={(event) => onNavigate({ kind: "channel", channelId: event.target.value, section: "overview" })}
          >
            <option value="" disabled>Bitte wählen</option>
            {channels.map((channel) => <option key={channel.channelId} value={channel.channelId}>{channel.displayName}</option>)}
          </select>
        </label>
      ) : null}
      <div className="sidebar__footer">
        <a className="login-link" href="/auth/login">{channels.length === 0 ? "Mit Twitch anmelden" : "Twitch-Konto"}</a>
        {channels.length > 0 ? <button className="button button--quiet" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? "Abmeldung …" : "Abmelden"}</button> : null}
      </div>
    </aside>
  );
};

const OverviewPage = ({ channels, onNavigate }: { channels: PanelChannelState[]; onNavigate: (route: DashboardRoute) => void }): ReactElement => (
  <>
    <header className="page-heading">
      <h1>Übersicht</h1>
      <p>{channels.length === 1 ? "Ein Kanal ist für dich freigegeben." : `${String(channels.length)} Kanäle sind für dich freigegeben.`}</p>
    </header>
    {channels.length === 0 ? (
      <section className="empty-panel"><h2>Noch kein Kanal freigegeben</h2><p>Für dieses Konto gibt es keine Mitgliedschaft in einem freigegebenen Kanal.</p></section>
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

interface ModeratorCardProperties {
  moderator: PanelModeratorStatus | null;
}

const ModeratorCard = ({ moderator }: ModeratorCardProperties): ReactElement => {
  const tone = moderator === null ? "neutral" : moderator.isModerator ? "healthy" : "error";
  const value = moderator === null ? "Nicht geprüft" : moderator.isModerator ? "Moderator" : "Moderatorrolle fehlt";
  const detail = moderator === null
    ? "Für diesen Kanal liegt noch keine Prüfung vor."
    : moderator.reason ?? undefined;
  const checkTime = moderator === null ? undefined : `Letzte Prüfung: ${formatTimestamp(moderator.checkedAt)}`;
  return <StatusCard title="Moderatorstatus" tone={tone} value={value} detail={detail ?? checkTime} />;
};

/**
 * Die einzige helle Aktion der Kanalseite. Sie steht in der Titelzeile und
 * nicht in der Moderatorzeile, weil diese bei gesundem Zustand gar nicht
 * erscheint — die Nachpruefung muss trotzdem jederzeit erreichbar sein.
 */
const relativeZeit = (seit: number, jetzt: number): string => {
  const s = Math.max(0, Math.round((jetzt - seit) / 1000));
  if (s < 60) return `vor ${String(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${String(m)} Min.`;
  return `vor ${String(Math.round(m / 60))} Std.`;
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
  return <span className="datenalter mono">aktualisiert {relativeZeit(seit, jetzt)}</span>;
};

const ModeratorCheckAction = ({ canCheck, checking, checkError, nextAllowedAt, checkedAt, dringend, onCheck }: {
  canCheck: boolean; checking: boolean; checkError: string | null;
  nextAllowedAt: string | null; checkedAt: string | null; dringend: boolean; onCheck: () => void;
}): ReactElement | null => {
  if (!canCheck) {
    return checkedAt === null ? null : <p className="muted moderator-check-time">Letzte Prüfung: {formatTimestamp(checkedAt)}</p>;
  }
  return (
    <div className="page-heading__actions">
      {/* Gefuellt nur bei Anlass. Auf einer gesunden Seite ist die kraeftigste
          Flaeche keine Handlungsaufforderung, die niemand braucht. */}
      <button className={dringend ? "button button--primary" : "button"} type="button" onClick={onCheck} disabled={checking} aria-busy={checking}>
        {checking ? "Prüfung läuft …" : "Moderatorstatus prüfen"}
      </button>
      {checkedAt === null ? null : <p className="muted moderator-check-time">Letzte Prüfung: {formatTimestamp(checkedAt)}</p>}
      {nextAllowedAt === null ? null : <p className="muted moderator-check-time">Nächste Prüfung ab {formatTimestamp(nextAllowedAt)}.</p>}
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
  if (!canRequest) return <p className="muted moderator-check-time">Der Broadcaster muss Twitch erneut autorisieren.</p>;
  return (
    <div className="page-heading__actions">
      <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/channel-bot`}>
        Broadcaster-Zustimmung anfordern
      </a>
    </div>
  );
};

const BotCard = ({ bot }: { bot: PanelBotStatus | null }): ReactElement => {
  if (bot === null) return <StatusCard title="Bot-Account" tone="neutral" value="Nicht eingerichtet" detail="Es gibt noch keinen gespeicherten Botstatus." />;
  const tone = bot.status === "connected" ? "healthy" : "error";
  return <StatusCard title="Bot-Account" tone={tone} value={statusLabel(bot.status)} detail={bot.reason ?? `Zuletzt aktualisiert: ${formatTimestamp(bot.updatedAt)}`} />;
};

const TokenCard = ({ tokens, bot }: { tokens: PanelTokenStatus; bot: PanelBotStatus | null }): ReactElement => (
  <StatusCard title="Token-Zustand" tone={tokenView(tokens, bot).tone} value={tokenSummary(tokens, bot)} detail={tokens.loginReason ?? undefined} />
);

const BroadcasterConnectionCard = ({ status }: { status: PanelChannelState["broadcasterConnection"] }): ReactElement => (
  <StatusCard
    title="Broadcaster-OAuth"
    tone={status === "connected" ? "healthy" : "neutral"}
    value={broadcasterConnectionLabel(status)}
    detail={status === "connected" ? "Für optionale Broadcaster-Module verbunden." : "Optional; für den normalen Bot-Betrieb nicht erforderlich."}
  />
);

const ChannelBotConsentCard = ({ status }: { status: PanelChannelState["channelBotConsent"] }): ReactElement => (
  <StatusCard
    title="Chat-Zustimmung"
    tone={status === "missing" ? "warning" : "healthy"}
    value={status === "missing" ? "Broadcaster-Zustimmung fehlt" : "Vorhanden"}
    detail={status === "missing" ? "channel:bot wird vom Broadcaster benötigt." : undefined}
  />
);

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
    ? <StatusCard title="Letzter Fehler" tone="neutral" value="Keine gespeicherte Ursache" />
    : <StatusCard title="Letzter Fehler" tone="error" value={error.reason} detail={`${error.source} · ${formatTimestamp(error.at)}`} />;

interface ChannelOverviewPageProperties {
  overview: PanelChannelOverview;
  geladenAm: number | undefined;
  moderatorCheck: ModeratorCheckState;
  onCheckModeratorStatus: () => void;
}

const ChannelOverviewPage = ({ overview, geladenAm, moderatorCheck, onCheckModeratorStatus }: ChannelOverviewPageProperties): ReactElement => {
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
      <section className="content-section"><div className="section-heading"><h2>Aktive Module</h2><span className="muted zahl">{String(overview.activeModules.length)}</span></div><ModulePanelMount activeModules={overview.activeModules} /></section>
    </>
  );
};

const SystemPage = ({ system, auditState, onNextPage, loadingNextPage }: { system: PanelSystemResponse; auditState: LoadState<PanelAuditResponse>; onNextPage: () => void; loadingNextPage: boolean }): ReactElement => (
  <>
    <header className="page-heading"><h1>System</h1></header>
    <div className="status-grid"><BroadcasterConnectionCard status={system.broadcasterConnection} /><BotCard bot={system.bot} /><TokenCard tokens={system.tokens} bot={system.bot} /></div>
    <section className="content-section"><div className="section-heading"><h2>Audit-Log</h2>{auditState.data === null ? null : <span className="muted"><span className="zahl">{String(auditState.data.entries.length)}</span> Einträge</span>}</div>
      {auditState.status === "loading" ? <p className="loading-line">Audit-Log wird geladen …</p> : null}
      {auditState.error !== null ? <ErrorPanel message={auditState.error} /> : null}
      {auditState.data !== null && auditState.data.entries.length === 0 ? <p className="muted">Noch keine Audit-Einträge gespeichert.</p> : null}
      {auditState.data !== null && auditState.data.entries.length > 0 ? <>
        <div className="audit-list">{auditState.data.entries.map((entry) => <article className="audit-entry" key={entry.auditId}><div><strong>{entry.action}</strong><span>{entry.actorUserId} · {formatTimestamp(entry.createdAt)}</span></div><details><summary>Änderungsdaten</summary><pre>{`Vorher: ${entry.before}\nNachher: ${entry.after}`}</pre></details></article>)}</div>
        {auditState.data.nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? "Ältere Einträge werden geladen …" : "Ältere Einträge laden"}</button>}
      </> : null}
    </section>
  </>
);

const EventsPage = ({ eventsState, onNextPage, loadingNextPage }: { eventsState: LoadState<PanelEventsResponse>; onNextPage: () => void; loadingNextPage: boolean }): ReactElement => (
  <>
    <header className="page-heading"><h1>Ereignisse</h1></header>
    <section className="content-section"><div className="section-heading"><h2>Ereignisprotokoll</h2>{eventsState.data === null ? null : <span className="muted"><span className="zahl">{String(eventsState.data.entries.length)}</span> Einträge</span>}</div>
      {eventsState.status === "loading" ? <p className="loading-line">Ereignisse werden geladen …</p> : null}
      {eventsState.error !== null ? <ErrorPanel message={eventsState.error} /> : null}
      {eventsState.data !== null && eventsState.data.entries.length === 0 ? <p className="muted">Noch keine Ereignisse protokolliert.</p> : null}
      {eventsState.data !== null && eventsState.data.entries.length > 0 ? <>
        <div className="event-list">{eventsState.data.entries.map((entry) => {
          const actor = entry.actorDisplayName ?? (entry.actorLogin == null
            ? entry.actorUserId ?? "Automatisch"
            : `@${entry.actorLogin}`);
          return <article className="event-entry" key={entry.eventId}><div className="event-entry__heading"><strong className="mono">{entry.code}</strong><span><span className="mono">{entry.moduleId}</span> · <span className="mono">{formatTimestamp(entry.createdAt)}</span> · <span className="mono">{actor}</span></span></div><details><summary>Detail</summary><pre>{entry.detail}</pre></details></article>;
        })}</div>
        {eventsState.data.nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={onNextPage} disabled={loadingNextPage}>{loadingNextPage ? "Ältere Ereignisse werden geladen …" : "Ältere Ereignisse laden"}</button>}
      </> : null}
    </section>
  </>
);

export const DashboardApp = (): ReactElement => {
  const [route, navigate] = useDashboardRoute();
  const [channels, setChannels] = useState<LoadState<PanelChannelState[]>>(() => idleState());
  const [overview, setOverview] = useState<LoadState<PanelChannelOverview>>(() => idleState());
  const [moderatorCheck, setModeratorCheck] = useState<ModeratorCheckState>(() => idleModeratorCheck());
  const [system, setSystem] = useState<LoadState<PanelSystemResponse>>(() => idleState());
  const [members, setMembers] = useState<LoadState<PanelMembersResponse>>(() => idleState());
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
    setModeratorCheck(idleModeratorCheck());
    setSystem(idleState());
    setMembers(idleState());
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
    setModeratorCheck(idleModeratorCheck());
    setSystem(idleState());
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
    if (route.kind !== "channel") return cleanup;

    const load = async (): Promise<void> => {
      if (route.section === "overview") {
        try {
          const response = await fetchChannelOverview(route.channelId, controller.signal);
          if (!cancelled) setOverview({ status: "success", data: response, error: null, loadedAt: Date.now() });
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
      try {
        const [systemResponse, auditResponse] = await Promise.all([
          fetchSystemOverview(route.channelId, controller.signal),
          fetchAuditLog(route.channelId, null, controller.signal),
        ]);
        if (!cancelled) {
          setSystem({ status: "success", data: systemResponse, error: null });
          setAudit({ status: "success", data: auditResponse, error: null });
          setSystemChannelId(route.channelId);
          setAuditChannelId(route.channelId);
        }
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
          const message = errorMessage(error);
          setSystem({ status: "error", data: null, error: message });
          setAudit({ status: "error", data: null, error: message });
          if (error instanceof PanelApiError && error.status === 401) setAuthenticationRequired(true);
        }
      }
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
    if (route.kind !== "channel" || channels.data === null) return null;
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
    return <main className="auth-screen"><div className="auth-card"><h1>Anmeldung erforderlich</h1><p>Bitte melde dich mit deinem Twitch-Konto an, um freigegebene Kanäle zu sehen.</p><a className="button" href="/auth/login">Mit Twitch anmelden</a></div></main>;
  }

  return (
    <div className="app-shell">
      <Sidebar route={route} channels={channels.data ?? []} onNavigate={navigate} onLogout={() => { void handleLogout(); }} loggingOut={loggingOut} />
      <main className="main-content">
        {channels.status === "loading" ? <p className="loading-line">Kanalzugriff wird geprüft …</p> : null}
        {channels.error !== null ? <ErrorPanel message={channels.error} /> : null}
        {route.kind === "overview" && channels.data !== null ? <OverviewPage channels={channels.data} onNavigate={navigate} /> : null}
        {route.kind === "channel" && selectedChannel === null && channels.status === "success" ? <ErrorPanel message="Dieser Kanal ist für dein Konto nicht freigegeben." /> : null}
        {route.kind === "channel" && route.section === "overview" && overview.status === "loading" ? <p className="loading-line">Kanalzustand wird geladen …</p> : null}
        {route.kind === "channel" && route.section === "overview" && overview.error !== null ? <ErrorPanel message={overview.error} /> : null}
        {route.kind === "channel" && route.section === "overview" && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} geladenAm={overview.loadedAt} moderatorCheck={moderatorCheck} onCheckModeratorStatus={() => { void handleModeratorStatusCheck(); }} /> : null}
        {route.kind === "channel" && route.section === "members" && members.status === "loading" ? <p className="loading-line">Mitglieder werden geladen …</p> : null}
        {route.kind === "channel" && route.section === "members" && members.error !== null ? <ErrorPanel message={members.error} /> : null}
        {route.kind === "channel" && route.section === "members" && members.data !== null && selectedChannel !== null ? <MembersPage channelId={route.channelId} ownRole={selectedChannel.role} eigeneUserId={members.data.viewerUserId} members={members.data.members} broadcasterCount={members.data.broadcasterCount} nextCursor={members.data.nextCursor} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {route.kind === "channel" && route.section === "system" && system.status === "loading" ? <p className="loading-line">Systemzustand wird geladen …</p> : null}
        {route.kind === "channel" && route.section === "system" && system.error !== null ? <ErrorPanel message={system.error} /> : null}
        {route.kind === "channel" && route.section === "system" && system.data !== null && systemChannelId === route.channelId ? <SystemPage system={system.data} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
        {route.kind === "channel" && route.section === "events" && events.status === "loading" ? <p className="loading-line">Ereignisse werden geladen …</p> : null}
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

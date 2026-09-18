import { StrictMode, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import type {
  PanelAuditResponse,
  PanelBotStatus,
  PanelChannelOverview,
  PanelChannelState,
  PanelLastError,
  PanelMembersResponse,
  PanelModeratorStatus,
  PanelSystemResponse,
  PanelTokenStatus,
} from "../panel-contract";
import {
  fetchAuditLog,
  fetchChannelOverview,
  fetchChannels,
  fetchMembers,
  fetchSystemOverview,
  logout,
  PanelApiError,
} from "./api";
import { ModulePanelMount } from "./module-panels";
import { MembersPage } from "./members";
import { dashboardRoutePath, useDashboardRoute, type DashboardRoute } from "./router";
import "./styles.css";

interface LoadState<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
}

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

const tokenView = (tokens: PanelTokenStatus): TokenView => {
  if (tokens.loginStatus === "error" || tokens.loginStatus === "revoked") {
    return { tone: "error", label: statusLabel(tokens.loginStatus) };
  }
  if (tokens.loginStatus === null) return { tone: "neutral", label: "Login-Identität fehlt" };
  const now = Date.now();
  const botExpiresAt = parseDate(tokens.botExpiresAt);
  const loginExpiresAt = parseDate(tokens.loginExpiresAt);
  if (botExpiresAt === null || loginExpiresAt === null) return { tone: "neutral", label: "Nicht geprüft" };
  if (botExpiresAt <= now || loginExpiresAt <= now) return { tone: "error", label: "Abgelaufen" };
  if (botExpiresAt <= now + 24 * 60 * 60 * 1000 || loginExpiresAt <= now + 24 * 60 * 60 * 1000) {
    return { tone: "warning", label: "Läuft bald ab" };
  }
  return { tone: "healthy", label: "Gültig" };
};

const channelStatus = (channel: PanelChannelState): "healthy" | "warning" | "error" => {
  if (channel.moderator?.isModerator === false) return "error";
  if (channel.bot?.status === "error" || channel.bot?.status === "revoked") return "error";
  if (channel.tokens.loginStatus === "error" || channel.tokens.loginStatus === "revoked") return "error";
  const tokenStatus = tokenView(channel.tokens);
  if (tokenStatus.tone === "error") return "error";
  if (tokenStatus.tone !== "healthy") return "warning";
  if (channel.bot?.status !== "connected" || channel.moderator?.isModerator !== true ||
      channel.tokens.loginStatus !== "connected" || channel.tokens.botExpiresAt === null ||
      channel.tokens.loginExpiresAt === null) return "warning";
  return "healthy";
};

const statusText = (channel: PanelChannelState): string => {
  if (channel.moderator?.isModerator === false) return "Moderatorrolle fehlt";
  if (channel.bot?.status === "error") return "Bot-Fehler";
  if (channel.bot?.status === "revoked") return "Bot-Token widerrufen";
  const tokenStatus = tokenView(channel.tokens);
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

interface LinkProperties {
  route: DashboardRoute;
  current: DashboardRoute;
  children: ReactElement | string;
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

const formatTimestamp = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const tokenSummary = (tokens: PanelTokenStatus): string => {
  return tokenView(tokens).label;
};

const ChannelStateCard = ({ channel }: { channel: PanelChannelState }): ReactElement => (
  <article className="channel-card" data-status={channelStatus(channel)}>
    <div className="channel-card__heading">
      <div>
        <span className="eyebrow">{channel.login}</span>
        <h2>{channel.displayName}</h2>
      </div>
      <StatusBadge tone={channelStatus(channel)}>{statusText(channel)}</StatusBadge>
    </div>
    <dl className="compact-list">
      <div><dt>Deine Rolle</dt><dd>{channel.role}</dd></div>
      <div><dt>Broadcaster-OAuth</dt><dd><StatusBadge tone={channel.broadcasterConnection === "connected" ? "healthy" : "neutral"}>{broadcasterConnectionLabel(channel.broadcasterConnection)}</StatusBadge></dd></div>
      <div><dt>Bot-Account</dt><dd>{channel.bot === null ? "Nicht eingerichtet" : statusLabel(channel.bot.status)}</dd></div>
      <div><dt>Moderatorstatus</dt><dd>{channel.moderator === null ? "Nicht geprüft" : channel.moderator.isModerator ? "Moderator" : "Fehlt"}</dd></div>
      <div><dt>Token</dt><dd>{tokenSummary(channel.tokens)}</dd></div>
    </dl>
  </article>
);

const StatusCard = ({ title, tone, value, detail, badgeLabel }: { title: string; tone: StatusBadgeProperties["tone"]; value: string; detail?: string; badgeLabel?: string }): ReactElement => (
  <article className="status-card" aria-label={title} data-status={tone}>
    <div className="status-card__heading">
      <span className="eyebrow">{title}</span>
      <StatusBadge tone={tone}>{badgeLabel ?? (tone === "healthy" ? "Gesund" : tone === "warning" ? "Warnung" : tone === "error" ? "Fehler" : "Nicht geprüft")}</StatusBadge>
    </div>
    <strong>{value}</strong>
    {detail === undefined ? null : <p>{detail}</p>}
  </article>
);

const ErrorPanel = ({ message }: { message: string }): ReactElement => (
  <section className="error-panel" data-status="error" role="alert">
    <span className="eyebrow">Fehler</span>
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
  return (
    <aside className="sidebar">
      <div className="brand-mark"><span className="brand-mark__dot" />BroBot</div>
      <div className="sidebar__intro">
        <span className="eyebrow">Admin- und Mod-Panel</span>
        <p>Der verlässliche Blick auf deinen Bot.</p>
      </div>
      <nav className="primary-nav" aria-label="Hauptnavigation">
        <RouteLink route={{ kind: "overview" }} current={route} onNavigate={onNavigate}>Übersicht</RouteLink>
        {route.kind === "channel" ? (
          <>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "overview" }} current={route} onNavigate={onNavigate}>Kanal</RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "system" }} current={route} onNavigate={onNavigate}>System</RouteLink>
            <RouteLink route={{ kind: "channel", channelId: route.channelId, section: "members" }} current={route} onNavigate={onNavigate}>Mitglieder</RouteLink>
          </>
        ) : null}
      </nav>
      {channels.length > 1 ? (
        <label className="channel-picker">
          <span className="eyebrow">Kanal auswählen</span>
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
      <div><span className="eyebrow">Arbeitsbereich</span><h1>Übersicht</h1></div>
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

const ModeratorCard = ({ moderator }: { moderator: PanelModeratorStatus | null }): ReactElement => {
  if (moderator === null) return <StatusCard title="Moderatorstatus" tone="neutral" value="Nicht geprüft" detail="Für diesen Kanal liegt noch keine Prüfung vor." />;
  if (!moderator.isModerator) return <StatusCard title="Moderatorstatus" tone="error" value="Moderatorrolle fehlt" detail={moderator.reason ?? "Ohne diese Rolle scheitern mehrere Bot-Funktionen."} />;
  return <StatusCard title="Moderatorstatus" tone="healthy" value="Moderator" detail={`Geprüft: ${formatTimestamp(moderator.checkedAt)}`} />;
};

const BotCard = ({ bot }: { bot: PanelBotStatus | null }): ReactElement => {
  if (bot === null) return <StatusCard title="Bot-Account" tone="neutral" value="Nicht eingerichtet" detail="Es gibt noch keinen gespeicherten Botstatus." />;
  const tone = bot.status === "connected" ? "healthy" : "error";
  return <StatusCard title="Bot-Account" tone={tone} value={statusLabel(bot.status)} detail={bot.reason ?? `Zuletzt aktualisiert: ${formatTimestamp(bot.updatedAt)}`} />;
};

const TokenCard = ({ tokens }: { tokens: PanelTokenStatus }): ReactElement => (
  <StatusCard title="Token-Zustand" tone={tokenView(tokens).tone} value={tokenSummary(tokens)} detail={tokens.loginReason ?? "Ablaufzeiten werden aus der Datenbank gelesen."} />
);

const BroadcasterConnectionCard = ({ status }: { status: PanelChannelState["broadcasterConnection"] }): ReactElement => (
  <StatusCard
    title="Broadcaster-OAuth"
    tone={status === "connected" ? "healthy" : "neutral"}
    value={broadcasterConnectionLabel(status)}
    badgeLabel={broadcasterConnectionLabel(status)}
    detail={status === "connected" ? "Für optionale Broadcaster-Module verbunden." : "Optional; für den normalen Bot-Betrieb nicht erforderlich."}
  />
);

const ErrorCard = ({ error }: { error: PanelLastError | null }): ReactElement =>
  error === null
    ? <StatusCard title="Letzter Fehler" tone="neutral" value="Keine gespeicherte Ursache" detail="Es gibt keinen Fehlergrund in den gelesenen Zustandsdaten." />
    : <StatusCard title="Letzter Fehler" tone="error" value={error.reason} detail={`${error.source} · ${formatTimestamp(error.at)}`} />;

const ChannelOverviewPage = ({ overview }: { overview: PanelChannelOverview }): ReactElement => (
  <>
    <header className="page-heading">
      <div><span className="eyebrow">Kanalübersicht · {overview.role}</span><h1>{overview.displayName}</h1></div>
      <p>Nur Zustände, die für diesen Kanal tatsächlich gespeichert sind.</p>
    </header>
    <div className="status-grid">
      <BroadcasterConnectionCard status={overview.broadcasterConnection} />
      <ModeratorCard moderator={overview.moderator} />
      <BotCard bot={overview.bot} />
      <TokenCard tokens={overview.tokens} />
      <ErrorCard error={overview.lastError} />
    </div>
    <section className="content-section"><div className="section-heading"><div><span className="eyebrow">Aktivierung</span><h2>Aktive Module</h2></div><span className="muted">{String(overview.activeModules.length)}</span></div><ModulePanelMount activeModules={overview.activeModules} /></section>
  </>
);

const SystemPage = ({ system, auditState, onNextPage, loadingNextPage }: { system: PanelSystemResponse; auditState: LoadState<PanelAuditResponse>; onNextPage: () => void; loadingNextPage: boolean }): ReactElement => (
  <>
    <header className="page-heading"><div><span className="eyebrow">Betrieb</span><h1>System</h1></div><p>Token-Zustand und gespeicherte Audit-Einträge.</p></header>
    <div className="status-grid status-grid--system"><BroadcasterConnectionCard status={system.broadcasterConnection} /><BotCard bot={system.bot} /><TokenCard tokens={system.tokens} /></div>
    <section className="content-section"><div className="section-heading"><div><span className="eyebrow">Nachvollziehbarkeit</span><h2>Audit-Log</h2></div>{auditState.data === null ? null : <span className="muted">{String(auditState.data.entries.length)} Einträge</span>}</div>
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

export const DashboardApp = (): ReactElement => {
  const [route, navigate] = useDashboardRoute();
  const [channels, setChannels] = useState<LoadState<PanelChannelState[]>>(() => idleState());
  const [overview, setOverview] = useState<LoadState<PanelChannelOverview>>(() => idleState());
  const [system, setSystem] = useState<LoadState<PanelSystemResponse>>(() => idleState());
  const [members, setMembers] = useState<LoadState<PanelMembersResponse>>(() => idleState());
  const [audit, setAudit] = useState<LoadState<PanelAuditResponse>>(() => idleState());
  const [systemChannelId, setSystemChannelId] = useState<string | null>(null);
  const [auditChannelId, setAuditChannelId] = useState<string | null>(null);
  const [loadingNextAuditPage, setLoadingNextAuditPage] = useState(false);
  const auditPageController = useRef<AbortController | null>(null);
  const [loadingNextMembersPage, setLoadingNextMembersPage] = useState(false);
  const membersPageController = useRef<AbortController | null>(null);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const clearProtectedState = (): void => {
    auditPageController.current?.abort();
    auditPageController.current = null;
    membersPageController.current?.abort();
    membersPageController.current = null;
    setChannels({ status: "success", data: [], error: null });
    setOverview(idleState());
    setSystem(idleState());
    setMembers(idleState());
    setAudit(idleState());
    setSystemChannelId(null);
    setAuditChannelId(null);
    setLoadingNextAuditPage(false);
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
    membersPageController.current?.abort();
    membersPageController.current = null;
    setLoadingNextMembersPage(false);
    setOverview(loadingState());
    setSystem(idleState());
    setAudit(idleState());
    setSystemChannelId(null);
    setAuditChannelId(null);
    const cleanup = (): void => {
      cancelled = true;
      controller.abort();
      auditPageController.current?.abort();
      auditPageController.current = null;
      membersPageController.current?.abort();
      membersPageController.current = null;
      setLoadingNextMembersPage(false);
    };
    if (route.kind !== "channel") return cleanup;

    const load = async (): Promise<void> => {
      if (route.section === "overview") {
        try {
          const response = await fetchChannelOverview(route.channelId, controller.signal);
          if (!cancelled) setOverview({ status: "success", data: response, error: null });
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
          data: { members: [...current.data.members, ...nextPage.members], nextCursor: nextPage.nextCursor },
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
      if (error instanceof PanelApiError && (error.status === 401 || error.status === 403)) {
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

  if (authenticationRequired) {
    return <main className="auth-screen"><div className="auth-card"><span className="eyebrow">BroBot Panel</span><h1>Anmeldung erforderlich</h1><p>Bitte melde dich mit deinem Twitch-Konto an, um freigegebene Kanäle zu sehen.</p><a className="button" href="/auth/login">Mit Twitch anmelden</a></div></main>;
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
        {route.kind === "channel" && route.section === "overview" && overview.data !== null && overview.data.channelId === route.channelId ? <ChannelOverviewPage overview={overview.data} /> : null}
        {route.kind === "channel" && route.section === "members" && members.status === "loading" ? <p className="loading-line">Mitglieder werden geladen …</p> : null}
        {route.kind === "channel" && route.section === "members" && members.error !== null ? <ErrorPanel message={members.error} /> : null}
        {route.kind === "channel" && route.section === "members" && members.data !== null && selectedChannel !== null ? <MembersPage channelId={route.channelId} ownRole={selectedChannel.role} members={members.data.members} nextCursor={members.data.nextCursor} loading={members.status === "loading"} loadingNextPage={loadingNextMembersPage} error={members.error} onReload={reloadMembers} onLoadNextPage={loadNextMembersPage} onAuthenticationRequired={() => setAuthenticationRequired(true)} /> : null}
        {route.kind === "channel" && route.section === "system" && system.status === "loading" ? <p className="loading-line">Systemzustand wird geladen …</p> : null}
        {route.kind === "channel" && route.section === "system" && system.error !== null ? <ErrorPanel message={system.error} /> : null}
        {route.kind === "channel" && route.section === "system" && system.data !== null && systemChannelId === route.channelId ? <SystemPage system={system.data} auditState={auditChannelId === route.channelId ? audit : idleState<PanelAuditResponse>()} onNextPage={() => { void loadNextAuditPage(); }} loadingNextPage={loadingNextAuditPage} /> : null}
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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChannelStreamState } from "../contracts/values";
import type { PanelChannelOverview, PanelModuleState } from "../panel-contract";
import type { ModuleImmediateActionResult, ModuleLiveTileSnapshot } from "../modules/contract";
import { MODULES } from "../modules/registry";
import type { DashboardRoute } from "./router";
import { dashboardTexts, formatNumber } from "./locale";
import { useEventsQuery, useOverlaysQuery } from "./data/lists";
import { queryKeys } from "./data/keys";
import { Button, Dialog, Icon, StatusLed } from "./ui";
import { ImmediateActions } from "./ImmediateActions";
import { LiveCockpitEventFeed, LiveCockpitTiles } from "./LiveCockpitParts";
import "./cockpit.css";
import { LiveCockpitBroadcast } from "./LiveCockpitBroadcast";
import { browserTimeZone } from "./ui/format-relative-time";
import { useChannelSettings } from "./data/channel-settings";
import { emptyEventFilter } from "./events/model";
import {
  belaboxObservationFromStatus,
  belaboxObservationIsExpired,
  failedBelaboxObservation,
  latestBelaboxObservation,
  successfulManualBelaboxObservation,
  type LiveCockpitBelaboxObservation,
} from "./live-cockpit-belabox";

const formatDuration = (startedAt: string | null | undefined, now: number): string => {
  if (startedAt == null) return "—";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "—";
  const elapsedSeconds = Math.max(0, Math.floor((now - started) / 1_000));
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const ACTION_FEEDBACK_TIMEOUT_MS = 5_000;

interface LiveCockpitFooterMessage {
  text: string;
  tone?: "warning";
  link?: { href: string; label: string };
}

interface LiveCockpitFooterState {
  healthKey: string;
  message: LiveCockpitFooterMessage | null;
}

const streamStateLabel = (state: ChannelStreamState | null | undefined): string => {
  const texts = dashboardTexts().liveCockpit;
  return state === "online" ? texts.live : state === "offline" ? texts.offline : texts.unknown;
};

export const LiveCockpit = ({ overview, modules, modulesLoaded, viewerUserId, onNavigate }: {
  overview: PanelChannelOverview;
  modules: readonly PanelModuleState[];
  modulesLoaded: boolean;
  viewerUserId: string | null;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const labels = texts.liveCockpit;
  const [now, setNow] = useState(() => Date.now());
  const [warningDetailsOpen, setWarningDetailsOpen] = useState(false);
  const queryClient = useQueryClient();
  const [broadcastQueryState, setBroadcastQueryState] = useState<{ channelId: string; state: "pending" | "ready" | "error" } | null>(null);
  const moduleState = useMemo(() => new Map(modules.map((module) => [module.id, module.enabled])), [modules]);
  const [belaboxObservationState, setBelaboxObservationState] = useState<{ channelId: string; observation: LiveCockpitBelaboxObservation } | null>(null);
  const belaboxObservationClock = useRef(0);
  const nextBelaboxObservationAt = useCallback((): number => {
    const observedAt = Math.max(Date.now(), belaboxObservationClock.current + 1);
    belaboxObservationClock.current = observedAt;
    return observedAt;
  }, []);
  const recordBelaboxObservation = useCallback((
    channelId: string,
    create: (current: LiveCockpitBelaboxObservation | null) => LiveCockpitBelaboxObservation,
  ): void => {
    setBelaboxObservationState((current) => {
      const previous = current?.channelId === channelId ? current.observation : null;
      return { channelId, observation: latestBelaboxObservation(previous, create(previous)) };
    });
  }, []);
  const overlaysQuery = useOverlaysQuery(overview.channelId);
  const eventsQuery = useEventsQuery(overview.channelId, emptyEventFilter, 30_000);
  const channelSettings = useChannelSettings(overview.channelId);
  const timeZone = channelSettings.data?.timeZone ?? browserTimeZone();
  const liveQuery = useQuery({
    queryKey: queryKeys.channel(overview.channelId, "live-cockpit", { modules: modules.map((module) => `${module.id}:${String(module.enabled)}`).sort((left, right) => left.localeCompare(right)).join(",") }),
    queryFn: async ({ signal }): Promise<{ snapshots: ModuleLiveTileSnapshot[]; failed: boolean; failedModules: string[] }> => {
      const results = await Promise.all(MODULES.flatMap((module) => {
        if (module.liveTile === undefined || moduleState.get(module.id) !== true) return [];
        return [module.liveTile.load(overview.channelId, signal)
          .then((snapshots) => ({ moduleId: module.id, snapshots, failed: false }))
          .catch((error: unknown) => {
            if (error instanceof Error && error.name === "AbortError") throw error;
            return { moduleId: module.id, snapshots: [] as readonly ModuleLiveTileSnapshot[], failed: true };
          })];
      }));
      return {
        snapshots: results.flatMap((result) => result.snapshots),
        failed: results.some((result) => result.failed),
        failedModules: results.filter((result) => result.failed).map((result) => result.moduleId),
      };
    },
    enabled: modulesLoaded,
    refetchInterval: modulesLoaded ? 5_000 : false,
    refetchOnWindowFocus: false,
  });
  const onBroadcastQueryStateChange = useCallback((state: "pending" | "ready" | "error") => {
    setBroadcastQueryState((current) => current?.channelId === overview.channelId && current.state === state
      ? current
      : { channelId: overview.channelId, state });
  }, [overview.channelId]);
  const currentBroadcastQueryState = broadcastQueryState?.channelId === overview.channelId
    ? broadcastQueryState.state
    : "pending";
  const belaboxEnabled = moduleState.get("belabox") === true;
  const streamState = overview.streamState;
  const streamLabel = streamStateLabel(streamState);
  const viewerCount = overview.viewerCount ?? null;
  const overlayCount = overlaysQuery.data?.overlays.length ?? null;
  const botConnected = overview.bot?.status === "connected";

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (streamState !== "online") return;
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channel(overview.channelId, "overview"), exact: true });
    };
    const interval = window.setInterval(refresh, 30_000);
    return () => { window.clearInterval(interval); };
  }, [overview.channelId, queryClient, streamState]);

  useEffect(() => {
    if (!belaboxEnabled) return;
    let active = true;
    let controller: AbortController | null = null;
    const refresh = async (): Promise<void> => {
      controller?.abort();
      controller = new AbortController();
      const observedAt = nextBelaboxObservationAt();
      try {
        const service = await import("../modules/belabox/panel/service");
        const data = await service.loadBelaboxStatus(overview.channelId, controller.signal);
        if (active) recordBelaboxObservation(overview.channelId, () => belaboxObservationFromStatus(data, observedAt));
      } catch (error: unknown) {
        if (!active || (error instanceof Error && error.name === "AbortError")) return;
        recordBelaboxObservation(overview.channelId, (previous) => failedBelaboxObservation(observedAt, previous));
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 5_000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [belaboxEnabled, nextBelaboxObservationAt, overview.channelId, recordBelaboxObservation]);

  const belaboxObservation = belaboxObservationState?.channelId === overview.channelId ? belaboxObservationState.observation : null;
  const belaboxUnavailable = belaboxObservation !== null &&
    (belaboxObservation.failed || belaboxObservationIsExpired(belaboxObservation, now));
  const sampleConnected = belaboxObservation !== null && !belaboxUnavailable &&
    belaboxObservation.sampledAt !== null && belaboxObservation.connected;
  const sampleBitrate = belaboxObservation?.bitrateKbps ?? 0;
  const belaboxWeak = belaboxEnabled && !belaboxUnavailable && belaboxObservation?.configured === true && belaboxObservation.phase === "low";
  const liveDataFailed = liveQuery.isError || liveQuery.data?.failed === true || overlaysQuery.isError || eventsQuery.isError || currentBroadcastQueryState === "error";
  const liveDataPending = liveQuery.isPending || overlaysQuery.isPending || eventsQuery.isPending || currentBroadcastQueryState === "pending";
  const footerStatus: "ok" | "warn" | "loading" = !botConnected || liveDataFailed
    ? "warn"
    : liveDataPending ? "loading" : "ok";
  const footerHealthText = !botConnected ? labels.botUnavailable
    : liveDataFailed ? labels.liveDataUnavailable
      : liveDataPending ? labels.liveDataLoading
        : `${labels.systemReady} · ${labels.liveDataCurrent}`;
  const footerHealthKey = `${footerStatus}:${footerHealthText}`;
  const [footerState, setFooterState] = useState<LiveCockpitFooterState>(() => ({ healthKey: footerHealthKey, message: null }));
  if (footerState.healthKey !== footerHealthKey) setFooterState({ healthKey: footerHealthKey, message: null });
  useEffect(() => {
    const message = footerState.message;
    if (message === null) return;
    const timeout = window.setTimeout(() => {
      setFooterState((current) => current.message === message ? { ...current, message: null } : current);
    }, ACTION_FEEDBACK_TIMEOUT_MS);
    return () => { window.clearTimeout(timeout); };
  }, [footerState.message]);
  const showFooterMessage = (message: LiveCockpitFooterMessage): void => {
    setFooterState({ healthKey: footerHealthKey, message });
  };
  const visibleFooterMessage = footerState.healthKey === footerHealthKey &&
    (footerStatus === "ok" || footerState.message?.tone === "warning") ? footerState.message : null;
  const footerLedStatus = footerStatus === "ok" && visibleFooterMessage?.tone === "warning" ? "warn" : footerStatus;
  const warnings = [
    ...(overview.location == null ? [{ key: "location", title: labels.locationMissing, description: labels.locationMissingDescription, action: labels.configureLocation, run: () => onNavigate({ kind: "channel", channelId: overview.channelId, section: "location-weather" }) }] : []),
    ...(belaboxWeak ? [{ key: "belabox", title: labels.belaboxWeak, description: labels.belaboxWeakDescription(formatNumber(Math.round(sampleBitrate))), action: labels.openBelabox, run: () => onNavigate({ kind: "module", channelId: overview.channelId, moduleId: "belabox" }) }] : []),
  ];
  const locationWarning = warnings.find((warning) => warning.key === "location");
  const renderWarning = (warning: (typeof warnings)[number]): ReactElement =>
    <div className="live-cockpit__location-warning" role="status" key={warning.key}>
      <div><strong>{warning.title}</strong><span>{warning.description}</span></div>
      <Button {...(warning.key === "location"
        ? { className: "live-cockpit__location-action", icon: "map-pin" as const, variant: "primary" as const }
        : { variant: "secondary" as const, size: "compact" as const })}
        onClick={() => { setWarningDetailsOpen(false); warning.run(); }}>{warning.action}</Button>
    </div>;
  const refreshLiveData = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.channel(overview.channelId, "live-cockpit") });
  };

  return <div className="live-cockpit" data-stream-state={streamState ?? "unknown"}>
    <header className="live-cockpit-header">
      <div className="live-cockpit-header__summary">
        <h1 className="sr-only">{overview.displayName}</h1>
        <span className={`live-cockpit-header__stream${streamState === "online" ? " is-live" : streamState === "offline" ? " is-offline" : " is-unknown"}`}>
          <span className="live-cockpit-header__stream-dot" aria-hidden="true" />
          <span className="live-cockpit-header__stream-label">{streamLabel}</span>
        </span>
        <span className="live-cockpit-header__metric"><Icon name="clock-hour-4" size={16} /><span>{labels.duration}</span><strong className="mono">{streamState === "online" ? formatDuration(overview.streamStartedAt, now) : "—"}</strong></span>
        <span className="live-cockpit-header__metric"><Icon name="member" size={16} /><span>{labels.viewers}</span><strong className="mono">{viewerCount == null ? "—" : formatNumber(viewerCount)}</strong></span>
        <span className="live-cockpit-header__role">{labels.youAre(labels.roles[overview.role])}</span>
      </div>
      <LiveCockpitBroadcast key={overview.channelId} channelId={overview.channelId} role={overview.role}
        onQueryStateChange={onBroadcastQueryStateChange}
        onSaved={(text) => { showFooterMessage({ text }); }} />
      <div className="live-cockpit-header__status">
        <div className="live-cockpit-header__indicators" aria-label={labels.statusIndicators}>
          <StatusLed state={botConnected ? "ok" : "off"} label={`${labels.bot} · ${botConnected ? labels.botConnected : labels.botUnavailable}`} />
          <StatusLed
            state={!belaboxEnabled || belaboxObservation?.configured === false ? "off" : belaboxUnavailable || belaboxObservation === null ? "warn" : belaboxObservation.phase === "low" ? "warn" : sampleConnected ? "ok" : "warn"}
            label={`${labels.belabox} · ${!belaboxEnabled
              ? labels.belaboxDisabled
              : belaboxObservation === null
                ? labels.belaboxChecking
                : belaboxObservation.configured === false
                  ? labels.belaboxNotConfigured
                  : belaboxUnavailable
                    ? labels.belaboxUnavailable
                    : sampleConnected
                      ? labels.belaboxConnected(formatNumber(Math.round(sampleBitrate)))
                      : labels.belaboxDisconnected}`}
          />
          {overlaysQuery.isPending
            ? <StatusLed state="loading" label={`${labels.overlays} · ${labels.overlaysChecking}`} />
            : overlayCount === null
              ? <StatusLed state="warn" label={`${labels.overlays} · ${labels.overlaysNotSetUp}`} />
              : <StatusLed state={overlayCount > 0 ? "ok" : "off"} label={`${labels.overlays} · ${overlayCount === 0 ? labels.overlaysNotSetUp : labels.overlaysCount(formatNumber(overlayCount))}`} />}
        </div>
        <div className="live-cockpit__warning-slot" data-slot="warning-banner" data-warning-count={warnings.length}
          aria-live="polite" aria-hidden={warnings.length === 0} inert={warnings.length === 0}>
          {warnings.length === 0 ? null : <div className="live-cockpit__warning-summary">
            <Button variant="secondary" icon="warning" ariaHasPopup="dialog" ariaExpanded={warningDetailsOpen}
              onClick={() => { setWarningDetailsOpen(true); }}>
              <span>{warnings.length === 1 ? warnings[0]?.title : labels.warningSummary(formatNumber(warnings.length))}</span>
              <Icon name="more" size={16} />
            </Button>
            {locationWarning === undefined ? null : <Button className="live-cockpit__location-action" variant="primary" icon="map-pin"
              onClick={() => { setWarningDetailsOpen(false); locationWarning.run(); }}>
              {locationWarning.action}
            </Button>}
          </div>}
        </div>
      </div>
    </header>
    <Dialog opened={warningDetailsOpen} title={labels.warningDetailsTitle} className="live-cockpit__warning-dialog"
      onClose={() => { setWarningDetailsOpen(false); }}>
      <div className="live-cockpit__warning-details">
        {warnings.length === 0 ? <p>{labels.noWarnings}</p> : warnings.map(renderWarning)}
      </div>
    </Dialog>
    <div className="live-cockpit__wall">
      <ImmediateActions
        channelId={overview.channelId}
        viewerUserId={viewerUserId}
        streamState={streamState}
        botConnected={botConnected}
        role={overview.role}
        modules={modules}
        modulesLoaded={modulesLoaded}
        onActionStart={(moduleId: string, actionId: string) => moduleId === "belabox" && actionId === "check-belabox"
          ? nextBelaboxObservationAt()
          : Date.now()}
        onActionResult={(moduleId: string, result: ModuleImmediateActionResult, observedAt: number) => {
          if (moduleId === "quiz") refreshLiveData();
          if (moduleId === "belabox" && result.belaboxSample !== undefined) {
            recordBelaboxObservation(overview.channelId, (previous) => successfulManualBelaboxObservation(
              observedAt,
              result.belaboxSample?.sampledAt ?? Date.now(),
              result.belaboxSample?.connected ?? false,
              result.belaboxSample?.bitrateKbps ?? 0,
              previous,
            ));
          }
        }}
        onActionFailure={(moduleId: string, actionId: string, observedAt: number) => {
          if (moduleId === "belabox" && actionId === "check-belabox") {
            recordBelaboxObservation(overview.channelId, (previous) => failedBelaboxObservation(observedAt, previous));
          }
        }}
        onFeedbackMessage={(text, link, tone) => { showFooterMessage({ text, ...(link === undefined ? {} : { link }), ...(tone === "info" ? { tone: "warning" } : {}) }); }}
      />
      <div className="live-cockpit__running-area">
        <LiveCockpitTiles
          key={overview.channelId}
          channelId={overview.channelId}
          role={overview.role}
          snapshots={liveQuery.data?.snapshots ?? []}
          failedModules={liveQuery.data?.failedModules ?? []}
          adsEnabled={moduleState.get("ads") === true}
          loading={liveQuery.isPending}
          failed={liveQuery.data?.failed ?? liveQuery.isError}
          now={now}
          timeZone={timeZone}
          streamState={overview.streamState}
          onMessage={(text, tone) => { showFooterMessage({ text, ...(tone === undefined ? {} : { tone }) }); }}
          onRefresh={refreshLiveData}
        />
      </div>
      <LiveCockpitEventFeed channelId={overview.channelId} role={overview.role} now={now} timeZone={timeZone} eventQuery={eventsQuery}
        streamState={overview.streamState} raidEnabled={modules.some((module) => module.id === "raid" && module.enabled)}
        onMessage={(text) => { showFooterMessage({ text }); }} />
    </div>
    <footer className="live-cockpit__status" aria-live="polite" aria-label={labels.systemStatusDescription(visibleFooterMessage?.tone === "warning" ? visibleFooterMessage.text : footerHealthText)}>
      <StatusLed state={footerLedStatus} label={labels.systemStatus} />
      {visibleFooterMessage === null ? <span>{footerHealthText}</span> : <span className="live-cockpit__status-message">
        {visibleFooterMessage.text}{visibleFooterMessage.link === undefined ? null : <a href={visibleFooterMessage.link.href} target="_blank" rel="noreferrer">{visibleFooterMessage.link.label}</a>}
      </span>}
    </footer>
  </div>;
};

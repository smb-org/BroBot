import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ChannelStreamState } from "../contracts/values";
import type { PanelChannelOverview, PanelModuleState } from "../panel-contract";
import type { BelaboxStatusResponse } from "../modules/belabox/contracts";
import type { ModuleImmediateActionResult, ModuleLiveTileSnapshot } from "../modules/contract";
import { MODULES } from "../modules/registry";
import { fetchChannelOverview } from "./api";
import type { DashboardRoute } from "./router";
import { dashboardTexts, formatNumber } from "./locale";
import { useOverlaysQuery } from "./data/lists";
import { queryKeys } from "./data/keys";
import { Button, Icon, StatusLed } from "./ui";
import { ImmediateActions } from "./ImmediateActions";
import { LiveCockpitEventFeed, LiveCockpitTiles } from "./LiveCockpitParts";
import { browserTimeZone } from "./ui/format-relative-time";
import { useChannelSettings } from "./data/channel-settings";

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

const streamStateLabel = (state: ChannelStreamState | null | undefined): string => {
  const texts = dashboardTexts().liveCockpit;
  return state === "online" ? texts.live : state === "offline" ? texts.offline : texts.unknown;
};

export const LiveCockpit = ({ overview, modules, modulesLoaded, onNavigate }: {
  overview: PanelChannelOverview;
  modules: readonly PanelModuleState[];
  modulesLoaded: boolean;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => {
  const texts = dashboardTexts();
  const labels = texts.liveCockpit;
  const [now, setNow] = useState(() => Date.now());
  const queryClient = useQueryClient();
  const moduleState = useMemo(() => new Map(modules.map((module) => [module.id, module.enabled])), [modules]);
  const [belaboxStatus, setBelaboxStatus] = useState<{ data: BelaboxStatusResponse | null; failed: boolean }>({ data: null, failed: false });
  const [belaboxActionSample, setBelaboxActionSample] = useState<{ channelId: string; connected: boolean; bitrateKbps: number; sampledAt: number } | null>(null);
  const [footerMessage, setFooterMessage] = useState<{ text: string; link?: { href: string; label: string } } | null>(null);
  const overlaysQuery = useOverlaysQuery(overview.channelId);
  const channelSettings = useChannelSettings(overview.channelId);
  const timeZone = channelSettings.data?.timeZone ?? browserTimeZone();
  const liveQuery = useQuery({
    queryKey: queryKeys.channel(overview.channelId, "live-cockpit", { modules: modules.map((module) => `${module.id}:${String(module.enabled)}`).sort((left, right) => left.localeCompare(right)).join(",") }),
    queryFn: async ({ signal }): Promise<{ snapshots: ModuleLiveTileSnapshot[]; failed: boolean }> => {
      const results = await Promise.all(MODULES.flatMap((module) => {
        if (module.liveTile === undefined || moduleState.get(module.id) !== true) return [];
        return [module.liveTile.load(overview.channelId, signal)
          .then((snapshots) => ({ snapshots, failed: false }))
          .catch((error: unknown) => {
            if (error instanceof Error && error.name === "AbortError") throw error;
            return { snapshots: [] as readonly ModuleLiveTileSnapshot[], failed: true };
          })];
      }));
      return { snapshots: results.flatMap((result) => result.snapshots), failed: results.some((result) => result.failed) };
    },
    enabled: modulesLoaded,
    refetchInterval: modulesLoaded ? 5_000 : false,
    refetchOnWindowFocus: false,
  });
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
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const freshOverview = await fetchChannelOverview(overview.channelId, controller.signal);
        if (active) {
          queryClient.setQueryData<PanelChannelOverview>(queryKeys.channel(overview.channelId, "overview"), (current) =>
            current === undefined ? current : { ...current, viewerCount: freshOverview.viewerCount ?? null });
        }
      } catch (error: unknown) {
        if (active && !(error instanceof Error && error.name === "AbortError")) {
          // Keep the last useful viewer count until a later refresh succeeds.
        }
      } finally {
        inFlight = false;
      }
    };
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [overview.channelId, queryClient, streamState]);

  useEffect(() => {
    if (!belaboxEnabled) return;
    let active = true;
    let controller: AbortController | null = null;
    const refresh = async (): Promise<void> => {
      controller?.abort();
      controller = new AbortController();
      try {
        const service = await import("../modules/belabox/panel/service");
        const data = await service.loadBelaboxStatus(overview.channelId, controller.signal);
        if (active) setBelaboxStatus({ data, failed: false });
      } catch (error: unknown) {
        if (!active || (error instanceof Error && error.name === "AbortError")) return;
        setBelaboxStatus({ data: null, failed: true });
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 5_000);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [belaboxEnabled, overview.channelId]);

  const statusSample = belaboxStatus.data?.sample ?? null;
  const actionSample = belaboxActionSample?.channelId === overview.channelId ? belaboxActionSample : null;
  const statusSampleAt = statusSample === null ? Number.NEGATIVE_INFINITY : Date.parse(statusSample.at);
  const freshActionSample = actionSample !== null && actionSample.sampledAt > statusSampleAt ? actionSample : null;
  const sampleConnected = freshActionSample?.connected ?? statusSample?.connected ?? false;
  const sampleBitrate = freshActionSample?.bitrateKbps ?? statusSample?.bitrateKbps ?? 0;
  const belaboxFetchFailed = belaboxStatus.data !== null &&
    (belaboxStatus.data.fetchFailureNotice || belaboxStatus.data.errorCode !== null);
  const belaboxUnavailable = belaboxFetchFailed ||
    belaboxStatus.failed && statusSample === null && freshActionSample === null;
  const belaboxWeak = belaboxEnabled && belaboxStatus.data?.configured === true && statusSample?.phase === "low";
  const liveDataFailed = liveQuery.isError || liveQuery.data?.failed === true || overlaysQuery.isError;
  const footerStatus: "ok" | "warn" | "loading" = !botConnected || liveDataFailed
    ? "warn"
    : liveQuery.isPending || overlaysQuery.isPending ? "loading" : "ok";
  const footerHealthText = !botConnected ? labels.botUnavailable
    : liveDataFailed ? labels.liveDataUnavailable
      : liveQuery.isPending || overlaysQuery.isPending ? labels.liveDataLoading
        : `${labels.systemReady} · ${labels.liveDataCurrent}`;
  const warnings = [
    ...(overview.location == null ? [{ key: "location", title: labels.locationMissing, description: labels.locationMissingDescription, action: labels.configureLocation, run: () => onNavigate({ kind: "channel", channelId: overview.channelId, section: "location-weather" }) }] : []),
    ...(belaboxWeak ? [{ key: "belabox", title: labels.belaboxWeak, description: labels.belaboxWeakDescription(formatNumber(Math.round(sampleBitrate))), action: labels.openBelabox, run: () => onNavigate({ kind: "module", channelId: overview.channelId, moduleId: "belabox" }) }] : []),
  ];
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
      <div className="live-cockpit-header__title-slot" data-slot="stream-title-category">
        <span>{labels.titleCategoryPlaceholder}</span>
      </div>
      <div className="live-cockpit-header__indicators" aria-label={labels.statusIndicators}>
        <StatusLed state={botConnected ? "ok" : "off"} label={`${labels.bot} · ${botConnected ? labels.botConnected : labels.botUnavailable}`} />
        <StatusLed
          state={!belaboxEnabled || belaboxStatus.data?.configured === false ? "off" : belaboxUnavailable ? "warn" : statusSample?.phase === "low" ? "warn" : sampleConnected ? "ok" : "warn"}
          label={`${labels.belabox} · ${!belaboxEnabled
            ? labels.belaboxDisabled
            : belaboxStatus.data === null && !belaboxStatus.failed && freshActionSample === null
              ? labels.belaboxChecking
              : belaboxUnavailable
                ? labels.belaboxUnavailable
                : belaboxStatus.data?.configured === false
                  ? labels.belaboxNotConfigured
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
    </header>
    <div className="live-cockpit__warning-slot" data-slot="warning-banner" data-warning-count={warnings.length} aria-live="polite">
      {warnings.map((warning) => <div className="live-cockpit__location-warning" role="status" key={warning.key}>
        <div><strong>{warning.title}</strong><span>{warning.description}</span></div>
        <Button {...(warning.key === "location"
          ? { className: "live-cockpit__location-action", icon: "map-pin" as const, variant: "primary" as const }
          : { variant: "secondary" as const, size: "compact" as const })} onClick={warning.run}>{warning.action}</Button>
      </div>)}
    </div>
    <div className="live-cockpit__wall">
      <ImmediateActions
        channelId={overview.channelId}
        streamState={streamState}
        role={overview.role}
        modules={modules}
        modulesLoaded={modulesLoaded}
        onActionResult={(moduleId: string, result: ModuleImmediateActionResult) => {
          if (moduleId === "belabox" && result.belaboxSample !== undefined) {
            setBelaboxActionSample({ channelId: overview.channelId, ...result.belaboxSample });
          }
        }}
        onFeedbackMessage={(text, link) => { setFooterMessage({ text, ...(link === undefined ? {} : { link }) }); }}
      />
      <LiveCockpitTiles
        channelId={overview.channelId}
        role={overview.role}
        snapshots={liveQuery.data?.snapshots ?? []}
        loading={liveQuery.isPending}
        failed={liveQuery.data?.failed ?? liveQuery.isError}
        now={now}
        timeZone={timeZone}
        onMessage={(text) => { setFooterMessage({ text }); }}
        onRefresh={refreshLiveData}
      />
      <LiveCockpitEventFeed channelId={overview.channelId} role={overview.role} now={now}
        streamState={overview.streamState} raidEnabled={modules.some((module) => module.id === "raid" && module.enabled)}
        onMessage={(text) => { setFooterMessage({ text }); }} />
    </div>
    <footer className="live-cockpit__status" aria-live="polite" aria-label={labels.systemStatus}>
      <StatusLed state={footerStatus} label={labels.systemStatus} />
      {footerMessage === null ? <span>{footerHealthText}</span> : <span className="live-cockpit__status-message">
        {footerMessage.text}{footerMessage.link === undefined ? null : <a href={footerMessage.link.href} target="_blank" rel="noreferrer">{footerMessage.link.label}</a>}
      </span>}
    </footer>
  </div>;
};

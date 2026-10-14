import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ChannelStreamState } from "../contracts/values";
import type { PanelChannelOverview, PanelModuleState } from "../panel-contract";
import type { BelaboxStatusResponse } from "../modules/belabox/contracts";
import type { ModuleImmediateActionResult } from "../modules/contract";
import { fetchChannelOverview } from "./api";
import type { DashboardRoute } from "./router";
import { dashboardTexts, formatNumber } from "./locale";
import { useOverlaysQuery } from "./data/lists";
import { queryKeys } from "./data/keys";
import { Button, Icon, StatusLed } from "./ui";
import { ImmediateActions } from "./ImmediateActions";

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

const ReserveTile = ({ title, description, slot }: { title: string; description: string; slot: string }): ReactElement => (
  <section className="live-cockpit-reserve" data-slot={slot} aria-label={title}>
    <h2>{title}</h2>
    <p>{description}</p>
  </section>
);

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
  const [belaboxStatus, setBelaboxStatus] = useState<{ data: BelaboxStatusResponse | null; failed: boolean }>({ data: null, failed: false });
  const [belaboxActionSample, setBelaboxActionSample] = useState<{ channelId: string; connected: boolean; bitrateKbps: number; sampledAt: number } | null>(null);
  const overlaysQuery = useOverlaysQuery(overview.channelId);
  const moduleState = useMemo(() => new Map(modules.map((module) => [module.id, module.enabled])), [modules]);
  const belaboxEnabled = moduleState.get("belabox") === true;
  const streamState = overview.streamState;
  const streamLabel = streamStateLabel(streamState);
  const viewerCount = overview.viewerCount ?? null;
  const overlayCount = overlaysQuery.data?.overlays.length ?? null;
  const botConnected = overview.bot?.status === "connected";

  useEffect(() => {
    if (streamState !== "online") return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(timer); };
  }, [streamState]);

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
      <div className="live-cockpit-header__title-slot" data-slot="stream-title-category" aria-label={labels.titleCategoryReserved}>
        <span>{labels.titleCategoryReserved}</span>
      </div>
      <div className="live-cockpit-header__indicators" aria-label={labels.statusIndicators}>
        <StatusLed state={botConnected ? "ok" : "off"} label={`${labels.bot} · ${botConnected ? labels.botConnected : labels.botUnavailable}`} />
        <StatusLed
          state={!belaboxEnabled || belaboxStatus.data?.configured === false ? "off" : belaboxStatus.failed && statusSample === null && freshActionSample === null ? "warn" : sampleConnected ? "ok" : "warn"}
          label={`${labels.belabox} · ${!belaboxEnabled
            ? labels.belaboxDisabled
            : belaboxStatus.data === null && !belaboxStatus.failed && freshActionSample === null
              ? labels.belaboxChecking
              : belaboxStatus.failed && statusSample === null && freshActionSample === null
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
    <div className="live-cockpit__warning-slot" data-slot="warning-banner">
      {overview.location == null ? <div className="live-cockpit__location-warning" role="status">
        <div><strong>{labels.locationMissing}</strong><span>{labels.locationMissingDescription}</span></div>
        <Button variant="secondary" size="compact" onClick={() => { onNavigate({ kind: "channel", channelId: overview.channelId, section: "location-weather" }); }}>{labels.configureLocation}</Button>
      </div> : null}
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
      />
      <div className="live-cockpit__running">
        <ReserveTile slot="running-now" title={labels.runningNow} description={labels.runningNowReserved} />
        <ReserveTile slot="next-up" title={labels.nextUp} description={labels.nextUpReserved} />
      </div>
      <ReserveTile slot="events" title={labels.events} description={labels.eventsReserved} />
    </div>
    <footer className="live-cockpit__status" aria-live="polite" aria-label={`${labels.systemStatus} · ${labels.systemReady} · ${labels.liveDataCurrent}`}>
      <StatusLed state="ok" label={labels.systemStatus} />
      <span>{labels.systemReady} · {labels.liveDataCurrent}</span>
    </footer>
  </div>;
};

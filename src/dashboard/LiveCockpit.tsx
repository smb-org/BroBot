import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { ChannelStreamState } from "../contracts/values";
import type { PanelChannelOverview, PanelModuleState } from "../panel-contract";
import type { BelaboxStatusResponse } from "../modules/belabox/contracts";
import { dashboardTexts, formatNumber } from "./locale";
import { useOverlaysQuery } from "./data/lists";
import { Icon, StatusLed } from "./ui";
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

export const LiveCockpit = ({ overview, modules, modulesLoaded }: {
  overview: PanelChannelOverview;
  modules: readonly PanelModuleState[];
  modulesLoaded: boolean;
}): ReactElement => {
  const texts = dashboardTexts();
  const labels = texts.liveCockpit;
  const [now, setNow] = useState(() => Date.now());
  const [belaboxStatus, setBelaboxStatus] = useState<{ data: BelaboxStatusResponse | null; failed: boolean }>({ data: null, failed: false });
  const overlaysQuery = useOverlaysQuery(overview.channelId);
  const moduleState = useMemo(() => new Map(modules.map((module) => [module.id, module.enabled])), [modules]);
  const belaboxEnabled = moduleState.get("belabox") === true;
  const streamState = overview.streamState;
  const streamLabel = streamStateLabel(streamState);
  const viewerCount = overview.viewerCount;
  const overlayCount = overlaysQuery.data?.overlays.length ?? null;
  const botConnected = overview.bot?.status === "connected";

  useEffect(() => {
    if (streamState !== "online") return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(timer); };
  }, [streamState]);

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

  return <div className="live-cockpit" data-stream-state={streamState ?? "unknown"}>
    <header className="live-cockpit-header">
      <div className="live-cockpit-header__identity">
        <h1>{overview.displayName}</h1>
        <span className={`live-cockpit-header__stream${streamState === "online" ? " is-live" : streamState === "offline" ? " is-offline" : " is-unknown"}`}>
          <span aria-hidden="true" />{streamLabel}
        </span>
      </div>
      <div className="live-cockpit-header__metrics">
        <span className="live-cockpit-header__metric"><Icon name="clock-hour-4" size={16} /><span>{labels.duration}</span><strong className="mono">{streamState === "online" ? formatDuration(overview.streamStartedAt, now) : "—"}</strong></span>
        <span className="live-cockpit-header__metric"><Icon name="member" size={16} /><span>{labels.viewers}</span><strong className="mono">{viewerCount == null ? "—" : formatNumber(viewerCount)}</strong></span>
      </div>
      <div className="live-cockpit-header__indicators" aria-label={labels.statusIndicators}>
        <StatusLed state={botConnected ? "ok" : "off"} label={`${labels.bot} · ${botConnected ? labels.botConnected : labels.botUnavailable}`} />
        <StatusLed
          state={!belaboxEnabled || belaboxStatus.data?.configured === false ? "off" : belaboxStatus.failed ? "warn" : belaboxStatus.data?.sample?.connected === true ? "ok" : "warn"}
          label={`${labels.belabox} · ${!belaboxEnabled
            ? labels.belaboxDisabled
            : belaboxStatus.data === null && !belaboxStatus.failed
              ? labels.belaboxChecking
              : belaboxStatus.failed
                ? labels.belaboxUnavailable
                : belaboxStatus.data?.configured === false
                  ? labels.belaboxNotConfigured
                  : belaboxStatus.data?.sample?.connected === true
                    ? labels.belaboxConnected(formatNumber(Math.round(belaboxStatus.data.sample.bitrateKbps)))
                    : labels.belaboxDisconnected}`}
        />
        {overlaysQuery.isPending
          ? <StatusLed state="loading" label={`${labels.overlays} · ${labels.overlaysChecking}`} />
          : overlayCount === null
            ? <StatusLed state="warn" label={`${labels.overlays} · ${labels.overlaysNotSetUp}`} />
            : <StatusLed state={overlayCount > 0 ? "ok" : "off"} label={`${labels.overlays} · ${overlayCount === 0 ? labels.overlaysNotSetUp : labels.overlaysCount(formatNumber(overlayCount))}`} />}
      </div>
    </header>
    <div className="live-cockpit__wall">
      <ImmediateActions
        channelId={overview.channelId}
        streamState={streamState}
        role={overview.role}
        modules={modules}
        modulesLoaded={modulesLoaded}
      />
      <div className="live-cockpit__reserved-grid" aria-label={labels.runningNow}>
        <ReserveTile slot="running-now" title={labels.runningNow} description={labels.runningNowReserved} />
        <ReserveTile slot="next-up" title={labels.nextUp} description={labels.nextUpReserved} />
        <ReserveTile slot="events" title={labels.events} description={labels.eventsReserved} />
        <ReserveTile slot="warnings" title={labels.warnings} description={labels.warningsReserved} />
      </div>
    </div>
    <footer className="live-cockpit__status" aria-live="polite">
      <span><StatusLed state="ok" label={texts.status.healthy} /></span>
      <span>{labels.roleLabel}: {labels.roles[overview.role]}</span>
    </footer>
  </div>;
};

import type { ModuleLanguage } from "../contract";
import type { BelaboxAlertState } from "./domain/alert";
import type { BelaboxSample } from "./contracts";
import { belaboxCatalog } from "./contracts/catalog";
import {
  belaboxDownMilliseconds,
  belaboxPresentationAlertStartedAt,
  resolvedBelaboxPhase,
} from "./domain/presentation";

const numberFormatter = (language: ModuleLanguage, maximumFractionDigits = 0): Intl.NumberFormat =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits });

const formatDuration = (milliseconds: number, language: ModuleLanguage): string => {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  if (totalSeconds < 60) {
    return language === "de"
      ? `${String(totalSeconds)} ${totalSeconds === 1 ? "Sekunde" : "Sekunden"}`
      : `${String(totalSeconds)} ${totalSeconds === 1 ? "second" : "seconds"}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return language === "de"
      ? `${String(totalMinutes)} ${totalMinutes === 1 ? "Minute" : "Minuten"}`
      : `${String(totalMinutes)} ${totalMinutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return language === "de"
    ? `${String(hours)} ${hours === 1 ? "Stunde" : "Stunden"}`
    : `${String(hours)} ${hours === 1 ? "hour" : "hours"}`;
};

export const formatTemplateValues = (
  sample: BelaboxSample,
  names: readonly string[],
  language: ModuleLanguage,
  now: number,
  classified: boolean,
  lowBitrateKbps: number,
  alertState?: BelaboxAlertState,
): Readonly<Record<string, string>> => {
  const requested = new Set(names);
  const integer = numberFormatter(language);
  const decimal = numberFormatter(language, 1);
  const phase = resolvedBelaboxPhase(sample, classified, lowBitrateKbps, alertState);
  const alertStartedAt = belaboxPresentationAlertStartedAt(sample, phase, alertState);
  const catalog = belaboxCatalog[language];
  const values: Readonly<Record<string, string>> = {
    "belabox.bitrate": `${integer.format(sample.bitrateKbps)} kbps`,
    "belabox.bitrate_mbps": `${decimal.format(sample.bitrateKbps / 1_000)} Mbit/s`,
    "belabox.rtt": `${integer.format(sample.rttMs)} ms`,
    "belabox.latency": `${integer.format(sample.latencyMs)} ms`,
    "belabox.network": integer.format(sample.network),
    "belabox.dropped": integer.format(sample.droppedTotal ?? 0),
    "belabox.connected": sample.connected ? catalog.connected : catalog.disconnected,
    "belabox.status": catalog.phases[phase],
    "belabox.down_for": formatDuration(belaboxDownMilliseconds({ ...sample, phase, alertStartedAt }, now,
      lowBitrateKbps, classified, alertState), language),
  };
  return Object.fromEntries(Object.entries(values).filter(([name]) => requested.has(name)));
};

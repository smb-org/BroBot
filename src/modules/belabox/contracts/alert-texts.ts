import type { TemplateVariable } from "../../contract";
import type { ModuleLanguage } from "../../contract";

export interface BelaboxDefaultAlertTexts {
  lowText: string;
  disconnectText: string;
  recoveryText: string;
}

const defaults: Readonly<Record<ModuleLanguage, BelaboxDefaultAlertTexts>> = {
  de: {
    lowText: "⚠️ Stream-Verbindung schwach: {belabox.bitrate}. Bin gleich wieder stabil.",
    disconnectText: "⚠️ Verbindung zum Encoder verloren – Moment bitte.",
    recoveryText: "✅ Verbindung wieder stabil ({belabox.bitrate}, {belabox.down_for} Ausfall).",
  },
  en: {
    lowText: "⚠️ Stream connection weak: {belabox.bitrate}. Hang tight.",
    disconnectText: "⚠️ Lost connection to the encoder – one moment.",
    recoveryText: "✅ Connection stable again ({belabox.bitrate}, down for {belabox.down_for}).",
  },
};

export const belaboxDefaultAlertTexts = (language: ModuleLanguage): BelaboxDefaultAlertTexts => defaults[language];

const alertTemplateVariables = {
  bitrate: {
    name: "belabox.bitrate",
    maxLength: 32,
    sample: "3,200 kbps",
    source: "module",
    picker: {
      de: { label: "BELABOX-Bitrate", description: "Aktuelle Encoder-Bitrate", sample: "3.200 kbps" },
      en: { label: "BELABOX bitrate", description: "Current encoder bitrate", sample: "3,200 kbps" },
    },
  },
  downFor: {
    name: "belabox.down_for",
    maxLength: 32,
    sample: "12 s",
    source: "module",
    picker: {
      de: { label: "BELABOX-Ausfalldauer", description: "Dauer des laufenden Alarms", sample: "12 s" },
      en: { label: "BELABOX downtime", description: "Duration of the current alert", sample: "12 s" },
    },
  },
} as const satisfies Record<string, TemplateVariable>;

const alertTemplateVariablesForMessage = [alertTemplateVariables.bitrate, alertTemplateVariables.downFor] as const;

export const BELABOX_ALERT_TEMPLATE_FIELDS = {
  lowText: alertTemplateVariablesForMessage,
  disconnectText: alertTemplateVariablesForMessage,
  recoveryText: alertTemplateVariablesForMessage,
} as const;

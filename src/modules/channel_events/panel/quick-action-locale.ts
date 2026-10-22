import type { ModuleLanguage } from "../../contract";

type BilingualCopy = Readonly<Record<ModuleLanguage, string>>;

export const streamMarkerActionTexts = {
  name: { de: "Stream-Marker setzen", en: "Set stream marker" },
  error: { de: "Der Stream-Marker konnte nicht gesetzt werden.", en: "The stream marker could not be set." },
  scopeMissing: { de: "Broadcaster-Berechtigung fehlt.", en: "Broadcaster permission is missing." },
  scopeOwnerOnly: { de: "Nur der Kanalinhaber kann diese Berechtigung erteilen.", en: "Only the channel owner can grant this permission." },
  scopeGrant: { de: "Berechtigung erteilen", en: "Grant permission" },
  scopeCheckFailed: { de: "Berechtigung konnte nicht geprüft werden.", en: "Could not check permission." },
  offline: { de: "Der Stream ist offline.", en: "The stream is offline." },
  created: (position: string) => ({
    de: `Stream-Marker bei ${position} gesetzt.`,
    en: `Stream marker set at ${position}.`,
  }),
  rateLimited: (seconds: string) => ({
    de: `Erneut in ${seconds} s`,
    en: `Retry in ${seconds} s`,
  }),
  tokenExpired: { de: "Twitch-Zugang abgelaufen. Kanal neu verbinden.", en: "Twitch access expired. Reconnect channel." },
  notBroadcaster: { de: "Dieses Twitch-Konto darf für den Kanal keinen Marker setzen.", en: "This Twitch account cannot set a marker for this channel." },
  failed: { de: "Stream-Marker konnte nicht gesetzt werden.", en: "Could not set stream marker." },
} as const satisfies Readonly<{
  name: BilingualCopy;
  error: BilingualCopy;
  scopeMissing: BilingualCopy;
  scopeOwnerOnly: BilingualCopy;
  scopeGrant: BilingualCopy;
  scopeCheckFailed: BilingualCopy;
  offline: BilingualCopy;
  created: (position: string) => BilingualCopy;
  rateLimited: (seconds: string) => BilingualCopy;
  tokenExpired: BilingualCopy;
  notBroadcaster: BilingualCopy;
  failed: BilingualCopy;
}>;

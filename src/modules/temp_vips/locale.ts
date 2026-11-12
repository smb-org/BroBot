import type { ModuleLanguage } from "../contract";

export const tempVipsChannelPointsActionTexts = {
  de: {
    name: "VIP auf Zeit vergeben",
    durationLabel: "Dauer",
    durationUnit: "Tage",
    refundReasons: {
      moduleDisabled: "Das VIP-Modul ist deaktiviert.",
      maximumExceeded: "Die angeforderte Dauer überschreitet die maximale VIP-Dauer.",
      noSlots: "Auf Twitch sind keine VIP-Plätze frei.",
      moderator: "Mods können keine VIPs sein.",
      broadcaster: "Der Broadcaster kann kein zeitlich begrenztes VIP erhalten.",
      alreadyVip: "Dieses Konto ist bereits VIP und wird nicht von BroBot verwaltet.",
      communityGate: "Der Kanal erfüllt Twitches „Build a Community“-Voraussetzung für VIPs noch nicht.",
      scopeMissing: "Die Broadcaster-Verbindung benötigt die Berechtigung channel:manage:vips.",
      invalidConfiguration: "Die Dauer für das zeitlich begrenzte VIP ist ungültig.",
      userNotFound: "Dieses Twitch-Konto wurde nicht gefunden.",
      broadcasterRequired: "Die Broadcaster-Verbindung darf keine VIPs vergeben.",
      rejected: "Twitch hat die VIP-Vergabe abgelehnt.",
    },
  },
  en: {
    name: "Grant temporary VIP",
    durationLabel: "Duration",
    durationUnit: "days",
    refundReasons: {
      moduleDisabled: "The temporary VIP module is disabled.",
      maximumExceeded: "The requested duration exceeds the maximum VIP duration.",
      noSlots: "There are no free VIP slots on Twitch.",
      moderator: "Moderators cannot be VIPs.",
      broadcaster: "The broadcaster cannot receive a temporary VIP.",
      alreadyVip: "This account is already a VIP and is not managed by BroBot.",
      communityGate: "The channel does not meet Twitch's Build a Community requirement for VIPs yet.",
      scopeMissing: "The broadcaster connection needs the channel:manage:vips permission.",
      invalidConfiguration: "The temporary VIP duration is invalid.",
      userNotFound: "This Twitch account could not be found.",
      broadcasterRequired: "The broadcaster connection is not authorized to grant VIPs.",
      rejected: "Twitch rejected the VIP grant.",
    },
  },
} satisfies Readonly<Record<ModuleLanguage, object>>;

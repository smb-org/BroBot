import type { LocaleCatalog } from "../../../dashboard/locale";
import type { ShoutoutFailureReason } from "../../../contracts/values";

interface RaidActionTexts {
  title: string;
  login: string;
  loginHint: string;
  loginRequired: string;
  send: string;
  sent: (login: string) => string;
  failed: string;
  failureReasons: Record<ShoutoutFailureReason, string>;
}

const actionCatalog: LocaleCatalog<RaidActionTexts> = {
  de: {
    title: "Shoutout",
    login: "Twitch-Name",
    loginHint: "Twitch-Name des Kanals, den du empfiehlst.",
    loginRequired: "Bitte gib einen Twitch-Namen ein.",
    send: "Shoutout senden",
    sent: (login) => `Shoutout an ${login} gesendet`,
    failed: "Der Shoutout konnte nicht gesendet werden.",
    failureReasons: {
      app_token_unavailable: "App-Token nicht verfügbar",
      bot_identity_missing: "Bot-Identität fehlt",
      network_error: "Netzwerkfehler bei Twitch",
      not_moderator: "Der Bot ist kein Moderator in diesem Kanal",
      rate_limited: "Twitch-Abklingzeit aktiv",
      scope_missing: "Berechtigung zum Senden des Shoutouts fehlt",
      timeout: "Twitch-Anfrage hat zu lange gedauert",
      twitch_error: "Twitch hat den Shoutout abgelehnt",
      twitch_user_not_found: "Twitch-Nutzer nicht gefunden",
      twitch_user_search_failed: "Twitch-Nutzersuche fehlgeschlagen",
    },
  },
  en: {
    title: "Shoutout",
    login: "Twitch login",
    loginHint: "Twitch login of the channel you're recommending.",
    loginRequired: "Enter a Twitch login.",
    send: "Send shoutout",
    sent: (login) => `Shoutout sent to ${login}`,
    failed: "The shoutout could not be sent.",
    failureReasons: {
      app_token_unavailable: "App token unavailable",
      bot_identity_missing: "Bot identity is missing",
      network_error: "Network error from Twitch",
      not_moderator: "The bot is not a moderator in this channel",
      rate_limited: "Twitch cooldown is active",
      scope_missing: "Permission to send shoutouts is missing",
      timeout: "The Twitch request timed out",
      twitch_error: "Twitch rejected the shoutout",
      twitch_user_not_found: "Twitch user not found",
      twitch_user_search_failed: "Twitch user search failed",
    },
  },
};

export const raidActionTexts = (language: "de" | "en"): RaidActionTexts => actionCatalog[language];

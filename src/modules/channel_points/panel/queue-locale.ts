import { PanelApiError } from "../../../contracts/panel-error";
import { CHANNEL_POINTS_QUEUE_ACTION_NAME } from "../contracts";

type ChannelPointsQueueLanguage = "de" | "en";

const createTexts = (language: ChannelPointsQueueLanguage) => {
  const de = language === "de";
  return {
    actionName: CHANNEL_POINTS_QUEUE_ACTION_NAME[language],
    title: de ? "Warteschlange" : "Queue",
    loading: de ? "Warteschlange wird geladen …" : "Loading queue …",
    loadFailed: de ? "Die Warteschlange konnte nicht geladen werden." : "The queue could not be loaded.",
    empty: de ? "Keine Einlösungen warten." : "No redemptions are waiting.",
    run: de ? "Ausführen" : "Run",
    refund: de ? "Erstatten" : "Refund",
    pending: de ? "Wird verarbeitet …" : "Processing …",
    count: (count: number) => de ? `${String(count)} wartend` : `${String(count)} waiting`,
    alreadyProcessed: de
      ? "Diese Einlösung wurde bereits verarbeitet."
      : "This redemption has already been processed.",
    alreadyResolvedOnTwitch: de
      ? "Diese Einlösung wurde auf Twitch bereits verarbeitet."
      : "This redemption has already been resolved on Twitch.",
    twitchStatusUnavailable: de
      ? "Der Twitch-Status konnte nicht geprüft werden. Bitte versuche es erneut."
      : "The Twitch status could not be checked. Please try again.",
    redemptionMissingOnTwitch: de
      ? "Diese Einlösung wurde auf Twitch nicht gefunden."
      : "This redemption could not be found on Twitch.",
    moduleDisabled: de ? "Kanalpunkte sind derzeit deaktiviert." : "Channel points are currently disabled.",
    operationDenied: de
      ? "Du darfst diese Einlösung nicht bedienen."
      : "You are not allowed to operate this redemption.",
    missingAuthorization: de
      ? "Die Broadcaster-Autorisierung für Kanalpunkte fehlt."
      : "Broadcaster authorization for channel points is missing.",
    missingScopes: de
      ? "Die Twitch-Berechtigung für Kanalpunkte fehlt."
      : "The Twitch channel-points permission is missing.",
    twitchUpdateFailed: de
      ? "Twitch konnte den Einlösungsstatus nicht aktualisieren."
      : "Twitch could not update the redemption status.",
    requestFailed: de
      ? "Die Anfrage ist fehlgeschlagen. Bitte versuche es erneut."
      : "The request failed. Please try again.",
  };
};

export const channelPointsQueueTexts = {
  de: createTexts("de"),
  en: createTexts("en"),
} as const;

export const channelPointsQueueErrorMessage = (error: unknown, language: ChannelPointsQueueLanguage): string => {
  const labels = channelPointsQueueTexts[language];
  if (!(error instanceof PanelApiError) || error.code === null) return labels.requestFailed;
  switch (error.code) {
    case "channel_points_redemption_not_queued": return labels.alreadyProcessed;
    case "channel_points_already_resolved_on_twitch": return labels.alreadyResolvedOnTwitch;
    case "channel_points_twitch_status_unavailable": return labels.twitchStatusUnavailable;
    case "channel_points_redemption_missing_on_twitch": return labels.redemptionMissingOnTwitch;
    case "channel_points_module_disabled": return labels.moduleDisabled;
    case "channel_points_operation_denied": return labels.operationDenied;
    case "channel_points_precondition_failed": return labels.operationDenied;
    case "channel_points_scope_missing": return labels.missingScopes;
    case "channel_points_not_connected":
    case "channel_points_token_unavailable":
    case "channel_points_revoked":
    case "channel_points_refresh_failed": return labels.missingAuthorization;
    case "channel_points_network":
    case "channel_points_invalid_response":
    case "channel_points_unknown_status":
    case "channel_points_not_found": return labels.twitchUpdateFailed;
    default: return labels.requestFailed;
  }
};

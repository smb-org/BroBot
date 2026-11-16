import type { SongRequestsRoleThreshold } from "./contracts";

type Language = "de" | "en";

const roleName = (threshold: SongRequestsRoleThreshold, language: Language): string => {
  const names: Record<SongRequestsRoleThreshold, Record<Language, string>> = {
    everyone: { de: "alle", en: "everyone" },
    subscriber: { de: "Abonnenten", en: "subscribers" },
    vip: { de: "VIPs", en: "VIPs" },
    moderator: { de: "Moderatoren", en: "moderators" },
  };
  return names[threshold][language];
};

export const songRequestChatTexts = {
  de: {
    usage: "Verwendung: !sr <Song, Spotify-Link oder URI>.",
    offline: "Song-Wünsche sind offline deaktiviert.",
    spotifySlot: "Spotify ist für diesen Kanal nicht freigeschaltet.",
    spotifyNotConnected: "Spotify ist nicht verbunden. Bitte den Kanalinhaber informieren.",
    spotifyReconnect: "Die Spotify-Verbindung muss erneuert werden.",
    spotifyDevice: "Spotify hat kein aktives Wiedergabegerät. Starte Spotify auf einem Gerät.",
    spotifyUnavailable: "Spotify ist gerade nicht erreichbar. Bitte versuche es später erneut.",
    noTrack: "Diesen Song konnte Spotify nicht finden.",
    pointsDisabled: "Song-Wünsche mit Bot-Punkten sind nicht verfügbar, weil das Punkte-Modul deaktiviert ist.",
    roleRequired: (threshold: SongRequestsRoleThreshold) => `Kostenlose Song-Wünsche sind für ${roleName(threshold, "de")} verfügbar.`,
    insufficientPoints: "Du hast nicht genug Bot-Punkte für diesen Song-Wunsch.",
    waitingReview: (position: number) => `Song-Wunsch angenommen. Position ${String(position)} in BroBots Liste; wartet auf Moderation.`,
    accepted: (position: number) => `Song-Wunsch angenommen. Position ${String(position)} in BroBots Liste.`,
    alreadyRequested: (position: number) => `Bereits angefragt, Position ${String(position)}.`,
    rejected: (reason: string) => `Song-Wunsch abgelehnt: ${reason}.`,
    reasons: {
      explicit_not_allowed: "explizite Songs sind nicht erlaubt",
      track_too_long: "der Song ist zu lang",
      track_blocked: "der Song steht auf der Sperrliste",
      artist_blocked: "der Künstler steht auf der Sperrliste",
      song_cooldown: "der Song ist noch in der Abklingzeit",
      person_cooldown: "du musst vor deinem nächsten Wunsch noch warten",
      person_open_limit: "du hast bereits zu viele offene Wünsche",
      person_round_limit: "du hast dein Limit für diese Runde erreicht",
      channel_open_limit: "BroBots Liste ist voll",
      artist_open_limit: "für diesen Künstler ist die Liste voll",
      request_unavailable: "die Anfrage ist gerade nicht verfügbar",
    } as const,
  },
  en: {
    usage: "Usage: !sr <song, Spotify link, or URI>.",
    offline: "Song requests are disabled while the stream is offline.",
    spotifySlot: "Spotify is not enabled for this channel.",
    spotifyNotConnected: "Spotify is not connected. Please tell the channel owner.",
    spotifyReconnect: "The Spotify connection needs to be renewed.",
    spotifyDevice: "Spotify has no active playback device. Start Spotify on a device.",
    spotifyUnavailable: "Spotify is unavailable right now. Please try again later.",
    noTrack: "Spotify could not find that track.",
    pointsDisabled: "Bot point song requests are unavailable because the points module is disabled.",
    roleRequired: (threshold: SongRequestsRoleThreshold) => `Free song requests are available to ${roleName(threshold, "en")}.`,
    insufficientPoints: "You do not have enough bot points for this song request.",
    waitingReview: (position: number) => `Song request accepted at position ${String(position)} in BroBot's list; waiting for a moderator.`,
    accepted: (position: number) => `Song request accepted at position ${String(position)} in BroBot's list.`,
    alreadyRequested: (position: number) => `Already requested, position ${String(position)}.`,
    rejected: (reason: string) => `Song request rejected: ${reason}.`,
    reasons: {
      explicit_not_allowed: "explicit tracks are not allowed",
      track_too_long: "the track is too long",
      track_blocked: "the track is blocked",
      artist_blocked: "the artist is blocked",
      song_cooldown: "the track is still on cooldown",
      person_cooldown: "wait before making another request",
      person_open_limit: "you already have too many open requests",
      person_round_limit: "you have reached your limit for this round",
      channel_open_limit: "BroBot's list is full",
      artist_open_limit: "the list is full for this artist",
      request_unavailable: "the request is not available right now",
    } as const,
  },
} as const;

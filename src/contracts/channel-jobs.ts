export const CHANNEL_JOB_ERROR_TEXTS = {
  de: {
    refresh_failed: "Die Twitch-Anmeldung ist abgelaufen. Bitte verbinde den Kanal erneut.",
    missing_scope: "Eine benötigte Twitch-Berechtigung fehlt. Bitte verbinde den Kanal erneut.",
    lease_expired: "Der Lauf wurde unterbrochen und von einem neuen Lauf übernommen.",
    unknown: "Die Aufgabe ist fehlgeschlagen. Sie wird automatisch erneut versucht.",
  },
  en: {
    refresh_failed: "The Twitch sign-in expired. Reconnect the channel to continue.",
    missing_scope: "A required Twitch permission is missing. Reconnect the channel to continue.",
    lease_expired: "The run was interrupted and taken over by a new run.",
    unknown: "The job failed. It will be retried automatically.",
  },
} as const;

export type ChannelJobErrorCode = keyof typeof CHANNEL_JOB_ERROR_TEXTS.en;

/** Short localized result text a job handler returns as `{ summary }`. */
export type ChannelJobSummary = Readonly<Record<"de" | "en", string>>;

export class ChannelJobError extends Error {
  public readonly code: ChannelJobErrorCode;

  public constructor(code: ChannelJobErrorCode) {
    super(code);
    this.name = "ChannelJobError";
    this.code = code;
  }
}

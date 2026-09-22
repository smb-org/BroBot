/**
 * These pages are reached by direct browser navigation (a Twitch redirect,
 * an `<a href>` in the dashboard) rather than by a `fetch` the dashboard's
 * own error catalogue in `dashboard/locale.ts` can translate -- there is no
 * script in between to read a `{ "error": "<code>" }` body. The browser
 * shows this text as the page itself, so it stays prose, bilingual by the
 * request's own `Accept-Language` instead of the panel's language state.
 *
 * This file is its own bilingual catalogue for exactly that reason -- same
 * as `dashboard/locale.ts` -- and is allowlisted in the German guard
 * (`tests/unit/german-guard.test.ts`) on that basis.
 */
export const OAUTH_ERROR_TEXTS = {
  oauth_state_missing: { de: "OAuth-State fehlt.", en: "OAuth state is missing." },
  oauth_state_invalid: { de: "OAuth-State ist ungültig oder abgelaufen.", en: "OAuth state is invalid or expired." },
  oauth_transaction_invalid: {
    de: "OAuth-Transaktion ist ungültig oder wurde bereits verwendet.",
    en: "The OAuth transaction is invalid or was already used.",
  },
  authorization_denied: { de: "Twitch-Autorisierung wurde abgelehnt.", en: "Twitch authorization was declined." },
  oauth_code_missing: { de: "OAuth-Code fehlt.", en: "OAuth code is missing." },
  identity_user_mismatch: {
    de: "Die Twitch-Identität gehört nicht zum Kanalinhaber.",
    en: "This Twitch identity does not belong to the channel owner.",
  },
  bot_login_mismatch: {
    de: "Der Twitch-Login gehört nicht zum konfigurierten Bot.",
    en: "This Twitch login does not belong to the configured bot.",
  },
  bot_identity_mismatch: {
    de: "Der Twitch-Login gehört nicht zur hinterlegten Bot-Identität.",
    en: "This Twitch login does not belong to the stored bot identity.",
  },
  full_consent_second_attempt_incomplete: {
    de: "Die vollständige Zustimmung für diesen Kanal wurde nicht erteilt.",
    en: "Full consent for this channel was not granted.",
  },
  code_exchange_rejected: {
    de: "Twitch-Code-Tausch wurde abgelehnt.",
    en: "The Twitch code exchange was rejected.",
  },
  callback_failed: {
    de: "Twitch-Autorisierung konnte nicht abgeschlossen werden.",
    en: "Twitch authorization could not be completed.",
  },
  channel_owner_only_consent_request: {
    de: "Nur der Kanalinhaber darf diese Zustimmung nachfordern.",
    en: "Only the channel owner can re-request this consent.",
  },
  channel_owner_only_scope_grant: {
    de: "Nur der Kanalinhaber darf diese Zustimmung erteilen.",
    en: "Only the channel owner can grant this consent.",
  },
  module_not_found: { de: "Modul nicht gefunden.", en: "Module not found." },
} as const;

export type OAuthErrorKey = keyof typeof OAUTH_ERROR_TEXTS;

export const requestLanguage = (request: Request): "de" | "en" =>
  /\ben\b/i.test((request.headers.get("Accept-Language") ?? "").split(",")[0] ?? "") ? "en" : "de";

export const oauthError = (
  context: { req: { raw: Request }; text: (body: string, status: 400 | 403 | 404 | 502) => Response },
  key: OAuthErrorKey,
  status: 400 | 403 | 404 | 502 = 400,
): Response => context.text(OAUTH_ERROR_TEXTS[key][requestLanguage(context.req.raw)], status);

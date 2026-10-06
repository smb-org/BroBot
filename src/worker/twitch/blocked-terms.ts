import { z } from "zod";

import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "../auth/crypto";
import { getBotIdentity } from "../db/bot-identity";
import { helixPages, helixRequest } from "./helix";

const BLOCKED_TERMS_URL = "https://api.twitch.tv/helix/moderation/blocked_terms";
const BLOCKED_TERMS_SCOPES = ["moderator:read:blocked_terms", "moderator:manage:blocked_terms"] as const;
const MAX_BLOCKED_TERMS = 1_000;
const MAX_BLOCKED_FILTER_BYTES = 64 * 1024;

const blockedTermsPageSchema = z.object({
  data: z.array(z.object({ text: z.string().max(500) })).max(100),
  pagination: z.object({ cursor: z.string().max(512).optional() }).optional(),
});

export interface BlockedTermsEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
}

/** Reads the bot moderator's current public blocked-term list; failure returns null. */
export const readChannelBlockedTerms = async (
  environment: BlockedTermsEnvironment,
  channelId: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly string[] | null> => {
  try {
    const identity = await getBotIdentity(environment.DB);
    if (identity === null) return null;
    const grantedScopes: unknown = JSON.parse(identity.scopesJson);
    if (!Array.isArray(grantedScopes) || !BLOCKED_TERMS_SCOPES.some((scope) => grantedScopes.includes(scope))) return null;
    const tokenData = await decryptJson<{ token?: unknown }>(
      identity.accessTokenCiphertext,
      parseKeyRing(getTokenEncryptionKeys(environment)),
    );
    if (tokenData === null || typeof tokenData.token !== "string" || tokenData.token.length === 0) return null;

    const result = await helixPages<{ text: string }>(async (cursor) => {
      const page = await helixRequest({
        url: BLOCKED_TERMS_URL,
        query: {
          broadcaster_id: channelId,
          moderator_id: identity.userId,
          first: "100",
          after: cursor ?? undefined,
        },
        accessToken: tokenData.token as string,
        clientId: environment.TWITCH_CLIENT_ID,
        schema: blockedTermsPageSchema,
        fetcher,
      });
      if (!page.ok) return page;
      const nextCursor = page.data.pagination?.cursor;
      return {
        ok: true,
        status: page.status,
        data: {
          data: page.data.data,
          ...(nextCursor === undefined ? {} : { pagination: { cursor: nextCursor } }),
        },
      };
    });
    if (!result.ok || result.data.length > MAX_BLOCKED_TERMS) return null;
    const terms = result.data.map(({ text }) => text);
    return new TextEncoder().encode(JSON.stringify(terms)).byteLength <= MAX_BLOCKED_FILTER_BYTES ? terms : null;
  } catch {
    return null;
  }
};

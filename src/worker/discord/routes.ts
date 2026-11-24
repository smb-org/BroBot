import { Hono } from "hono";

import { createCsrfToken, verifyCsrfToken } from "../auth/csrf";
import { readCookieValue } from "../auth/session";
import {
  beginDiscordOAuth,
  clearDiscordCsrfCookie,
  clearDiscordOAuthStateCookie,
  clearDiscordViewerSessionCookie,
  consumeDiscordOAuthTransaction,
  createDiscordViewerSession,
  discordCsrfCookie,
  discordOAuthStateCookie,
  DISCORD_CSRF_COOKIE,
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_VIEWER_COOKIE,
  readDiscordViewerSession,
  serializeDiscordViewerSession,
  verifyDiscordOAuthState,
} from "../auth/discord-oauth";
import { exchangeDiscordCode, fetchDiscordConnections, fetchDiscordUser, verifiedTwitchConnection } from "../../modules/discord/adapters/discord";
import { getDiscordLink, removeDiscordLink, replaceDiscordLink } from "../../modules/discord/repository";
import { DISCORD_LINK_PAGE_PATH } from "../../modules/discord/contracts";

export const discordRouter = new Hono<{ Bindings: Env }>();

const nowIso = (): string => new Date().toISOString();
const pageLocation = (environment: Env, state?: string): string => {
  const url = new URL(DISCORD_LINK_PAGE_PATH, environment.PUBLIC_ORIGIN);
  if (state !== undefined) url.searchParams.set("discord", state);
  return url.toString();
};
const isConfigured = (environment: Env): boolean =>
  typeof environment.DISCORD_CLIENT_ID === "string" && environment.DISCORD_CLIENT_ID.length > 0 &&
  typeof environment.DISCORD_CLIENT_SECRET === "string" && environment.DISCORD_CLIENT_SECRET.length > 0;
const withNoStore = (context: { header: (name: string, value: string) => unknown }): void => {
  context.header("Cache-Control", "no-store");
};

discordRouter.get("/auth/discord", async (context) => {
  withNoStore(context);
  if (!isConfigured(context.env)) return context.redirect(pageLocation(context.env, "unavailable"), 302);
  try {
    const redirectUri = new URL("/auth/discord/callback", context.env.PUBLIC_ORIGIN).toString();
    const transaction = await beginDiscordOAuth(context.env.DB, context.env, redirectUri, nowIso());
    context.header("Set-Cookie", discordOAuthStateCookie(transaction.stateNonce));
    return context.redirect(transaction.authorizationUrl, 302);
  } catch {
    return context.redirect(pageLocation(context.env, "unavailable"), 302);
  }
});

discordRouter.get("/auth/discord/callback", async (context) => {
  withNoStore(context);
  const clearStateCookie = (): void => {
    context.header("Set-Cookie", clearDiscordOAuthStateCookie(), { append: true });
  };
  const serializedState = context.req.query("state");
  const now = nowIso();
  const cookieNonce = readCookieValue(context.req.raw.headers.get("Cookie"), DISCORD_OAUTH_STATE_COOKIE);
  if (serializedState === undefined) {
    clearStateCookie();
    return context.json({ error: "discord_oauth_state_missing" }, 400);
  }
  const state = await verifyDiscordOAuthState(serializedState, cookieNonce, context.env.SESSION_COOKIE_KEYS, now);
  clearStateCookie();
  if (state === null) return context.json({ error: "discord_oauth_state_invalid" }, 400);
  if (!await consumeDiscordOAuthTransaction(context.env.DB, state, now)) {
    return context.json({ error: "discord_oauth_transaction_invalid" }, 400);
  }
  if (context.req.query("error") !== undefined) return context.redirect(pageLocation(context.env, "error"), 302);
  const code = context.req.query("code");
  if (code === undefined || code.length === 0) return context.json({ error: "discord_oauth_code_missing" }, 400);
  if (!isConfigured(context.env)) return context.redirect(pageLocation(context.env, "unavailable"), 302);

  try {
    const redirectUri = new URL("/auth/discord/callback", context.env.PUBLIC_ORIGIN).toString();
    const token = await exchangeDiscordCode(context.env, redirectUri, code);
    const [user, connections] = await Promise.all([
      fetchDiscordUser(context.env, token.access_token),
      fetchDiscordConnections(context.env, token.access_token),
    ]);
    const twitch = verifiedTwitchConnection(connections);
    if (twitch === null) return context.redirect(pageLocation(context.env, "no-twitch"), 302);

    const linkedAt = nowIso();
    await replaceDiscordLink(context.env.DB, {
      discordUserId: user.id,
      twitchUserId: twitch.twitchUserId,
      discordUsername: user.username,
      twitchLogin: twitch.twitchLogin,
      linkedAt,
      verifiedAt: linkedAt,
    });
    const viewer = createDiscordViewerSession(user.id, linkedAt);
    const viewerCookie = await serializeDiscordViewerSession(viewer, context.env.SESSION_COOKIE_KEYS);
    const csrfToken = await createCsrfToken(viewer.sessionId, context.env.SESSION_COOKIE_KEYS, linkedAt);
    context.header("Set-Cookie", viewerCookie, { append: true });
    context.header("Set-Cookie", discordCsrfCookie(csrfToken), { append: true });
    return context.redirect(pageLocation(context.env, "linked"), 302);
  } catch {
    return context.redirect(pageLocation(context.env, "error"), 302);
  }
});

discordRouter.get("/api/discord/link", async (context) => {
  withNoStore(context);
  if (!isConfigured(context.env)) {
    return context.json({ configured: false, signedIn: false, link: null });
  }
  const now = nowIso();
  const viewer = await readDiscordViewerSession(
    readCookieValue(context.req.raw.headers.get("Cookie"), DISCORD_VIEWER_COOKIE),
    context.env.SESSION_COOKIE_KEYS,
    now,
  );
  if (viewer === null) {
    context.header("Set-Cookie", clearDiscordViewerSessionCookie());
    context.header("Set-Cookie", clearDiscordCsrfCookie(), { append: true });
    return context.json({ configured: true, signedIn: false, link: null });
  }
  const link = await getDiscordLink(context.env.DB, viewer.discordUserId);
  if (link === null) {
    context.header("Set-Cookie", clearDiscordViewerSessionCookie());
    context.header("Set-Cookie", clearDiscordCsrfCookie(), { append: true });
    return context.json({ configured: true, signedIn: false, link: null });
  }
  const existingCsrfToken = readCookieValue(context.req.raw.headers.get("Cookie"), DISCORD_CSRF_COOKIE);
  const csrfToken = existingCsrfToken !== null && await verifyCsrfToken(
    existingCsrfToken,
    viewer.sessionId,
    context.env.SESSION_COOKIE_KEYS,
    now,
  )
    ? existingCsrfToken
    : await createCsrfToken(viewer.sessionId, context.env.SESSION_COOKIE_KEYS, now);
  context.header("Set-Cookie", discordCsrfCookie(csrfToken));
  return context.json({
    configured: true,
    signedIn: true,
    csrfToken,
    link: {
      discordUsername: link.discordUsername,
      twitchLogin: link.twitchLogin,
      linkedAt: link.linkedAt,
    },
  });
});

discordRouter.post("/api/discord/unlink", async (context) => {
  withNoStore(context);
  const origin = context.req.header("Origin");
  if (origin === undefined || origin !== new URL(context.env.PUBLIC_ORIGIN).origin) {
    return context.json({ error: "discord_origin_invalid" }, 403);
  }
  const now = nowIso();
  const viewer = await readDiscordViewerSession(
    readCookieValue(context.req.raw.headers.get("Cookie"), DISCORD_VIEWER_COOKIE),
    context.env.SESSION_COOKIE_KEYS,
    now,
  );
  if (viewer === null) return context.json({ error: "discord_viewer_session_missing" }, 401);
  const headerToken = context.req.header("X-CSRF-Token") ?? null;
  const cookieToken = readCookieValue(context.req.raw.headers.get("Cookie"), DISCORD_CSRF_COOKIE);
  if (headerToken === null || cookieToken === null || headerToken !== cookieToken ||
      !await verifyCsrfToken(headerToken, viewer.sessionId, context.env.SESSION_COOKIE_KEYS, now)) {
    return context.json({ error: "csrf_invalid" }, 403);
  }
  await removeDiscordLink(context.env.DB, viewer.discordUserId);
  context.header("Set-Cookie", clearDiscordViewerSessionCookie());
  context.header("Set-Cookie", clearDiscordCsrfCookie(), { append: true });
  return context.body(null, 204);
});

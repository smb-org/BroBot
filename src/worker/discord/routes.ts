import { Hono } from "hono";

import { canManage } from "../../contracts/values";
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
import {
  clearDiscordServerOAuthStateCookie,
  consumeDiscordServerOAuthTransaction,
  DISCORD_SERVER_OAUTH_STATE_COOKIE,
  verifyDiscordServerOAuthState,
} from "../auth/discord-server-oauth";
import { getSessionFromRequest } from "../auth/session-access";
import { getChannelMemberForChannel } from "../db/channel-members";
import { authorizeModuleManagementMutation } from "../module-authorization";
import {
  exchangeDiscordCode,
  exchangeDiscordServerCode,
  fetchDiscordConnections,
  fetchDiscordUser,
  verifiedTwitchConnection,
} from "../../modules/discord/adapters/discord";
import {
  connectDiscordServer,
  getDiscordLink,
  removeDiscordLink,
  replaceDiscordLink,
  listDiscordConnectedChannels,
} from "../../modules/discord/repository";
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
const isServerConfigured = (environment: Env): boolean => isConfigured(environment) &&
  typeof environment.DISCORD_BOT_TOKEN === "string" && environment.DISCORD_BOT_TOKEN.length > 0;
const withNoStore = (context: { header: (name: string, value: string) => unknown }): void => {
  context.header("Cache-Control", "no-store");
};
const serverDashboardLocation = (environment: Env, channelId: string, state?: string): string => {
  const url = new URL(`/channels/${encodeURIComponent(channelId)}/modules/discord`, environment.PUBLIC_ORIGIN);
  if (state !== undefined) url.searchParams.set("discord", state);
  return url.toString();
};

interface DiscordChannelObjectRpc {
  beginDiscordReconcileMutation: (blockDuringCleanup?: boolean) => Promise<string | null>;
  endDiscordReconcileMutation: (token: string) => Promise<void>;
  discordChannelState: () => Promise<{ teardown: boolean; disconnecting: boolean }>;
  discordMemberRoleStatus: (discordUserId: string, twitchUserId: string) => Promise<"has_role" | "pending" | "not_in_server" | "no_rank" | "locked" | "unknown">;
}

const withConnectedDiscordReconcileBarrier = async <Result>(environment: Env, mutation: () => Promise<Result>): Promise<Result> => {
  const channels = await listDiscordConnectedChannels(environment.DB);
  if (channels.length === 0) return await mutation();
  const started: Array<{ object: DiscordChannelObjectRpc; token: string }> = [];
  try {
    for (const { channelId } of channels) {
      const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId)) as unknown as DiscordChannelObjectRpc;
      const token = await object.beginDiscordReconcileMutation(false);
      if (token === null) throw new Error("Discord reconciliation is already being changed.");
      started.push({ object, token });
    }
  } catch (error) {
    await Promise.all(started.map(async ({ object, token }) => await object.endDiscordReconcileMutation(token).catch(() => undefined)));
    throw error;
  }
  try {
    return await mutation();
  } finally {
    await Promise.all(started.map(async ({ object, token }) => await object.endDiscordReconcileMutation(token).catch(() => undefined)));
  }
};

const channelStatusWithinLimit = async (
  environment: Env,
  channelId: string,
  discordUserId: string,
  twitchUserId: string,
): Promise<"has_role" | "pending" | "not_in_server" | "no_rank" | "locked" | "unknown"> => {
  const object = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId)) as unknown as DiscordChannelObjectRpc;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      object.discordMemberRoleStatus(discordUserId, twitchUserId),
      new Promise<"unknown">((resolve) => { timeout = setTimeout(() => { resolve("unknown"); }, 3_000); }),
    ]);
  } catch {
    return "unknown";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
  // A failed relink must not leave a previously linked viewer signed in.
  const clearViewerCookies = (): void => {
    context.header("Set-Cookie", clearDiscordViewerSessionCookie(), { append: true });
    context.header("Set-Cookie", clearDiscordCsrfCookie(), { append: true });
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
    if (twitch === null) {
      clearViewerCookies();
      return context.redirect(pageLocation(context.env, "no-twitch"), 302);
    }

    const linkedAt = nowIso();
    await withConnectedDiscordReconcileBarrier(context.env, async () => await replaceDiscordLink(context.env.DB, {
      discordUserId: user.id,
      twitchUserId: twitch.twitchUserId,
      discordUsername: user.username,
      twitchLogin: twitch.twitchLogin,
      linkedAt,
      verifiedAt: linkedAt,
    }));
    const viewer = createDiscordViewerSession(user.id, linkedAt);
    const viewerCookie = await serializeDiscordViewerSession(viewer, context.env.SESSION_COOKIE_KEYS);
    const csrfToken = await createCsrfToken(viewer.sessionId, context.env.SESSION_COOKIE_KEYS, linkedAt);
    context.header("Set-Cookie", viewerCookie, { append: true });
    context.header("Set-Cookie", discordCsrfCookie(csrfToken), { append: true });
    return context.redirect(pageLocation(context.env, "linked"), 302);
  } catch {
    clearViewerCookies();
    return context.redirect(pageLocation(context.env, "error"), 302);
  }
});

discordRouter.get("/auth/discord/server/callback", async (context) => {
  withNoStore(context);
  const clearStateCookie = (): void => {
    context.header("Set-Cookie", clearDiscordServerOAuthStateCookie());
  };
  const serializedState = context.req.query("state");
  const now = nowIso();
  const cookieNonce = readCookieValue(context.req.raw.headers.get("Cookie"), DISCORD_SERVER_OAUTH_STATE_COOKIE);
  if (serializedState === undefined) {
    clearStateCookie();
    return context.json({ error: "discord_server_oauth_state_missing" }, 400);
  }
  const state = await verifyDiscordServerOAuthState(serializedState, cookieNonce, context.env.SESSION_COOKIE_KEYS, now);
  clearStateCookie();
  if (state === null) return context.json({ error: "discord_server_oauth_state_invalid" }, 400);
  const transaction = await consumeDiscordServerOAuthTransaction(context.env.DB, state, now);
  if (transaction === null) return context.json({ error: "discord_server_oauth_transaction_invalid" }, 400);
  if (context.req.query("error") !== undefined) {
    return context.redirect(serverDashboardLocation(context.env, transaction.channelId, "error"), 302);
  }
  const code = context.req.query("code");
  if (code === undefined || code.length === 0) return context.json({ error: "discord_server_oauth_code_missing" }, 400);

  const session = await getSessionFromRequest(context.req.raw, context.env);
  if (session === null || session.userId !== transaction.memberUserId) {
    return context.json({ error: "discord_server_oauth_member_mismatch" }, 403);
  }
  const member = await getChannelMemberForChannel(context.env.DB, transaction.channelId, session.userId);
  if (member === null || !canManage(member.role)) {
    return context.json({ error: "discord_server_oauth_channel_access_denied" }, 403);
  }
  if (!isServerConfigured(context.env)) {
    return context.redirect(serverDashboardLocation(context.env, transaction.channelId, "unavailable"), 302);
  }

  try {
    const redirectUri = new URL("/auth/discord/server/callback", context.env.PUBLIC_ORIGIN).toString();
    const token = await exchangeDiscordServerCode(context.env, redirectUri, code);
    const connectedAt = nowIso();
    const authorization = authorizeModuleManagementMutation(transaction.channelId, {
      userId: session.userId,
      sessionId: session.sessionId,
    }, connectedAt);
    let result: Awaited<ReturnType<typeof connectDiscordServer>>;
    const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(transaction.channelId)) as unknown as DiscordChannelObjectRpc;
    const state = await object.discordChannelState();
    if (state.teardown || state.disconnecting) {
      return context.redirect(serverDashboardLocation(context.env, transaction.channelId, "server-changed"), 302);
    }
    const mutationToken = await object.beginDiscordReconcileMutation();
    if (mutationToken === null) return context.redirect(serverDashboardLocation(context.env, transaction.channelId, "server-changed"), 302);
    try {
      result = await connectDiscordServer(context.env.DB, {
        channelId: transaction.channelId,
        guildId: token.guildId,
        connectedAt,
        connectedBy: session.userId,
      }, authorization);
    } finally {
      await object.endDiscordReconcileMutation(mutationToken);
    }
    return context.redirect(serverDashboardLocation(
      context.env,
      transaction.channelId,
      result === "connected" ? "connected" : result === "already_connected" ? "already-connected" : result === "different_guild" ? "server-changed" : "error",
    ), 302);
  } catch {
    return context.redirect(serverDashboardLocation(context.env, transaction.channelId, "error"), 302);
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
  const connectedChannels = await listDiscordConnectedChannels(context.env.DB);
  const channels = await Promise.all(connectedChannels.map(async ({ channelId, displayName }) => ({
    channelId,
    displayName,
    status: await channelStatusWithinLimit(context.env, channelId, link.discordUserId, link.twitchUserId),
  })));
  return context.json({
    configured: true,
    signedIn: true,
    csrfToken,
    link: {
      discordUsername: link.discordUsername,
      twitchLogin: link.twitchLogin,
      linkedAt: link.linkedAt,
    },
    channels,
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
  await withConnectedDiscordReconcileBarrier(context.env, async () => await removeDiscordLink(context.env.DB, viewer.discordUserId));
  context.header("Set-Cookie", clearDiscordViewerSessionCookie());
  context.header("Set-Cookie", clearDiscordCsrfCookie(), { append: true });
  return context.body(null, 204);
});

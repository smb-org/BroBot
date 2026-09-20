import { MODULES } from "../modules/registry";
import { getAppAccessToken } from "./app-token";
import { parseKeyRing } from "./auth/crypto";
import {
  channelBotConsentCondition,
  getBotIdentity,
  getBotIdentityStatus,
  listEventSubSubscriptions,
  type EventSubSubscriptionStatus,
  upsertEventSubSubscription,
} from "./auth/repository";
import { TwitchApiError } from "./bot-maintenance";

export const EVENTSUB_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
export const EVENTSUB_CALLBACK_PATH = "/api/twitch/eventsub";
export const EVENTSUB_REQUEST_TIMEOUT_MS = 5_000;

export interface EventSubTarget {
  channelId: string;
  subscriptionType: string;
  version: string;
}

interface EventSubTargetRow {
  channel_id: string;
  module_id: string;
}

interface EventSubRemoteSubscription {
  id: string;
  type: string;
  version: string;
  status: string;
  condition: Record<string, unknown>;
  transport: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const responseJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
};

const fetchWithTimeout = async (
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TwitchApiError("Die EventSub-Abfrage hat das Zeitlimit überschritten.", 504, "timeout"));
    }, EVENTSUB_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetcher(input, { ...init, signal: controller.signal }), timeout]);
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new TwitchApiError("Die EventSub-Abfrage hat das Zeitlimit überschritten.", 504, "timeout");
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const requestEventSubApi = async (
  fetcher: typeof fetch,
  appAccessToken: string,
  clientId: string,
  // Bewusst enger als `RequestInfo`: Ein `Request` hat keine brauchbare
  // Zeichenkettenform und landete als `[object Object]` in der Adresse.
  input: string | URL,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> => {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("Client-ID", clientId);
    headers.set("Authorization", `Bearer ${appAccessToken}`);
    response = await fetchWithTimeout(fetcher, input.toString(), {
      ...init,
      headers,
    });
  } catch (error: unknown) {
    if (error instanceof TwitchApiError) throw error;
    throw new TwitchApiError("Twitch EventSub ist nicht erreichbar.", 503, "network_error");
  }
  const body = await responseJson(response);
  if (!response.ok) {
    const code = response.status === 429
      ? "rate_limited"
      : typeof body.error === "string" && body.error.length > 0 ? body.error : `http_${String(response.status)}`;
    throw new TwitchApiError(
      typeof body.message === "string" && body.message.length > 0
        ? body.message
        : "Twitch EventSub hat die Anfrage abgelehnt.",
      response.status,
      code,
    );
  }
  return { response, body };
};

/** Ermittelt den Sollstand ausschließlich aus aktivierten Modulen und Zustimmung. */
export const listDesiredEventSubTargets = async (
  db: D1Database,
  channelId?: string,
): Promise<EventSubTarget[]> => {
  const query = `SELECT channel.channel_id, channel_modules.module_id
       FROM channels AS channel
       JOIN channel_modules ON channel_modules.channel_id = channel.channel_id
        AND channel_modules.enabled = 1
      WHERE ${channelBotConsentCondition("channel")}
        ${channelId === undefined ? "" : "AND channel.channel_id = ?"}
      ORDER BY channel.channel_id, channel_modules.module_id`;
  const result = channelId === undefined
    ? await db.prepare(query).all<EventSubTargetRow>()
    : await db.prepare(query).bind(channelId).all<EventSubTargetRow>();
  const modules = new Map(MODULES.map((module) => [module.id, module]));
  const targets = new Map<string, EventSubTarget>();
  for (const row of result.results) {
    const module = modules.get(row.module_id);
    for (const subscriptionType of module?.eventSubTypes ?? []) {
      const target: EventSubTarget = {
        channelId: row.channel_id,
        subscriptionType,
        version: "1",
      };
      targets.set(`${target.channelId}\u0000${target.subscriptionType}`, target);
    }
  }
  return [...targets.values()];
};

const parseRemoteSubscription = (value: unknown): EventSubRemoteSubscription | null => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 ||
      typeof value.type !== "string" || typeof value.version !== "string" ||
      typeof value.status !== "string" || !isRecord(value.condition) || !isRecord(value.transport)) return null;
  return {
    id: value.id,
    type: value.type,
    version: value.version,
    status: value.status,
    condition: value.condition,
    transport: value.transport,
  };
};

export const fetchEventSubSubscriptions = async (
  fetcher: typeof fetch,
  clientId: string,
  appAccessToken: string,
): Promise<EventSubRemoteSubscription[]> => {
  const subscriptions: EventSubRemoteSubscription[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const url = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
    url.searchParams.set("first", "100");
    if (cursor !== null) url.searchParams.set("after", cursor);
    const { body } = await requestEventSubApi(fetcher, appAccessToken, clientId, url);
    if (!Array.isArray(body.data)) {
      throw new TwitchApiError("Twitch EventSub lieferte keine Aboliste.", 502, "invalid_response");
    }
    for (const value of body.data) {
      const subscription = parseRemoteSubscription(value);
      if (subscription === null) {
        throw new TwitchApiError("Twitch EventSub lieferte ein ungültiges Abo.", 502, "invalid_response");
      }
      subscriptions.push(subscription);
    }
    const pagination = body.pagination;
    const next = isRecord(pagination) && typeof pagination.cursor === "string" && pagination.cursor.length > 0
      ? pagination.cursor
      : null;
    if (next === null) return subscriptions;
    if (seenCursors.has(next)) throw new TwitchApiError("Twitch liefert einen wiederholten Pagination-Cursor.", 502, "pagination_loop");
    seenCursors.add(next);
    cursor = next;
  }
};

const callbackUrl = (publicOrigin: string): string => `${publicOrigin}${EVENTSUB_CALLBACK_PATH}`;

const isOwnedByTarget = (
  subscription: EventSubRemoteSubscription,
  target: EventSubTarget,
  botUserId: string,
  expectedCallback: string,
): boolean => subscription.type === target.subscriptionType &&
  subscription.version === target.version &&
  subscription.condition.broadcaster_user_id === target.channelId &&
  subscription.condition.user_id === botUserId &&
  subscription.transport.method === "webhook" &&
  subscription.transport.callback === expectedCallback;

const reasonFor = (error: unknown): string =>
  error instanceof TwitchApiError && error.code !== null ? error.code : "maintenance_failed";

const mark = async (
  db: D1Database,
  target: EventSubTarget,
  status: EventSubSubscriptionStatus,
  reason: string | null,
  subscriptionId: string | null,
  now: string,
  secretId: string | null = null,
): Promise<void> => {
  await upsertEventSubSubscription(db, {
    channelId: target.channelId,
    subscriptionType: target.subscriptionType,
    subscriptionId,
    secretId,
    status,
    reason,
    updatedAt: now,
  });
};

const createSubscription = async (
  env: Env,
  target: EventSubTarget,
  botUserId: string,
  appAccessToken: string,
  fetcher: typeof fetch,
): Promise<EventSubRemoteSubscription> => {
  const ring = parseKeyRing(env.TWITCH_EVENTSUB_SECRET);
  const { body } = await requestEventSubApi(
    fetcher,
    appAccessToken,
    env.TWITCH_CLIENT_ID,
    EVENTSUB_SUBSCRIPTIONS_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: target.subscriptionType,
        version: target.version,
        condition: { broadcaster_user_id: target.channelId, user_id: botUserId },
        transport: {
          method: "webhook",
          callback: callbackUrl(env.PUBLIC_ORIGIN),
          secret: ring.active.key,
        },
      }),
    },
  );
  const subscription = parseRemoteSubscription(Array.isArray(body.data) ? body.data[0] : null);
  if (subscription === null) {
    throw new TwitchApiError("Twitch EventSub lieferte kein angelegtes Abo.", 502, "invalid_response");
  }
  if (!isOwnedByTarget(subscription, target, botUserId, callbackUrl(env.PUBLIC_ORIGIN))) {
    throw new TwitchApiError("Twitch EventSub lieferte ein fremdes Abo.", 502, "invalid_response");
  }
  return subscription;
};

const deleteSubscription = async (
  fetcher: typeof fetch,
  clientId: string,
  appAccessToken: string,
  subscriptionId: string,
): Promise<void> => {
  const url = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
  url.searchParams.set("id", subscriptionId);
  try {
    await requestEventSubApi(fetcher, appAccessToken, clientId, url, { method: "DELETE" });
  } catch (error: unknown) {
    // Twitch kann ein widerrufenes Abo zwischen GET und DELETE bereits entfernt haben.
    if (!(error instanceof TwitchApiError) || error.status !== 404) throw error;
  }
};

export const reconcileEventSubSubscriptions = async (
  env: Env,
  now: string,
  appAccessToken: string,
  botUserId: string,
  fetcher: typeof fetch = fetch,
  channelId?: string,
): Promise<void> => {
  const targets = await listDesiredEventSubTargets(env.DB, channelId);
  const targetByKey = new Map(targets.map((target) => [`${target.channelId}\u0000${target.subscriptionType}`, target]));
  const currentStates = new Map((await listEventSubSubscriptions(env.DB, channelId)).map((state) => [
    `${state.channelId}\u0000${state.subscriptionType}`,
    state,
  ]));
  const markError = async (target: EventSubTarget, error: unknown, subscriptionId: string | null = null): Promise<void> => {
    await mark(env.DB, target, "error", reasonFor(error), subscriptionId, now);
  };

  let remote: EventSubRemoteSubscription[];
  try {
    remote = await fetchEventSubSubscriptions(fetcher, env.TWITCH_CLIENT_ID, appAccessToken);
  } catch (error: unknown) {
    const desiredKeys = new Set(targetByKey.keys());
    await Promise.all([
      ...targets.map((target) => markError(target, error, currentStates.get(`${target.channelId}\u0000${target.subscriptionType}`)?.subscriptionId ?? null)),
      ...[...currentStates.values()]
        .filter((state) => !desiredKeys.has(`${state.channelId}\u0000${state.subscriptionType}`))
        .map((state) => upsertEventSubSubscription(env.DB, {
          ...state,
          status: "error",
          secretId: null,
          reason: reasonFor(error),
          updatedAt: now,
        })),
    ]);
    return;
  }

  const expectedCallback = callbackUrl(env.PUBLIC_ORIGIN);
  const activeSecretId = parseKeyRing(env.TWITCH_EVENTSUB_SECRET).active.id;
  const kept = new Set<string>();
  const matched = new Set<string>();
  const blocked = new Set<string>();
  const failedStaleCleanup = new Set<string>();
  for (const subscription of remote) {
    if (channelId !== undefined && subscription.condition.broadcaster_user_id !== channelId) continue;
    const target = targets.find((candidate) => isOwnedByTarget(subscription, candidate, botUserId, expectedCallback));
    const owned = target !== undefined || (
      subscription.transport.method === "webhook" && subscription.transport.callback === expectedCallback &&
      subscription.condition.user_id === botUserId
    );
    if (!owned) continue;
    const targetKey = target === undefined
      ? `${String(subscription.condition.broadcaster_user_id)}\u0000${subscription.type}`
      : `${target.channelId}\u0000${target.subscriptionType}`;
    const desired = targetByKey.get(targetKey);
    const valid = desired !== undefined && subscription.status === "enabled" &&
      isOwnedByTarget(subscription, desired, botUserId, expectedCallback) && !kept.has(targetKey);
    if (valid) {
      kept.add(targetKey);
      const state = currentStates.get(targetKey);
      if (state !== undefined && (state.status !== "enabled" || state.secretId !== activeSecretId)) {
        try {
          await deleteSubscription(fetcher, env.TWITCH_CLIENT_ID, appAccessToken, subscription.id);
        } catch (error: unknown) {
          blocked.add(targetKey);
          await markError(desired, error, subscription.id);
          continue;
        }
        continue;
      }
      matched.add(targetKey);
      await mark(env.DB, desired, "enabled", null, subscription.id, now, activeSecretId);
      continue;
    }
    const duplicate = desired !== undefined && kept.has(targetKey);
    try {
      await deleteSubscription(fetcher, env.TWITCH_CLIENT_ID, appAccessToken, subscription.id);
      if (desired !== undefined && !duplicate) {
        await mark(env.DB, desired, "missing", "subscription_replaced", null, now, activeSecretId);
      }
    } catch (error: unknown) {
      if (desired !== undefined) {
        const desiredKey = `${desired.channelId}\u0000${desired.subscriptionType}`;
        blocked.add(desiredKey);
        await markError(desired, error, subscription.id);
      } else {
        const state = currentStates.get(targetKey);
        if (state !== undefined) {
          failedStaleCleanup.add(targetKey);
          await upsertEventSubSubscription(env.DB, {
            ...state,
            status: "error",
            subscriptionId: subscription.id,
            secretId: null,
            reason: reasonFor(error),
            updatedAt: now,
          });
        }
      }
    }
  }

  for (const target of targets) {
    const targetKey = `${target.channelId}\u0000${target.subscriptionType}`;
    if (matched.has(targetKey) || blocked.has(targetKey)) continue;
    try {
      const subscription = await createSubscription(env, target, botUserId, appAccessToken, fetcher);
      await mark(env.DB, target, "enabled", null, subscription.id, now, activeSecretId);
    } catch (error: unknown) {
      await markError(target, error);
    }
  }

  const desiredKeys = new Set(targetByKey.keys());
  const staleStates = [...currentStates.values()].filter((state) => {
    const key = `${state.channelId}\u0000${state.subscriptionType}`;
    return !desiredKeys.has(key) && !failedStaleCleanup.has(key);
  });
  await Promise.all(staleStates.map((state) => upsertEventSubSubscription(env.DB, {
    ...state,
    status: state.status === "revoked" ? "revoked" : "missing",
    subscriptionId: null,
    secretId: null,
    reason: state.status === "revoked" ? state.reason : "channel_or_consent_missing",
    updatedAt: now,
  })));
};

/** Führt genau einen Abgleich aus; Fehler werden als Zustand gespeichert. */
export const maintainEventSubSubscriptions = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
  channelId?: string,
): Promise<void> => {
  let targets: EventSubTarget[];
  try {
    targets = await listDesiredEventSubTargets(env.DB, channelId);
  } catch {
    return;
  }
  const botIdentity = await getBotIdentity(env.DB);
  if (botIdentity === null) {
    await Promise.all(targets.map((target) => mark(env.DB, target, "error", "bot_identity_missing", null, now)));
    return;
  }
  const botStatus = await getBotIdentityStatus(env.DB);
  if (botStatus?.status === "revoked") {
    await Promise.all(targets.map((target) => mark(env.DB, target, "error", "bot_identity_revoked", null, now)));
    return;
  }
  let appAccessToken: string;
  try {
    appAccessToken = await getAppAccessToken(env, now, fetcher);
  } catch (error: unknown) {
    await Promise.all(targets.map((target) => mark(env.DB, target, "error", reasonFor(error), null, now)));
    return;
  }
  try {
    await reconcileEventSubSubscriptions(env, now, appAccessToken, botIdentity.userId, fetcher, channelId);
  } catch (error: unknown) {
    await Promise.all(targets.map((target) => mark(env.DB, target, "error", reasonFor(error), null, now)));
  }
};

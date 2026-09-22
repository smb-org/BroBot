import { MODULES } from "../modules/registry";
import { moduleHasRequiredBroadcasterScopes, moduleScopeRequirement } from "./module-scopes";
import { getAppAccessToken } from "./app-token";
import { parseKeyRing } from "./auth/crypto";
import {
  channelBotConsentCondition,
} from "./db/guards";
import {
  getBotIdentity,
  getBotIdentityStatus,
} from "./db/bot-identity";
import {
  listEventSubSubscriptions,
  type EventSubAuthorizationIdentity,
  type EventSubSubscriptionStatus,
  upsertEventSubSubscription,
} from "./db/eventsub-state";
import {
  logMaintenanceError,
  maintenanceErrorDetails,
  TwitchApiError,
} from "./bot-maintenance";

export const EVENTSUB_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
export const EVENTSUB_CALLBACK_PATH = "/api/twitch/eventsub";
export const EVENTSUB_REQUEST_TIMEOUT_MS = 5_000;

export interface EventSubTarget {
  channelId: string;
  subscriptionType: string;
  /** Leer bei EventSub-Typen mit genau einem Ziel; Raid unterscheidet die Richtungen. */
  variant: string;
  version: string;
}

export interface EventSubSubscriptionDefinition {
  subscriptionType: string;
  variant: string;
  version: string;
  buildCondition: (channelId: string, botUserId: string) => Readonly<Record<string, string>>;
  channelIdFromCondition: (condition: Readonly<Record<string, unknown>>) => string | null;
  consentingIdentityFromCondition: (
    condition: Readonly<Record<string, unknown>>,
  ) => EventSubAuthorizationIdentity | null;
}

const conditionField = (field: string): ((condition: Readonly<Record<string, unknown>>) => string | null) =>
  (condition) => typeof condition[field] === "string" && condition[field].length > 0
    ? condition[field]
    : null;

const channelAndBotCondition = (
  channelField: string,
  botField: string,
  botUserId: string,
  channelId: string,
): Readonly<Record<string, string>> => ({
  [channelField]: channelId,
  [botField]: botUserId,
});

const identityFromConditionField = (
  field: string,
  kind: EventSubAuthorizationIdentity["kind"],
): ((condition: Readonly<Record<string, unknown>>) => EventSubAuthorizationIdentity | null) =>
  (condition) => {
    const userId = conditionField(field)(condition);
    return userId === null ? null : { kind, userId };
  };

/** Abo mit Moderator-Bedingung (`broadcaster_user_id` + `moderator_user_id`), Kanal aus `broadcaster_user_id`. */
const moderatorSubscriptionDefinition = (subscriptionType: string, version: string): EventSubSubscriptionDefinition => ({
  subscriptionType,
  variant: "",
  version,
  buildCondition: (channelId, botUserId) => channelAndBotCondition("broadcaster_user_id", "moderator_user_id", botUserId, channelId),
  channelIdFromCondition: conditionField("broadcaster_user_id"),
  consentingIdentityFromCondition: identityFromConditionField("moderator_user_id", "bot"),
});

/** Abo mit Nutzer-Bedingung (`broadcaster_user_id` + `user_id`), Kanal aus `broadcaster_user_id`. */
const userSubscriptionDefinition = (subscriptionType: string, version: string): EventSubSubscriptionDefinition => ({
  subscriptionType,
  variant: "",
  version,
  buildCondition: (channelId, botUserId) => channelAndBotCondition("broadcaster_user_id", "user_id", botUserId, channelId),
  channelIdFromCondition: conditionField("broadcaster_user_id"),
  consentingIdentityFromCondition: identityFromConditionField("user_id", "bot"),
});

/** Abo mit ausschließlicher Broadcaster-Bedingung, wie channel.ad_break.begin. */
const broadcasterSubscriptionDefinition = (
  subscriptionType: string,
  version: string,
  requiresConsent = true,
): EventSubSubscriptionDefinition => ({
  subscriptionType,
  variant: "",
  version,
  buildCondition: (channelId) => ({ broadcaster_user_id: channelId }),
  channelIdFromCondition: conditionField("broadcaster_user_id"),
  consentingIdentityFromCondition: requiresConsent
    ? identityFromConditionField("broadcaster_user_id", "login")
    : noConsentingIdentity,
});

const noConsentingIdentity = (): null => null;

/**
 * Die einzige Tabelle für EventSub-Bedingungen. Sie beschreibt sowohl das
 * Anlegen als auch die sichere Rückgewinnung des Kanal-Mandanten aus dem
 * geprüften Abo. Ein Raid ist absichtlich zweimal vertreten.
 */
export const EVENTSUB_SUBSCRIPTION_DEFINITIONS: readonly EventSubSubscriptionDefinition[] = [
  userSubscriptionDefinition("channel.chat.message", "1"),
  {
    subscriptionType: "channel.raid",
    variant: "eingehend",
    version: "1",
    buildCondition: (channelId) => ({ to_broadcaster_user_id: channelId }),
    channelIdFromCondition: conditionField("to_broadcaster_user_id"),
    consentingIdentityFromCondition: noConsentingIdentity,
  },
  {
    subscriptionType: "channel.raid",
    variant: "ausgehend",
    version: "1",
    buildCondition: (channelId) => ({ from_broadcaster_user_id: channelId }),
    channelIdFromCondition: conditionField("from_broadcaster_user_id"),
    consentingIdentityFromCondition: noConsentingIdentity,
  },
  moderatorSubscriptionDefinition("channel.shoutout.create", "1"),
  moderatorSubscriptionDefinition("channel.shoutout.receive", "1"),
  userSubscriptionDefinition("channel.chat.notification", "1"),
  moderatorSubscriptionDefinition("channel.moderate", "2"),
  moderatorSubscriptionDefinition("automod.message.hold", "1"),
  moderatorSubscriptionDefinition("channel.suspicious_user.message", "1"),
  moderatorSubscriptionDefinition("channel.suspicious_user.update", "1"),
  broadcasterSubscriptionDefinition("stream.online", "1", false),
  broadcasterSubscriptionDefinition("channel.ad_break.begin", "1"),
];

export const eventSubTargetKey = (target: Pick<EventSubTarget, "channelId" | "subscriptionType" | "variant" | "version">): string =>
  `${target.channelId}\u0000${target.subscriptionType}\u0000${target.variant}\u0000${target.version}`;

export const eventSubDefinitionForCondition = (
  subscriptionType: string,
  condition: Readonly<Record<string, unknown>>,
): EventSubSubscriptionDefinition | null => {
  const matches = EVENTSUB_SUBSCRIPTION_DEFINITIONS.filter((definition) =>
    definition.subscriptionType === subscriptionType && definition.channelIdFromCondition(condition) !== null);
  return matches.length === 1 ? matches[0] ?? null : null;
};

const eventSubDefinitionForTarget = (target: EventSubTarget): EventSubSubscriptionDefinition | null =>
  EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((definition) =>
    definition.subscriptionType === target.subscriptionType &&
    definition.variant === target.variant &&
    definition.version === target.version) ?? null;

const conditionContains = (
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, string>>,
): boolean => Object.entries(expected).every(([key, value]) => actual[key] === value);

interface EventSubTargetRow {
  channel_id: string;
  module_id: string;
  channel_bot_consent: number;
  broadcaster_scopes_json: string | null;
  broadcaster_status: string | null;
}

const parseScopes = (serialized: string | null): string[] => {
  if (serialized === null) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : [];
  } catch {
    return [];
  }
};

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
       , CASE WHEN ${channelBotConsentCondition("channel")} THEN 1 ELSE 0 END AS channel_bot_consent
       , broadcaster_identity.scopes_json AS broadcaster_scopes_json
       , broadcaster_identity.status AS broadcaster_status
       FROM channels AS channel
       JOIN channel_modules ON channel_modules.channel_id = channel.channel_id
        AND channel_modules.enabled = 1
       LEFT JOIN twitch_login_identity AS broadcaster_identity
         ON broadcaster_identity.user_id = channel.channel_id
      WHERE 1 = 1
        ${channelId === undefined ? "" : "AND channel.channel_id = ?"}
      ORDER BY channel.channel_id, channel_modules.module_id`;
  const result = channelId === undefined
    ? await db.prepare(query).all<EventSubTargetRow>()
    : await db.prepare(query).bind(channelId).all<EventSubTargetRow>();
  const modules = new Map(MODULES.map((module) => [module.id, module]));
  const targets = new Map<string, EventSubTarget>();
  for (const row of result.results) {
    const module = modules.get(row.module_id);
    if (module === undefined) continue;
    const requiredScopes = moduleScopeRequirement(module);
    const grantedScopes = row.broadcaster_status === "connected" ? parseScopes(row.broadcaster_scopes_json) : [];
    if (requiredScopes.length === 0
      ? row.channel_bot_consent !== 1
      : !moduleHasRequiredBroadcasterScopes(module, grantedScopes)) continue;
    for (const subscriptionType of module.eventSubTypes ?? []) {
      for (const definition of EVENTSUB_SUBSCRIPTION_DEFINITIONS) {
        if (definition.subscriptionType !== subscriptionType) continue;
        const target: EventSubTarget = {
          channelId: row.channel_id,
          subscriptionType,
          variant: definition.variant,
          version: definition.version,
        };
        targets.set(eventSubTargetKey(target), target);
      }
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
): boolean => {
  const definition = eventSubDefinitionForTarget(target);
  return subscription.type === target.subscriptionType &&
    subscription.version === target.version &&
    definition !== null &&
    conditionContains(subscription.condition, definition.buildCondition(target.channelId, botUserId)) &&
    subscription.transport.method === "webhook" &&
    subscription.transport.callback === expectedCallback;
};

const reasonFor = (error: unknown): string =>
  error instanceof TwitchApiError && error.code !== null ? error.code : "maintenance_failed";

const logTargetError = (target: EventSubTarget, error: unknown, fallbackCode = "maintenance_failed"): void => {
  logMaintenanceError({
    channelId: target.channelId,
    subscriptionType: target.subscriptionType,
    variant: target.variant,
  }, error, fallbackCode);
};

const mark = async (
  db: D1Database,
  target: EventSubTarget,
  status: EventSubSubscriptionStatus,
  reason: string | null,
  subscriptionId: string | null,
  now: string,
  secretId: string | null = null,
  errorMessage: string | null = null,
  errorStatus: number | null = null,
): Promise<void> => {
  await upsertEventSubSubscription(db, {
    channelId: target.channelId,
    subscriptionType: target.subscriptionType,
    variant: target.variant,
    version: target.version,
    subscriptionId,
    secretId,
    status,
    reason,
    errorMessage,
    errorStatus,
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
  const definition = eventSubDefinitionForTarget(target);
  if (definition === null) {
    throw new TwitchApiError("Unbekannter EventSub-Zieltyp.", 500, "invalid_target");
  }
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
        condition: definition.buildCondition(target.channelId, botUserId),
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
  const targetByKey = new Map(targets.map((target) => [eventSubTargetKey(target), target]));
  const currentStates = new Map((await listEventSubSubscriptions(env.DB, channelId)).map((state) => [
    eventSubTargetKey(state),
    state,
  ]));
  const markError = async (target: EventSubTarget, error: unknown, subscriptionId: string | null = null): Promise<void> => {
    const details = maintenanceErrorDetails(error, reasonFor(error));
    logTargetError(target, error, details.code);
    await mark(env.DB, target, "error", details.code, subscriptionId, now, null, details.message, details.status);
  };

  let remote: EventSubRemoteSubscription[];
  try {
    remote = await fetchEventSubSubscriptions(fetcher, env.TWITCH_CLIENT_ID, appAccessToken);
  } catch (error: unknown) {
    const desiredKeys = new Set(targetByKey.keys());
    if (targets.length === 0 && currentStates.size === 0) {
      logMaintenanceError({ channelId: channelId ?? "global", subscriptionType: "eventsub", variant: "list" }, error);
    }
    const details = maintenanceErrorDetails(error, reasonFor(error));
    await Promise.all([
      ...targets.map((target) => markError(target, error, currentStates.get(eventSubTargetKey(target))?.subscriptionId ?? null)),
      ...[...currentStates.values()]
        .filter((state) => !desiredKeys.has(eventSubTargetKey(state)))
        .map((state) => {
          logMaintenanceError({
            channelId: state.channelId,
            subscriptionType: state.subscriptionType,
            variant: state.variant,
          }, error, details.code);
          return upsertEventSubSubscription(env.DB, {
            ...state,
            status: "error",
            secretId: null,
            reason: details.code,
            errorMessage: details.message,
            errorStatus: details.status,
            updatedAt: now,
          });
        }),
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
    const definition = eventSubDefinitionForCondition(subscription.type, subscription.condition);
    const remoteChannelId = definition?.channelIdFromCondition(subscription.condition) ?? null;
    if (channelId !== undefined && remoteChannelId !== channelId) continue;
    const target = targets.find((candidate) => isOwnedByTarget(subscription, candidate, botUserId, expectedCallback));
    const owned = definition !== null && remoteChannelId !== null &&
      subscription.transport.method === "webhook" && subscription.transport.callback === expectedCallback &&
      conditionContains(subscription.condition, definition.buildCondition(remoteChannelId, botUserId));
    if (!owned) continue;
    const remoteTarget: EventSubTarget = {
      channelId: remoteChannelId,
      subscriptionType: subscription.type,
      variant: definition.variant,
      version: subscription.version,
    };
    const targetKey = target === undefined
      ? eventSubTargetKey(remoteTarget)
      : eventSubTargetKey(target);
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
        const desiredKey = eventSubTargetKey(desired);
        blocked.add(desiredKey);
        await markError(desired, error, subscription.id);
      } else {
        const state = currentStates.get(targetKey);
        if (state !== undefined) {
          failedStaleCleanup.add(targetKey);
          const details = maintenanceErrorDetails(error, reasonFor(error));
          logMaintenanceError({
            channelId: state.channelId,
            subscriptionType: state.subscriptionType,
            variant: state.variant,
          }, error, details.code);
          await upsertEventSubSubscription(env.DB, {
            ...state,
            status: "error",
            subscriptionId: subscription.id,
            secretId: null,
            reason: details.code,
            errorMessage: details.message,
            errorStatus: details.status,
            updatedAt: now,
          });
        }
      }
    }
  }

  for (const target of targets) {
    const targetKey = eventSubTargetKey(target);
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
    const key = eventSubTargetKey(state);
    return !desiredKeys.has(key) && !failedStaleCleanup.has(key);
  });
  await Promise.all(staleStates.map((state) => upsertEventSubSubscription(env.DB, {
    ...state,
    status: state.status === "revoked" ? "revoked" : "missing",
    subscriptionId: null,
    secretId: null,
    reason: state.status === "revoked" ? state.reason : "channel_or_consent_missing",
    errorMessage: null,
    errorStatus: null,
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
  } catch (error: unknown) {
    logMaintenanceError({ channelId: channelId ?? "global", subscriptionType: "eventsub", variant: "targets" }, error);
    return;
  }
  const botIdentity = await getBotIdentity(env.DB);
  if (botIdentity === null) {
    await Promise.all(targets.map((target) => {
      logTargetError(target, new Error(), "bot_identity_missing");
      return mark(env.DB, target, "error", "bot_identity_missing", null, now);
    }));
    return;
  }
  const botStatus = await getBotIdentityStatus(env.DB);
  if (botStatus?.status === "revoked") {
    await Promise.all(targets.map((target) => {
      logTargetError(target, new Error(), "bot_identity_revoked");
      return mark(env.DB, target, "error", "bot_identity_revoked", null, now);
    }));
    return;
  }
  let appAccessToken: string;
  try {
    appAccessToken = await getAppAccessToken(env, now, fetcher);
  } catch (error: unknown) {
    if (targets.length === 0) {
      logMaintenanceError({ channelId: channelId ?? "global", subscriptionType: "app-token", variant: "eventsub" }, error);
    }
    await Promise.all(targets.map((target) => {
      const details = maintenanceErrorDetails(error, reasonFor(error));
      logTargetError(target, error, details.code);
      return mark(env.DB, target, "error", details.code, null, now, null, details.message, details.status);
    }));
    return;
  }
  try {
    await reconcileEventSubSubscriptions(env, now, appAccessToken, botIdentity.userId, fetcher, channelId);
  } catch (error: unknown) {
    const details = maintenanceErrorDetails(error, reasonFor(error));
    if (targets.length === 0) {
      logMaintenanceError({ channelId: channelId ?? "global", subscriptionType: "eventsub", variant: "reconcile" }, error, details.code);
    }
    await Promise.all(targets.map((target) => {
      logTargetError(target, error, details.code);
      return mark(env.DB, target, "error", details.code, null, now, null, details.message, details.status);
    }));
  }
};

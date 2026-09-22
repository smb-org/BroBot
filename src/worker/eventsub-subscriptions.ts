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
  type EventSubSubscriptionStatus,
  upsertEventSubSubscription,
} from "./db/eventsub-state";
import {
  logMaintenanceError,
  maintenanceErrorDetails,
  toTwitchApiError,
  TwitchApiError,
} from "./bot-maintenance";
import { helixPages, helixRequest } from "./twitch/helix";
import type { HelixResult } from "../modules/contract";
import type {
  EventSubAuthorizationIdentity,
  EventSubNeutralReasonCode,
  EventSubSubscriptionType,
} from "../contracts/values";
import { listChannelIds } from "./db/channels";

export type { EventSubSubscriptionType } from "../contracts/values";

interface EventSubSubscriptionDefinitionBase<SubscriptionType extends string> {
  subscriptionType: SubscriptionType;
  variant: string;
  version: string;
  buildCondition: (channelId: string, botUserId: string) => Readonly<Record<string, string>>;
  channelIdFromCondition: (condition: Readonly<Record<string, unknown>>) => string | null;
  consentingIdentityFromCondition: (
    condition: Readonly<Record<string, unknown>>,
  ) => EventSubAuthorizationIdentity | null;
  requiresModerator?: boolean;
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

const noConsentingIdentity = (_condition?: Readonly<Record<string, unknown>>): null => {
  void _condition;
  return null;
};

const moderatorSubscriptionDefinition = <SubscriptionType extends string>(
  subscriptionType: SubscriptionType,
  version: string,
): EventSubSubscriptionDefinitionBase<SubscriptionType> => ({
  subscriptionType,
  variant: "",
  version,
  requiresModerator: true,
  buildCondition: (channelId, botUserId) => channelAndBotCondition("broadcaster_user_id", "moderator_user_id", botUserId, channelId),
  channelIdFromCondition: conditionField("broadcaster_user_id"),
  consentingIdentityFromCondition: identityFromConditionField("moderator_user_id", "bot"),
});

const userSubscriptionDefinition = <SubscriptionType extends string>(
  subscriptionType: SubscriptionType,
  version: string,
): EventSubSubscriptionDefinitionBase<SubscriptionType> => ({
  subscriptionType,
  variant: "",
  version,
  buildCondition: (channelId, botUserId) => channelAndBotCondition("broadcaster_user_id", "user_id", botUserId, channelId),
  channelIdFromCondition: conditionField("broadcaster_user_id"),
  consentingIdentityFromCondition: identityFromConditionField("user_id", "bot"),
});

const broadcasterSubscriptionDefinition = <SubscriptionType extends string>(
  subscriptionType: SubscriptionType,
  version: string,
  requiresConsent = true,
): EventSubSubscriptionDefinitionBase<SubscriptionType> => ({
  subscriptionType,
  variant: "",
  version,
  buildCondition: (channelId) => ({ broadcaster_user_id: channelId }),
  channelIdFromCondition: conditionField("broadcaster_user_id"),
  consentingIdentityFromCondition: requiresConsent
    ? identityFromConditionField("broadcaster_user_id", "login")
    : noConsentingIdentity,
});

/** A single table, because the same conditions apply when creating and when receiving. */
export const EVENTSUB_SUBSCRIPTION_DEFINITIONS = [
  userSubscriptionDefinition("channel.chat.message", "1"),
  {
    subscriptionType: "channel.raid",
    variant: "incoming",
    version: "1",
    buildCondition: (channelId: string, botUserId: string) => {
      void botUserId;
      return { to_broadcaster_user_id: channelId };
    },
    channelIdFromCondition: conditionField("to_broadcaster_user_id"),
    consentingIdentityFromCondition: noConsentingIdentity,
  },
  {
    subscriptionType: "channel.raid",
    variant: "outgoing",
    version: "1",
    buildCondition: (channelId: string, botUserId: string) => {
      void botUserId;
      return { from_broadcaster_user_id: channelId };
    },
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
] as const satisfies readonly EventSubSubscriptionDefinitionBase<EventSubSubscriptionType>[];

export type EventSubSubscriptionDefinition = (typeof EVENTSUB_SUBSCRIPTION_DEFINITIONS)[number];


export const EVENTSUB_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
export const EVENTSUB_CALLBACK_PATH = "/api/twitch/eventsub";
export const EVENTSUB_REQUEST_TIMEOUT_MS = 5_000;

export interface EventSubTarget {
  channelId: string;
  subscriptionType: EventSubSubscriptionType;
  /** Empty for EventSub types with exactly one target; raid distinguishes the two directions. */
  variant: string;
  version: string;
  deferredReason?: EventSubNeutralReasonCode;
}

export const eventSubTargetKey = (target: { channelId: string; subscriptionType: string; variant: string; version: string }): string =>
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
  module_id: string | null;
  channel_bot_consent: number;
  broadcaster_scopes_json: string | null;
  broadcaster_status: string | null;
  bot_is_moderator: number | null;
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

const asSubscriptionsPage = (
  body: unknown,
  status: number,
): HelixResult<{ data: unknown[]; pagination?: { cursor?: string } }> => {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return {
      ok: false,
      status,
      reason: "invalid_response",
      message: "Twitch EventSub returned no subscription list.",
      body: isRecord(body) ? body : {},
    };
  }
  const cursor = isRecord(body.pagination) && typeof body.pagination.cursor === "string"
    ? body.pagination.cursor
    : undefined;
  return {
    ok: true,
    status,
    data: { data: body.data, pagination: cursor === undefined ? {} : { cursor } },
  };
};

/** Determines the desired state solely from enabled modules and consent. */
export const listDesiredEventSubTargets = async (
  db: D1Database,
  channelId?: string,
): Promise<EventSubTarget[]> => {
  const query = `SELECT channel.channel_id, channel_modules.module_id
       , CASE WHEN ${channelBotConsentCondition("channel")} THEN 1 ELSE 0 END AS channel_bot_consent
       , broadcaster_identity.scopes_json AS broadcaster_scopes_json
       , broadcaster_identity.status AS broadcaster_status
       , bot_status.is_moderator AS bot_is_moderator
       FROM channels AS channel
       LEFT JOIN channel_modules ON channel_modules.channel_id = channel.channel_id
        AND channel_modules.enabled = 1
       LEFT JOIN twitch_login_identity AS broadcaster_identity
         ON broadcaster_identity.user_id = channel.channel_id
       LEFT JOIN bot_channel_status AS bot_status
         ON bot_status.channel_id = channel.channel_id
      WHERE 1 = 1
        ${channelId === undefined ? "" : "AND channel.channel_id = ?"}
      ORDER BY channel.channel_id, channel_modules.module_id`;
  const result = channelId === undefined
    ? await db.prepare(query).all<EventSubTargetRow>()
    : await db.prepare(query).bind(channelId).all<EventSubTargetRow>();
  const modules = new Map(MODULES.map((module) => [module.id, module]));
  const channels = new Map<string, { row: EventSubTargetRow; moduleIds: Set<string> }>();
  for (const row of result.results) {
    const channel = channels.get(row.channel_id) ?? { row, moduleIds: new Set<string>() };
    if (row.module_id !== null) channel.moduleIds.add(row.module_id);
    channels.set(row.channel_id, channel);
  }
  const targets = new Map<string, EventSubTarget>();
  for (const [id, channel] of channels) {
    const row = channel.row;
    const enabledModuleIds = new Set(channel.moduleIds);
    for (const module of MODULES) {
      if (module.mandatory === true) enabledModuleIds.add(module.id);
    }
    for (const moduleId of enabledModuleIds) {
      const module = modules.get(moduleId);
      if (module === undefined) continue;
      const requiredScopes = moduleScopeRequirement(module);
      const grantedScopes = row.broadcaster_status === "connected" ? parseScopes(row.broadcaster_scopes_json) : [];
      if (requiredScopes.length === 0
        ? row.channel_bot_consent !== 1
        : !moduleHasRequiredBroadcasterScopes(module, grantedScopes)) continue;
      for (const subscriptionType of module.eventSubTypes ?? []) {
        for (const definition of EVENTSUB_SUBSCRIPTION_DEFINITIONS) {
          if (definition.subscriptionType !== subscriptionType) continue;
          const baseTarget: EventSubTarget = {
            channelId: id,
            subscriptionType: definition.subscriptionType,
            variant: definition.variant,
            version: definition.version,
          };
          const target = "requiresModerator" in definition && definition.requiresModerator && row.bot_is_moderator !== 1
            ? { ...baseTarget, deferredReason: "moderator_required" as const }
            : baseTarget;
          targets.set(eventSubTargetKey(target), target);
        }
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
  const result = await helixPages<unknown>(async (cursor) => {
    const page = await helixRequest({
      url: EVENTSUB_SUBSCRIPTIONS_URL,
      query: { first: "100", after: cursor ?? undefined },
      accessToken: appAccessToken,
      clientId,
      fetcher,
      timeoutMs: EVENTSUB_REQUEST_TIMEOUT_MS,
    });
    return page.ok ? asSubscriptionsPage(page.data, page.status) : page;
  });
  if (!result.ok) throw toTwitchApiError(result, "Twitch EventSub returned no subscription list.");
  return result.data.map((value) => {
    const subscription = parseRemoteSubscription(value);
    if (subscription === null) {
      throw new TwitchApiError("Twitch EventSub returned an invalid subscription.", 502, "invalid_response");
    }
    return subscription;
  });
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
    throw new TwitchApiError("Unknown EventSub target type.", 500, "invalid_target");
  }
  const result = await helixRequest<Record<string, unknown>>({
    method: "POST",
    url: EVENTSUB_SUBSCRIPTIONS_URL,
    body: {
      type: target.subscriptionType,
      version: target.version,
      condition: definition.buildCondition(target.channelId, botUserId),
      transport: {
        method: "webhook",
        callback: callbackUrl(env.PUBLIC_ORIGIN),
        secret: ring.active.key,
      },
    },
    accessToken: appAccessToken,
    clientId: env.TWITCH_CLIENT_ID,
    fetcher,
    timeoutMs: EVENTSUB_REQUEST_TIMEOUT_MS,
  });
  if (!result.ok) throw toTwitchApiError(result, "Twitch EventSub rejected the request.");
  const subscription = parseRemoteSubscription(Array.isArray(result.data.data) ? result.data.data[0] : null);
  if (subscription === null) {
    throw new TwitchApiError("Twitch EventSub returned no created subscription.", 502, "invalid_response");
  }
  if (!isOwnedByTarget(subscription, target, botUserId, callbackUrl(env.PUBLIC_ORIGIN))) {
    throw new TwitchApiError("Twitch EventSub returned a foreign subscription.", 502, "invalid_response");
  }
  return subscription;
};

const isAlreadyExistsConflict = (error: unknown): error is TwitchApiError =>
  error instanceof TwitchApiError && error.status === 409 &&
  /subscription already exists/i.test(error.message);

const adoptRemoteSubscription = async (
  env: Env,
  target: EventSubTarget,
  botUserId: string,
  now: string,
  appAccessToken: string,
  activeSecretId: string,
  fetcher: typeof fetch,
): Promise<boolean> => {
  const remote = await fetchEventSubSubscriptions(fetcher, env.TWITCH_CLIENT_ID, appAccessToken);
  const adopted = remote.find((subscription) => subscription.status === "enabled" &&
    isOwnedByTarget(subscription, target, botUserId, callbackUrl(env.PUBLIC_ORIGIN)));
  if (adopted === undefined) {
    await mark(env.DB, target, "missing", "pending_adoption", null, now);
    return false;
  }
  await mark(env.DB, target, "enabled", null, adopted.id, now, activeSecretId);
  return true;
};

const deleteSubscription = async (
  fetcher: typeof fetch,
  clientId: string,
  appAccessToken: string,
  subscriptionId: string,
): Promise<void> => {
  const result = await helixRequest({
    method: "DELETE",
    url: EVENTSUB_SUBSCRIPTIONS_URL,
    query: { id: subscriptionId },
    accessToken: appAccessToken,
    clientId,
    fetcher,
    timeoutMs: EVENTSUB_REQUEST_TIMEOUT_MS,
  });
  // Twitch may have already removed a revoked subscription between the GET and the DELETE.
  if (!result.ok && result.status !== 404) throw toTwitchApiError(result, "Twitch EventSub rejected the request.");
};

export const reconcileEventSubSubscriptions = async (
  env: Env,
  now: string,
  appAccessToken: string,
  botUserId: string,
  fetcher: typeof fetch = fetch,
  channelId?: string,
): Promise<void> => {
  const allTargets = await listDesiredEventSubTargets(env.DB, channelId);
  const deferredTargets = allTargets.filter((target) => target.deferredReason !== undefined);
  const targets = allTargets.filter((target) => target.deferredReason === undefined);
  const targetByKey = new Map(targets.map((target) => [eventSubTargetKey(target), target]));
  const deferredByKey = new Map(deferredTargets.map((target) => [eventSubTargetKey(target), target]));
  const allDesiredKeys = new Set(allTargets.map(eventSubTargetKey));
  const currentStates = new Map((await listEventSubSubscriptions(env.DB, channelId)).map((state) => [
    eventSubTargetKey(state),
    state,
  ]));
  const markError = async (target: EventSubTarget, error: unknown, subscriptionId: string | null = null): Promise<void> => {
    const details = maintenanceErrorDetails(error, reasonFor(error));
    logTargetError(target, error, details.code);
    await mark(env.DB, target, "error", details.code, subscriptionId, now, null, details.message, details.status);
  };

  await Promise.all(deferredTargets.map((target) =>
    mark(env.DB, target, "missing", target.deferredReason ?? "moderator_required", null, now)));

  let remote: EventSubRemoteSubscription[];
  try {
    remote = await fetchEventSubSubscriptions(fetcher, env.TWITCH_CLIENT_ID, appAccessToken);
  } catch (error: unknown) {
    const desiredKeys = allDesiredKeys;
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
      subscriptionType: definition.subscriptionType,
      variant: definition.variant,
      version: subscription.version,
    };
    const targetKey = eventSubTargetKey(target ?? remoteTarget);
    if (deferredByKey.has(targetKey)) continue;
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
      if (isAlreadyExistsConflict(error)) {
        try {
          await adoptRemoteSubscription(env, target, botUserId, now, appAccessToken, activeSecretId, fetcher);
        } catch (adoptionError: unknown) {
          await markError(target, adoptionError);
        }
      } else {
        await markError(target, error);
      }
    }
  }

  const desiredKeys = allDesiredKeys;
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

/** Runs one channel pass; callers hold that channel's D1 lease. */
const maintainEventSubSubscriptionsPass = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
  channelId: string,
): Promise<void> => {
  let targets: EventSubTarget[];
  try {
    targets = await listDesiredEventSubTargets(env.DB, channelId);
  } catch (error: unknown) {
    logMaintenanceError({ channelId, subscriptionType: "eventsub", variant: "targets" }, error);
    return;
  }
  const deferredTargets = targets.filter((target) => target.deferredReason !== undefined);
  const actionableTargets = targets.filter((target) => target.deferredReason === undefined);
  await Promise.all(deferredTargets.map((target) =>
    mark(env.DB, target, "missing", target.deferredReason ?? "moderator_required", null, now)));
  const botIdentity = await getBotIdentity(env.DB);
  if (botIdentity === null) {
    await Promise.all(actionableTargets.map((target) => {
      logTargetError(target, new Error(), "bot_identity_missing");
      return mark(env.DB, target, "error", "bot_identity_missing", null, now);
    }));
    return;
  }
  const botStatus = await getBotIdentityStatus(env.DB);
  if (botStatus?.status === "revoked") {
    await Promise.all(actionableTargets.map((target) => {
      logTargetError(target, new Error(), "bot_identity_revoked");
      return mark(env.DB, target, "error", "bot_identity_revoked", null, now);
    }));
    return;
  }
  let appAccessToken: string;
  try {
    appAccessToken = await getAppAccessToken(env, now, fetcher);
  } catch (error: unknown) {
    if (actionableTargets.length === 0) {
      logMaintenanceError({ channelId, subscriptionType: "app-token", variant: "eventsub" }, error);
    }
    await Promise.all(actionableTargets.map((target) => {
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
    if (actionableTargets.length === 0) {
      logMaintenanceError({ channelId, subscriptionType: "eventsub", variant: "reconcile" }, error, details.code);
    }
    await Promise.all(actionableTargets.map((target) => {
      logTargetError(target, error, details.code);
      return mark(env.DB, target, "error", details.code, null, now, null, details.message, details.status);
    }));
  }
};

const EVENTSUB_MAINTENANCE_LEASE_MS = 10 * 60 * 1000;

interface EventSubMaintenanceLeaseRow {
  owner_id: string;
  rerun_needed: number;
}

const maintainChannelWithLease = async (
  env: Env,
  now: string,
  fetcher: typeof fetch,
  channelId: string,
): Promise<void> => {
  const ownerId = crypto.randomUUID();
  const wallClock = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + EVENTSUB_MAINTENANCE_LEASE_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO eventsub_maintenance_locks (channel_id, owner_id, lease_until, rerun_needed)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(channel_id) DO UPDATE SET
       owner_id = CASE WHEN eventsub_maintenance_locks.lease_until <= ? THEN excluded.owner_id ELSE eventsub_maintenance_locks.owner_id END,
       lease_until = CASE WHEN eventsub_maintenance_locks.lease_until <= ? THEN excluded.lease_until ELSE eventsub_maintenance_locks.lease_until END,
       rerun_needed = CASE WHEN eventsub_maintenance_locks.lease_until <= ? THEN 0 ELSE 1 END`,
  ).bind(channelId, ownerId, leaseUntil, wallClock, wallClock, wallClock).run();

  const lease = await env.DB.prepare(
    "SELECT owner_id, rerun_needed FROM eventsub_maintenance_locks WHERE channel_id = ?",
  ).bind(channelId).first<EventSubMaintenanceLeaseRow>();
  if (lease?.owner_id !== ownerId) return;

  for (;;) {
    await maintainEventSubSubscriptionsPass(env, now, fetcher, channelId);
    const released = await env.DB.prepare(
      `DELETE FROM eventsub_maintenance_locks
        WHERE channel_id = ? AND owner_id = ? AND rerun_needed = 0`,
    ).bind(channelId, ownerId).run();
    if (released.meta.changes > 0) return;

    const current = await env.DB.prepare(
      "SELECT owner_id, rerun_needed FROM eventsub_maintenance_locks WHERE channel_id = ?",
    ).bind(channelId).first<EventSubMaintenanceLeaseRow>();
    if (current?.owner_id !== ownerId || current.rerun_needed !== 1) return;

    await env.DB.prepare(
      `UPDATE eventsub_maintenance_locks
          SET rerun_needed = 0,
              lease_until = ?
        WHERE channel_id = ? AND owner_id = ? AND rerun_needed = 1`,
    ).bind(new Date(Date.now() + EVENTSUB_MAINTENANCE_LEASE_MS).toISOString(), channelId, ownerId).run();
  }
};

/**
 * Serializes reconciliation per channel. Active contenders set one durable
 * rerun bit, which the lease owner consumes after its current pass.
 */
export const maintainEventSubSubscriptions = async (
  env: Env,
  now: string,
  fetcher: typeof fetch = fetch,
  channelId?: string,
): Promise<void> => {
  let channelIds: string[];
  if (channelId !== undefined) {
    channelIds = [channelId];
  } else {
    try {
      channelIds = await listChannelIds(env.DB);
    } catch (error: unknown) {
      logMaintenanceError({ channelId: "global", subscriptionType: "eventsub", variant: "channels" }, error);
      return;
    }
  }
  for (const id of channelIds) await maintainChannelWithLease(env, now, fetcher, id);
};

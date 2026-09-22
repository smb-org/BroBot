import { kuerzeAuf200Zeichen } from "../contract";
import type { ChannelEventDiagnostic, ChannelEventDetail } from "../contracts";
import type { EventSubSubscriptionType } from "../../../contracts/values";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const textValue = (value: unknown): string | null => {
  const text = stringValue(value);
  return text === null ? null : kuerzeAuf200Zeichen(text);
};

const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const feld = (payload: Readonly<Record<string, unknown>>, key: string): unknown => payload[key];

const optionaleTextDetail = (
  key: string,
  value: string | null,
): ChannelEventDetail => value === null ? {} : { [key]: value };

const nestedFeld = (
  payload: Readonly<Record<string, unknown>>,
  noticeType: string,
  key: string,
): unknown => {
  const nested = payload[noticeType];
  return isRecord(nested) && nested[key] !== undefined ? nested[key] : payload[key];
};

const person = (
  payload: Readonly<Record<string, unknown>>,
  prefix: string,
): string | null => {
  const displayName = textValue(feld(payload, `${prefix}_user_name`));
  const login = textValue(feld(payload, `${prefix}_user_login`));
  if (displayName === null && login === null) return null;
  if (displayName === null) return login;
  if (login === null || displayName === login) return displayName;
  return kuerzeAuf200Zeichen(`${displayName} (@${login})`);
};

const personAusObjekt = (
  value: Readonly<Record<string, unknown>>,
  prefix: string,
): string | null => {
  const displayName = textValue(value[`${prefix}_name`]);
  const login = textValue(value[`${prefix}_login`]);
  if (displayName === null && login === null) return null;
  if (displayName === null) return login;
  if (login === null || displayName === login) return displayName;
  return kuerzeAuf200Zeichen(`${displayName} (@${login})`);
};

const detail = (values: ChannelEventDetail): ChannelEventDetail => values;

const raidDiagnose = (
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  variant: string | undefined,
): ChannelEventDiagnostic => {
  const fromId = stringValue(feld(payload, "from_broadcaster_user_id"));
  const outgoing = variant === "outgoing" || (variant !== "incoming" && fromId === channelId);
  return outgoing
    ? {
      code: "channel_events.raid.outgoing",
      detail: detail({
        target: person(payload, "to_broadcaster"),
        viewers: numberValue(feld(payload, "viewers")),
      }),
    }
    : {
      code: "channel_events.raid.incoming",
      detail: detail({
        source: person(payload, "from_broadcaster"),
        viewers: numberValue(feld(payload, "viewers")),
      }),
    };
};

const shoutoutDiagnose = (
  subscriptionType: EventSubSubscriptionType,
  payload: Readonly<Record<string, unknown>>,
): ChannelEventDiagnostic => subscriptionType === "channel.shoutout.create"
  ? {
    code: "channel_events.shoutout.gesendet",
    detail: detail({ target: person(payload, "to_broadcaster") }),
  }
  : {
    code: "channel_events.shoutout.empfangen",
    detail: detail({
      source: person(payload, "from_broadcaster"),
      ...(numberValue(feld(payload, "viewer_count")) === null
        ? {}
        : { viewers: numberValue(feld(payload, "viewer_count")) }),
    }),
  };

const chatNotificationDiagnose = (
  payload: Readonly<Record<string, unknown>>,
): ChannelEventDiagnostic => {
  const noticeType = textValue(feld(payload, "notice_type"));
  const typ = noticeType === null ? "unbekannt" : noticeType;
  const chatter = person(payload, "chatter");
  const tier = textValue(nestedFeld(payload, typ, "sub_tier"));
  if (typ === "sub") {
    return {
      code: "channel_events.chat.sub",
      detail: detail({ person: chatter, tier: tier }),
    };
  }
  if (typ === "resub") {
    return {
      code: "channel_events.chat.resub",
      detail: detail({ person: chatter, tier: tier }),
    };
  }
  if (typ === "sub_gift") {
    return {
      code: "channel_events.chat.gift_sub",
      detail: detail({
        gifter: person(payload, "gifter"),
        recipient: person(payload, "recipient"),
        tier: tier,
      }),
    };
  }
  if (typ === "community_sub_gift") {
    return {
      code: "channel_events.chat.community_gift",
      detail: detail({
        gifter: person(payload, "gifter"),
        count: numberValue(nestedFeld(payload, typ, "total")),
        tier: tier,
      }),
    };
  }
  if (typ === "announcement") {
    const message = isRecord(payload.message) ? textValue(payload.message.text) : textValue(payload.message);
    return {
      code: "channel_events.chat.ankuendigung",
      detail: detail({ person: chatter, text: message }),
    };
  }
  return {
    code: "channel_events.chat.unbekannt",
    detail: detail({ kind: kuerzeAuf200Zeichen(typ) }),
  };
};

const dauerInSekunden = (ende: string | null, eventTime: string | undefined): number | null => {
  if (ende === null || eventTime === undefined) return null;
  const endeMs = Date.parse(ende);
  const eventMs = Date.parse(eventTime);
  if (!Number.isFinite(endeMs) || !Number.isFinite(eventMs)) return null;
  return Math.max(0, Math.round((endeMs - eventMs) / 1000));
};

const moderationDiagnose = (
  payload: Readonly<Record<string, unknown>>,
  eventTime: string | undefined,
): ChannelEventDiagnostic => {
  const action = textValue(feld(payload, "action"));
  const actionName = action ?? "unbekannt";
  const actionData = action !== null && isRecord(feld(payload, action)) ? feld(payload, action) as Readonly<Record<string, unknown>> : {};
  const beteiligt = personAusObjekt(actionData, "user");
  const moderator = person(payload, "moderator");
  const reason = textValue(actionData.reason);
  const common = { person: beteiligt, moderator, reason: reason };

  if (actionName === "ban") {
    return { code: "channel_events.moderation.ban", detail: detail(common) };
  }
  if (actionName === "timeout") {
    const ende = textValue(actionData.ends_at);
    return {
      code: "channel_events.moderation.timeout",
      detail: detail({ ...common, endsAt: ende, duration: dauerInSekunden(ende, eventTime) }),
    };
  }
  if (actionName === "untimeout") {
    return { code: "channel_events.moderation.untimeout", detail: detail({ person: beteiligt, moderator }) };
  }
  if (actionName === "unban") {
    return { code: "channel_events.moderation.unban", detail: detail({ person: beteiligt, moderator }) };
  }
  if (actionName === "delete") {
    return {
      code: "channel_events.moderation.delete",
      detail: detail({ person: beteiligt, moderator, text: textValue(actionData.message_body) }),
    };
  }
  if (actionName === "warn") {
    return { code: "channel_events.moderation.warn", detail: detail(common) };
  }
  return {
    code: "channel_events.moderation.unbekannt",
    detail: detail({ action: actionName }),
  };
};

const messageText = (payload: Readonly<Record<string, unknown>>): string | null => {
  const message = feld(payload, "message");
  return isRecord(message) ? textValue(message.text) : textValue(message);
};

const documentedValue = <T extends string>(value: unknown, values: readonly T[]): T | null => {
  const text = stringValue(value);
  return text !== null && values.includes(text as T) ? text as T : null;
};

const LOW_TRUST_STATUS = ["none", "active_monitoring", "restricted"] as const;
const SUSPICIOUS_USER_TYPES = ["manually_added", "ban_evader", "banned_in_shared_channel"] as const;
const BAN_EVASION_EVALUATIONS = ["unknown", "possible", "likely"] as const;

const lowTrustStatus = (payload: Readonly<Record<string, unknown>>): string | null =>
  documentedValue(feld(payload, "low_trust_status"), LOW_TRUST_STATUS);

const suspiciousUserTypes = (payload: Readonly<Record<string, unknown>>): string | null => {
  const types = feld(payload, "types");
  if (!Array.isArray(types)) return null;
  const documentedTypes: string[] = [];
  for (const type of types) {
    const documentedType = documentedValue(type, SUSPICIOUS_USER_TYPES);
    if (documentedType !== null) documentedTypes.push(documentedType);
  }
  return documentedTypes.length === 0 ? null : kuerzeAuf200Zeichen(documentedTypes.join(", "));
};

const suspiciousEinstufung = (payload: Readonly<Record<string, unknown>>): string | null => {
  const values = [
    lowTrustStatus(payload),
    suspiciousUserTypes(payload),
    documentedValue(feld(payload, "ban_evasion_evaluation"), BAN_EVASION_EVALUATIONS),
  ].filter((value): value is string => value !== null);
  return values.length === 0 ? null : kuerzeAuf200Zeichen(values.join(" / "));
};

const automodDiagnose = (payload: Readonly<Record<string, unknown>>): ChannelEventDiagnostic => ({
  code: "channel_events.automod.halte",
  detail: detail({
    ...optionaleTextDetail("person", personAusObjekt(payload, "user")),
    ...optionaleTextDetail("reason", textValue(feld(payload, "category"))),
    ...optionaleTextDetail("text", messageText(payload)),
  }),
});

const suspiciousMessageDiagnose = (payload: Readonly<Record<string, unknown>>): ChannelEventDiagnostic => ({
  code: "channel_events.verdacht.nachricht",
  detail: detail({
    ...optionaleTextDetail("person", personAusObjekt(payload, "user")),
    ...optionaleTextDetail("einstufung", suspiciousEinstufung(payload)),
    ...optionaleTextDetail("text", messageText(payload)),
  }),
});

const suspiciousUpdateDiagnose = (payload: Readonly<Record<string, unknown>>): ChannelEventDiagnostic => {
  const status = lowTrustStatus(payload);
  return {
    code: status === "none"
      ? "channel_events.verdacht.entwarnung"
      : "channel_events.verdacht.einstufung",
    detail: detail({
      ...optionaleTextDetail("person", personAusObjekt(payload, "user")),
      ...optionaleTextDetail("einstufung", status),
      ...optionaleTextDetail("moderator", person(payload, "moderator")),
    }),
  };
};

/** Reine Abbildung des EventSub-Ereignisrumpfs auf Kanaldiagnosen. */
export const diagnoseChannelEvent = (
  subscriptionType: EventSubSubscriptionType,
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  subscriptionVariant?: string,
  eventTime?: string,
): readonly ChannelEventDiagnostic[] => {
  if (subscriptionType === "channel.raid") return [raidDiagnose(payload, channelId, subscriptionVariant)];
  if (subscriptionType === "channel.shoutout.create" || subscriptionType === "channel.shoutout.receive") {
    return [shoutoutDiagnose(subscriptionType, payload)];
  }
  if (subscriptionType === "channel.chat.notification") return [chatNotificationDiagnose(payload)];
  if (subscriptionType === "automod.message.hold") return [automodDiagnose(payload)];
  if (subscriptionType === "channel.suspicious_user.message") return [suspiciousMessageDiagnose(payload)];
  if (subscriptionType === "channel.suspicious_user.update") return [suspiciousUpdateDiagnose(payload)];
  if (subscriptionType === "channel.moderate") return [moderationDiagnose(payload, eventTime)];
  return [];
};

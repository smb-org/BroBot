import { kuerzeAuf200Zeichen } from "../contract";
import type { KanalereignisDiagnose, KanalereignisDetail } from "../contracts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringWert = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const textWert = (value: unknown): string | null => {
  const text = stringWert(value);
  return text === null ? null : kuerzeAuf200Zeichen(text);
};

const zahlWert = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const feld = (payload: Readonly<Record<string, unknown>>, key: string): unknown => payload[key];

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
  const displayName = textWert(feld(payload, `${prefix}_user_name`));
  const login = textWert(feld(payload, `${prefix}_user_login`));
  if (displayName === null && login === null) return null;
  if (displayName === null) return login;
  if (login === null || displayName === login) return displayName;
  return kuerzeAuf200Zeichen(`${displayName} (@${login})`);
};

const personAusObjekt = (
  value: Readonly<Record<string, unknown>>,
  prefix: string,
): string | null => {
  const displayName = textWert(value[`${prefix}_name`]);
  const login = textWert(value[`${prefix}_login`]);
  if (displayName === null && login === null) return null;
  if (displayName === null) return login;
  if (login === null || displayName === login) return displayName;
  return kuerzeAuf200Zeichen(`${displayName} (@${login})`);
};

const detail = (values: KanalereignisDetail): KanalereignisDetail => values;

const raidDiagnose = (
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  variant: string | undefined,
): KanalereignisDiagnose => {
  const fromId = stringWert(feld(payload, "from_broadcaster_user_id"));
  const outgoing = variant === "ausgehend" || (variant !== "eingehend" && fromId === channelId);
  return outgoing
    ? {
      code: "kanalereignisse.raid.ausgehend",
      detail: detail({
        ziel: person(payload, "to_broadcaster"),
        zuschauer: zahlWert(feld(payload, "viewers")),
      }),
    }
    : {
      code: "kanalereignisse.raid.eingehend",
      detail: detail({
        quelle: person(payload, "from_broadcaster"),
        zuschauer: zahlWert(feld(payload, "viewers")),
      }),
    };
};

const shoutoutDiagnose = (
  subscriptionType: string,
  payload: Readonly<Record<string, unknown>>,
): KanalereignisDiagnose => subscriptionType === "channel.shoutout.create"
  ? {
    code: "kanalereignisse.shoutout.gesendet",
    detail: detail({ ziel: person(payload, "to_broadcaster") }),
  }
  : {
    code: "kanalereignisse.shoutout.empfangen",
    detail: detail({
      quelle: person(payload, "from_broadcaster"),
      ...(zahlWert(feld(payload, "viewer_count")) === null
        ? {}
        : { zuschauer: zahlWert(feld(payload, "viewer_count")) }),
    }),
  };

const chatNotificationDiagnose = (
  payload: Readonly<Record<string, unknown>>,
): KanalereignisDiagnose => {
  const noticeType = textWert(feld(payload, "notice_type"));
  const typ = noticeType === null ? "unbekannt" : noticeType;
  const chatter = person(payload, "chatter");
  const tier = textWert(nestedFeld(payload, typ, "sub_tier"));
  if (typ === "sub") {
    return {
      code: "kanalereignisse.chat.sub",
      detail: detail({ person: chatter, stufe: tier }),
    };
  }
  if (typ === "resub") {
    return {
      code: "kanalereignisse.chat.resub",
      detail: detail({ person: chatter, stufe: tier }),
    };
  }
  if (typ === "sub_gift") {
    return {
      code: "kanalereignisse.chat.gift_sub",
      detail: detail({
        spender: person(payload, "gifter"),
        empfaenger: person(payload, "recipient"),
        stufe: tier,
      }),
    };
  }
  if (typ === "community_sub_gift") {
    return {
      code: "kanalereignisse.chat.community_gift",
      detail: detail({
        spender: person(payload, "gifter"),
        anzahl: zahlWert(nestedFeld(payload, typ, "total")),
        stufe: tier,
      }),
    };
  }
  if (typ === "announcement") {
    const message = isRecord(payload.message) ? textWert(payload.message.text) : textWert(payload.message);
    return {
      code: "kanalereignisse.chat.ankuendigung",
      detail: detail({ person: chatter, text: message }),
    };
  }
  return {
    code: "kanalereignisse.chat.unbekannt",
    detail: detail({ art: kuerzeAuf200Zeichen(typ) }),
  };
};

const dauerInSekunden = (ende: string | null, ereigniszeit: string | undefined): number | null => {
  if (ende === null || ereigniszeit === undefined) return null;
  const endeMs = Date.parse(ende);
  const ereignisMs = Date.parse(ereigniszeit);
  if (!Number.isFinite(endeMs) || !Number.isFinite(ereignisMs)) return null;
  return Math.max(0, Math.round((endeMs - ereignisMs) / 1000));
};

const moderationDiagnose = (
  payload: Readonly<Record<string, unknown>>,
  ereigniszeit: string | undefined,
): KanalereignisDiagnose => {
  const action = textWert(feld(payload, "action"));
  const actionName = action ?? "unbekannt";
  const actionData = action !== null && isRecord(feld(payload, action)) ? feld(payload, action) as Readonly<Record<string, unknown>> : {};
  const beteiligt = personAusObjekt(actionData, "user");
  const moderator = person(payload, "moderator");
  const grund = textWert(actionData.reason);
  const common = { person: beteiligt, moderator, grund };

  if (actionName === "ban") {
    return { code: "kanalereignisse.moderation.ban", detail: detail(common) };
  }
  if (actionName === "timeout") {
    const ende = textWert(actionData.ends_at);
    return {
      code: "kanalereignisse.moderation.timeout",
      detail: detail({ ...common, ende, dauer: dauerInSekunden(ende, ereigniszeit) }),
    };
  }
  if (actionName === "untimeout") {
    return { code: "kanalereignisse.moderation.untimeout", detail: detail({ person: beteiligt, moderator }) };
  }
  if (actionName === "unban") {
    return { code: "kanalereignisse.moderation.unban", detail: detail({ person: beteiligt, moderator }) };
  }
  if (actionName === "delete") {
    return {
      code: "kanalereignisse.moderation.delete",
      detail: detail({ person: beteiligt, moderator, text: textWert(actionData.message_body) }),
    };
  }
  if (actionName === "warn") {
    return { code: "kanalereignisse.moderation.warn", detail: detail(common) };
  }
  return {
    code: "kanalereignisse.moderation.unbekannt",
    detail: detail({ aktion: actionName }),
  };
};

/** Reine Abbildung des EventSub-Ereignisrumpfs auf Kanaldiagnosen. */
export const diagnostiziereKanalereignis = (
  subscriptionType: string,
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  subscriptionVariant?: string,
  ereigniszeit?: string,
): readonly KanalereignisDiagnose[] => {
  if (subscriptionType === "channel.raid") return [raidDiagnose(payload, channelId, subscriptionVariant)];
  if (subscriptionType === "channel.shoutout.create" || subscriptionType === "channel.shoutout.receive") {
    return [shoutoutDiagnose(subscriptionType, payload)];
  }
  if (subscriptionType === "channel.chat.notification") return [chatNotificationDiagnose(payload)];
  if (subscriptionType === "channel.moderate") return [moderationDiagnose(payload, ereigniszeit)];
  return [];
};

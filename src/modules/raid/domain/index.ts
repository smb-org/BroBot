const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const viewerValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

export type RaidEntscheidung =
  | {
    kind: "incoming";
    sourceChannelId: string;
    quelleKanalName: string;
    viewers: number;
    voll: boolean;
  }
  | {
    kind: "outgoing";
    targetChannelId: string | null;
    viewers: number | null;
  }
  | {
    kind: "ungueltig";
    reason: "ziel_ungueltig" | "quelle_ungueltig" | "zuschauer_ungueltig";
  };

/** Unterscheidet die beiden EventSub-Raid-Richtungen anhand desselben Musters wie Kanalereignisse. */
export const entscheideRaid = (
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  subscriptionVariant: string | undefined,
  textThreshold: number,
): RaidEntscheidung => {
  const fromId = textValue(payload.from_broadcaster_user_id);
  const toId = textValue(payload.to_broadcaster_user_id);
  const zuschauer = viewerValue(payload.viewers);
  const outgoing = subscriptionVariant === "outgoing" ||
    (subscriptionVariant !== "incoming" && fromId === channelId);

  if (outgoing) return { kind: "outgoing", targetChannelId: toId, viewers: zuschauer };
  if (toId !== channelId) return { kind: "ungueltig", reason: "ziel_ungueltig" };
  if (fromId === null) return { kind: "ungueltig", reason: "quelle_ungueltig" };
  if (zuschauer === null) return { kind: "ungueltig", reason: "zuschauer_ungueltig" };

  return {
    kind: "incoming",
    sourceChannelId: fromId,
    quelleKanalName: textValue(payload.from_broadcaster_user_name) ?? textValue(payload.from_broadcaster_user_login) ?? fromId,
    viewers: zuschauer,
    voll: zuschauer >= textThreshold,
  };
};

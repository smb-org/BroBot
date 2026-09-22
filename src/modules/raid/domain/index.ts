const textwert = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const zuschauerwert = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

export type RaidEntscheidung =
  | {
    kind: "incoming";
    quelleKanalId: string;
    quelleKanalName: string;
    zuschauer: number;
    voll: boolean;
  }
  | {
    kind: "outgoing";
    zielKanalId: string | null;
    zuschauer: number | null;
  }
  | {
    kind: "ungueltig";
    grund: "ziel_ungueltig" | "quelle_ungueltig" | "zuschauer_ungueltig";
  };

/** Unterscheidet die beiden EventSub-Raid-Richtungen anhand desselben Musters wie Kanalereignisse. */
export const entscheideRaid = (
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  subscriptionVariant: string | undefined,
  textSchwelle: number,
): RaidEntscheidung => {
  const fromId = textwert(payload.from_broadcaster_user_id);
  const toId = textwert(payload.to_broadcaster_user_id);
  const zuschauer = zuschauerwert(payload.viewers);
  const outgoing = subscriptionVariant === "outgoing" ||
    (subscriptionVariant !== "incoming" && fromId === channelId);

  if (outgoing) return { kind: "outgoing", zielKanalId: toId, zuschauer };
  if (toId !== channelId) return { kind: "ungueltig", grund: "ziel_ungueltig" };
  if (fromId === null) return { kind: "ungueltig", grund: "quelle_ungueltig" };
  if (zuschauer === null) return { kind: "ungueltig", grund: "zuschauer_ungueltig" };

  return {
    kind: "incoming",
    quelleKanalId: fromId,
    quelleKanalName: textwert(payload.from_broadcaster_user_name) ?? textwert(payload.from_broadcaster_user_login) ?? fromId,
    zuschauer,
    voll: zuschauer >= textSchwelle,
  };
};

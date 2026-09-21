const textwert = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const zuschauerwert = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

export type RaidEntscheidung =
  | {
    kind: "eingehend";
    quelleKanalId: string;
    quelleKanalName: string;
    zuschauer: number;
    voll: boolean;
  }
  | {
    kind: "ausgehend";
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
  mindestZuschauer: number,
): RaidEntscheidung => {
  const fromId = textwert(payload.from_broadcaster_user_id);
  const toId = textwert(payload.to_broadcaster_user_id);
  const zuschauer = zuschauerwert(payload.viewers);
  const outgoing = subscriptionVariant === "ausgehend" ||
    (subscriptionVariant !== "eingehend" && fromId === channelId);

  if (outgoing) return { kind: "ausgehend", zielKanalId: toId, zuschauer };
  if (toId !== channelId) return { kind: "ungueltig", grund: "ziel_ungueltig" };
  if (fromId === null) return { kind: "ungueltig", grund: "quelle_ungueltig" };
  if (zuschauer === null) return { kind: "ungueltig", grund: "zuschauer_ungueltig" };

  return {
    kind: "eingehend",
    quelleKanalId: fromId,
    quelleKanalName: textwert(payload.from_broadcaster_user_name) ?? textwert(payload.from_broadcaster_user_login) ?? fromId,
    zuschauer,
    voll: zuschauer >= mindestZuschauer,
  };
};

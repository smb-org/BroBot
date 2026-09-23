import type { RAID_TEMPLATE_FIELDS } from "../contracts";
import { renderTemplate } from "../contract";
import type { TemplateValues } from "../contract";

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const viewerValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

export type RaidDecision =
  | {
    kind: "incoming";
    sourceChannelId: string;
    sourceChannelName: string;
    viewers: number;
    aboveThreshold: boolean;
  }
  | {
    kind: "outgoing";
    targetChannelId: string | null;
    viewers: number | null;
  }
  | {
    kind: "invalid";
    reason: "ziel_ungueltig" | "quelle_ungueltig" | "zuschauer_ungueltig";
  };

export const renderRaidText = (
  template: string,
  values: TemplateValues<typeof RAID_TEMPLATE_FIELDS.textLong>,
): string => renderTemplate(template.trim(), values);

/** Distinguishes the two EventSub raid directions using the same pattern as channel events. */
export const decideRaid = (
  payload: Readonly<Record<string, unknown>>,
  channelId: string,
  subscriptionVariant: string | undefined,
  textThreshold: number,
): RaidDecision => {
  const fromId = textValue(payload.from_broadcaster_user_id);
  const toId = textValue(payload.to_broadcaster_user_id);
  const viewers = viewerValue(payload.viewers);
  const outgoing = subscriptionVariant === "outgoing" ||
    (subscriptionVariant !== "incoming" && fromId === channelId);

  if (outgoing) return { kind: "outgoing", targetChannelId: toId, viewers };
  if (toId !== channelId) return { kind: "invalid", reason: "ziel_ungueltig" };
  if (fromId === null) return { kind: "invalid", reason: "quelle_ungueltig" };
  if (viewers === null) return { kind: "invalid", reason: "zuschauer_ungueltig" };

  return {
    kind: "incoming",
    sourceChannelId: fromId,
    sourceChannelName: textValue(payload.from_broadcaster_user_name) ?? textValue(payload.from_broadcaster_user_login) ?? fromId,
    viewers,
    aboveThreshold: viewers >= textThreshold,
  };
};

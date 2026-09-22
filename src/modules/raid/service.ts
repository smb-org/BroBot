import type { ModuleEvent, ModuleResult } from "../contract";
import type { RaidSettings } from "./contracts";
import { decideRaid } from "./domain";

const textWithRaid = (template: string, channel: string, viewers: number): string => template
  .trim()
  .replaceAll("{channel}", channel)
  .replaceAll("{viewers}", String(viewers));

export const processRaid = (
  event: ModuleEvent<RaidSettings>,
): ModuleResult => {
  const decision = decideRaid(
    event.payload,
    event.channelId,
    event.subscriptionVariant,
    event.settings.textThreshold,
  );

  if (decision.kind === "outgoing") {
    return {
      actions: [],
      diagnostics: [{
        code: "raid.outgoing",
        detail: { targetChannelId: decision.targetChannelId, viewers: decision.viewers },
      }],
    };
  }

  if (decision.kind === "invalid") {
    return { actions: [], diagnostics: [{ code: "raid.ungueltig", detail: { reason: decision.reason } }] };
  }

  const chatText = textWithRaid(
    decision.aboveThreshold ? event.settings.textLong : event.settings.textShort,
    decision.sourceChannelName,
    decision.viewers,
  );
  const shoutoutPossible = event.settings.shoutoutEnabled && decision.viewers >= event.settings.shoutoutThreshold;
  if (!shoutoutPossible) {
    return {
      actions: [{ kind: "chat", text: chatText }],
      diagnostics: [{
        code: "shoutout.unterdrueckt",
        detail: {
          reason: event.settings.shoutoutEnabled ? "unter_schwelle" : "abgeschaltet",
          viewers: decision.viewers,
          threshold: event.settings.shoutoutThreshold,
        },
      }],
    };
  }

  return {
    actions: [
      { kind: "shoutout", targetChannelId: decision.sourceChannelId },
      { kind: "chat", text: chatText },
    ],
    diagnostics: [{
      code: "raid.shoutout",
      detail: {
        sourceChannelId: decision.sourceChannelId,
        viewers: decision.viewers,
        threshold: event.settings.shoutoutThreshold,
      },
    }],
  };
};

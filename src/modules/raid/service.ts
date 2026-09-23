import type { EventCode } from "../../contracts/values";
import type { ModuleEvent, ModuleResult } from "../contract";
import type { RaidSettings } from "./contracts";
import { decideRaid, renderRaidText } from "./domain";

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
        code: "raid.outgoing" satisfies EventCode,
        detail: { targetChannelId: decision.targetChannelId, viewers: decision.viewers },
      }],
    };
  }

  if (decision.kind === "invalid") {
    return { actions: [], diagnostics: [{ code: "raid.invalid" satisfies EventCode, detail: { reason: decision.reason } }] };
  }

  const chatText = renderRaidText(
    decision.aboveThreshold ? event.settings.textLong : event.settings.textShort,
    { channel: decision.sourceChannelName, viewers: decision.viewers },
  );
  const shoutoutPossible = event.settings.shoutoutEnabled && decision.viewers >= event.settings.shoutoutThreshold;
  if (!shoutoutPossible) {
    return {
      actions: [{ kind: "chat", text: chatText }],
      diagnostics: [{
        code: "shoutout.suppressed" satisfies EventCode,
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
      code: "raid.shoutout" satisfies EventCode,
      detail: {
        sourceChannelId: decision.sourceChannelId,
        viewers: decision.viewers,
        threshold: event.settings.shoutoutThreshold,
      },
    }],
  };
};

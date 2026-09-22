import type { ModuleEvent, ModuleResult } from "../contract";
import type { RaidSettings } from "./contracts";
import { entscheideRaid } from "./domain";

const textMitRaid = (vorlage: string, kanal: string, zuschauer: number): string => vorlage
  .trim()
  .replaceAll("{channel}", kanal)
  .replaceAll("{viewers}", String(zuschauer));

export const verarbeiteRaid = (
  event: ModuleEvent<RaidSettings>,
): ModuleResult => {
  const entscheidung = entscheideRaid(
    event.payload,
    event.channelId,
    event.subscriptionVariant,
    event.settings.textThreshold,
  );

  if (entscheidung.kind === "outgoing") {
    return {
      actions: [],
      diagnostics: [{
        code: "raid.outgoing",
        detail: { targetChannelId: entscheidung.targetChannelId, viewers: entscheidung.viewers },
      }],
    };
  }

  if (entscheidung.kind === "ungueltig") {
    return { actions: [], diagnostics: [{ code: "raid.ungueltig", detail: { reason: entscheidung.reason } }] };
  }

  const chatText = textMitRaid(
    entscheidung.voll ? event.settings.textLong : event.settings.textShort,
    entscheidung.quelleKanalName,
    entscheidung.viewers,
  );
  const shoutoutMoeglich = event.settings.shoutoutEnabled && entscheidung.viewers >= event.settings.shoutoutThreshold;
  if (!shoutoutMoeglich) {
    return {
      actions: [{ kind: "chat", text: chatText }],
      diagnostics: [{
        code: "shoutout.unterdrueckt",
        detail: {
          reason: event.settings.shoutoutEnabled ? "unter_schwelle" : "abgeschaltet",
          viewers: entscheidung.viewers,
          schwelle: event.settings.shoutoutThreshold,
        },
      }],
    };
  }

  return {
    actions: [
      { kind: "shoutout", targetChannelId: entscheidung.quelleKanalId },
      { kind: "chat", text: chatText },
    ],
    diagnostics: [{
      code: "raid.shoutout",
      detail: {
        quelleKanalId: entscheidung.quelleKanalId,
        viewers: entscheidung.viewers,
        schwelle: event.settings.shoutoutThreshold,
      },
    }],
  };
};

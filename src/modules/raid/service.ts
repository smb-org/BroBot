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
    event.settings.textSchwelle,
  );

  if (entscheidung.kind === "ausgehend") {
    return {
      actions: [],
      diagnostics: [{
        code: "raid.ausgehend",
        detail: { zielKanalId: entscheidung.zielKanalId, zuschauer: entscheidung.zuschauer },
      }],
    };
  }

  if (entscheidung.kind === "ungueltig") {
    return { actions: [], diagnostics: [{ code: "raid.ungueltig", detail: { grund: entscheidung.grund } }] };
  }

  const chatText = textMitRaid(
    entscheidung.voll ? event.settings.textVoll : event.settings.textKlein,
    entscheidung.quelleKanalName,
    entscheidung.zuschauer,
  );
  const shoutoutMoeglich = event.settings.shoutoutAktiv && entscheidung.zuschauer >= event.settings.shoutoutSchwelle;
  if (!shoutoutMoeglich) {
    return {
      actions: [{ kind: "chat", text: chatText }],
      diagnostics: [{
        code: "shoutout.unterdrueckt",
        detail: {
          grund: event.settings.shoutoutAktiv ? "unter_schwelle" : "abgeschaltet",
          zuschauer: entscheidung.zuschauer,
          schwelle: event.settings.shoutoutSchwelle,
        },
      }],
    };
  }

  return {
    actions: [
      { kind: "shoutout", zielKanalId: entscheidung.quelleKanalId },
      { kind: "chat", text: chatText },
    ],
    diagnostics: [{
      code: "raid.shoutout",
      detail: {
        quelleKanalId: entscheidung.quelleKanalId,
        zuschauer: entscheidung.zuschauer,
        schwelle: event.settings.shoutoutSchwelle,
      },
    }],
  };
};

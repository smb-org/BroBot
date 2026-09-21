import type { ModuleEvent, ModuleResult } from "../contract";
import type { RaidSettings } from "./contracts";
import { entscheideRaid } from "./domain";

const textMitRaid = (vorlage: string, kanal: string, zuschauer: number): string => vorlage
  .trim()
  .replaceAll("{kanal}", kanal)
  .replaceAll("{zuschauer}", String(zuschauer));

export const verarbeiteRaid = (
  event: ModuleEvent<RaidSettings>,
): ModuleResult => {
  const entscheidung = entscheideRaid(
    event.payload,
    event.channelId,
    event.subscriptionVariant,
    event.settings.mindestZuschauer,
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

  if (!entscheidung.voll) {
    return {
      actions: [{
        kind: "chat",
        text: textMitRaid(event.settings.textKlein, entscheidung.quelleKanalName, entscheidung.zuschauer),
      }],
      diagnostics: [{
        code: "shoutout.unterdrueckt",
        detail: {
          grund: "unter_schwelle",
          zuschauer: entscheidung.zuschauer,
          schwelle: event.settings.mindestZuschauer,
        },
      }],
    };
  }

  return {
    actions: [
      { kind: "shoutout", zielKanalId: entscheidung.quelleKanalId },
      {
        kind: "chat",
        text: textMitRaid(event.settings.textVoll, entscheidung.quelleKanalName, entscheidung.zuschauer),
      },
    ],
    diagnostics: [{
      code: "raid.shoutout",
      detail: {
        quelleKanalId: entscheidung.quelleKanalId,
        zuschauer: entscheidung.zuschauer,
        schwelle: event.settings.mindestZuschauer,
      },
    }],
  };
};

import type { ModuleRouteVariables } from "../contract";
import type { WerbungZeitplanAntwort } from "../contracts";
import { werbungSettingsSchema } from "../contracts";

const WARNING_SCOPE = "channel:read:ads";

interface WerbevorwarnungsPlaner {
  plane: (faelligAmMs: number) => Promise<void>;
  loesche: () => Promise<void>;
}

interface ChannelModuleSettingsRow {
  enabled: number;
  settings: string;
}

interface WerbevorwarnungsUmgebung extends Omit<Env, "CHANNEL"> {
  CHANNEL?: Env["CHANNEL"];
}

const planerFuer = (environment: WerbevorwarnungsUmgebung, channelId: string): WerbevorwarnungsPlaner | null => {
  if (environment.CHANNEL === undefined) return null;
  const stub = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId)) as unknown as {
    planeWerbevorwarnung: (faelligAmMs: number) => Promise<void>;
    loescheWerbevorwarnung: () => Promise<void>;
  };
  return {
    plane: (faelligAmMs) => stub.planeWerbevorwarnung(faelligAmMs),
    loesche: () => stub.loescheWerbevorwarnung(),
  };
};

const loesche = async (planer: WerbevorwarnungsPlaner | null): Promise<void> => {
  await planer?.loesche();
};

/** Hält den Vorwarnungswecker nach einem im Panel gelesenen Zeitplan aktuell. */
export const aktualisiereWerbevorwarnungswecker = async (
  environment: WerbevorwarnungsUmgebung,
  channelId: string,
  schedule: WerbungZeitplanAntwort["schedule"],
  broadcasterHasScope: ModuleRouteVariables["broadcasterHasScope"],
): Promise<void> => {
  const planer = planerFuer(environment, channelId);
  const row = await environment.DB.prepare(
    `SELECT enabled, settings
       FROM channel_modules
      WHERE channel_id = ? AND module_id = 'werbung'`,
  ).bind(channelId).first<ChannelModuleSettingsRow>();
  if (row === null || row.enabled !== 1) {
    await loesche(planer);
    return;
  }

  let rawSettings: unknown;
  try {
    rawSettings = JSON.parse(row.settings);
  } catch {
    await loesche(planer);
    return;
  }
  const settings = werbungSettingsSchema.safeParse(rawSettings);
  if (!settings.success || !settings.data.vorwarnung || !await broadcasterHasScope(
    environment.DB,
    channelId,
    WARNING_SCOPE,
  )) {
    await loesche(planer);
    return;
  }

  if (schedule.nextAdAt === null) {
    await loesche(planer);
    return;
  }
  const nextAdAtMs = Date.parse(schedule.nextAdAt);
  if (!Number.isFinite(nextAdAtMs)) {
    await loesche(planer);
    return;
  }
  await planer?.plane(nextAdAtMs - settings.data.vorlaufSekunden * 1000);
};

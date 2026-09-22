import type { ModuleRouteVariables } from "../contract";
import type { AdsScheduleResponse } from "../contracts";
import { adsSettingsSchema } from "../contracts";

const WARNING_SCOPE = "channel:read:ads";

interface AdPrewarningScheduler {
  schedule: (dueAtMs: number) => Promise<void>;
  clear: () => Promise<void>;
}

interface ChannelModuleSettingsRow {
  enabled: number;
  settings: string;
}

interface AdPrewarningEnvironment extends Omit<Env, "CHANNEL"> {
  CHANNEL?: Env["CHANNEL"];
}

const schedulerFor = (environment: AdPrewarningEnvironment, channelId: string): AdPrewarningScheduler | null => {
  if (environment.CHANNEL === undefined) return null;
  const stub = environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId)) as unknown as {
    scheduleAdPrewarning: (dueAtMs: number) => Promise<void>;
    clearAdPrewarning: () => Promise<void>;
  };
  return {
    schedule: (dueAtMs) => stub.scheduleAdPrewarning(dueAtMs),
    clear: () => stub.clearAdPrewarning(),
  };
};

const clearPrewarning = async (scheduler: AdPrewarningScheduler | null): Promise<void> => {
  await scheduler?.clear();
};

/** Hält den Vorwarnungswecker nach einem im Panel gelesenen Zeitplan aktuell. */
export const refreshAdPrewarningAlarm = async (
  environment: AdPrewarningEnvironment,
  channelId: string,
  schedule: AdsScheduleResponse["schedule"],
  broadcasterHasScope: ModuleRouteVariables["broadcasterHasScope"],
): Promise<void> => {
  const scheduler = schedulerFor(environment, channelId);
  const row = await environment.DB.prepare(
    `SELECT enabled, settings
       FROM channel_modules
      WHERE channel_id = ? AND module_id = 'ads'`,
  ).bind(channelId).first<ChannelModuleSettingsRow>();
  if (row === null || row.enabled !== 1) {
    await clearPrewarning(scheduler);
    return;
  }

  let rawSettings: unknown;
  try {
    rawSettings = JSON.parse(row.settings);
  } catch {
    await clearPrewarning(scheduler);
    return;
  }
  const settings = adsSettingsSchema.safeParse(rawSettings);
  if (!settings.success || !settings.data.prewarning || !await broadcasterHasScope(
    environment.DB,
    channelId,
    WARNING_SCOPE,
  )) {
    await clearPrewarning(scheduler);
    return;
  }

  if (schedule.nextAdAt === null) {
    await clearPrewarning(scheduler);
    return;
  }
  const nextAdAtMs = Date.parse(schedule.nextAdAt);
  if (!Number.isFinite(nextAdAtMs)) {
    await clearPrewarning(scheduler);
    return;
  }
  await scheduler?.schedule(nextAdAtMs - settings.data.leadSeconds * 1000);
};

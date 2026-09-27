import type { ModuleEventTimeContext, ResolvedModuleEventTime } from "../modules/contract";
import { MODULES } from "../modules/registry";
import { readChannelLocation } from "./db/channel-settings";

export interface ModuleEventTimeOption {
  id: string;
  label: Readonly<Record<"de" | "en", string>>;
}

export const moduleEventTimeOptions = (): readonly ModuleEventTimeOption[] => MODULES.flatMap((module) =>
  (module.eventTimeSources ?? []).map((source) => ({ id: `${module.id}.${source.id}`, label: source.label })),
);

export const resolveModuleEventTimes = async (
  db: D1Database,
  channelId: string,
  now: number,
): Promise<readonly ResolvedModuleEventTime[]> => {
  const [channel, channelLocation] = await Promise.all([
    db.prepare("SELECT time_zone FROM channels WHERE channel_id = ?").bind(channelId).first<{ time_zone: string }>(),
    readChannelLocation(db, channelId),
  ]);
  const context: ModuleEventTimeContext = {
    DB: db,
    channelId,
    now,
    channelTimeZone: () => Promise.resolve(channel?.time_zone ?? "Europe/Berlin"),
    channelLocation: () => Promise.resolve(channelLocation),
  };
  const resolved = await Promise.all(MODULES.flatMap((module) => (module.eventTimeSources ?? []).map(async (source) => {
    const times = await source.resolve(context);
    return times.flatMap((at): ResolvedModuleEventTime[] => {
      const instant = Date.parse(at);
      if (!Number.isFinite(instant) || instant <= now) return [];
      return [{ id: `${module.id}.${source.id}`, label: source.label, at: new Date(instant).toISOString() }];
    });
  })));
  return resolved.flat().sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
};

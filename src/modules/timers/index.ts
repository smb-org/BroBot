import { z } from "zod";

import { columnVariableReferences } from "../contract";
import type {
  BotModule,
  ModuleScheduleInputChangeReason,
  ModuleTemplateUsageSource,
} from "../contract";
import { timersModuleCatalog } from "./contracts/catalog";
import { timerRoutes } from "./routes";
import { validateTimerTemplateMutation } from "./service";

const settingsSchema = z.object({});
const TIMER_MODULE_ID = "timers";

const templateUsageSources = async (db: D1Database, channelId: string): Promise<readonly ModuleTemplateUsageSource[]> => {
  const result = await db.prepare("SELECT timer_id, name, message_text FROM timers WHERE channel_id = ?")
    .bind(channelId).all<{ timer_id: string; name: string; message_text: string }>();
  return result.results.map((row) => ({
    text: row.message_text,
    kind: "timer",
    label: row.name || row.timer_id,
  }));
};

const timerVariableReferences = columnVariableReferences({
  moduleId: TIMER_MODULE_ID,
  tableName: "timers",
  idColumn: "timer_id",
  itemNameColumn: "name",
  textColumn: "message_text",
  maxTextLength: 500,
});

export const timersModule: BotModule<typeof settingsSchema> = {
  id: TIMER_MODULE_ID,
  navigationCategory: "chat",
  panelIcon: { paths: ["M12 6v6l4 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"] },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateUsageSources,
  variableReferences: timerVariableReferences,
  validateTemplateContent: validateTimerTemplateMutation,
  navigationEntries: [{
    id: "timers",
    label: { de: timersModuleCatalog.de.label, en: timersModuleCatalog.en.label },
    description: { de: timersModuleCatalog.de.description, en: timersModuleCatalog.en.description },
    iconKind: "timers",
    keywords: ["timer", "timers", "schedule", "zeitplan", "zeitplanung"],
  }],
  liveTile: {
    load: async (channelId, signal) => {
      const timers = await (await import("./panel/service")).loadUpcomingTimers(channelId, signal);
      const now = Date.now();
      return timers.flatMap((timer) => {
        if (!timer.enabled || timer.nextRunAt === null || Date.parse(timer.nextRunAt) <= now) return [];
        return [{
          kind: "upcoming" as const,
          id: timer.id,
          category: "timer" as const,
          name: timer.name.trim() || timer.id,
          at: timer.nextRunAt,
          detail: null,
        }];
      }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).slice(0, 10);
    },
  },
  eventSubTypes: ["channel.chat.message"],
  dryRunSilentReason: "activity_tracking",
  alarms: [{
    key: "run",
    retryDelaysMs: [5_000, 15_000, 60_000],
    handle: async (context, key, deadline, ownerRevision) => {
      if (context.runTimerOccurrence === undefined) throw new Error("The channel timer scheduler is unavailable.");
      return await context.runTimerOccurrence(key, deadline, ownerRevision, context.alarmIdentity ?? null,
        context.alarmPlanSequence, context);
    },
    onScheduleInputsChanged: async (context, reason: ModuleScheduleInputChangeReason) => {
      if (context.reconcileTimerSchedules === undefined) throw new Error("The channel timer scheduler is unavailable.");
      await context.reconcileTimerSchedules(reason);
    },
  }],
  routes: timerRoutes,
  panel: () => import("./panel"),
};

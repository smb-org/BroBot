import { z } from "zod";

import { columnVariableReferences } from "../contract";
import type {
  BotModule,
  ModuleImmediateActionCondition,
  ModuleScheduleInputChangeReason,
  ModuleTemplateUsageSource,
} from "../contract";
import { timersModuleCatalog } from "./contracts/catalog";
import { timerRoutes } from "./routes";
import { validateTimerTemplateMutation } from "./service";
import { timersQuickActionTexts } from "./panel/quick-action-locale";

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

const timerHasPlannedOccurrence: ModuleImmediateActionCondition = {
  check: async ({ channelId, signal }) => {
    const timers = await (await import("./panel/service")).loadUpcomingTimers(channelId, signal);
    const planned = timers.some((timer) => timer.enabled && timer.nextRunAt !== null && Number.isFinite(Date.parse(timer.nextRunAt)));
    return { reason: planned ? null : timersQuickActionTexts.noPlanned };
  },
};

const skipTimerAction: NonNullable<BotModule["actions"]>[number] = {
  id: "skip-next-timer-message",
  name: timersQuickActionTexts.name,
  icon: "timer",
  conditions: ["moduleEnabled", timerHasPlannedOccurrence],
  requiredRole: "operator",
  content: { presentation: "popover", requiresReadiness: true, load: () => import("./panel/quick-action-content") },
  errorMessage: timersQuickActionTexts.error,
  execute: async ({ channelId, language, formData }) => {
    const timerId = formData.get("timerId");
    if (typeof timerId !== "string" || timerId.length === 0) {
      return { tone: "error", message: timersQuickActionTexts.error };
    }
    const result = await (await import("./panel/service")).skipNextTimerOccurrence(channelId, timerId);
    if (result.result === "skipped") {
      const nextTime = result.nextOccurrenceAt === null
        ? null
        : new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(result.nextOccurrenceAt));
      return { tone: "success", message: timersQuickActionTexts.success(nextTime) };
    }
    if (result.result === "already_skipped") return { tone: "info", message: timersQuickActionTexts.alreadySkipped };
    if (result.result === "nothing_planned") return { tone: "info", message: timersQuickActionTexts.nothingPlanned };
    return { tone: "error", message: timersQuickActionTexts.notFound };
  },
};

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
  actions: [skipTimerAction],
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

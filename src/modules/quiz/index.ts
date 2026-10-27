import type { BotModule, ModulePointRoundResult } from "../contract";
import { quizSettingsSchema, QUIZ_MODULE_ID } from "./contracts";
import { quizCatalog, quizCockpitTexts } from "./locale";
import { quizRoutes } from "./routes";
import { quizStarterSetStatements } from "./seed";
import { processQuizMessage, quizRoundData } from "./service";
import {
  formatQuizPointRoundAnnouncement,
  onQuizRoundDeadline,
  onQuizRoundAnnounced,
  onQuizRoundResolved,
  onQuizScheduleInputsChanged,
  quizSessionControlAlarm,
  resultChatLine,
} from "./lifecycle";
import { startQuizSession } from "./panel/service";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const quizModule: BotModule<typeof quizSettingsSchema> = {
  id: QUIZ_MODULE_ID,
  navigationCategory: "games",
  requiresModules: ["points"],
  panelIcon: { paths: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"] },
  settingsSchema: quizSettingsSchema,
  settingsReadSchema: quizSettingsSchema,
  defaultSettings: quizSettingsSchema.parse({}),
  routes: quizRoutes,
  eventSubTypes: ["channel.chat.message", "stream.online", "stream.offline"],
  pauseSafeEventSubTypes: ["stream.online", "stream.offline"],
  dryRunSilentReason: "round_answers",
  handleEvent: async (event, context) => {
    if (event.subscriptionType === "stream.online" || event.subscriptionType === "stream.offline") {
      if (context.streamStateTransitionAccepted === true) {
        await context.runModuleAlarm?.("session-control", "stream-state", {
          streamSnapshot: { state: event.subscriptionType === "stream.online" ? "online" : "offline" },
        });
      }
      return { actions: [], diagnostics: [] };
    }
    return processQuizMessage(event, context);
  },
  alarms: [{ ...quizSessionControlAlarm, onScheduleInputsChanged: onQuizScheduleInputsChanged }],
  serializeLifecycleMutations: true,
  serializePointRoundDeadline: true,
  preservePointRoundDeadlineOnAnnouncementFailure: true,
  retrySuppressedPointRoundAnnouncements: true,
  pointRoundCancellationNotice: false,
  overlayRealtimeElementKinds: ["quiz.session"],
  formatPointRoundAnnouncement: formatQuizPointRoundAnnouncement,
  formatPointRoundResult: (_context, round: ModulePointRoundResult) => {
    const data = quizRoundData(round.data);
    if (data === null || !data.chatQuestions) return Promise.resolve(null);
    const text = resultChatLine(data.language, round.result);
    return Promise.resolve(text === null ? null : { text });
  },
  onPointRoundAnnounced: onQuizRoundAnnounced,
  onPointRoundDeadline: onQuizRoundDeadline,
  onPointRoundResolved: onQuizRoundResolved,
  defaultEnabled: false,
  panel: () => import("./panel"),
  panelManagesSettings: true,
  actions: [{
    id: "start-quiz",
    name: { de: quizCatalog.de.startAction, en: quizCatalog.en.startAction },
    icon: "quiz",
    conditions: ["streamLive", "moduleEnabled", {
      check: async ({ channelId, signal, language }) => {
        const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/${QUIZ_MODULE_ID}/session/availability`, { signal });
        if (!response.ok) throw new Error("quiz_availability_unavailable");
        const reason = record(await response.json())?.reason;
        const labels = quizCockpitTexts(language);
        const reasonText = reason === "round_running" ? labels.roundRunning
          : reason === "question_pool_empty" ? labels.noQuestionSets : null;
        return { reason: reasonText === null ? null : { de: reasonText, en: reason === "round_running" ? quizCatalog.en.roundRunning : quizCatalog.en.noQuestionSets } };
      },
    }],
    requiredRole: "operator",
    errorMessage: { de: quizCatalog.de.actionError, en: quizCatalog.en.actionError },
    content: {
      presentation: "dialog",
      requiresReadiness: true,
      load: () => import("./panel/start-action-content"),
    },
    execute: async ({ channelId, formData }) => {
      const setId = formData.get("setId");
      const rawCount = formData.get("questionCount");
      if (typeof setId !== "string" || setId.length === 0 || (rawCount !== "" && typeof rawCount !== "string")) {
        throw new Error("invalid_quiz_start");
      }
      const questionCount = rawCount === "" || rawCount === "all" ? null : Number(rawCount);
      if (questionCount !== null && !Number.isSafeInteger(questionCount)) throw new Error("invalid_quiz_start");
      await startQuizSession(channelId, setId, questionCount);
      return { message: { de: quizCatalog.de.started, en: quizCatalog.en.started } };
    },
  }],
  liveTile: {
    load: async (channelId, signal) => {
      const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/${QUIZ_MODULE_ID}/session/state`, { signal });
      if (!response.ok) throw new Error("quiz_session_unavailable");
      const session = record(record(await response.json())?.session);
      if (session === null || typeof session.sessionId !== "string" || typeof session.setName !== "string" ||
          !["announce", "open", "reveal", "results"].includes(String(session.phase)) ||
          !Number.isSafeInteger(session.questionIndex) || !Number.isSafeInteger(session.questionCount) ||
          typeof session.paused !== "boolean" || !(session.phaseEndsAt === null || typeof session.phaseEndsAt === "string")) return [];
      return [{
        kind: "quiz",
        sessionId: session.sessionId,
        setName: session.setName,
        phase: session.phase as "announce" | "open" | "reveal" | "results",
        questionIndex: session.questionIndex as number,
        questionCount: session.questionCount as number,
        paused: session.paused,
        phaseEndsAt: session.phaseEndsAt,
      }];
    },
  },
  onEnable: async ({ DB, authorizeMutation, prepareModuleAudit, actor, now }, channelId) => {
    const language = (await DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
      .bind(channelId).first<{ language: "de" | "en" }>())?.language ?? "de";
    return quizStarterSetStatements(DB, channelId, language, now,
      authorizeMutation(channelId, actor, now), prepareModuleAudit);
  },
};

import type { JsonObject, ModuleLanguage } from "../../contract";
import { QUIZ_SESSION_OVERLAY_ELEMENT_KIND } from "./kinds";
import { quizOverlayTexts } from "./locale";
import { DEFAULT_QUIZ_OVERLAY_CONFIG, loadQuizOverlayState, mergeQuizOverlayRealtimeState, parseQuizOverlayConfig } from "./state";

const german = quizOverlayTexts("de");
const english = quizOverlayTexts("en");

const quizSessionOverlayElement = {
  kind: QUIZ_SESSION_OVERLAY_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: { width: 640, height: 360 },
  defaultConfig: DEFAULT_QUIZ_OVERLAY_CONFIG as unknown as JsonObject,
  previewState: (_config: JsonObject, language: ModuleLanguage, now: number): JsonObject => ({
    sessionId: "quiz-editor-preview",
    phase: "reveal",
    questionIndex: 1,
    questionCount: 5,
    question: quizOverlayTexts(language).previewQuestion,
    options: quizOverlayTexts(language).previewOptions,
    phaseEndsAt: new Date(now + 5_000).toISOString(),
    paused: false,
    remainingMs: null,
    serverNow: new Date(now).toISOString(),
    correctIndex: 0,
    answerDistribution: [12, 5, 3, 1],
  }),
  editorLabel: { de: german.editorLabel, en: english.editorLabel },
  editorDescription: { de: german.editorDescription, en: english.editorDescription },
  editorModuleLabel: { de: german.editorModuleLabel, en: english.editorModuleLabel },
  initialStateNeedsContext: true,
  mergeRealtimeStateOnModuleMessages: ["modul.quiz.phase", "modul.quiz.results"],
  mergeRealtimeState: mergeQuizOverlayRealtimeState,
  initialState: async (_db: D1Database, _channelId: string, _config: JsonObject, context: Parameters<typeof loadQuizOverlayState>[0]) =>
    loadQuizOverlayState(context),
  parseConfig: (raw: unknown) => {
    const config = parseQuizOverlayConfig(raw);
    return config === null ? null : config as unknown as JsonObject;
  },
  load: () => import("./view"),
  editor: () => import("./editor"),
};

export const quizOverlayElements = [quizSessionOverlayElement] as const;

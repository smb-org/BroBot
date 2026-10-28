import type { QuizSettings } from "../contracts";
import type { SettingsEditorSpec } from "../../../dashboard/ui";

export const quizSettingsSpec: SettingsEditorSpec<QuizSettings> = {
  sections: [
    { id: "rules", icon: "clock-hour-4", fields: [
      { kind: "number", key: "answerSeconds", min: 5, max: 300, step: 1, unit: "s" },
      { kind: "number", key: "revealSeconds", min: 1, max: 60, step: 1, unit: "s" },
    ] },
    { id: "reward", icon: "tabSettings", fields: [
      { kind: "number", key: "pot", min: 0, max: 100_000, step: 1 },
    ] },
    { id: "chat", icon: "tabMessages", fields: [
      { kind: "switchCard", key: "chatQuestions" },
    ] },
  ],
};


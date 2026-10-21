import { z } from "zod";

import { voteColorContrastIssue } from "./vote-colors";

const voteAnswerColorSchema = z.string()
  .regex(/^#[\da-f]{6}$/iu, "Use a six-digit hex color.")
  .transform((value) => value.toLowerCase())
  .refine((value) => voteColorContrastIssue(value) === null, "The color does not have enough contrast.");

export const chatVoteAnswerColorsSchema = z.array(voteAnswerColorSchema).max(9).superRefine((colors, context) => {
  if (new Set(colors).size !== colors.length) {
    context.addIssue({ code: "custom", message: "Answer colors must be unique." });
  }
});

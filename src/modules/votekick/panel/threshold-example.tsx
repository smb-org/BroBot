import type { ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { votekickThreshold } from "../domain";
import { votekickThresholdExampleTexts } from "./locale";
import "./threshold-example.css";

const safeInteger = (value: unknown, minimum: number, maximum: number): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;

export const VotekickThresholdExample = ({ minNetVotes, percent, language }: {
  minNetVotes: unknown;
  percent: unknown;
  language: DashboardLanguage;
}): ReactElement => {
  const words = votekickThresholdExampleTexts(language);
  const minimum = safeInteger(minNetVotes, 1, 100_000);
  const share = safeInteger(percent, 1, 100);
  const threshold = minimum === null || share === null ? null : votekickThreshold(minimum, share, 34);

  return <div className="votekick-threshold-example" aria-live="polite">
    <span>{words.lead(34)}</span>
    <strong>{words.result(threshold)}</strong>
    <p>{words.summary(minimum, share)}</p>
  </div>;
};

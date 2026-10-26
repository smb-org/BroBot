import type { HeistRoundData } from "./contracts";

export const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Validates the round data stored when the round opened; the confirmation fields are optional. */
export const heistRoundData = (value: unknown): HeistRoundData | null => {
  const data = record(value);
  return data !== null && (data.language === "de" || data.language === "en") &&
    Number.isSafeInteger(data.joinWindowSeconds) && (data.joinWindowSeconds as number) > 0 &&
    typeof data.startMessageId === "string" && typeof data.startText === "string" && typeof data.resultText === "string" &&
    (data.startTextEnabled === undefined || typeof data.startTextEnabled === "boolean") &&
    (data.resultTextEnabled === undefined || typeof data.resultTextEnabled === "boolean") &&
    (data.confirmText === undefined || typeof data.confirmText === "string") &&
    (data.confirmTextEnabled === undefined || typeof data.confirmTextEnabled === "boolean") &&
    (data.cooldownSeconds === undefined || (Number.isSafeInteger(data.cooldownSeconds) && (data.cooldownSeconds as number) >= 0))
    ? data as unknown as HeistRoundData
    : null;
};

/** One chat line: line breaks collapse and anything beyond 500 characters is cut. */
export const oneLine = (value: string): string => {
  const compact = value.replace(/[\r\n]+/gu, " ").trim();
  const characters = Array.from(compact);
  return characters.length > 500 ? `${characters.slice(0, 499).join("")}…` : compact;
};

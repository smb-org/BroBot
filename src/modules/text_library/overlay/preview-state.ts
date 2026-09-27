import type { JsonObject } from "../../contract";

const previewStateText = (text: string, examples: Readonly<Record<string, string>>): string => text.replace(/\{([a-z][a-z0-9_.]{0,63})\}/gu,
  (token, name: string) => name === "sun.set_in" || name === "sun.rise_in" ? token : examples[name] ?? (name.includes(".") ? "42" : name));

export const previewStateFor = (text: string, examples: Readonly<Record<string, string>>): JsonObject => {
  const now = Date.now();
  return {
    serverNow: new Date(now).toISOString(),
    timeZone: "Europe/Berlin",
    dataConditions: {},
    transitions: [],
    countdownTargets: {
      "sun.set_in": [new Date(now + 2 * 60 * 60 * 1_000).toISOString()],
      "sun.rise_in": [new Date(now + 8 * 60 * 60 * 1_000).toISOString()],
    },
    candidates: [{ conditions: {}, text: previewStateText(text, examples) }],
  };
};

import { useEffect, useState, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import type { TextBlockConditions } from "../contracts";
import { textBlockTimeConditionsMatch } from "../domain";

interface Candidate {
  conditions: TextBlockConditions;
  text: string;
}

interface Transition {
  at: string;
  values: Readonly<Record<string, string>>;
}

interface TextBlockState {
  serverNow: string;
  timeZone: string;
  dataConditions: Readonly<Record<string, string>>;
  transitions: readonly Transition[];
  countdownTargets: Readonly<Record<string, readonly string[]>>;
  candidates: readonly Candidate[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textBlockState = (value: unknown): TextBlockState | null => {
  if (!record(value) || typeof value.serverNow !== "string" || !Number.isFinite(Date.parse(value.serverNow)) ||
      typeof value.timeZone !== "string" || !record(value.dataConditions) || !Array.isArray(value.transitions) ||
      !record(value.countdownTargets) || !Array.isArray(value.candidates)) return null;
  const transitions = value.transitions.filter((item): item is Transition => record(item) &&
    typeof item.at === "string" && Number.isFinite(Date.parse(item.at)) && record(item.values));
  const candidates = value.candidates.filter((item): item is Candidate => record(item) && record(item.conditions) && typeof item.text === "string");
  const countdownTargets: Record<string, readonly string[]> = {};
  for (const [name, targets] of Object.entries(value.countdownTargets)) {
    if (Array.isArray(targets)) countdownTargets[name] = targets.filter((target): target is string => typeof target === "string" && Number.isFinite(Date.parse(target)));
  }
  return {
    serverNow: value.serverNow,
    timeZone: value.timeZone,
    dataConditions: Object.fromEntries(Object.entries(value.dataConditions).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    transitions,
    countdownTargets,
    candidates,
  };
};

const remainingText = (target: number, now: number, language: "de" | "en"): string => {
  const minutes = Math.max(0, Math.ceil((target - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const units = language === "de"
    ? { day: "Tag", days: "Tage", hour: "Std.", minute: "Min." }
    : { day: "day", days: "days", hour: "hr", minute: "min" };
  return [
    ...(days === 0 ? [] : [`${String(days)} ${days === 1 ? units.day : units.days}`]),
    ...(remainingHours === 0 ? [] : [`${String(remainingHours)} ${units.hour}`]),
    ...(remainder === 0 && (days > 0 || remainingHours > 0) ? [] : [`${String(remainder)} ${units.minute}`]),
  ].join(" ");
};

const dataAt = (state: TextBlockState, now: number): Readonly<Record<string, string>> => {
  const values: Record<string, string> = { ...state.dataConditions };
  for (const transition of state.transitions) {
    const at = Date.parse(transition.at);
    if (at > now) continue;
    Object.assign(values, transition.values);
  }
  return values;
};

export const TextBlockOverlayElement = ({ state: rawState, language = "en" }: ModuleOverlayElementProps): ReactElement | null => {
  const parsed = textBlockState(rawState);
  const serverNow = parsed === null ? Number.NaN : Date.parse(parsed.serverNow);
  const [clock, setClock] = useState(() => ({ serverNow: Number.NaN, offset: Number.NaN, now: serverNow }));

  useEffect(() => {
    if (!Number.isFinite(serverNow)) return;
    const offset = serverNow - performance.now();
    const timer = window.setInterval(() => {
      const monotonicNow = performance.now();
      setClock({ serverNow, offset, now: monotonicNow + offset });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [serverNow]);

  if (parsed === null || parsed.candidates.length === 0 || !Number.isFinite(serverNow)) return null;
  const now = clock.serverNow === serverNow ? clock.now : serverNow;
  const timeState = { now, timeZone: parsed.timeZone, dataConditions: dataAt(parsed, now) };
  const selected = parsed.candidates.find((candidate) => textBlockTimeConditionsMatch(candidate.conditions, timeState));
  if (selected === undefined) return null;
  const output = selected.text.replace(/\{([a-z][a-z0-9_.]{0,63})\}/gu, (token, name: string) => {
    const targets = parsed.countdownTargets[name];
    if (targets === undefined) return token;
    const next = targets.map(Date.parse).find((target) => target > now);
    const current = targets.map(Date.parse).filter((target) => Number.isFinite(target) && target <= now).at(-1);
    return next === undefined && current === undefined ? "" : remainingText(next ?? current ?? now, now, language);
  });
  if (output.trim().length === 0 || /\{[a-z][a-z0-9_.]{0,63}\}/u.test(output)) return null;
  return <span className="brobot-module-text">{output}</span>;
};

export default TextBlockOverlayElement;

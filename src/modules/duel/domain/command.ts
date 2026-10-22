import type { DuelSettings } from "../contracts";

export type DuelChallengeParseResult =
  | { ok: true; targetLogin: string | null; stake: number }
  | { ok: false; reason: "not_command" | "invalid_stake" | "out_of_range" };

export const parseDuelChallengeCommand = (text: string, settings: Pick<DuelSettings,
  "challengeCommand" | "defaultStake" | "minStake" | "maxStake">): DuelChallengeParseResult => {
  const [command, ...arguments_] = text.trim().split(/\s+/u);
  if (command?.toLocaleLowerCase("en-US") !== settings.challengeCommand.toLocaleLowerCase("en-US")) {
    return { ok: false, reason: "not_command" };
  }
  if (arguments_.length > 2) return { ok: false, reason: "invalid_stake" };

  const [first, second] = arguments_;
  let targetLogin: string | null = null;
  let rawStake = first;
  if (first?.startsWith("@")) {
    const login = first.slice(1);
    if (!/^[a-zA-Z0-9_]{1,25}$/u.test(login)) return { ok: false, reason: "invalid_stake" };
    targetLogin = login.toLocaleLowerCase("en-US");
    rawStake = second;
  } else if (second !== undefined) {
    return { ok: false, reason: "invalid_stake" };
  }

  let stake = settings.defaultStake;
  if (rawStake !== undefined) {
    if (!/^\d+$/u.test(rawStake)) return { ok: false, reason: "invalid_stake" };
    const parsed = Number(rawStake);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false, reason: "invalid_stake" };
    stake = parsed;
  }
  if (stake < settings.minStake || stake > settings.maxStake) return { ok: false, reason: "out_of_range" };
  return { ok: true, targetLogin, stake };
};

export const parseDuelAcceptCommand = (text: string, acceptCommand: string): boolean =>
  text.trim().toLocaleLowerCase("en-US") === acceptCommand.toLocaleLowerCase("en-US");

export const validateDuelTarget = (challengerId: string, targetId: string): "self_target" | null =>
  challengerId === targetId ? "self_target" : null;

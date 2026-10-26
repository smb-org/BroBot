export type HeistCommandResult =
  | { ok: true; stake: number }
  | { ok: false; reason: "not_command" | "invalid_stake" | "out_of_range" };

export const parseHeistCommand = (
  text: string,
  settings: { command: string; minStake: number; maxStake: number },
): HeistCommandResult => {
  const [command, rawStake, extra] = text.trim().split(/\s+/u);
  if (command?.toLocaleLowerCase("en-US") !== settings.command.toLocaleLowerCase("en-US")) {
    return { ok: false, reason: "not_command" };
  }
  if (rawStake === undefined || extra !== undefined || !/^\d+$/u.test(rawStake)) {
    return { ok: false, reason: "invalid_stake" };
  }
  const stake = Number(rawStake);
  if (!Number.isSafeInteger(stake) || stake < 1) return { ok: false, reason: "invalid_stake" };
  if (stake < settings.minStake || stake > settings.maxStake) return { ok: false, reason: "out_of_range" };
  return { ok: true, stake };
};

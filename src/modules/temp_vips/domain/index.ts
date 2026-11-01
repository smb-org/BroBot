const TEMP_VIP_MINIMUM_DURATION_MS = 10 * 60_000;

const DURATION_UNITS_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  t: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};

export const parseVipDuration = (value: string): number | null => {
  const match = /^(\d+)([mhdtw])$/iu.exec(value.trim());
  if (match === null) return null;

  const amount = Number(match[1]);
  const unit = DURATION_UNITS_MS[(match[2] ?? "").toLowerCase()];
  if (!Number.isSafeInteger(amount) || amount <= 0 || unit === undefined) return null;

  const durationMs = amount * unit;
  return Number.isSafeInteger(durationMs) && durationMs >= TEMP_VIP_MINIMUM_DURATION_MS ? durationMs : null;
};

type TempVipChatCommand =
  | { kind: "vip"; login: string | null; durationToken: string | null; problem: "usage" | null }
  | { kind: "unvip"; login: string | null; problem: "usage" | null }
  | { kind: "viptime"; login: string | null; problem: "usage" | null };

const targetLogin = (token: string | undefined): string | null => {
  if (token === undefined || !/^@[a-z0-9_]{1,25}$/iu.test(token)) return null;
  return token.slice(1).toLowerCase();
};

export const parseTempVipChatCommand = (text: string): TempVipChatCommand | null => {
  const trimmed = text.trim();
  const match = /^!(viptime|unvip|vip)(?=\s|$)(.*)$/iu.exec(trimmed);
  if (match === null) return null;

  const name = (match[1] ?? "").toLowerCase();
  const args = (match[2] ?? "").trim().split(/\s+/u).filter(Boolean);
  if (name === "vip") {
    const login = targetLogin(args[0]);
    const validShape = args.length >= 1 && args.length <= 2 && login !== null;
    return {
      kind: "vip",
      login: validShape ? login : null,
      durationToken: validShape ? args[1] ?? null : null,
      problem: validShape ? null : "usage",
    };
  }
  if (name === "unvip") {
    const login = targetLogin(args[0]);
    const validShape = args.length === 1 && login !== null;
    return { kind: "unvip", login: validShape ? login : null, problem: validShape ? null : "usage" };
  }

  if (args.length === 0) return { kind: "viptime", login: null, problem: null };
  const login = targetLogin(args[0]);
  const validShape = args.length === 1 && login !== null;
  return { kind: "viptime", login: validShape ? login : null, problem: validShape ? null : "usage" };
};

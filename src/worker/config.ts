import { isBase64url32Byte, parseKeyRing } from "./auth/crypto";

export const REQUIRED_SECRET_NAMES = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "PUBLIC_ORIGIN",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
] as const;

const KEY_RING_SECRET_NAMES = new Set([
  "TWITCH_EVENTSUB_SECRET",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
]);
const PLACEHOLDER_PATTERN = /replace-with|example\.invalid/i;

export const getMissingBindings = (env: Env): string[] =>
  REQUIRED_SECRET_NAMES.filter((name) => {
    const value = Reflect.get(env, name);
    if (typeof value !== "string" || value.length === 0 || PLACEHOLDER_PATTERN.test(value)) return true;
    if (name === "OVERLAY_TOKEN_PEPPER") return !isBase64url32Byte(value);
    if (!KEY_RING_SECRET_NAMES.has(name)) return false;
    try {
      parseKeyRing(value);
      return false;
    } catch {
      return true;
    }
  });

export const getHealthStatus = (env: Env): {
  status: "ok" | "misconfigured";
  missingBindings: string[];
  statusCode: 200 | 503;
} => {
  const missingBindings = getMissingBindings(env);
  return {
    status: missingBindings.length === 0 ? "ok" : "misconfigured",
    missingBindings,
    statusCode: missingBindings.length === 0 ? 200 : 503,
  };
};

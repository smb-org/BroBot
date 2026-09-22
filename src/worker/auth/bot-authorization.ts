import type { BotIdentityRecord } from "../db/bot-identity";
import type { SessionRecord } from "../db/sessions";

export const canConnectBot = (
  session: SessionRecord,
  environment: Pick<Env, "TWITCH_BOT_LOGIN">,
  botIdentity: BotIdentityRecord | null,
): boolean => session.login.toLowerCase() === environment.TWITCH_BOT_LOGIN.toLowerCase() &&
  (botIdentity === null || session.userId === botIdentity.userId);

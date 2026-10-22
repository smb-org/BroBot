import { Hono } from "hono";

import type { TestMessageResult } from "../../contracts/quick-actions";
import { textCommandQuickActionTexts } from "../../modules/text_commands/panel/quick-action-locale";
import { sendChatMessage } from "../chat";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";

interface QuickActionRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

export const quickActionRouter = new Hono<QuickActionRouteEnvironment>();

quickActionRouter.post(
  "/api/channels/:channelId/quick-actions/test-message",
  requireChannelAuthorization(),
  async (context) => {
    const channelId = context.req.param("channelId");
    const now = new Date().toISOString();
    const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
    const channel = await context.env.DB.prepare(
      `SELECT language FROM channels WHERE channel_id = ? ${authorization.sql}`,
    ).bind(channelId, ...authorization.values).first<{ language: string }>();
    if (channel === null) return context.json({ error: "test_message_denied" }, 403);

    const language = channel.language === "en" ? "en" : "de";
    const channelObject = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
    let localCooldownUntil = 0;
    const reservation: { claimedAt: number | null } = { claimedAt: null };
    const stillValid = async (): Promise<boolean> => {
      const currentAuthorization = context.get("authorizeMutation")(
        channelId,
        context.get("actor"),
        new Date().toISOString(),
      );
      const currentMember = await context.env.DB.prepare(
        `SELECT channel_id FROM channels WHERE channel_id = ? ${currentAuthorization.sql}`,
      ).bind(channelId, ...currentAuthorization.values).first<{ channel_id: string }>();
      return currentMember !== null;
    };
    const result = await sendChatMessage(
      context.env,
      channelId,
      textCommandQuickActionTexts.testMessage.chatText[language],
      undefined,
      fetch,
      stillValid,
      async () => {
        const claimAt = Date.now();
        const claim = await channelObject.claimTestMessageSend(claimAt);
        if (claim.allowed) {
          reservation.claimedAt = claimAt;
          localCooldownUntil = claimAt + 30_000;
          return true;
        }
        localCooldownUntil = claimAt + claim.retryAfter * 1_000;
        return "rate_limited";
      },
    );

    if (result.reason === "stale_before_send") {
      if (reservation.claimedAt !== null) await channelObject.releaseTestMessageSend(reservation.claimedAt);
      return context.json({ error: "test_message_denied" }, 403);
    }

    let response: TestMessageResult;
    if (result.sent) response = { result: "sent" };
    else if (result.reason === "bot_identity_missing") response = { result: "identity_missing" };
    else if (result.reason === "rate_limited") {
      const upstreamDeadline = result.detail.retryAfter;
      const localRemaining = Math.max(1, Math.ceil((localCooldownUntil - Date.now()) / 1_000));
      const upstreamRemaining = typeof upstreamDeadline === "number" && Number.isFinite(upstreamDeadline)
        ? Math.max(0, Math.ceil((upstreamDeadline - Date.now()) / 1_000))
        : 0;
      // The pre-send local reservation remains active after a definite Twitch
      // rejection; use the later deadline so retries do not hit either limit.
      const retryAfter = Math.max(localRemaining, upstreamRemaining);
      response = { result: "rate_limited", retryAfter };
    }
    else response = { result: "dropped", reason: result.reason ?? "not_sent" };
    return context.json(response);
  },
);

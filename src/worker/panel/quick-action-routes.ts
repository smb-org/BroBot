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
    let retryAfter = 30;
    const result = await sendChatMessage(
      context.env,
      channelId,
      textCommandQuickActionTexts.testMessage.chatText[language],
      undefined,
      fetch,
      undefined,
      async () => {
        const claim = await channelObject.claimTestMessageSend(Date.now());
        if (claim.allowed) return true;
        retryAfter = claim.retryAfter;
        return "rate_limited";
      },
    );

    let response: TestMessageResult;
    if (result.sent) response = { result: "sent" };
    else if (result.reason === "bot_identity_missing") response = { result: "identity_missing" };
    else if (result.reason === "rate_limited") response = { result: "rate_limited", retryAfter };
    else response = { result: "dropped", reason: result.reason ?? "not_sent" };
    return context.json(response);
  },
);

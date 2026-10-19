import type { ModuleAction, ModulePointsAccess } from "../modules/contract";
import { reserveChatTextBeforeSuffix } from "./chat";

export interface PendingPointWelcome {
  accountId: string;
  messageId: string;
  text: string;
  access: Pick<ModulePointsAccess, "ackWelcome">;
  used: boolean;
}

/** Adds the first-contact note to the next command reply and acknowledges only a successful send. */
export const appendPointWelcome = (
  action: ModuleAction,
  pending: PendingPointWelcome | undefined,
  attributions: readonly string[] = [],
  handledMessageId?: string,
): ModuleAction => {
  const responseMessageId = action.kind === "chat" ? action.replyToMessageId ?? handledMessageId : undefined;
  if (action.kind !== "chat" || pending === undefined || pending.used || responseMessageId !== pending.messageId) return action;
  const text = reserveChatTextBeforeSuffix(action.text, ` · ${pending.text}`, attributions);
  if (text === null) return action;
  pending.used = true;
  const originalDelivery = action.onDelivery;
  return {
    ...action,
    text,
    onDelivery: async (delivery) => {
      if (delivery === "sent") await pending.access.ackWelcome(pending.accountId);
      else pending.used = false;
      await originalDelivery?.(delivery);
    },
  };
};

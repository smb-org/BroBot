import type { ModuleAction, ModulePointsAccess } from "../modules/contract";

export interface PendingPointWelcome {
  accountId: string;
  messageId: string;
  text: string;
  access: Pick<ModulePointsAccess, "ackWelcome">;
  used: boolean;
}

/** Adds the first-contact note to the next command reply and acknowledges only a successful send. */
export const appendPointWelcome = (action: ModuleAction, pending: PendingPointWelcome | undefined): ModuleAction => {
  if (action.kind !== "chat" || pending === undefined || pending.used || action.replyToMessageId !== pending.messageId) return action;
  pending.used = true;
  const originalDelivery = action.onDelivery;
  return {
    ...action,
    text: `${action.text} · ${pending.text}`,
    onDelivery: async (delivery) => {
      if (delivery === "sent") await pending.access.ackWelcome(pending.accountId);
      else pending.used = false;
      await originalDelivery?.(delivery);
    },
  };
};

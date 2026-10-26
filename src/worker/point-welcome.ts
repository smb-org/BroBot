import type { BotModule, ModuleAction, ModulePointsAccess } from "../modules/contract";
import { reserveChatTextBeforeSuffix } from "./chat";

export const POINT_WELCOME_ACCOUNT_ID_KEY = "welcomeAccountId";
export const POINT_WELCOME_RESULT_ACCOUNT_ID_KEY = "welcomeResultAccountId";

export interface PointWelcomeNote {
  accountId: string;
  messageId: string;
  text: string;
}

export interface PendingPointWelcome extends PointWelcomeNote {
  access: Pick<ModulePointsAccess, "ackWelcome" | "claimWelcome" | "releaseWelcome">;
  deliveryClaimId?: string;
  used: boolean;
}

/** Adds the first-contact note to the next points or game reply and acknowledges only a successful send. */
export const appendPointWelcome = (
  action: ModuleAction,
  module: Pick<BotModule, "id" | "requiresModules">,
  pending: PendingPointWelcome | undefined,
  attributions: readonly string[] = [],
  commandResponseMessageId?: string,
): ModuleAction => {
  if (action.kind !== "chat" || pending === undefined || pending.used) return action;
  // The note only makes sense next to points; replies of other modules leave the welcome pending.
  if (module.id !== "points" && module.requiresModules?.includes("points") !== true) return action;
  const respondsToViewer = action.replyToMessageId === pending.messageId ||
    action.replyToMessageId === undefined && commandResponseMessageId === pending.messageId;
  if (!respondsToViewer) return action;
  const text = reserveChatTextBeforeSuffix(action.text, ` · ${pending.text}`, attributions);
  if (text === null) return action;
  pending.used = true;
  const originalDelivery = action.onDelivery;
  return {
    ...action,
    text,
    onDelivery: async (delivery) => {
      if (delivery === "sent") {
        if (pending.deliveryClaimId === undefined) await pending.access.ackWelcome(pending.accountId);
        else await pending.access.ackWelcome(pending.accountId, pending.deliveryClaimId);
      }
      else if (delivery !== "ambiguous") {
        if (pending.deliveryClaimId !== undefined) {
          await pending.access.releaseWelcome?.(pending.accountId, pending.deliveryClaimId);
        }
        pending.used = false;
      }
      await originalDelivery?.(delivery);
    },
  };
};

import type { BotModule, ModuleAction, ModuleChatDelivery, ModulePointsAccess, PointWelcomeKind } from "../modules/contract";
import { reserveChatTextBeforeSuffix } from "./chat";

export const POINT_WELCOME_ACCOUNT_ID_KEY = "welcomeAccountId";
export const POINT_WELCOME_RESULT_ACCOUNT_ID_KEY = "welcomeResultAccountId";

export interface PointWelcomeNote {
  accountId: string;
  messageId: string;
  text: string;
  kind: PointWelcomeKind;
}

export interface PendingPointWelcome extends PointWelcomeNote {
  access: Pick<ModulePointsAccess, "ackWelcome" | "claimWelcome" | "releaseWelcome">;
  deliveryClaimId?: string;
  used: boolean;
}

type PointWelcomeDeliveryClaim = Pick<PendingPointWelcome, "accountId" | "access" | "deliveryClaimId" | "used">;

/** Finalizes a welcome only when the posted receipt proves this exact claim carried the note. */
export const finalizePointWelcomeDelivery = async (
  pending: PointWelcomeDeliveryClaim,
  delivery: ModuleChatDelivery,
  postedWelcomeClaimId?: string,
): Promise<void> => {
  const claimId = pending.deliveryClaimId;
  if (delivery === "sent" && claimId !== undefined && postedWelcomeClaimId === claimId) {
    await pending.access.ackWelcome(pending.accountId, claimId);
    return;
  }
  if (delivery === "ambiguous") return;
  if (claimId !== undefined) await pending.access.releaseWelcome?.(pending.accountId, claimId);
  pending.used = false;
};

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
    ...(pending.deliveryClaimId === undefined ? {} : {
      pointWelcome: { claimId: pending.deliveryClaimId, text: pending.text },
    }),
    onDelivery: async (delivery, postedWelcomeClaimId) => {
      await finalizePointWelcomeDelivery(pending, delivery, postedWelcomeClaimId);
      await originalDelivery?.(delivery, postedWelcomeClaimId);
    },
  };
};

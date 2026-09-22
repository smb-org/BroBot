import type { ModuleEvent, ModuleResult } from "../contract";
import { isEventSubSubscriptionType } from "../../contracts/values";
import { diagnoseChannelEvent } from "./domain";

export const processChannelEvent = (event: ModuleEvent): ModuleResult => {
  if (!isEventSubSubscriptionType(event.subscriptionType)) return { actions: [], diagnostics: [] };
  return {
    actions: [],
    diagnostics: diagnoseChannelEvent(
      event.subscriptionType,
      event.payload,
      event.channelId,
      event.subscriptionVariant,
      event.receivedAt,
    ),
  };
};

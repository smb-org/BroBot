import type { ModuleEvent, ModuleResult } from "../contract";
import { isEventSubSubscriptionType } from "../../contracts/values";
import { diagnostiziereKanalereignis } from "./domain";

export const verarbeiteKanalereignis = (event: ModuleEvent): ModuleResult => {
  if (!isEventSubSubscriptionType(event.subscriptionType)) return { actions: [], diagnostics: [] };
  return {
    actions: [],
    diagnostics: diagnostiziereKanalereignis(
      event.subscriptionType,
      event.payload,
      event.channelId,
      event.subscriptionVariant,
      event.receivedAt,
    ),
  };
};

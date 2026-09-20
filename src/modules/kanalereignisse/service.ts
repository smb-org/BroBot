import type { ModuleEvent, ModuleResult } from "../contract";
import { diagnostiziereKanalereignis } from "./domain";

export const verarbeiteKanalereignis = (event: ModuleEvent): ModuleResult => ({
  actions: [],
  diagnostics: diagnostiziereKanalereignis(
    event.subscriptionType,
    event.payload,
    event.channelId,
    event.subscriptionVariant,
  ),
});

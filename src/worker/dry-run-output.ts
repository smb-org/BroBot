import type { DryRunBlockCode, DryRunEffect, DryRunEntryReport } from "../contracts/dry-run";
import type { BotModule, ModuleEvent } from "../modules/contract";
import { forSourceOnlyForChatTarget, truncateChatTextWithAttributions } from "./chat";
import { chatOutputSuppressionReason, moderationOutputSuppressionReason } from "./chat-output-gate";

export const withHostBlocks = (
  report: DryRunEntryReport,
  moduleDisabled: boolean,
  channelPaused: boolean,
): DryRunEntryReport => {
  if (!moduleDisabled && !channelPaused) return report;
  const hostBlocks = [
    ...(moduleDisabled ? [{ code: "host.module_disabled" as const satisfies DryRunBlockCode }] : []),
    ...(channelPaused ? [{ code: "host.channel_paused" as const satisfies DryRunBlockCode }] : []),
  ];
  return { ...report, outcome: "blocked", blocks: [...report.blocks, ...hostBlocks], effects: [] };
};

export const withOutputGate = (
  report: DryRunEntryReport,
  module: BotModule,
  event: ModuleEvent,
  channelId: string,
  muted: boolean,
  paused: boolean,
): DryRunEntryReport => ({
  ...report,
  effects: report.effects.map((effect): DryRunEffect => {
    if (effect.kind === "chat" || effect.kind === "announcement") {
      const { attributions = [], ...visibleEffect } = effect;
      const suppression = chatOutputSuppressionReason({
        moduleEnabled: true,
        mandatory: module.mandatory === true,
        paused: false,
        muted,
      });
      const prepared = truncateChatTextWithAttributions(effect.text, attributions);
      return {
        ...visibleEffect,
        text: prepared.text,
        postsTo: forSourceOnlyForChatTarget(
          effect.target,
          channelId,
          event.payload.source_broadcaster_user_id as string | null | undefined,
        ) ? "this_chat" : "all_shared_chats",
        suppressedBy: suppression,
      };
    }
    if (effect.kind === "shoutout") {
      const suppression = chatOutputSuppressionReason({
        moduleEnabled: true,
        mandatory: module.mandatory === true,
        paused: false,
        muted,
      });
      return suppression === null ? effect : { ...effect, suppressedBy: suppression };
    }
    if (effect.kind === "timeout") {
      const suppression = moderationOutputSuppressionReason({ muted, paused });
      return suppression === null ? effect : { ...effect, suppressedBy: suppression };
    }
    return effect;
  }),
});

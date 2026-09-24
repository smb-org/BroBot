import type { EventCode, ShoutoutSuppressedReason } from "../../contracts/values";
import type { ModuleDiagnostic, ModuleEvent, ModuleResult } from "../contract";
import type { RaidSettings } from "./contracts";
import { decideRaid, renderRaidText } from "./domain";

export function processRaid(event: ModuleEvent<RaidSettings>): ModuleResult;
export function processRaid(
  event: ModuleEvent<RaidSettings>,
  render: (text: string, values: Readonly<Record<string, string | number>>) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[] }>,
): Promise<ModuleResult>;
export function processRaid(
  event: ModuleEvent<RaidSettings>,
  render?: (text: string, values: Readonly<Record<string, string | number>>) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[] }>,
): ModuleResult | Promise<ModuleResult> {
  const decision = decideRaid(
    event.payload,
    event.channelId,
    event.subscriptionVariant,
    event.settings.textThreshold,
  );

  if (decision.kind === "outgoing") {
    return {
      actions: [],
      diagnostics: [{
        code: "raid.outgoing" satisfies EventCode,
        detail: { targetChannelId: decision.targetChannelId, viewers: decision.viewers },
      }],
    };
  }

  if (decision.kind === "invalid") {
    return { actions: [], diagnostics: [{ code: "raid.invalid" satisfies EventCode, detail: { reason: decision.reason } }] };
  }

  const template = decision.aboveThreshold ? event.settings.textLong : event.settings.textShort;
  const moduleValues = { channel: decision.sourceChannelName, viewers: decision.viewers };
  const makeResult = (chatText: string, templateDiagnostics: readonly ModuleDiagnostic[] = []): ModuleResult => {
  const shoutoutPossible = event.settings.shoutoutEnabled && decision.viewers >= event.settings.shoutoutThreshold;
  if (!shoutoutPossible) {
    return {
      actions: [{ kind: "chat", text: chatText }],
      diagnostics: [...templateDiagnostics, {
        code: "shoutout.suppressed" satisfies EventCode,
        detail: {
          reason: (event.settings.shoutoutEnabled ? "below_threshold" : "disabled") satisfies ShoutoutSuppressedReason,
          viewers: decision.viewers,
          threshold: event.settings.shoutoutThreshold,
        },
      }],
    };
  }

  return {
    actions: [
      { kind: "shoutout", targetChannelId: decision.sourceChannelId },
      { kind: "chat", text: chatText },
    ],
    diagnostics: [...templateDiagnostics, {
      code: "raid.shoutout" satisfies EventCode,
      detail: {
        sourceChannelId: decision.sourceChannelId,
        viewers: decision.viewers,
        threshold: event.settings.shoutoutThreshold,
      },
    }],
  };
  };
  if (render !== undefined) return render(template, moduleValues).then(({ text, diagnostics }) => makeResult(text, diagnostics));
  return makeResult(renderRaidText(template, moduleValues));
}

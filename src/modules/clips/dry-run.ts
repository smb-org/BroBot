import type { DryRunEntryReport } from "../../contracts/dry-run";
import { chatStatusMeetsMinimumTier, type ModuleDryRunContext, type ModuleEvent } from "../contract";
import type { ClipsSettings } from "./contracts";

const messageText = (event: ModuleEvent): string | null => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const text: unknown = Reflect.get(message, "text");
  return typeof text === "string" ? text : null;
};

export const dryRunClipsChatMessage = async (
  event: ModuleEvent<ClipsSettings>,
  context: ModuleDryRunContext,
): Promise<readonly DryRunEntryReport[]> => {
  if (event.subscriptionType !== "channel.chat.message" || messageText(event)?.trim().toLowerCase() !== "!clip") return [];

  const base = {
    moduleId: "clips",
    entry: { kind: "clip" as const, id: "clip", label: "!clip" },
    match: { kind: "command_name" as const, token: "!clip" },
    templateNotes: [],
  };
  if (!chatStatusMeetsMinimumTier(event.chatStatus, event.settings.commandMinimumRole)) {
    return [{
      ...base,
      outcome: "blocked",
      blocks: [{
        code: "clips.permission_denied",
        detail: {
          requiredTier: event.settings.commandMinimumRole === "viewer" ? "everyone" : event.settings.commandMinimumRole,
          currentTier: event.chatStatus?.[0] ?? "viewer",
        },
      }],
      effects: [],
    }];
  }

  if (event.settings.commandCooldownSeconds > 0) {
    const remainingSeconds = await context.pointCooldownRemaining?.("clips", "clip") ?? 0;
    if (remainingSeconds > 0) {
      return [{
        ...base,
        outcome: "blocked",
        blocks: [{ code: "clips.cooldown", detail: { name: "clip", remainingSeconds } }],
        effects: [],
      }];
    }
  }

  return [{ ...base, outcome: "fires", blocks: [], effects: [{ kind: "clip" }] }];
};

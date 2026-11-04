import { z } from "zod";

import type { BotModule, ModuleImmediateActionCondition, ModuleImmediateActionResult } from "../contract";
import { POLLS_MODULE_ID } from "./contracts";
import { pollsRoutes } from "./routes";
import { processPollsEvent } from "./service";
import { pollsCockpitActionTexts } from "./panel/action-locale";
import { pollsApiErrorMessage } from "./panel/error-message";
import { isPollsPanelState, openPollsPredictions } from "./panel/action-model";
import { pollsPanelTexts } from "./panel/locale";
import { loadPollsActionReadiness, loadPollsState, resolvePollsRun, startPollsEntry, type PollsActionReadiness, type PollsPanelState } from "./panel/service";

const pollsStartPermission: ModuleImmediateActionCondition = {
  query: {
    moduleId: POLLS_MODULE_ID,
    part: "action-availability-start",
    load: async (channelId, signal) => {
      try {
        return await loadPollsActionReadiness(channelId, signal);
      } catch {
        return { ready: false, missingScopes: [], metadataUnknown: true } satisfies PollsActionReadiness;
      }
    },
    evaluate: (value) => {
      if (typeof value !== "object" || value === null) {
        return { reason: { de: pollsCockpitActionTexts.de.scopeCheckFailed, en: pollsCockpitActionTexts.en.scopeCheckFailed } };
      }
      const state = value as PollsActionReadiness;
      if (!state.metadataUnknown && state.ready && Array.isArray(state.missingScopes) && state.missingScopes.length === 0) {
        return { reason: null };
      }
      const reason = state.metadataUnknown || !Array.isArray(state.missingScopes) ||
        (!state.ready && state.missingScopes.length === 0)
        ? { de: pollsCockpitActionTexts.de.scopeCheckFailed, en: pollsCockpitActionTexts.en.scopeCheckFailed }
        : {
          de: pollsCockpitActionTexts.de.scopeMissing(state.missingScopes),
          en: pollsCockpitActionTexts.en.scopeMissing(state.missingScopes),
        };
      return { reason };
    },
  },
};

const pollsResolveAvailability: ModuleImmediateActionCondition = {
  query: {
    moduleId: POLLS_MODULE_ID,
    part: "data",
    load: async (channelId, signal): Promise<PollsPanelState | null> => {
      try {
        return await loadPollsState(channelId, signal);
      } catch {
        return null;
      }
    },
    evaluate: (value) => {
      if (!isPollsPanelState(value)) {
        return { reason: { de: pollsCockpitActionTexts.de.openPredictionCheckFailed, en: pollsCockpitActionTexts.en.openPredictionCheckFailed } };
      }
      const predictions = openPollsPredictions(value);
      return predictions.length > 0
        ? { reason: null }
        : { reason: { de: pollsCockpitActionTexts.de.noOpenPrediction, en: pollsCockpitActionTexts.en.noOpenPrediction } };
    },
  },
};

const actionResult = (tone: NonNullable<ModuleImmediateActionResult["tone"]>, de: string, en: string): ModuleImmediateActionResult => ({
  tone,
  message: { de, en },
});

const startPollsAction = async (channelId: string, formData: FormData): Promise<ModuleImmediateActionResult> => {
  const entryId = formData.get("entryId");
  if (typeof entryId !== "string" || entryId.length === 0) {
    return actionResult("error", pollsPanelTexts.de.invalidEntry, pollsPanelTexts.en.invalidEntry);
  }
  try {
    await startPollsEntry(channelId, entryId);
    return actionResult("success", pollsPanelTexts.de.successStarted, pollsPanelTexts.en.successStarted);
  } catch (error) {
    return actionResult("error", pollsApiErrorMessage(error, pollsPanelTexts.de), pollsApiErrorMessage(error, pollsPanelTexts.en));
  }
};

const resolvePollsAction = async (channelId: string, formData: FormData): Promise<ModuleImmediateActionResult> => {
  const runId = formData.get("runId");
  const winningChoiceId = formData.get("winningChoiceId");
  if (typeof runId !== "string" || runId.length === 0 || typeof winningChoiceId !== "string" || winningChoiceId.length === 0) {
    return actionResult("error", pollsPanelTexts.de.choiceInvalid, pollsPanelTexts.en.choiceInvalid);
  }
  try {
    await resolvePollsRun(channelId, runId, winningChoiceId);
    return actionResult("success", pollsPanelTexts.de.successResolved, pollsPanelTexts.en.successResolved);
  } catch (error) {
    return actionResult("error", pollsApiErrorMessage(error, pollsPanelTexts.de), pollsApiErrorMessage(error, pollsPanelTexts.en));
  }
};

const pollsSettingsSchema = z.object({});

export const pollsModule: BotModule<typeof pollsSettingsSchema> = {
  id: POLLS_MODULE_ID,
  navigationCategory: "twitch",
  settingsSchema: pollsSettingsSchema,
  defaultSettings: pollsSettingsSchema.parse({}),
  broadcasterScopes: ["channel:manage:polls", "channel:manage:predictions"],
  eventSubTypes: [
    "channel.poll.begin",
    "channel.poll.progress",
    "channel.poll.end",
    "channel.prediction.begin",
    "channel.prediction.progress",
    "channel.prediction.lock",
    "channel.prediction.end",
  ],
  pauseSafeEventSubTypes: [
    "channel.poll.begin",
    "channel.poll.progress",
    "channel.poll.end",
    "channel.prediction.begin",
    "channel.prediction.progress",
    "channel.prediction.lock",
    "channel.prediction.end",
  ],
  handleEvent: processPollsEvent,
  routes: pollsRoutes,
  defaultEnabled: false,
  panelIcon: { paths: ["M4 6h10", "M4 12h16", "M4 18h7"] },
  panel: () => import("./panel"),
  actions: [
    {
      id: "start",
      name: { de: pollsCockpitActionTexts.de.startName, en: pollsCockpitActionTexts.en.startName },
      icon: "vote",
      conditions: ["moduleEnabled", pollsStartPermission],
      requiredRole: "operator",
      content: { presentation: "dialog", hideSubmit: true, load: () => import("./panel/cockpit-action-content") },
      errorMessage: { de: pollsCockpitActionTexts.de.error, en: pollsCockpitActionTexts.en.error },
      execute: ({ channelId, formData }) => startPollsAction(channelId, formData),
    },
    {
      id: "resolve",
      name: { de: pollsCockpitActionTexts.de.resolveName, en: pollsCockpitActionTexts.en.resolveName },
      icon: "vote",
      conditions: ["moduleEnabled", pollsResolveAvailability],
      requiredRole: "operator",
      content: { presentation: "dialog", hideSubmit: true, load: () => import("./panel/resolve-cockpit-action-content") },
      errorMessage: { de: pollsCockpitActionTexts.de.error, en: pollsCockpitActionTexts.en.error },
      execute: ({ channelId, formData }) => resolvePollsAction(channelId, formData),
    },
  ],
};

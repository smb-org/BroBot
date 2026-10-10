import { settingsVariableReferences } from "../contract";
import type { BotModule, JsonObject, ModuleOverlayElementContext } from "../contract";
import { createChatVotingRepository } from "./repository";
import { CHAT_VOTING_CHAT_COMMANDS } from "./contracts/chat-commands";
import { chatVotingDurationVariableCatalog, chatVotingOptionsVariableCatalog, chatVotingResultVariableCatalog, chatVotingTitleVariableCatalog } from "./contracts/template-variable-catalog";
import { chatVotingAlarmDefinition, chatVotingStartAnnouncementAlarmDefinition, processChatVotingMessage } from "./service";
import { CHAT_VOTING_ELEMENT_KIND, CHAT_VOTING_MODULE_ID, DEFAULT_CHAT_VOTING_SETTINGS, chatVotingSettingsSchema } from "./contracts";
import { chatVotingOverlayElements } from "./overlay/element";
import { chatVotingOverlayLabels } from "./overlay/locale";
import { chatVotingRoutes } from "./routes";

const settingsSchema = chatVotingSettingsSchema;

const resultVariable = {
  name: "vote.result",
  maxLength: 420,
  sample: "Yes: 8 (67%) · No: 4 (33%)",
  picker: chatVotingResultVariableCatalog,
} as const;

const titleVariable = {
  name: "vote.title",
  maxLength: 80,
  sample: "Pizza today?",
  picker: chatVotingTitleVariableCatalog,
} as const;

const optionsVariable = {
  name: "vote.options",
  maxLength: 500,
  sample: "1 = Pizza, 2 = Burger, 3 = Kebab",
  picker: chatVotingOptionsVariableCatalog,
} as const;

const durationVariable = {
  name: "vote.duration",
  maxLength: 16,
  sample: "2 minutes",
  picker: chatVotingDurationVariableCatalog,
} as const;

const initialTallyState = async (
  db: D1Database,
  channelId: string,
  config: Readonly<Record<string, unknown>>,
  context?: ModuleOverlayElementContext,
) => {
  const vote = await createChatVotingRepository(db).latest(channelId);
  if (vote === null) return null;
  let counts: readonly number[] | null = vote.counts;
  let revision = 0;
  let terms = vote.textResults ?? null;
  let more = vote.moreTerms;
  let termFilterReady = vote.termFilterReady ?? false;
  if (vote.status === "open") {
    const snapshot = await context?.readBallot(vote.id) ?? null;
    if (snapshot === null) return null;
    counts = snapshot.counts;
    revision = snapshot.revision;
    terms = snapshot.terms ?? null;
    more = snapshot.more ?? null;
    termFilterReady = snapshot.termFilterReady ?? false;
  } else {
    const hiddenAfterSeconds = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;
    const closedAt = vote.closedAt === null ? Number.NaN : Date.parse(vote.closedAt);
    if (!Number.isFinite(closedAt) || hiddenAfterSeconds === 0 || Date.now() >= closedAt + hiddenAfterSeconds * 1_000) return null;
  }
  if (counts === null) return null;
  return {
    pollId: vote.id,
    status: vote.status,
    title: vote.title,
    preset: vote.preset,
    optionCount: vote.optionCount,
    textMode: vote.textMode ?? null,
    labels: [...vote.labels],
    counts: [...counts],
    ...(terms === null ? {} : { terms: terms.map((entry) => ({ ...entry })) }),
    ...(more === null ? {} : { more }),
    termFilterReady,
    revision,
    openedAt: vote.openedAt,
    closesAt: vote.closesAt,
    requestedDurationSeconds: vote.requestedDurationSeconds,
    closedAt: vote.closedAt,
    closeReason: vote.closeReason,
    voterCount: vote.voterCount,
  };
};

export const chatVotingModule: BotModule<typeof settingsSchema> = {
  id: CHAT_VOTING_MODULE_ID,
  navigationCategory: "interaction",
  panelIcon: { paths: ["M4 5h16v14H4z", "M7 9h3", "M14 9h3", "M7 13h3", "M14 13h3", "M10 17h4"] },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: DEFAULT_CHAT_VOTING_SETTINGS,
  chatCommands: CHAT_VOTING_CHAT_COMMANDS,
  templateContext: "event",
  templateFields: {
    startText: [titleVariable, optionsVariable, durationVariable],
    resultText: [resultVariable, titleVariable, optionsVariable, durationVariable],
  },
  variableReferences: settingsVariableReferences(CHAT_VOTING_MODULE_ID, ["startText", "resultText"]),
  templateVariableGroup: {
    label: { de: "Abstimmung", en: "Voting" },
    icon: { paths: ["M4 5h16v14H4z", "M7 9h3", "M14 9h3", "M7 13h3", "M14 13h3"] },
  },
  routes: chatVotingRoutes,
  panel: () => import("./panel"),
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorRelatedParts: ["panel"],
  eventSubTypes: ["channel.chat.message"],
  alarms: [chatVotingAlarmDefinition, chatVotingStartAnnouncementAlarmDefinition],
  overlayElements: chatVotingOverlayElements.map((element) => ({
    ...element,
    kind: CHAT_VOTING_ELEMENT_KIND,
    initialStateNeedsContext: true,
    initialState: (db: D1Database, channelId: string, config: JsonObject, context?: ModuleOverlayElementContext) =>
      initialTallyState(db, channelId, config, context),
  })),
  handleEvent: (event, context) => processChatVotingMessage(event, createChatVotingRepository(context.DB), context),
};

export { CHAT_VOTING_ELEMENT_KIND };
export type { ChatVote, ChatVoteCloseReason, ChatVotePreset, ChatVotingSettings } from "./contracts";
export { chatVotingOverlayLabels };

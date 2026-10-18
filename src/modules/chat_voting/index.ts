import { moduleVariableRenameTarget, settingsVariableReferences } from "../contract";
import {
  CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL,
  findChatVoteResultTextReferences,
  prepareChatVoteResultTextReferenceRewrite,
} from "../contracts/chat-vote-result-text-references";
import type { BotModule, JsonObject, ModuleOverlayElementContext, ModuleTemplateUsageSource, ModuleVariableReferences } from "../contract";
import { templateTextLength } from "../../contracts/template-text-length";
import { channelVariableTemplateToken } from "../../contracts/channel-variable-template";
import { createChatVotingRepository } from "./repository";
import { CHAT_VOTING_CHAT_COMMANDS } from "./contracts/chat-commands";
import { chatVotingDurationVariableCatalog, chatVotingOptionsVariableCatalog, chatVotingResultVariableCatalog, chatVotingTitleVariableCatalog } from "./contracts/template-variable-catalog";
import { chatVotingAlarmDefinition, chatVotingStartAnnouncementAlarmDefinition, processChatVotingMessage } from "./service";
import { CHAT_VOTING_ELEMENT_KIND, CHAT_VOTING_HARD_LIMIT_MS, CHAT_VOTING_MODULE_ID, DEFAULT_CHAT_VOTING_SETTINGS, chatVotingPresetForKind, chatVotingSettingsSchema, type ChatVotingKind } from "./contracts";
import { chatVotingOverlayElements } from "./overlay/element";
import { chatVotingRoutes } from "./routes";
import { chatVotingImmediateActionTexts } from "./action-locale";
import { dryRunChatVotingMessage } from "./dry-run";

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

const settingsReferences = settingsVariableReferences(CHAT_VOTING_MODULE_ID, ["startText", "resultText"]);
const resultTextVariableReferences: ModuleVariableReferences = {
  async usages(db, channelId, name) {
    const token = channelVariableTemplateToken(name);
    const rows = await findChatVoteResultTextReferences(db, channelId, token);
    return rows.map((row) => ({
      moduleId: CHAT_VOTING_MODULE_ID,
      itemName: row.item_name || row.source_id,
      kind: "template" as const,
    }));
  },
  async validateRename(db, channelId, from, to) {
    const oldToken = channelVariableTemplateToken(from);
    const nextToken = channelVariableTemplateToken(to);
    const rows = await findChatVoteResultTextReferences(db, channelId, oldToken);
    const snapshot = rows.map((row) => ({ sourceKind: row.source_kind, itemId: row.source_id, text: row.result_text }));
    const usages = rows.filter((row) => templateTextLength(row.result_text.replaceAll(oldToken, nextToken)) > 500)
      .map((row) => ({ moduleId: CHAT_VOTING_MODULE_ID, itemName: row.item_name || row.source_id, kind: "template" as const }));
    const snapshotJson = JSON.stringify(snapshot);
    const currentReferences = `
      SELECT source.source_kind, source.source_id, source.result_text
        FROM (${CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL}) AS source
       WHERE source.channel_id = ? AND instr(source.result_text, ?) > 0`;
    return {
      usages,
      precondition: {
        sql: `NOT EXISTS (
          SELECT 1 FROM (
            ${currentReferences}
            EXCEPT
            SELECT json_extract(snapshot.value, '$.sourceKind'), json_extract(snapshot.value, '$.itemId'), json_extract(snapshot.value, '$.text')
              FROM json_each(?) AS snapshot
          )
        ) AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT json_extract(snapshot.value, '$.sourceKind'), json_extract(snapshot.value, '$.itemId'), json_extract(snapshot.value, '$.text')
              FROM json_each(?) AS snapshot
            EXCEPT
            ${currentReferences}
          )
        )`,
        values: [channelId, oldToken, snapshotJson, snapshotJson, channelId, oldToken],
      },
    };
  },
  rename(db, channelId, from, to, guard) {
    const target = moduleVariableRenameTarget(channelId, to, guard);
    return prepareChatVoteResultTextReferenceRewrite(db, {
      channelId,
      fromToken: channelVariableTemplateToken(from),
      toToken: channelVariableTemplateToken(to),
      conditionSql: `${target.sql} AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
      conditionValues: [...target.values, channelId, from],
    });
  },
};
const variableReferences: ModuleVariableReferences = {
  ...resultTextVariableReferences,
  async usages(db: D1Database, channelId: string, name: string) {
    return [
      ...await settingsReferences.usages(db, channelId, name),
      ...await resultTextVariableReferences.usages(db, channelId, name),
    ];
  },
  async validateRename(db, channelId, from, to) {
    return await resultTextVariableReferences.validateRename?.(db, channelId, from, to) ?? {
      usages: [],
      precondition: { sql: "1 = 1", values: [] },
    };
  },
  rename(db: D1Database, channelId: string, from: string, to: string, guard?: Parameters<typeof settingsReferences.rename>[4]) {
    return [
      ...settingsReferences.rename(db, channelId, from, to, guard),
      ...resultTextVariableReferences.rename(db, channelId, from, to, guard),
    ];
  },
};

const templateUsageSources = async (db: D1Database, channelId: string): Promise<readonly ModuleTemplateUsageSource[]> => {
  const rows = await findChatVoteResultTextReferences(db, channelId);
  return rows.map((row) => ({ text: row.result_text, kind: "event", label: `chat_voting.${row.item_name || row.source_id}` }));
};

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
  if (vote.status !== "closed") {
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
    preset: chatVotingPresetForKind(vote.kind),
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
    deadlineRevision: vote.deadlineRevision ?? 0,
    requestedDurationSeconds: vote.requestedDurationSeconds,
    closedAt: vote.closedAt,
    closeReason: vote.closeReason,
    voterCount: vote.voterCount,
  };
};
export const chatVotingModule: BotModule<typeof settingsSchema> = {
  id: CHAT_VOTING_MODULE_ID,
  navigationCategory: "participation",
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
  templateUsageSources,
  variableReferences,
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorRelatedParts: ["panel"],
  templateVariableGroup: {
    label: { de: "Abstimmung", en: "Voting" },
    icon: { paths: ["M4 5h16v14H4z", "M7 9h3", "M14 9h3", "M7 13h3", "M14 13h3"] },
  },
  routes: chatVotingRoutes,
  panel: () => import("./panel"),
  liveTile: {
    load: async (channelId, signal) => {
      const state = await (await import("./panel/service")).loadChatVotingState(channelId, signal);
      const vote = state.vote;
      if (vote === null || vote.status === "closed") return [];
      const options = vote.kind === "free_text"
        ? (state.terms ?? []).map(({ term, count, approved }) => ({ label: term, count, approved }))
        : vote.labels.map((label, index) => ({ label, count: state.counts?.[index] ?? 0 }));
      const totalVotes = options.reduce((total, option) => total + option.count, 0);
      const openedAt = Date.parse(vote.openedAt);
      const closesAt = Date.parse(vote.closesAt);
      return [{
        kind: "vote",
        id: vote.id,
        title: vote.title,
        options,
        totalVotes,
        closesAt: vote.closesAt,
        canExtend: vote.status === "open" && Number.isFinite(openedAt) && Number.isFinite(closesAt) && closesAt < openedAt + CHAT_VOTING_HARD_LIMIT_MS,
      }];
    },
  },
  actions: [{
    id: "start-vote",
    name: chatVotingImmediateActionTexts.name,
    icon: "vote",
    conditions: ["streamLive", {
      check: async ({ channelId, signal }) => {
        const service = await import("./panel/service");
        try {
          const state = await service.loadChatVotingState(channelId, signal);
          if (state.vote?.status === "open" || state.vote?.status === "closing") {
            const until = Date.parse(state.vote.closesAt);
            return {
              reason: chatVotingImmediateActionTexts.running,
              ...(Number.isFinite(until) ? { until } : {}),
            };
          }
          if (state.hasOpenBallot) {
            return { reason: chatVotingImmediateActionTexts.votekickRunning };
          }
          return { reason: null };
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          throw error;
        }
      },
    }],
    requiredRole: "operator",
    content: { presentation: "dialog", load: () => import("./panel/action-content") },
    errorMessage: chatVotingImmediateActionTexts.error,
    execute: async ({ channelId, formData }) => {
      const mode = formData.get("mode");
      const templateId = formData.get("templateId");
      if (mode === "saved") {
        if (typeof templateId !== "string" || templateId.length === 0) throw new Error("A vote template is required.");
        await (await import("./panel/service")).startChatVoting(channelId, { templateId });
        return;
      }
      const rawKind = formData.get("kind");
      if (rawKind !== "yes_no" && rawKind !== "options") throw new Error("A vote type is required.");
      const title = formData.get("title");
      const durationSeconds = Number(formData.get("durationSeconds"));
      if (typeof title !== "string" || title.trim().length === 0 || !Number.isSafeInteger(durationSeconds)) {
        throw new Error("A vote question and duration are required.");
      }
      const kind: ChatVotingKind = rawKind;
      const labels = formData.getAll("labels").map((label) => typeof label === "string" ? label.trim() : "");
      if (kind === "options" && (labels.length < 2 || labels.length > 9 || labels.some((label) => label.length === 0))) {
        throw new Error("Two to nine answer options are required.");
      }
      await (await import("./panel/service")).startChatVoting(channelId, {
        kind,
        ...(kind === "options" ? { optionCount: labels.length, labels } : {}),
        durationSeconds,
        title: title.trim(),
      });
    },
  }, {
    id: "end-vote",
    name: chatVotingImmediateActionTexts.endName,
    icon: "vote",
    conditions: [{
      check: async ({ channelId, signal }) => {
        const service = await import("./panel/service");
        try {
          const state = await service.loadChatVotingState(channelId, signal);
          return state.vote?.status === "open"
            ? { reason: null, pollId: state.vote.id }
            : { reason: chatVotingImmediateActionTexts.notRunning };
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          throw error;
        }
      },
    }],
    requiredRole: "operator",
    errorMessage: chatVotingImmediateActionTexts.endError,
    execute: async ({ channelId, pollId }) => {
      if (pollId === undefined) throw new Error("The rendered vote is no longer available.");
      await (await import("./panel/service")).closeChatVoting(channelId, pollId);
      return { message: chatVotingImmediateActionTexts.endSucceeded };
    },
  }],
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
  dryRunChatMessage: dryRunChatVotingMessage,
};

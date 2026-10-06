import { Hono } from "hono";

import type { AuditAction } from "../../contracts/values";
import type { BallotSnapshot, ModuleRouteEnvironment } from "../contract";
import { CHAT_VOTING_ALARM_HANDLER, CHAT_VOTING_ELEMENT_KIND, CHAT_VOTING_HARD_LIMIT_MS, CHAT_VOTING_MODULE_ID, chatVotingSettingsSchema } from "./contracts";
import type { ChatVotePreset } from "./contracts";
import { createChatVotingRepository } from "./repository";
import { requestChatVoteClose, startChatVote } from "./service";
import { isBlockedFreeTextVote, normalizeBlockedVoteTerm } from "./domain";

const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getEnabledSettings = async (db: D1Database, channelId: string) => {
  const row = await db.prepare(
    "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ? AND enabled = 1",
  ).bind(channelId, CHAT_VOTING_MODULE_ID).first<{ settings: string }>();
  if (row === null) return null;
  try {
    const parsed = chatVotingSettingsSchema.safeParse(JSON.parse(row.settings));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
};

const channelLanguage = async (db: D1Database, channelId: string): Promise<"de" | "en"> => {
  const row = await db.prepare("SELECT language FROM channels WHERE channel_id = ?")
    .bind(channelId).first<{ language: string }>();
  return row?.language === "en" ? "en" : "de";
};

export const chatVotingRoutes = new Hono<ModuleRouteEnvironment>();

chatVotingRoutes.get("/current", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const repository = createChatVotingRepository(context.env.DB);
  const [vote, settings] = await Promise.all([
    repository.latest(channelId),
    getEnabledSettings(context.env.DB, channelId),
  ]);
  const ballots = context.get("ballots")(channelId);
  if (vote === null) {
    const hasOpenBallot = await ballots.hasOpenBallot?.() ?? false;
    return context.json({ vote: null, counts: null, revision: 0, terms: null, moreTerms: null, hasOpenBallot, defaultDurationSeconds: settings?.autoCloseSeconds ?? 0 });
  }
  const [snapshot, hasOpenBallot] = await Promise.all([
    vote.status === "open" ? ballots.read(vote.id) : Promise.resolve(null),
    ballots.hasOpenBallot?.() ?? Promise.resolve(false),
  ]);
  return context.json({
    vote,
    counts: snapshot?.counts ?? vote.counts,
    revision: snapshot?.revision ?? 0,
    terms: snapshot?.terms ?? vote.textResults,
    moreTerms: snapshot?.more ?? vote.moreTerms,
    termFilterReady: snapshot?.termFilterReady ?? vote.termFilterReady ?? false,
    hasOpenBallot,
    defaultDurationSeconds: settings?.autoCloseSeconds ?? 0,
  });
});

chatVotingRoutes.post("/start", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const body = await readBody(context.req.raw);
  if (!isRecord(body) || !["yes_no", "scale_5", "options_n", "digit_01", "digit_12", "free_text"].includes(String(body.preset))) {
    return context.json({ error: "chat_voting_request_invalid" }, 400);
  }
  const preset = body.preset as ChatVotePreset;
  const optionCount = preset === "free_text" ? 0
    : preset === "yes_no" || preset === "digit_01" || preset === "digit_12" ? 2
      : preset === "scale_5" ? 5 : body.optionCount;
  if (!Number.isSafeInteger(optionCount) || (optionCount as number) < 0 || (optionCount as number) > 9 ||
      preset === "options_n" && (optionCount as number) < 2) {
    return context.json({ error: "chat_voting_request_invalid" }, 400);
  }
  const textMode = body.textMode === undefined ? "first_word"
    : body.textMode === "first_word" || body.textMode === "whole_message" ? body.textMode : null;
  if (preset === "free_text" && textMode === null || preset !== "free_text" && body.textMode !== undefined) {
    return context.json({ error: "chat_voting_request_invalid" }, 400);
  }
  const durationSeconds = body.durationSeconds;
  if (!Number.isSafeInteger(durationSeconds) || (durationSeconds as number) < 0 ||
      (durationSeconds as number) > CHAT_VOTING_HARD_LIMIT_MS / 1_000) {
    return context.json({ error: "chat_voting_request_invalid" }, 400);
  }

  const settings = await getEnabledSettings(context.env.DB, channelId);
  if (settings === null) return context.json({ error: "chat_voting_unavailable" }, 409);
  const now = new Date().toISOString();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const repository = createChatVotingRepository(context.env.DB);
  let blockedTerms: readonly string[] | null = null;
  if (preset === "free_text") {
    try {
      const readBlockedTerms = context.get("readChannelBlockedTerms");
      blockedTerms = readBlockedTerms === undefined ? null : await readBlockedTerms(channelId);
    } catch { blockedTerms = null; }
  }
  let result: Awaited<ReturnType<typeof startChatVote>>;
  try {
    result = await startChatVote(repository, {
      channelId,
      preset,
      optionCount: optionCount as number,
      ...(preset === "free_text" ? { textMode: textMode ?? "first_word", blockedTerms } : {}),
      settings: { ...settings, autoCloseSeconds: durationSeconds as number },
      language: await channelLanguage(context.env.DB, channelId),
      authorization,
    }, context.get("ballots")(channelId), async (pollId, deadline, ownerRevision) => {
      const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
      await object.scheduleModuleAlarm(CHAT_VOTING_MODULE_ID, CHAT_VOTING_ALARM_HANDLER, pollId, deadline, ownerRevision);
    });
  } catch {
    return context.json({ error: "chat_voting_start_failed" }, 503);
  }
  if (result.status === "busy") return context.json({ error: "chat_voting_busy" }, 409);

  await context.get("writeModuleAudit")({
    channelId,
    moduleId: CHAT_VOTING_MODULE_ID,
    action: "chat_voting.started" satisfies AuditAction,
    before: null,
    after: {
      pollId: result.vote.id,
      preset: result.vote.preset,
      optionCount: result.vote.optionCount,
      closesAt: result.vote.closesAt,
    },
  }, new Date().toISOString());
  await context.get("publishModuleOverlayMessage")(
    channelId,
    CHAT_VOTING_MODULE_ID,
    "opened",
    CHAT_VOTING_ELEMENT_KIND,
    { pollId: result.vote.id },
  );
  return context.json({ vote: result.vote });
});

chatVotingRoutes.post("/approve-term", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const body = await readBody(context.req.raw);
  if (!isRecord(body) || typeof body.pollId !== "string" || body.pollId.length < 1 || body.pollId.length > 128 ||
      typeof body.term !== "string" || Array.from(body.term).length < 1 || Array.from(body.term).length > 25) {
    return context.json({ error: "chat_voting_request_invalid" }, 400);
  }
  const vote = await createChatVotingRepository(context.env.DB).open(channelId);
  if (vote === null || vote.preset !== "free_text") return context.json({ error: "chat_voting_not_running" }, 409);
  if (body.pollId !== vote.id) return context.json({ error: "chat_voting_poll_changed" }, 409);
  let rawBlockedTerms: readonly string[] | null;
  try {
    const readBlockedTerms = context.get("readChannelBlockedTerms");
    rawBlockedTerms = readBlockedTerms === undefined ? null : await readBlockedTerms(channelId);
  } catch { rawBlockedTerms = null; }
  if (rawBlockedTerms === null) return context.json({ error: "chat_voting_blocked_terms_unavailable" }, 503);
  const blockedTerms = [...new Set(rawBlockedTerms.map(normalizeBlockedVoteTerm).filter((term) => term.length > 0))];
  const term = normalizeBlockedVoteTerm(body.term);
  const ballots = context.get("ballots")(channelId);

  const hasMutationAuthorization = async (): Promise<boolean> => {
    const authorization = context.get("authorizeMutation")(
      channelId,
      context.get("actor"),
      new Date().toISOString(),
    );
    const row = await context.env.DB.prepare(
      `SELECT 1 AS authorized WHERE 1 = 1 ${authorization.sql}`,
    ).bind(...authorization.values).first<{ authorized: number }>();
    return row !== null;
  };

  const publishTally = async (snapshot: BallotSnapshot): Promise<void> => {
    await context.get("publishModuleOverlayMessage")(
      channelId,
      CHAT_VOTING_MODULE_ID,
      "tally",
      CHAT_VOTING_ELEMENT_KIND,
      {
        pollId: vote.id,
        openedAt: vote.openedAt,
        preset: vote.preset,
        optionCount: vote.optionCount,
        textMode: vote.textMode,
        labels: [...vote.labels],
        counts: [...snapshot.counts],
        terms: (snapshot.terms ?? []).map((entry) => ({ ...entry })),
        more: snapshot.more ?? 0,
        termFilterReady: snapshot.termFilterReady ?? false,
        revision: snapshot.revision,
      },
    );
  };

  if (!await hasMutationAuthorization()) {
    return context.json({ error: "chat_voting_not_authorized" }, 403);
  }
  const filtered = await ballots.setBlockedTerms?.(vote.id, blockedTerms);
  if (filtered === undefined || filtered === null) return context.json({ error: "chat_voting_not_running" }, 409);
  // A refresh can remove previously counted terms. Publish that durable state
  // before any later validation returns an error.
  await publishTally(filtered);
  if (isBlockedFreeTextVote(term, blockedTerms)) return context.json({ error: "chat_voting_term_blocked" }, 409);

  if (!await hasMutationAuthorization()) {
    return context.json({ error: "chat_voting_not_authorized" }, 403);
  }
  const approval = await ballots.approveTerm?.(vote.id, term);
  if (approval === undefined || approval.status === "not_open") return context.json({ error: "chat_voting_not_running" }, 409);
  if (approval.status === "unavailable") return context.json({ error: "chat_voting_blocked_terms_unavailable" }, 503);
  if (approval.status === "blocked") return context.json({ error: "chat_voting_term_blocked" }, 409);
  if (approval.snapshot === null) return context.json({ error: "chat_voting_not_running" }, 409);
  const snapshot = approval.snapshot;
  await publishTally(snapshot);
  return context.json({ terms: snapshot.terms ?? [], moreTerms: snapshot.more ?? 0, revision: snapshot.revision });
});

chatVotingRoutes.post("/close", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const now = new Date().toISOString();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const repository = createChatVotingRepository(context.env.DB);
  const vote = await repository.open(channelId);
  if (vote === null) return context.json({ error: "chat_voting_not_running" }, 404);
  const audit = {
    channelId,
    moduleId: CHAT_VOTING_MODULE_ID,
    action: "chat_voting.closed" as const satisfies AuditAction,
    before: { pollId: vote.id, status: vote.status },
    after: { pollId: vote.id, status: "closing" },
  };
  const result = await requestChatVoteClose(repository, channelId, async (pollId, deadline, ownerRevision) => {
    const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
    await object.scheduleModuleAlarm(CHAT_VOTING_MODULE_ID, CHAT_VOTING_ALARM_HANDLER, pollId, deadline, ownerRevision);
  }, authorization);
  if (result === null) return context.json({ error: "chat_voting_not_running" }, 404);
  await context.get("writeModuleAudit")(audit, now);
  return context.json({ closing: true, pollId: result.id });
});

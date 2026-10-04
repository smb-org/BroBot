import { Hono } from "hono";

import type { AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { CHAT_VOTING_ALARM_HANDLER, CHAT_VOTING_ELEMENT_KIND, CHAT_VOTING_MODULE_ID, chatVotingSettingsSchema } from "./contracts";
import type { ChatVotePreset } from "./contracts";
import { createChatVotingRepository } from "./repository";
import { requestChatVoteClose, startChatVote } from "./service";

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
  const vote = await repository.latest(channelId);
  if (vote === null) return context.json({ vote: null });
  const snapshot = vote.status === "open"
    ? await context.get("ballots")(channelId).read(vote.id)
    : null;
  return context.json({
    vote,
    counts: snapshot?.counts ?? vote.counts,
    revision: snapshot?.revision ?? 0,
  });
});

chatVotingRoutes.post("/start", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const body = await readBody(context.req.raw);
  if (!isRecord(body) || (body.preset !== "yes_no" && body.preset !== "scale_5" && body.preset !== "options_n")) {
    return context.json({ error: "chat_voting_request_invalid" }, 400);
  }
  const preset: ChatVotePreset = body.preset;
  const optionCount = preset === "yes_no" ? 2 : preset === "scale_5" ? 5 : body.optionCount;
  if (!Number.isSafeInteger(optionCount) || (optionCount as number) < 2 || (optionCount as number) > 9) {
    return context.json({ error: "chat_voting_request_invalid" }, 400);
  }

  const settings = await getEnabledSettings(context.env.DB, channelId);
  if (settings === null) return context.json({ error: "chat_voting_unavailable" }, 409);
  const now = new Date().toISOString();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const repository = createChatVotingRepository(context.env.DB);
  let result: Awaited<ReturnType<typeof startChatVote>>;
  try {
    result = await startChatVote(repository, {
      channelId,
      preset,
      optionCount: optionCount as number,
      settings,
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

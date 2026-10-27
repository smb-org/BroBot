import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModulePointsAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { quizRoutes } from "../../src/modules/quiz/routes";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const channelId = "quiz-session-route-channel";
const databases: TestD1Database[] = [];
const settings = { pot: 500, answerSeconds: 30, revealSeconds: 8, chatQuestions: true };

const createDatabase = async (online: boolean): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, channelId);
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'quiz', 1, ?, 1)",
  ).bind(channelId, JSON.stringify(settings)).run();
  if (online) await database.prepare(
    "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
  ).bind(channelId, "2030-01-01T00:00:00.000Z").run();
  await database.prepare(
    "INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at) VALUES (?, 'set-one', 'Space', 1, ?, ?)",
  ).bind(channelId, "2030-01-01", "2030-01-01").run();
  await database.prepare(
    "INSERT INTO quiz_questions (set_id, position, text, options_json, correct_index, enabled) VALUES ('set-one', 0, 'Capital?', '[\"A\",\"B\"]', 1, 1), ('set-one', 1, 'Disabled?', '[\"A\",\"B\"]', 0, 0)",
  ).run();
  return database;
};

const appFor = (options: {
  role?: "broadcaster" | "manager" | "operator" | null;
  active?: { roundId: string; state: "announcing" | "open"; data: unknown; deadlineAt: number | null } | null;
} = {}) => {
  const active = options.active ?? null;
  const opened = vi.fn<ModulePointsAccess["rounds"]["open"]>().mockResolvedValue(undefined);
  const publish = vi.fn(() => Promise.resolve());
  const points = {
    rounds: {
      active: vi.fn(() => Promise.resolve(active)),
      open: opened,
    },
  } as unknown as ModulePointsAccess;
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", (options.role === undefined ? "operator" : options.role) as "broadcaster" | "manager" | "operator");
    context.set("points", () => points);
    context.set("publishModuleOverlayMessage", publish);
    await next();
  });
  app.route("/channels/:channelId/modules/quiz", quizRoutes);
  return { app, opened, publish };
};

const startRequest = (questionCount: number | null = null): Request => new Request(
  `https://brobot.example/channels/${channelId}/modules/quiz/session/start`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setId: "set-one", questionCount }) },
);

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("quiz session cockpit routes", () => {
  it("requires a channel role before starting a session", async () => {
    const database = await createDatabase(true);
    const harness = appFor({ role: null });

    const response = await harness.app.fetch(startRequest(), { DB: database as unknown as D1Database });

    expect(response.status).toBe(403);
    expect(harness.opened).not.toHaveBeenCalled();
  });

  it("rechecks that the channel is live when the cockpit starts the quiz", async () => {
    const database = await createDatabase(false);
    const harness = appFor();

    const response = await harness.app.fetch(startRequest(), { DB: database as unknown as D1Database });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "stream_offline" });
    expect(harness.opened).not.toHaveBeenCalled();
  });

  it("allows only one active quiz in the channel and snapshots the requested enabled questions", async () => {
    const database = await createDatabase(true);
    const alreadyRunning = appFor({ active: { roundId: "active-quiz", state: "open", data: {}, deadlineAt: Date.now() + 30_000 } });
    const runningResponse = await alreadyRunning.app.fetch(startRequest(), { DB: database as unknown as D1Database });
    expect(runningResponse.status).toBe(409);
    expect(alreadyRunning.opened).not.toHaveBeenCalled();

    const harness = appFor();
    const response = await harness.app.fetch(startRequest(1), { DB: database as unknown as D1Database });

    expect(response.status).toBe(201);
    expect(harness.opened).toHaveBeenCalledOnce();
    const [, roundData] = harness.opened.mock.calls[0] ?? [];
    const sessionId = (await response.json<{ sessionId: string }>()).sessionId;
    const roundDataRecord = typeof roundData === "object" && roundData !== null && !Array.isArray(roundData)
      ? roundData as Record<string, unknown> : null;
    expect(roundData).toMatchObject({
      questions: [{ text: "Capital?", options: ["A", "B"], correctIndex: 1 }],
      phase: "announce",
      settlement: { kind: "quiz", params: {} },
    });
    expect(roundDataRecord?.resolveOperationId).toBe("quiz:" + sessionId + ":resolve");
    expect(harness.publish).toHaveBeenCalledWith(channelId, "quiz", "phase", "quiz.session", expect.objectContaining({ phase: "announce" }));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  startEntry: vi.fn(),
  reconcile: vi.fn(),
  endPollRun: vi.fn(),
  lockPredictionRun: vi.fn(),
  resolvePredictionRun: vi.fn(),
  cancelPredictionRun: vi.fn(),
  loadFreshPrediction: vi.fn(),
}));

vi.mock("../../src/modules/polls/service", () => mocks);

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { pollsRoutes } from "../../src/modules/polls/routes";
import { TestD1Database } from "./test-d1";

const channelId = "channel_polls";
const now = "2026-11-04T12:00:00.000Z";

describe("polls routes", () => {
  let database: TestD1Database;

  beforeEach(() => {
    vi.resetAllMocks();
    database = new TestD1Database();
    database.sqlite.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(channelId, "polls_demo", "Polls demo", now, now);
    database.sqlite.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'polls', 1, '{}')",
    ).run(channelId);
    mocks.reconcile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    database.close();
  });

  const writeModuleAudit = vi.fn(() => Promise.resolve());

  const makeRequest = (role: string, path: string, body?: unknown, method = "POST"): Response | Promise<Response> => {
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", role as "operator");
      context.set("actor", { userId: "operator_polls", sessionId: "polls-session" });
      context.set("authorizeMutation", () => ({ sql: "", values: [] }));
      context.set("authorizeManagementMutation", () => ({ sql: "", values: [] }));
      context.set("prepareModuleAudit", () => database.prepare("SELECT 1") as unknown as D1PreparedStatement);
      context.set("writeModuleAudit", writeModuleAudit);
      await next();
    });
    app.route(`/api/channels/:channelId/modules/polls`, pollsRoutes);
    return app.request(
      `/api/channels/${channelId}/modules/polls${path}`,
      {
        method,
        ...(body === undefined ? {} : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      },
      { DB: database as unknown as D1Database, TWITCH_CLIENT_ID: "fictional-client" },
    );
  };

  it("serves GET /state without reconciling, fetching, or writing", async () => {
    database.sqlite.prepare(
      `INSERT INTO polls_runs (
         channel_id, run_id, kind, twitch_id, entry_id, source, title, choices_json, status,
         started_at, ends_at, locked_at, ended_at, winning_choice_id, last_event_at
       ) VALUES (?, ?, 'poll', ?, NULL, 'twitch', ?, ?, 'active', ?, NULL, NULL, NULL, NULL, ?)`,
    ).run(channelId, "run_open", "twitch_poll_open", "Fictional poll", "[]", now, now);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const changes = (): number =>
      (database.sqlite.prepare("SELECT total_changes() AS value").get() as { value: number }).value;
    const before = changes();

    const response = await makeRequest("viewer", "/state", undefined, "GET");

    expect(response.status).toBe(200);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(changes()).toBe(before);
    vi.unstubAllGlobals();
  });

  it("throttled POST /reconcile writes no audit entry and forced POST does", async () => {
    mocks.reconcile.mockResolvedValue("success");

    const throttled = await makeRequest("operator", "/reconcile");
    expect(throttled.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenLastCalledWith(expect.anything(), channelId, expect.any(String), { force: false });
    expect(writeModuleAudit).not.toHaveBeenCalled();

    const forced = await makeRequest("operator", "/reconcile", { force: true });
    expect(forced.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenLastCalledWith(expect.anything(), channelId, expect.any(String), { force: true });
    expect(writeModuleAudit).toHaveBeenCalledTimes(1);
  });

  it("rejects entry creation for a role below operator", async () => {
    const response = await makeRequest("viewer", "/entries", {
      kind: "poll", title: "Fictional poll", choices: ["First", "Second"], durationSeconds: 60,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    });

    expect(response.status).toBe(403);
  });

  it("returns field paths for invalid entry input", async () => {
    const response = await makeRequest("operator", "/entries", {
      kind: "poll", title: "", choices: ["Only one"], durationSeconds: 60,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "polls_invalid_entry",
      fields: expect.arrayContaining([
        expect.objectContaining({ path: ["title"] }) as unknown,
        expect.objectContaining({ path: ["choices"] }) as unknown,
      ]) as unknown,
    });
  });

  it("maps an already-active start result to HTTP 409", async () => {
    mocks.startEntry.mockResolvedValue({ ok: false, reason: "already_active" });

    const response = await makeRequest("operator", "/entries/entry_demo/start");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "polls_already_active" });
  });

  it("rejects dismissing a prediction that is locked rather than unknown", async () => {
    database.sqlite.prepare(
      `INSERT INTO polls_runs (
         channel_id, run_id, kind, twitch_id, entry_id, source, title, choices_json, status,
         started_at, ends_at, locked_at, ended_at, winning_choice_id, last_event_at
       ) VALUES (?, ?, 'prediction', ?, NULL, 'twitch', ?, ?, 'locked', ?, NULL, ?, NULL, NULL, ?)`,
    ).run(
      channelId, "run_locked", "twitch_prediction_locked", "Fictional prediction", "[]",
      now, "2026-11-04T12:01:00.000Z", "2026-11-04T12:01:00.000Z",
    );

    const response = await makeRequest("operator", "/runs/run_locked/dismiss");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "polls_run_not_dismissible" });
  });
});

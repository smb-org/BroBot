import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import type { PanelChannelJob } from "../../src/panel-contract";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "channel-jobs-channel";
const MEMBER_ID = "channel-jobs-member";
const SESSION_COOKIE_KEYS = JSON.stringify({ active: { id: "cookie-v1", key: testKey(81) }, retired: [] });
const SESSION_ENCRYPTION_KEYS = JSON.stringify({ active: { id: "session-v1", key: testKey(82) }, retired: [] });
const job: PanelChannelJob = {
  id: "host:test_only",
  intervalMs: 60_000,
  label: { de: "Test task", en: "Test job" },
  requiredScopes: [],
  state: "idle",
  lastStartedAt: null,
  lastSuccessAt: null,
  nextRunAt: 1_800_000_000_000,
  errorCode: null,
  errorTextKey: null,
  consecutiveFailures: 0,
  resultSummary: null,
  pausedAt: null,
  reconcileNeeded: false,
};

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  csrf = true,
): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const sessionCookie = await createSessionCookie({ sessionId }, SESSION_COOKIE_KEYS, SESSION_ENCRYPTION_KEYS);
  const csrfToken = await createCsrfToken(sessionId, SESSION_COOKIE_KEYS, new Date().toISOString());
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
    "Content-Type": "application/json",
  });
  if (csrf) headers.set("X-CSRF-Token", csrfToken);
  return new Request(`https://brobot.example${path}`, {
    method,
    headers,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
};

describe("channel jobs panel routes", () => {
  let database: TestD1Database;
  let environment: Env;
  const listChannelJobs = vi.fn<() => Promise<PanelChannelJob[]>>();
  const runChannelJobNow = vi.fn<(jobId: string) => Promise<"scheduled" | "already_running" | "paused" | "not_found">>();
  const pauseChannelJob = vi.fn<(jobId: string) => Promise<unknown>>();
  const resumeChannelJob = vi.fn<(jobId: string) => Promise<"scheduled" | "already_running" | "not_paused" | "not_found">>();

  beforeEach(async () => {
    database = new TestD1Database();
    listChannelJobs.mockReset();
    runChannelJobNow.mockReset();
    pauseChannelJob.mockReset();
    resumeChannelJob.mockReset();
    await insertChannel(database, CHANNEL_ID);
    await insertLoginIdentityAndSession(database, MEMBER_ID);
    await insertMember(database, CHANNEL_ID, MEMBER_ID, "operator");
    listChannelJobs.mockResolvedValue([job]);
    runChannelJobNow.mockResolvedValue("scheduled");
    pauseChannelJob.mockResolvedValue({ state: "paused", pausedAt: 1_800_000_000_000, reconcileNeeded: false });
    resumeChannelJob.mockResolvedValue("scheduled");
    environment = {
      DB: database as unknown as D1Database,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ listChannelJobs, runChannelJobNow, pauseChannelJob, resumeChannelJob }),
      },
      PUBLIC_ORIGIN: "https://brobot.example",
      SESSION_COOKIE_KEYS,
      SESSION_ENCRYPTION_KEYS,
    } as unknown as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

  it("lets a channel member list, run, pause, and resume jobs", async () => {
    const list = await panelRouter.fetch(await requestFor(MEMBER_ID, `/api/channels/${CHANNEL_ID}/jobs`), environment);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ jobs: [job] });

    const run = await panelRouter.fetch(await requestFor(MEMBER_ID, `/api/channels/${CHANNEL_ID}/jobs/host%3Atest_only/run`, "POST"), environment);
    expect(run.status).toBe(200);
    await expect(run.json()).resolves.toEqual({ result: "scheduled" });

    const pause = await panelRouter.fetch(await requestFor(MEMBER_ID, `/api/channels/${CHANNEL_ID}/jobs/host%3Atest_only/pause`, "POST"), environment);
    expect(pause.status).toBe(200);
    await expect(pause.json()).resolves.toMatchObject({ status: { state: "paused" } });

    const resume = await panelRouter.fetch(await requestFor(MEMBER_ID, `/api/channels/${CHANNEL_ID}/jobs/host%3Atest_only/resume`, "POST"), environment);
    expect(resume.status).toBe(200);
    await expect(resume.json()).resolves.toEqual({ result: "scheduled" });
    expect(listChannelJobs).toHaveBeenCalledOnce();
    expect(runChannelJobNow).toHaveBeenCalledWith("host:test_only");
    expect(pauseChannelJob).toHaveBeenCalledWith("host:test_only");
    expect(resumeChannelJob).toHaveBeenCalledWith("host:test_only");
  });

  it("rejects a session without channel membership", async () => {
    const nonMember = "channel-jobs-outsider";
    await insertLoginIdentityAndSession(database, nonMember);
    const response = await panelRouter.fetch(await requestFor(nonMember, `/api/channels/${CHANNEL_ID}/jobs`), environment);
    expect(response.status).toBe(403);
    expect(listChannelJobs).not.toHaveBeenCalled();
  });

  it("rejects a job action without a valid CSRF token", async () => {
    const response = await panelRouter.fetch(
      await requestFor(MEMBER_ID, `/api/channels/${CHANNEL_ID}/jobs/host%3Atest_only/run`, "POST", false),
      environment,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "csrf_invalid" });
    expect(runChannelJobNow).not.toHaveBeenCalled();
  });
});

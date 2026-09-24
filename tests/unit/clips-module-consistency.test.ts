import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { getChannelOverviewForUser } from "../../src/worker/panel/repository";
import { readDispatchChannelState } from "../../src/worker/db/channel-controls";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

// The module list API, the overview's activeModules, and dispatch's
// activations all used to have their own idea of whether a default-enabled
// module (clips) was on when `channel_modules` had no row for it: the API
// had a fallback that treated it as enabled, the others read the row
// directly and saw it as off. This checks all three now agree, in both
// directions, straight off the same table -- with the real module registry,
// not a test double.

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  PUBLIC_ORIGIN: "https://brobot.example",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (userId: string, path: string): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
    "X-CSRF-Token": csrfToken,
  });
  return new Request(`https://brobot.example${path}`, { headers });
};

const clipsEnabledEverywhere = async (
  environment: Env,
  channelId: string,
): Promise<{ inModuleList: boolean; inOverview: boolean; inDispatch: boolean }> => {
  const modulesResponse = await panelRouter.fetch(await requestFor("user-1", `/api/channels/${channelId}/modules`), environment);
  const modules = await modulesResponse.json<{ modules: Array<{ id: string; enabled: boolean }> }>();

  const overview = await getChannelOverviewForUser(environment.DB, "user-1", channelId);

  const dispatchState = await readDispatchChannelState(environment.DB, channelId, "2026-09-23T00:00:00.000Z");

  return {
    inModuleList: modules.modules.some((module) => module.id === "clips" && module.enabled),
    inOverview: overview?.activeModules.some((module) => module.moduleId === "clips") ?? false,
    inDispatch: dispatchState.activations.some((activation) => activation.moduleId === "clips" && activation.enabled),
  };
};

describe("clips enabled state agrees across every reader", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = environmentFor(database);
  });

  afterEach(() => {
    database.close();
  });

  it("agrees clips is off when there is no row", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const state = await clipsEnabledEverywhere(environment, "kanal-a");

    expect(state).toEqual({ inModuleList: false, inOverview: false, inDispatch: false });
  });

  it("agrees clips is on once a real row says so", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'clips', 1, '{}')`,
    ).run();

    const state = await clipsEnabledEverywhere(environment, "kanal-a");

    expect(state).toEqual({ inModuleList: true, inOverview: true, inDispatch: true });
  });
});

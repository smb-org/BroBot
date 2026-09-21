import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotModule, ModuleRouteEnvironment } from "../../src/modules/contract";
import { createSessionCookie } from "../../src/worker/auth/session";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: "a".repeat(43) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: "b".repeat(43) }, retired: [] }),
};

const routeFor = (): NonNullable<BotModule["routes"]> => {
  const route = new Hono<ModuleRouteEnvironment>();
  route.get("/probe", (context) => {
    const variables = context.var as unknown as Record<string, unknown>;
    return context.json({
      protokoll: typeof variables.writeModuleDiagnostics === "function",
      scope: typeof variables.broadcasterHasScope === "function",
      token: typeof variables.getAppAccessToken === "function",
    });
  });
  return route;
};

const testModule = (id: string): BotModule => ({
  id,
  settingsSchema: z.object({}),
  defaultSettings: {},
  routes: routeFor(),
});

vi.mock("../../src/modules/registry", () => ({
  MODULES: [testModule("erstes-modul"), testModule("zweites-modul")],
}));

const { moduleRouter } = await import("../../src/worker/panel/module-routes");

const requestFor = async (): Promise<Request> => new Request(
  "https://brobot.example/api/channels/kanal-a/modules",
  {
    headers: {
      Cookie: `__Host-brobot_session=${await createSessionCookie(
        { sessionId: "session-user-1" },
        environmentKeys.SESSION_COOKIE_KEYS,
        environmentKeys.SESSION_ENCRYPTION_KEYS,
      )}`,
    },
  },
);

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  ...environmentKeys,
} as unknown as Env);

describe("Fähigkeiten für Modulrouten", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
  });

  afterEach(() => { database.close(); });

  it.each(["erstes-modul", "zweites-modul"])(
    "reicht alle generischen Fähigkeiten an die Route von %s weiter",
    async (moduleId) => {
      const response = await moduleRouter.fetch(
        new Request(
          `https://brobot.example/api/channels/kanal-a/modules/${moduleId}/probe`,
          { headers: (await requestFor()).headers },
        ),
        environmentFor(database),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ protokoll: true, scope: true, token: true });
    },
  );
});

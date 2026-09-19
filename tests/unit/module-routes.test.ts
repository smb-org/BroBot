import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BotModule } from "../../src/modules/contract";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

// MODULES ist in der Registry bewusst leer (siehe src/modules/registry.ts).
// Diese Tests brauchen ein registriertes Modul, um Aktivierung end-to-end
// durch die Route zu prüfen — daher ein kleines Doppel statt eines echten
// Moduls, gemockt bevor die Route es importiert.
const testModuleSchema = z.object({ betrag: z.number() });
const testModule: BotModule<typeof testModuleSchema> = {
  id: "test-modul",
  settingsSchema: testModuleSchema,
  defaultSettings: { betrag: 42 },
};

vi.mock("../../src/modules/registry", () => ({ MODULES: [testModule] }));

const { createCsrfToken } = await import("../../src/worker/auth/csrf");
const { createSessionCookie } = await import("../../src/worker/auth/session");
const { panelRouter } = await import("../../src/worker/panel/routes");

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://brobot.example${path}`, init);
};

const auditCount = async (database: TestD1Database): Promise<number> => {
  const row = await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>();
  return row?.count ?? 0;
};

// Gemeinsamer Ablauf der Verweigerungs-Faelle: Mitgliedschaft mit einer Rolle
// in einem Kanal anlegen, PATCH auf einen (moeglicherweise anderen) Zielkanal
// versuchen, erwarteten Fehlerstatus und unveraenderten Endzustand pruefen.
const expectDeniedPatch = async (
  database: TestD1Database,
  environment: Env,
  options: {
    memberChannelId: string;
    role: "broadcaster" | "verwalter" | "bediener";
    targetChannelId: string;
    extraChannelIds?: string[];
    expectedStatus: number;
  },
): Promise<void> => {
  await insertChannel(database, options.memberChannelId);
  for (const extraChannelId of options.extraChannelIds ?? []) {
    await insertChannel(database, extraChannelId);
  }
  await insertLoginIdentityAndSession(database, "user-1");
  await insertMember(database, options.memberChannelId, "user-1", options.role);

  const response = await panelRouter.fetch(
    await requestFor("user-1", `/api/channels/${options.targetChannelId}/modules/test-modul`, "PATCH", { enabled: true }),
    environment,
  );

  expect(response.status).toBe(options.expectedStatus);
  await expect(auditCount(database)).resolves.toBe(0);
};

describe("Modulverwaltung im Panel", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = environmentFor(database);
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("liefert im Leerzustand die Registry-Module mit Default-Einstellungen", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules"),
      environment,
    );
    const body = await response.json<{ modules: Array<{ id: string; enabled: boolean; settings: string }> }>();

    expect(response.status).toBe(200);
    expect(body.modules).toEqual([{ id: "test-modul", enabled: false, settings: '{"betrag":42}' }]);
  });

  it("aktiviert ein Modul für einen Broadcaster und schreibt genau einen Audit-Eintrag", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );
    const body = await response.json<{ module: { id: string; enabled: boolean; settings: string } }>();

    expect(response.status).toBe(200);
    expect(body.module).toEqual({ id: "test-modul", enabled: true, settings: '{"betrag":42}' });
    await expect(auditCount(database)).resolves.toBe(1);

    const listResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules"),
      environment,
    );
    const list = await listResponse.json<{ modules: Array<{ id: string; enabled: boolean }> }>();
    expect(list.modules).toEqual([{ id: "test-modul", enabled: true, settings: '{"betrag":42}' }]);
  });

  it("verweigert einem Bediener das Aktivieren eines Moduls", async () => {
    await expectDeniedPatch(database, environment, {
      memberChannelId: "kanal-a",
      role: "bediener",
      targetChannelId: "kanal-a",
      expectedStatus: 403,
    });
  });

  it("lehnt ein der Registry unbekanntes Modul ab", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/unbekanntes-modul", "PATCH", { enabled: true }),
      environment,
    );

    expect(response.status).toBe(404);
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("verweigert die Aktivierung in einem fremden Kanal trotz gültiger Session", async () => {
    await expectDeniedPatch(database, environment, {
      memberChannelId: "kanal-a",
      role: "broadcaster",
      targetChannelId: "kanal-b",
      extraChannelIds: ["kanal-b"],
      expectedStatus: 403,
    });
  });

  it("behält beim Deaktivieren die zuvor geschriebenen Einstellungen", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: true }),
      environment,
    );

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/test-modul", "PATCH", { enabled: false }),
      environment,
    );
    const body = await response.json<{ module: { id: string; enabled: boolean; settings: string } }>();

    expect(response.status).toBe(200);
    expect(body.module).toEqual({ id: "test-modul", enabled: false, settings: '{"betrag":42}' });
    await expect(auditCount(database)).resolves.toBe(2);
  });
});
